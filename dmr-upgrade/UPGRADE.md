# DMR Upgrade — I-AM-IOS v2.1

## What Changed

Two files were upgraded. Everything else is untouched.

---

### `src/routing/overlay-routing.ts` — Full rewrite (DMR v1)

The previous routing implementation used an adaptive scoring model
(`scoreRoutingPath`, `scoreEPD`) where weights could diverge per-node
depending on local state. This violated the determinism requirement.

The new implementation guarantees:

> **Given identical DAG state, every node independently computes the
> identical canonical route set for any (source, target) pair.**

#### Key changes

| Old | New |
|-----|-----|
| `scoreRoutingPath()` — adaptive, per-node | `computeEdgeCost()` — pure function, protocol constants |
| `selectRoute()` → single path | `computeCanonicalRouteSet()` → ordered set (primary + backups) |
| BFS multi-hop | Bounded DFS enumeration of all simple paths |
| No deterministic tie-breaking | Three-key comparator: cost → hops → CID-sequence hash |
| No capability-filter gate | `nodePassesCapabilityFilter()` — boolean gate, no soft matching |
| No failover model | `determineFailoverTrigger()` + `activateNextBackup()` — rule-based |
| No state hashing | `hashRoutingTableState()` for reproducibility verification |

`selectRoute()` is kept for **backward compatibility** — it now returns
`computeCanonicalRouteSet(...).primary`.

#### Protocol constants (`DMR_CONSTANTS`)

```
WEIGHT_LATENCY   = 0.30   (L)
WEIGHT_FAILURE   = 0.35   (F)
WEIGHT_TRUST     = 0.20   (T)
WEIGHT_HOP       = 0.15   (H)
MAX_LATENCY_MS   = 2000
MAX_HOPS         = 6
MAX_PATHS        = 5
FAILOVER_TIMEOUT = 5000ms
```

These are **fixed at the protocol level**. Changing them requires a
`DMR_PROTOCOL_VERSION` bump.

#### Edge cost function

```
edge_cost(e) =
  (latency_ms / MAX_LATENCY_MS) * WEIGHT_LATENCY
  + (1 − trust_score)           * WEIGHT_FAILURE
  + (1 − trust_score)           * WEIGHT_TRUST

path_cost(p) = Σ edge_cost(hop_i) + hop_count * WEIGHT_HOP
```

Pure function. Same inputs → same output. Always.

#### Deterministic tie-breaking

When two paths have equal cost:
1. Fewer hops wins
2. Lowest lexicographic SHA-256 of the CID sequence wins

This produces a total order on paths, eliminating all ambiguity.

#### Capability filtering

Before routing, each node in the path is checked:
- Intermediate nodes: always allowed (no filtering)
- Target node: must have a `CapEdge` in the routing table covering the
  requested scope — **boolean gate, no soft matching**

Capability edges are imported from `OverlayState.capIndex` during
`buildRoutingTable()`, so they derive from the DAG (deterministic).

#### Failover model

Failover is not reactive randomness — it is rule-based:

| Trigger | Condition |
|---------|-----------|
| `revocation` | DAG emitted a revocation event |
| `signature_failure` | Handshake/message signature invalid |
| `capability_invalid` | CAP expired, revoked, or missing |
| `timeout` | Elapsed > `FAILOVER_TIMEOUT_MS` |

On trigger, `activateNextBackup()` returns the next path in the
**canonical backup list** — the same list on every node.

---

### `src/dag/dag-events.ts` — Four new event types

Four new `OverlayEventType` values:

| Event | When emitted |
|-------|-------------|
| `overlay.ROUTE_SET_COMPUTED` | After `computeCanonicalRouteSet()` — records the decision |
| `overlay.ROUTE_ACTIVATED_PRIMARY` | When primary path becomes active for a session |
| `overlay.ROUTE_FAILOVER_TRIGGERED` | When a failover trigger fires |
| `overlay.ROUTE_SWITCHED` | When active path changes to a backup |

`ROUTE_SET_COMPUTED` events are stored in `OverlayState.routeSets`
(a new field), keyed by `"localCID→targetCID"`. The other three are
**audit events** — they do not mutate structural state.

Factory functions:
- `evtRouteSetComputed()`
- `evtRouteActivatedPrimary()`
- `evtRouteFailoverTriggered()`
- `evtRouteSwitched()`

---

## What Was NOT Changed

- `cid.ts` — unchanged
- `cid-registry.ts` — unchanged
- `capability.ts` — unchanged
- `endpoint.ts` — unchanged
- `connection.ts` — unchanged (still calls `selectRoute()` which is backward-compatible)
- `cli.js` — unchanged

---

## Integration Checklist

When dropping these files into the existing project:

1. Replace `src/routing/overlay-routing.ts` with the new version.
2. Replace `src/dag/dag-events.ts` with the new version.
3. Update any direct calls to `selectRoute()` to optionally use
   `computeCanonicalRouteSet()` for access to backups.
4. After `computeCanonicalRouteSet()`, emit `evtRouteSetComputed()`
   to record the decision in the DAG.
5. Wire `evtRouteFailoverTriggered()` and `evtRouteSwitched()` into
   your session management layer.
6. Run `ts-node tests/overlay.test.ts` — all tests should pass.

---

## Test Coverage

The extended test suite (`tests/overlay.test.ts`) adds:

- `[DMR — Protocol Constants]` — weight sum, version, bounds
- `[DMR — Edge Cost]` — purity, monotonicity, range
- `[DMR — Path Ordering]` — comparator correctness, stability, tie-breaking
- `[DMR — Canonical Route Set]` — primary selection, maxPaths, null on unreachable
- `[DMR — Convergence]` — **the core guarantee** — two independent computations
  on identical state produce identical route sets
- `[DMR — Capability Filtering]` — gate correctness
- `[DMR — Failover]` — trigger priority, backup activation, exhaustion
- `[DMR — Routing DAG Events]` — event validity, replay into state
- `[DMR — State Hashing]` — deterministic hash, sensitivity to topology change

All original tests from v1 are retained and pass unchanged.
