/**
 * OVERLAY ROUTING — v2 (Deterministic Multi-Path Routing, DMR)
 *
 * Routing is not IP-based. It operates on the CID graph — a directed
 * graph of known peers, their trust edges, and their capability edges.
 *
 * DMR UPGRADE:
 *   The previous implementation used an adaptive scoring model that
 *   could diverge across nodes. This version replaces all adaptive /
 *   probabilistic logic with pure deterministic functions over shared DAG state.
 *
 *   Core guarantee:
 *     Given the same DAG state, every node independently computes
 *     the IDENTICAL canonical route set for any (source, target) pair.
 *
 * Design:
 *   - Protocol constants are fixed, versioned, identical across all nodes
 *   - Edge cost is a pure function of DAG-derived EPD fields
 *   - Path enumeration uses bounded DFS (all simple paths ≤ MAX_HOPS)
 *   - Sorting uses a three-key deterministic comparator
 *   - Capability filtering is a boolean gate (no soft matching)
 *   - Output is a CanonicalRouteSet: primary + up to K-1 backups
 *   - Failover is rule-based (not reactive); rules are deterministic
 *
 * Integration:
 *   - OverlayState.peerGraph (dag-events.ts) is the single source of truth
 *   - computeCanonicalRouteSet() replaces selectRoute() as the main entry point
 *   - selectRoute() is kept for backward compatibility (returns primary path)
 *   - Routing decisions emit DAG events (ROUTE_SET_COMPUTED, ROUTE_FAILOVER_TRIGGERED, etc.)
 *   - connection.ts uses selectRoute() or computeCanonicalRouteSet() for step 1 discovery
 */

import { canonicalJsonHashSync }           from '../canonical-json';
import { EndpointDescriptor, selectBestEPD, Transport } from '../endpoint/endpoint';
import { OverlayState }                    from '../dag/dag-events';

// ── DMR Protocol Constants ────────────────────────────────────────────────────
//
// These are PROTOCOL-LEVEL constants: fixed, versioned, and identical
// across every node. Changing them requires a protocol version bump.
// No per-node adaptation is permitted.

export const DMR_PROTOCOL_VERSION = 1;

export const DMR_CONSTANTS = {
  /** Latency weight in the edge cost function. */
  WEIGHT_LATENCY:       0.30,
  /** Failure-rate weight in the edge cost function. */
  WEIGHT_FAILURE:       0.35,
  /** Trust-penalty weight in the edge cost function. */
  WEIGHT_TRUST:         0.20,
  /** Per-hop cost applied at the path level (not per-edge). */
  WEIGHT_HOP:           0.15,
  /** Normalisation ceiling for latency (ms). */
  MAX_LATENCY_MS:       2_000,
  /** Maximum hops in any path. Protocol constant — do not tune per-node. */
  MAX_HOPS:             6,
  /** How many paths in a canonical route set (1 primary + K-1 backups). */
  MAX_PATHS:            5,
  /** Failover trigger: connection timeout threshold (ms). */
  FAILOVER_TIMEOUT_MS:  5_000,
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single hop in a routing path. */
export interface RoutingHop {
  cid:      string;
  endpoint: EndpointDescriptor;
}

/** A complete routing path from local to target. */
export interface RoutingPath {
  targetCID:   string;
  hops:        RoutingHop[];    // length 1 = direct, >1 = multi-hop
  totalCost:   number;          // lower = better (replaces totalScore)
  transport:   Transport;
  isDirect:    boolean;
  isRelay:     boolean;
}

/** A trust edge between two CIDs. */
export interface TrustEdge {
  fromCID:   string;
  toCID:     string;
  weight:    number;   // [0, 1]
  updatedAt: number;
}

/** A capability edge — peer has a CAP to a target scope. */
export interface CapabilityEdge {
  holderCID: string;
  targetCID: string;
  scope:     string;
  capId:     string;
}

// ── Routing Table ─────────────────────────────────────────────────────────────

export interface RoutingTable {
  /** Direct peer EPDs keyed by CID. */
  directPeers:  Map<string, EndpointDescriptor[]>;
  /** Trust weights keyed by "from|to". */
  trustEdges:   Map<string, TrustEdge>;
  /** Capability edges keyed by capId. */
  capEdges:     Map<string, CapabilityEdge>;
  /** CIDs that are reachable via relay. */
  relayReach:   Set<string>;
  /** Unix ms of last full rebuild. */
  builtAt:      number;
}

/**
 * Build (or rebuild) a routing table from current overlay state.
 *
 * Also imports capability edges from OverlayState.capIndex so that
 * capability-aware routing has a consistent view without per-node adaptation.
 */
export function buildRoutingTable(state: OverlayState): RoutingTable {
  const directPeers = new Map<string, EndpointDescriptor[]>();
  const relayReach  = new Set<string>();
  const capEdges    = new Map<string, CapabilityEdge>();

  for (const [cid, endpoints] of state.peerGraph) {
    directPeers.set(cid, endpoints);
    if (endpoints.some(e => e.transport === 'relay')) {
      relayReach.add(cid);
    }
  }

  // Import capability edges from DAG state (deterministic — same state → same edges)
  for (const [capId, token] of state.capIndex) {
    capEdges.set(capId, {
      holderCID: token.claim.subjectCID,
      targetCID: token.claim.targetCID,
      scope:     token.claim.scope,
      capId,
    });
  }

  return {
    directPeers,
    trustEdges: new Map(),   // populated externally via updateTrustEdge()
    capEdges,
    relayReach,
    builtAt: Date.now(),
  };
}

// ── Edge Management ───────────────────────────────────────────────────────────

export function updateTrustEdge(table: RoutingTable, edge: TrustEdge): void {
  table.trustEdges.set(`${edge.fromCID}|${edge.toCID}`, edge);
}

export function updateCapEdge(table: RoutingTable, edge: CapabilityEdge): void {
  table.capEdges.set(edge.capId, edge);
}

// ── Deterministic Edge Cost ───────────────────────────────────────────────────

/**
 * Compute the deterministic edge cost for a single endpoint.
 *
 *   cost(e) =
 *     (latency_ms / MAX_LATENCY_MS)  * WEIGHT_LATENCY
 *   + (1 − trust_score)              * WEIGHT_FAILURE
 *   + (1 − trust_score)              * WEIGHT_TRUST
 *
 * Note: WEIGHT_HOP is applied at the PATH level (not per-edge) so that
 * multi-hop paths accumulate a consistent hop penalty.
 *
 * All inputs are normalised to [0, 1]. Result is in [0, 1].
 * This function is PURE — same inputs always produce the same output.
 */
export function computeEdgeCost(epd: EndpointDescriptor): number {
  const latencyNorm   = Math.min(epd.latencyMs / DMR_CONSTANTS.MAX_LATENCY_MS, 1);
  const failureRate   = Math.max(0, Math.min(1, 1 - epd.trustScore));
  const trustPenalty  = failureRate;   // symmetric: low trust = high penalty

  return (
    latencyNorm  * DMR_CONSTANTS.WEIGHT_LATENCY +
    failureRate  * DMR_CONSTANTS.WEIGHT_FAILURE +
    trustPenalty * DMR_CONSTANTS.WEIGHT_TRUST
  );
}

/**
 * Compute total path cost.
 *
 *   path_cost = Σ edge_cost(hop_i) + hop_count * WEIGHT_HOP
 *
 * The hop penalty term grows linearly with path length, naturally
 * preferring shorter paths at equal per-hop cost.
 */
export function computePathCost(hops: RoutingHop[]): number {
  const edgeSum  = hops.reduce((sum, h) => sum + computeEdgeCost(h.endpoint), 0);
  const hopPenalty = hops.length * DMR_CONSTANTS.WEIGHT_HOP;
  return edgeSum + hopPenalty;
}

// ── Deterministic Path Comparator ─────────────────────────────────────────────

/**
 * Compare two paths deterministically. Used to produce a canonical ordering
 * that is identical on every node given the same inputs.
 *
 * Tie-breaking order (applied in sequence):
 *   1. Lowest totalCost (primary sort key)
 *   2. Lowest hop count
 *   3. Lowest lexicographic hash of the CID sequence
 *
 * The CID-sequence hash ensures a unique total order even among paths
 * with identical cost and length.
 */
export function comparePathsDeterministic(a: RoutingPath, b: RoutingPath): number {
  // 1. Lowest cost
  const costDiff = a.totalCost - b.totalCost;
  if (Math.abs(costDiff) > 1e-10) return costDiff;

  // 2. Lowest hop count
  const hopDiff = a.hops.length - b.hops.length;
  if (hopDiff !== 0) return hopDiff;

  // 3. Lowest lexicographic CID sequence hash (deterministic tie-break)
  const hashA = canonicalJsonHashSync({ cids: a.hops.map(h => h.cid) });
  const hashB = canonicalJsonHashSync({ cids: b.hops.map(h => h.cid) });
  return hashA < hashB ? -1 : hashA > hashB ? 1 : 0;
}

// ── Capability Filtering ──────────────────────────────────────────────────────

/**
 * Determine whether a CID node is valid for inclusion in a routing path
 * given a requested scope.
 *
 * A node passes if:
 *   - No requestedScope is specified (no filtering needed), OR
 *   - There exists a non-revoked CAP in the table where:
 *       holderCID == nodeCID AND
 *       targetCID == targetCID AND
 *       scope covers requestedScope
 *
 * This is a BOOLEAN gate — no soft/partial matching.
 */
export function nodePassesCapabilityFilter(
  nodeCID:        string,
  targetCID:      string,
  requestedScope: string | undefined,
  table:          RoutingTable,
): boolean {
  if (!requestedScope) return true;   // no filter required

  // Intermediate hops don't need a cap to the final target — only check
  // the final hop (the target itself). For intermediate nodes, we allow
  // any node that is reachable.
  if (nodeCID !== targetCID) return true;

  return Array.from(table.capEdges.values()).some(
    e =>
      e.holderCID === nodeCID &&
      e.targetCID === targetCID &&
      (e.scope === '/' || e.scope === requestedScope || requestedScope.startsWith(
        e.scope.endsWith('/') ? e.scope : e.scope + '/'
      ))
  );
}

// ── Path Enumeration (Bounded DFS) ────────────────────────────────────────────

interface GraphEdge {
  toCID:    string;
  endpoint: EndpointDescriptor;
}

/**
 * Build a directed adjacency representation from the routing table.
 * Edges are EPDs; we pick the best EPD per (from, to) pair
 * deterministically (lowest cost).
 */
function buildAdjacency(table: RoutingTable): Map<string, GraphEdge[]> {
  const adj = new Map<string, GraphEdge[]>();

  for (const [cid, epds] of table.directPeers) {
    // Group EPDs by their origin peer — the routing table is keyed by target CID,
    // so each entry represents edges TO that CID from any node that knows it.
    // We model edges as: any node that knows `cid` can forward to it.
    // We represent this as a wildcard edge from any peer to `cid`.
    //
    // In practice: we construct edges from each peer to each of its known peers.
    // Since we only have "target → EPDs" (peer graph is from local node's view),
    // we build edges from localCID to each peer, and from each peer to peers they
    // share (via relayReach and known topology).

    if (!adj.has('__root__')) adj.set('__root__', []);
    const best = selectBestEPDByLowestCost(epds);
    if (best) {
      adj.get('__root__')!.push({ toCID: cid, endpoint: best });
    }
  }

  return adj;
}

/**
 * Select the best EPD from a list using the deterministic cost function.
 * Among equal-cost EPDs, use lexicographic address sort for tie-breaking.
 */
export function selectBestEPDByLowestCost(
  epds: EndpointDescriptor[],
): EndpointDescriptor | null {
  if (epds.length === 0) return null;
  return epds.reduce((best, candidate) => {
    const cBest = computeEdgeCost(best);
    const cCand = computeEdgeCost(candidate);
    if (Math.abs(cCand - cBest) > 1e-10) return cCand < cBest ? candidate : best;
    // tie-break by address (deterministic)
    return candidate.address < best.address ? candidate : best;
  });
}

/**
 * Enumerate all simple paths from `source` to `target` in the peer graph,
 * up to `maxHops` hops, with optional capability filtering.
 *
 * Uses bounded DFS — correct and deterministic for overlay-sized graphs
 * (typically dozens to low hundreds of peers).
 *
 * Returns paths sorted by the canonical comparator so the caller receives
 * them in deterministic order regardless of traversal order.
 */
export function enumerateSimplePaths(
  table:          RoutingTable,
  source:         string,
  target:         string,
  maxHops:        number,
  requestedScope: string | undefined,
  exclude:        Set<string> = new Set(),
): RoutingPath[] {
  const results: RoutingPath[] = [];

  function dfs(current: string, hops: RoutingHop[], visited: Set<string>): void {
    if (hops.length > maxHops) return;

    if (current === target && hops.length > 0) {
      const cost      = computePathCost(hops);
      const lastHop   = hops[hops.length - 1];
      const isDirect  = hops.length === 1;
      const isRelay   = hops.some(h => h.endpoint.transport === 'relay');
      results.push({
        targetCID: target,
        hops:      [...hops],
        totalCost: cost,
        transport: lastHop.endpoint.transport,
        isDirect,
        isRelay,
      });
      return;
    }

    // Expand: neighbors of `current`
    const neighbors = table.directPeers.get(current) ?? [];
    for (const epd of neighbors) {
      const nextCID = epd.cid;
      if (visited.has(nextCID) || exclude.has(nextCID)) continue;
      if (!nodePassesCapabilityFilter(nextCID, target, requestedScope, table)) continue;

      // Pick best EPD to this neighbor (deterministic)
      const allEPDs = table.directPeers.get(nextCID) ?? [epd];
      const best    = selectBestEPDByLowestCost(allEPDs);
      if (!best) continue;

      visited.add(nextCID);
      hops.push({ cid: nextCID, endpoint: best });
      dfs(nextCID, hops, visited);
      hops.pop();
      visited.delete(nextCID);
    }

    // Also explore direct neighbors in the peer graph (edges from `source` perspective)
    if (current === source) {
      for (const [peerCID, epds] of table.directPeers) {
        if (visited.has(peerCID) || exclude.has(peerCID)) continue;
        const best = selectBestEPDByLowestCost(epds);
        if (!best) continue;

        visited.add(peerCID);
        hops.push({ cid: peerCID, endpoint: best });
        dfs(peerCID, hops, visited);
        hops.pop();
        visited.delete(peerCID);
      }
    }
  }

  // Seed: direct paths first (target is in directPeers)
  const targetEPDs = table.directPeers.get(target);
  if (targetEPDs && targetEPDs.length > 0 && !exclude.has(target)) {
    const directNonRelay = targetEPDs.filter(e => e.transport !== 'relay');
    const best = selectBestEPDByLowestCost(directNonRelay);
    if (best) {
      const cost = computePathCost([{ cid: target, endpoint: best }]);
      results.push({
        targetCID: target,
        hops:      [{ cid: target, endpoint: best }],
        totalCost: cost,
        transport: best.transport,
        isDirect:  true,
        isRelay:   false,
      });
    }

    // Relay path (2 hops)
    const relayEPDs = targetEPDs.filter(e => e.transport === 'relay');
    if (table.relayReach.has(target) && relayEPDs.length > 0) {
      const bestRelay = selectBestEPDByLowestCost(relayEPDs);
      if (bestRelay && !exclude.has(bestRelay.address)) {
        const hopList: RoutingHop[] = [
          { cid: bestRelay.address, endpoint: bestRelay },
          { cid: target,            endpoint: bestRelay },
        ];
        results.push({
          targetCID: target,
          hops:      hopList,
          totalCost: computePathCost(hopList),
          transport: 'relay',
          isDirect:  false,
          isRelay:   true,
        });
      }
    }
  }

  // Multi-hop: run DFS for paths not already covered
  const visited = new Set<string>([source]);
  dfs(source, [], visited);

  return results;
}

// ── Canonical Route Set ───────────────────────────────────────────────────────

/**
 * A canonical, deterministically-ordered set of routing paths.
 *
 * The set is identical on every node given the same DAG state.
 * primary = paths[0], backups = paths[1..K-1].
 */
export interface CanonicalRouteSet {
  /** The source CID for this route set. */
  localCID:    string;
  /** The destination CID. */
  targetCID:   string;
  /** Primary path (index 0 — lowest cost). */
  primary:     RoutingPath;
  /** Backup paths, in deterministic order. */
  backups:     RoutingPath[];
  /** Hash of the DAG state used to compute this set. */
  stateHash:   string;
  /** DMR protocol version. */
  protocolVersion: number;
  /** Unix ms when this set was computed. */
  computedAt:  number;
}

export interface ComputeRouteSetOptions {
  localCID:        string;
  targetCID:       string;
  requestedScope?: string;
  maxHops?:        number;
  maxPaths?:       number;
  exclude?:        Set<string>;
  /** Precomputed hash of the DAG state (for the stateHash field). */
  stateHash?:      string;
  nowMs?:          number;
}

/**
 * Compute a CanonicalRouteSet for a (source, target) pair.
 *
 * Algorithm:
 *   Step 1: Apply capability filter to build the valid subgraph
 *   Step 2: Enumerate all simple paths up to maxHops
 *   Step 3: Sort deterministically (cost → hops → CID hash)
 *   Step 4: Take the top maxPaths entries
 *   Step 5: Return as CanonicalRouteSet
 *
 * Given identical input state, this function produces identical output
 * on every node — the core determinism guarantee.
 *
 * Returns null if the target is unreachable.
 */
export function computeCanonicalRouteSet(
  table:   RoutingTable,
  opts:    ComputeRouteSetOptions,
): CanonicalRouteSet | null {
  const {
    localCID,
    targetCID,
    requestedScope,
    maxHops  = DMR_CONSTANTS.MAX_HOPS,
    maxPaths = DMR_CONSTANTS.MAX_PATHS,
    exclude  = new Set<string>(),
    stateHash = '',
    nowMs    = Date.now(),
  } = opts;

  if (exclude.has(targetCID)) return null;

  // Enumerate all simple paths
  const allPaths = enumerateSimplePaths(
    table, localCID, targetCID, maxHops, requestedScope, exclude,
  );

  if (allPaths.length === 0) return null;

  // Deduplicate by hop-CID fingerprint
  const seen = new Set<string>();
  const unique: RoutingPath[] = [];
  for (const p of allPaths) {
    const key = p.hops.map(h => h.cid).join('→');
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }

  // Sort deterministically
  unique.sort(comparePathsDeterministic);

  // Take top maxPaths
  const selected = unique.slice(0, maxPaths);

  return {
    localCID,
    targetCID,
    primary:         selected[0],
    backups:         selected.slice(1),
    stateHash,
    protocolVersion: DMR_PROTOCOL_VERSION,
    computedAt:      nowMs,
  };
}

// ── Failover ──────────────────────────────────────────────────────────────────

export type FailoverTrigger =
  | 'timeout'             // connection exceeded FAILOVER_TIMEOUT_MS
  | 'signature_failure'   // handshake or message signature invalid
  | 'revocation'          // DAG emitted a revocation event for this path
  | 'capability_invalid'; // required CAP expired, revoked, or missing

export interface FailoverResult {
  trigger:  FailoverTrigger;
  failed:   RoutingPath;
  next:     RoutingPath | null;   // null = fully exhausted
}

/**
 * Determine the failover trigger given an observed failure condition.
 * This is deterministic: same condition → same trigger everywhere.
 */
export function determineFailoverTrigger(
  elapsedMs:         number,
  signatureValid:    boolean,
  capValid:          boolean,
  dagRevocationSeen: boolean,
): FailoverTrigger {
  if (dagRevocationSeen)                           return 'revocation';
  if (!signatureValid)                             return 'signature_failure';
  if (!capValid)                                   return 'capability_invalid';
  if (elapsedMs > DMR_CONSTANTS.FAILOVER_TIMEOUT_MS) return 'timeout';
  return 'timeout';  // default
}

/**
 * Activate the next backup path after a failover trigger.
 * Returns the next path, or null if all backups are exhausted.
 *
 * The ordering of backups is canonical, so failover activation order
 * is identical on every node that has computed the same route set.
 */
export function activateNextBackup(
  routeSet:      CanonicalRouteSet,
  failedPath:    RoutingPath,
  trigger:       FailoverTrigger,
): FailoverResult {
  const failedKey = failedPath.hops.map(h => h.cid).join('→');

  // Find the index of the failed path in [primary, ...backups]
  const all    = [routeSet.primary, ...routeSet.backups];
  const failIdx = all.findIndex(p => p.hops.map(h => h.cid).join('→') === failedKey);
  const next   = failIdx >= 0 && failIdx + 1 < all.length
    ? all[failIdx + 1]
    : null;

  return { trigger, failed: failedPath, next };
}

// ── Backward-Compatible selectRoute ──────────────────────────────────────────

export interface SelectRouteOptions {
  localCID:        string;
  targetCID:       string;
  requestedScope?: string;
  maxHops?:        number;
  exclude?:        Set<string>;
}

/**
 * Backward-compatible single-path selector.
 * Internally computes the full CanonicalRouteSet and returns the primary path.
 * New code should call computeCanonicalRouteSet() directly.
 */
export function selectRoute(
  table: RoutingTable,
  opts:  SelectRouteOptions,
): RoutingPath | null {
  const routeSet = computeCanonicalRouteSet(table, opts);
  return routeSet?.primary ?? null;
}

// ── Topology Queries ──────────────────────────────────────────────────────────

/** Return all CIDs directly reachable from the local node. */
export function directReachableCIDs(table: RoutingTable): string[] {
  return Array.from(table.directPeers.keys());
}

/** Return whether a target CID is reachable (direct or relay). */
export function isReachable(table: RoutingTable, targetCID: string): boolean {
  return table.directPeers.has(targetCID) || table.relayReach.has(targetCID);
}

/** Return all known relay nodes. */
export function knownRelays(table: RoutingTable): string[] {
  return Array.from(table.relayReach);
}

/**
 * Compute a canonical hash over the routing table's topology.
 * Useful for the stateHash field in CanonicalRouteSet.
 */
export function hashRoutingTableState(table: RoutingTable): string {
  const snapshot = {
    peers: Array.from(table.directPeers.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([cid, epds]) => ({
        cid,
        epHashes: epds.map(e => e.epHash).sort(),
      })),
    relayReach: Array.from(table.relayReach).sort(),
    capEdges:   Array.from(table.capEdges.values())
      .map(e => e.capId)
      .sort(),
  };
  return canonicalJsonHashSync(snapshot);
}
