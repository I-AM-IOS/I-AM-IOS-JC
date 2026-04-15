/**
 * DAG EVENT MODEL — v2 (+ DMR Routing Events)
 *
 * Every overlay action — identity creation, capability issuance,
 * peer discovery, session establishment, revocation — becomes an
 * append-only event in the L1 event log. This makes all overlay
 * state deterministic and replayable across nodes.
 *
 * DMR UPGRADE adds four new routing event types:
 *   overlay.ROUTE_SET_COMPUTED     — a canonical route set was computed
 *   overlay.ROUTE_ACTIVATED_PRIMARY — primary path is now active
 *   overlay.ROUTE_FAILOVER_TRIGGERED — a failover trigger fired
 *   overlay.ROUTE_SWITCHED         — active path changed to a backup
 *
 * These events allow the global DAG to:
 *   - Audit all routing decisions (reproducible from log alone)
 *   - Drive future edge-weight updates via DAG-derived metrics
 *   - Track failover history across the network
 *
 * These events flow through the SAME pipeline as all other events:
 *   L0 canonical serialization → L1 ingress verification →
 *   L2 state transition → L3 consensus finality
 */

import { canonicalJson, canonicalJsonHashSync } from '../canonical-json';
import { CIDRecord }          from '../cid/cid';
import { CAPToken }           from '../capability/capability';
import { EndpointDescriptor } from '../endpoint/endpoint';
import { CanonicalRouteSet, RoutingPath, FailoverTrigger } from '../routing/overlay-routing';

// ── Protocol ──────────────────────────────────────────────────────────────────

export const OVERLAY_PROTOCOL_VERSION = 1;

// ── Event Types ───────────────────────────────────────────────────────────────

export type OverlayEventType =
  | 'overlay.CID_CREATED'
  | 'overlay.CID_ROTATED'
  | 'overlay.CID_REVOKED'
  | 'overlay.CAP_ISSUED'
  | 'overlay.CAP_REVOKED'
  | 'overlay.PEER_DISCOVERED'
  | 'overlay.PEER_LOST'
  | 'overlay.ENDPOINT_UPDATED'
  | 'overlay.SESSION_ESTABLISHED'
  | 'overlay.SESSION_CLOSED'
  | 'overlay.CONSENSUS_FINALIZED'
  // ── DMR routing events (new in v2) ──
  | 'overlay.ROUTE_SET_COMPUTED'
  | 'overlay.ROUTE_ACTIVATED_PRIMARY'
  | 'overlay.ROUTE_FAILOVER_TRIGGERED'
  | 'overlay.ROUTE_SWITCHED';

// ── Payload Shapes ────────────────────────────────────────────────────────────

export interface CIDCreatedPayload {
  record: CIDRecord;
}

export interface CIDRotatedPayload {
  oldCID:    string;
  newRecord: CIDRecord;
  /** Hash of old CIDRecord — proves knowledge of prior state. */
  prevRecordHash: string;
}

export interface CIDRevokedPayload {
  cid:       string;
  reason:    string;
  revokedBy: string;   // CID of revoking party
}

export interface CAPIssuedPayload {
  token: CAPToken;
}

export interface CAPRevokedPayload {
  capId:     string;
  reason:    string;
  revokedBy: string;
}

export interface PeerDiscoveredPayload {
  peerCID:   string;
  endpoints: EndpointDescriptor[];
  via:       string;   // CID of the introducing node, or 'bootstrap'
}

export interface PeerLostPayload {
  peerCID:  string;
  reason:   'timeout' | 'explicit' | 'protocol_error';
  lastSeen: number;
}

export interface EndpointUpdatedPayload {
  cid: string;
  endpoints: EndpointDescriptor[];
}

export interface SessionEstablishedPayload {
  localCID:    string;
  remoteCID:   string;
  sessionId:   string;
  transport:   string;
  capId:       string;   // Which capability authorized this session
}

export interface SessionClosedPayload {
  sessionId:  string;
  reason:     'normal' | 'timeout' | 'error' | 'revoked';
  durationMs: number;
}

export interface ConsensusFinalizedPayload {
  stateRoot:  string;
  height:     number;
  validators: string[];   // CIDs of attesting validators
}

// ── DMR Routing Payloads (new in v2) ──────────────────────────────────────────

/**
 * Emitted when a canonical route set is computed for a (local, target) pair.
 * Recording this in the DAG makes routing decisions auditable and replayable.
 */
export interface RouteSetComputedPayload {
  localCID:       string;
  targetCID:      string;
  /** CID-sequence of the primary path (hops). */
  primaryHops:    string[];
  /** CID-sequences of each backup path. */
  backupHops:     string[][];
  /** Hash of the routing table state used. Verifies inputs. */
  stateHash:      string;
  protocolVersion: number;
}

/**
 * Emitted when the primary path becomes the active connection path.
 */
export interface RouteActivatedPrimaryPayload {
  localCID:    string;
  targetCID:   string;
  sessionId:   string;
  primaryHops: string[];
  stateHash:   string;
}

/**
 * Emitted when a deterministic failover trigger fires on the active path.
 * This causes the system to activate the next backup in the canonical set.
 */
export interface RouteFailoverTriggeredPayload {
  localCID:    string;
  targetCID:   string;
  sessionId:   string;
  trigger:     FailoverTrigger;
  failedHops:  string[];
  /** null if all backups are exhausted. */
  nextHops:    string[] | null;
}

/**
 * Emitted when the active path switches to a backup.
 */
export interface RouteSwitchedPayload {
  localCID:   string;
  targetCID:  string;
  sessionId:  string;
  fromHops:   string[];
  toHops:     string[];
  trigger:    FailoverTrigger;
}

/** Union of all possible overlay payloads. */
export type OverlayPayload =
  | CIDCreatedPayload
  | CIDRotatedPayload
  | CIDRevokedPayload
  | CAPIssuedPayload
  | CAPRevokedPayload
  | PeerDiscoveredPayload
  | PeerLostPayload
  | EndpointUpdatedPayload
  | SessionEstablishedPayload
  | SessionClosedPayload
  | ConsensusFinalizedPayload
  | RouteSetComputedPayload
  | RouteActivatedPrimaryPayload
  | RouteFailoverTriggeredPayload
  | RouteSwitchedPayload;

// ── Base Event Shape ──────────────────────────────────────────────────────────

/**
 * An overlay event. Structurally compatible with the L1 Event interface
 * so it can flow through the existing ingress → log → consensus pipeline.
 */
export interface OverlayEvent {
  /** Content-addressed id: SHA-256(type + actor + canonicalJson(payload)). */
  id:              string;
  /** SHA-256 over all state-influencing fields. */
  hash:            string;
  /** Previous event's hash. Null for genesis. */
  prevHash:        string | null;
  /** Unix ms at creation — immutable once written. */
  timestamp:       number;
  /** Event classifier (namespaced under "overlay.*"). */
  type:            OverlayEventType;
  /** CID of the originating actor. */
  actor:           string;
  /** The event payload. */
  payload:         OverlayPayload;
  /** L0 safety gate. */
  protocolVersion: number;
}

// ── Event Construction ────────────────────────────────────────────────────────

function hashableEventFields(
  e: Omit<OverlayEvent, 'id' | 'hash'>
): object {
  return {
    actor:           e.actor,
    payload:         e.payload,
    prevHash:        e.prevHash,
    protocolVersion: e.protocolVersion,
    timestamp:       e.timestamp,
    type:            e.type,
  };
}

/**
 * Build a new OverlayEvent. Computes id and hash canonically.
 */
export function createOverlayEvent(
  type:     OverlayEventType,
  actor:    string,
  payload:  OverlayPayload,
  prevHash: string | null,
  nowMs:    number = Date.now(),
): OverlayEvent {
  const id = canonicalJsonHashSync({ type, actor, payload: canonicalJson(payload) });

  const partial: Omit<OverlayEvent, 'id' | 'hash'> = {
    type,
    actor,
    payload,
    prevHash,
    timestamp:       nowMs,
    protocolVersion: OVERLAY_PROTOCOL_VERSION,
  };

  const hash = canonicalJsonHashSync(hashableEventFields(partial));
  return { id, hash, ...partial };
}

// ── Typed Factory Functions — Identity / Capability / Session ─────────────────

export function evtCIDCreated(
  actor: string, record: CIDRecord,
  prevHash: string | null, nowMs?: number,
): OverlayEvent {
  return createOverlayEvent(
    'overlay.CID_CREATED', actor,
    { record } satisfies CIDCreatedPayload, prevHash, nowMs,
  );
}

export function evtCIDRotated(
  actor: string, oldCID: string, newRecord: CIDRecord,
  prevRecordHash: string, prevHash: string | null, nowMs?: number,
): OverlayEvent {
  return createOverlayEvent(
    'overlay.CID_ROTATED', actor,
    { oldCID, newRecord, prevRecordHash } satisfies CIDRotatedPayload,
    prevHash, nowMs,
  );
}

export function evtCIDRevoked(
  actor: string, cid: string, reason: string, revokedBy: string,
  prevHash: string | null, nowMs?: number,
): OverlayEvent {
  return createOverlayEvent(
    'overlay.CID_REVOKED', actor,
    { cid, reason, revokedBy } satisfies CIDRevokedPayload,
    prevHash, nowMs,
  );
}

export function evtCAPissued(
  actor: string, token: CAPToken,
  prevHash: string | null, nowMs?: number,
): OverlayEvent {
  return createOverlayEvent(
    'overlay.CAP_ISSUED', actor,
    { token } satisfies CAPIssuedPayload, prevHash, nowMs,
  );
}

export function evtCAPRevoked(
  actor: string, capId: string, reason: string, revokedBy: string,
  prevHash: string | null, nowMs?: number,
): OverlayEvent {
  return createOverlayEvent(
    'overlay.CAP_REVOKED', actor,
    { capId, reason, revokedBy } satisfies CAPRevokedPayload,
    prevHash, nowMs,
  );
}

export function evtPeerDiscovered(
  actor: string, peerCID: string,
  endpoints: EndpointDescriptor[], via: string,
  prevHash: string | null, nowMs?: number,
): OverlayEvent {
  return createOverlayEvent(
    'overlay.PEER_DISCOVERED', actor,
    { peerCID, endpoints, via } satisfies PeerDiscoveredPayload,
    prevHash, nowMs,
  );
}

export function evtSessionEstablished(
  actor: string, localCID: string, remoteCID: string,
  sessionId: string, transport: string, capId: string,
  prevHash: string | null, nowMs?: number,
): OverlayEvent {
  return createOverlayEvent(
    'overlay.SESSION_ESTABLISHED', actor,
    { localCID, remoteCID, sessionId, transport, capId } satisfies SessionEstablishedPayload,
    prevHash, nowMs,
  );
}

export function evtConsensusFinalizedOverlay(
  actor: string, stateRoot: string, height: number, validators: string[],
  prevHash: string | null, nowMs?: number,
): OverlayEvent {
  return createOverlayEvent(
    'overlay.CONSENSUS_FINALIZED', actor,
    { stateRoot, height, validators } satisfies ConsensusFinalizedPayload,
    prevHash, nowMs,
  );
}

// ── Typed Factory Functions — DMR Routing Events (new in v2) ─────────────────

/**
 * Emit a ROUTE_SET_COMPUTED event when computeCanonicalRouteSet() produces
 * a new canonical route set. This event records the decision in the DAG.
 */
export function evtRouteSetComputed(
  actor:    string,
  routeSet: CanonicalRouteSet,
  prevHash: string | null,
  nowMs?:   number,
): OverlayEvent {
  const payload: RouteSetComputedPayload = {
    localCID:        routeSet.localCID,
    targetCID:       routeSet.targetCID,
    primaryHops:     routeSet.primary.hops.map(h => h.cid),
    backupHops:      routeSet.backups.map(p => p.hops.map(h => h.cid)),
    stateHash:       routeSet.stateHash,
    protocolVersion: routeSet.protocolVersion,
  };
  return createOverlayEvent('overlay.ROUTE_SET_COMPUTED', actor, payload, prevHash, nowMs);
}

/**
 * Emit when the primary path is activated for a session.
 */
export function evtRouteActivatedPrimary(
  actor:     string,
  localCID:  string,
  targetCID: string,
  sessionId: string,
  path:      RoutingPath,
  stateHash: string,
  prevHash:  string | null,
  nowMs?:    number,
): OverlayEvent {
  const payload: RouteActivatedPrimaryPayload = {
    localCID,
    targetCID,
    sessionId,
    primaryHops: path.hops.map(h => h.cid),
    stateHash,
  };
  return createOverlayEvent('overlay.ROUTE_ACTIVATED_PRIMARY', actor, payload, prevHash, nowMs);
}

/**
 * Emit when a deterministic failover trigger fires.
 */
export function evtRouteFailoverTriggered(
  actor:     string,
  localCID:  string,
  targetCID: string,
  sessionId: string,
  trigger:   FailoverTrigger,
  failed:    RoutingPath,
  next:      RoutingPath | null,
  prevHash:  string | null,
  nowMs?:    number,
): OverlayEvent {
  const payload: RouteFailoverTriggeredPayload = {
    localCID,
    targetCID,
    sessionId,
    trigger,
    failedHops: failed.hops.map(h => h.cid),
    nextHops:   next ? next.hops.map(h => h.cid) : null,
  };
  return createOverlayEvent('overlay.ROUTE_FAILOVER_TRIGGERED', actor, payload, prevHash, nowMs);
}

/**
 * Emit when the active path switches to a backup.
 */
export function evtRouteSwitched(
  actor:     string,
  localCID:  string,
  targetCID: string,
  sessionId: string,
  fromPath:  RoutingPath,
  toPath:    RoutingPath,
  trigger:   FailoverTrigger,
  prevHash:  string | null,
  nowMs?:    number,
): OverlayEvent {
  const payload: RouteSwitchedPayload = {
    localCID,
    targetCID,
    sessionId,
    fromHops: fromPath.hops.map(h => h.cid),
    toHops:   toPath.hops.map(h => h.cid),
    trigger,
  };
  return createOverlayEvent('overlay.ROUTE_SWITCHED', actor, payload, prevHash, nowMs);
}

// ── Event Verification ────────────────────────────────────────────────────────

export type OverlayEventVerifyResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

/**
 * Verify the structural and cryptographic integrity of an OverlayEvent.
 *
 * OE1: id correctness (content-addressed)
 * OE2: hash correctness (covers all state-influencing fields)
 * OE3: protocol version match
 * OE4: required fields present
 * OE5: timestamp not in the future (±5 min tolerance)
 * OE6: payload non-null
 */
export function verifyOverlayEvent(
  event:       OverlayEvent,
  nowMs:       number = Date.now(),
  clockSkewMs: number = 5 * 60 * 1000,
): OverlayEventVerifyResult {
  // OE4: Required fields
  if (!event.id || !event.hash || !event.type || !event.actor) {
    return { ok: false, code: 'OE4', reason: 'Missing required fields (id, hash, type, actor)' };
  }

  // OE3: Protocol version
  if (event.protocolVersion !== OVERLAY_PROTOCOL_VERSION) {
    return {
      ok: false, code: 'OE3',
      reason: `Expected protocolVersion ${OVERLAY_PROTOCOL_VERSION}, got ${event.protocolVersion}`,
    };
  }

  // OE1: id correctness
  const expectedId = canonicalJsonHashSync({
    type:    event.type,
    actor:   event.actor,
    payload: canonicalJson(event.payload),
  });
  if (expectedId !== event.id) {
    return { ok: false, code: 'OE1', reason: `id mismatch: expected ${expectedId}` };
  }

  // OE2: hash correctness
  const expectedHash = canonicalJsonHashSync(hashableEventFields(event));
  if (expectedHash !== event.hash) {
    return { ok: false, code: 'OE2', reason: `hash mismatch: expected ${expectedHash}` };
  }

  // OE5: Timestamp skew
  if (Math.abs(nowMs - event.timestamp) > clockSkewMs) {
    return {
      ok: false, code: 'OE5',
      reason: `Timestamp skew too large: event=${event.timestamp}, now=${nowMs}`,
    };
  }

  // OE6: Payload
  if (event.payload === null || event.payload === undefined) {
    return { ok: false, code: 'OE6', reason: 'Null payload' };
  }

  return { ok: true };
}

// ── State Projection ──────────────────────────────────────────────────────────

/**
 * Overlay state derived by replaying the event log.
 * This is the L2 state machine for overlay events.
 *
 * v2 adds routeSets: a map of the most recently computed canonical
 * route set for each (localCID→targetCID) pair.
 */
export interface OverlayState {
  cidRegistry:    Map<string, CIDRecord>;
  capIndex:       Map<string, CAPToken>;
  revocationList: Set<string>;                          // revoked CAP ids
  revokedCIDs:    Set<string>;                          // revoked CIDs
  peerGraph:      Map<string, EndpointDescriptor[]>;    // cid → endpoints
  activeSessions: Map<string, SessionEstablishedPayload>;
  /** Most recently computed canonical route sets (DMR, v2). */
  routeSets:      Map<string, RouteSetComputedPayload>; // key: "localCID→targetCID"
  height:         number;
}

export function emptyOverlayState(): OverlayState {
  return {
    cidRegistry:    new Map(),
    capIndex:       new Map(),
    revocationList: new Set(),
    revokedCIDs:    new Set(),
    peerGraph:      new Map(),
    activeSessions: new Map(),
    routeSets:      new Map(),
    height:         0,
  };
}

/**
 * Apply a single overlay event to the state. Pure function — does not
 * mutate the input state; returns a new state object.
 */
export function applyOverlayEvent(
  state: OverlayState,
  event: OverlayEvent,
): OverlayState {
  const next: OverlayState = {
    ...state,
    cidRegistry:    new Map(state.cidRegistry),
    capIndex:       new Map(state.capIndex),
    revocationList: new Set(state.revocationList),
    revokedCIDs:    new Set(state.revokedCIDs),
    peerGraph:      new Map(state.peerGraph),
    activeSessions: new Map(state.activeSessions),
    routeSets:      new Map(state.routeSets),
    height:         state.height + 1,
  };

  const p = event.payload;

  switch (event.type) {
    case 'overlay.CID_CREATED': {
      const { record } = p as CIDCreatedPayload;
      next.cidRegistry.set(record.cid, record);
      break;
    }
    case 'overlay.CID_ROTATED': {
      const { oldCID, newRecord } = p as CIDRotatedPayload;
      next.cidRegistry.delete(oldCID);
      next.cidRegistry.set(newRecord.cid, newRecord);
      break;
    }
    case 'overlay.CID_REVOKED': {
      const { cid } = p as CIDRevokedPayload;
      next.revokedCIDs.add(cid);
      next.cidRegistry.delete(cid);
      break;
    }
    case 'overlay.CAP_ISSUED': {
      const { token } = p as CAPIssuedPayload;
      next.capIndex.set(token.id, token);
      break;
    }
    case 'overlay.CAP_REVOKED': {
      const { capId } = p as CAPRevokedPayload;
      next.revocationList.add(capId);
      next.capIndex.delete(capId);
      break;
    }
    case 'overlay.PEER_DISCOVERED': {
      const { peerCID, endpoints } = p as PeerDiscoveredPayload;
      next.peerGraph.set(peerCID, endpoints);
      break;
    }
    case 'overlay.PEER_LOST': {
      const { peerCID } = p as PeerLostPayload;
      next.peerGraph.delete(peerCID);
      break;
    }
    case 'overlay.ENDPOINT_UPDATED': {
      const { cid, endpoints } = p as EndpointUpdatedPayload;
      next.peerGraph.set(cid, endpoints);
      break;
    }
    case 'overlay.SESSION_ESTABLISHED': {
      const sess = p as SessionEstablishedPayload;
      next.activeSessions.set(sess.sessionId, sess);
      break;
    }
    case 'overlay.SESSION_CLOSED': {
      const { sessionId } = p as SessionClosedPayload;
      next.activeSessions.delete(sessionId);
      break;
    }
    case 'overlay.CONSENSUS_FINALIZED': {
      // No additional state change — height already incremented
      break;
    }
    // ── DMR routing state transitions (v2) ──
    case 'overlay.ROUTE_SET_COMPUTED': {
      const rs = p as RouteSetComputedPayload;
      next.routeSets.set(`${rs.localCID}→${rs.targetCID}`, rs);
      break;
    }
    case 'overlay.ROUTE_ACTIVATED_PRIMARY':
    case 'overlay.ROUTE_FAILOVER_TRIGGERED':
    case 'overlay.ROUTE_SWITCHED': {
      // These are audit events — they do not mutate structural state.
      // They are recorded in the DAG for replay / accountability.
      break;
    }
  }

  return next;
}

/**
 * Replay an ordered list of overlay events to produce final state.
 */
export function replayOverlayLog(events: OverlayEvent[]): OverlayState {
  return events.reduce(applyOverlayEvent, emptyOverlayState());
}
