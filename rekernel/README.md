# Locked Kernel: Six Locking Mechanisms

A coherent, verifiable state machine kernel with explicit locking mechanisms that prevent silent corruption and ensure deterministic convergence.

## The Six Locks

### 1. Protocol Freeze (`core/protocol.ts`)
**Consensus-critical immutability**

- `HASH_PROTOCOL_VERSION = 1` is frozen (immutable constant)
- All events carry this version at creation
- Version mismatch → explicit fork, not silent corruption
- Supports planned upgrades via `PLANNED_UPGRADES`

**Key functions:**
- `validateProtocolVersion(version)` — reject incompatible versions
- `isAcceptedProtocolVersion(version)` — consensus rules

**Invariant:** Every event's `protocolVersion` must match node's `ACCEPTED_PROTOCOL_VERSIONS`.

---

### 2. Mandatory Ingress Verification (`core/ingress.ts`)
**Security boundary**

No event (local or remote) enters execution without:
- **I1**: Hash integrity check (`hash(E) == stored hash`)
- **I2**: ID derivation check (`id(E) == deriveId(fields)`)
- **I3**: Protocol version match (`protocolVersion ∈ ACCEPTED_VERSIONS`)
- **I4**: Structural validation (required fields present)
- **I5**: Timestamp reasonableness (clock skew tolerance)
- **I6**: JSON serializability (payload check)

**Key function:**
```typescript
verifyEvent(event): EventValidationResult
  ├─ valid: boolean
  ├─ violations: ValidationViolation[]
  └─ reason?: RejectionReason
```

**Invariant:** `verifyEvent()` is called before every `exec()`.

---

### 3. Rejection Records (`core/rejections.ts`)
**First-class ledger entries**

Failed events don't disappear—they become deterministic `RejectionRecord` objects:

```typescript
RejectionRecord {
  type: 'REJECTION'
  rejectedHash: string      // Hash of rejected event
  rejectedId: string        // ID of rejected event
  stateHash: string         // State at rejection (immutable proof)
  reason: RejectionReason   // Deterministic code (not opaque string)
  hash: string              // Self-hash
}
```

**Key function:**
```typescript
createRejectionRecord(
  rejectedHash, rejectedId, stateHash, reason, prevHash, details
): RejectionRecord
```

**Invariant:** Ledger = `accepted events + rejection records` (total history).

---

### 4. Event Ordering (`core/ordering.ts`)
**Deterministic total order**

Without ordering, same events in different order → different states → divergence.

**Solution:** Canonical sort by hash (lexicographic):

```typescript
compareEvents(a, b): number
  ├─ Primary: a.hash.localeCompare(b.hash)
  ├─ Secondary: a.timestamp - b.timestamp
  └─ Tertiary: a.id.localeCompare(b.id)

canonicalizeEventBatch(events)
  ├─ Sort by hash
  └─ Deduplicate (remove duplicates by hash)
```

**Invariant:** All nodes apply the same events in the same canonical order.

---

### 5. Transition Chain (`core/chain.ts`)
**Full history persistence**

Instead of storing only current state `S_n`, persist the full chain:

```
S_0 → E_1 → T_1 → S_1
       ↓
      E_2 → T_2 → S_2
             ↓
            E_3 → T_3 → S_3
```

Where:
- `S_i` = State after applying i events
- `E_i` = i-th event
- `T_i` = Transition proof: `hash(T_{i-1}, E_i, S_i)`

**Key function:**
```typescript
createTransitionRecord(
  index, prevTransitionHash, event, preStateHash, postStateHash
): TransitionRecord
```

**Properties:**
- Tamper-evident (altering any `T` invalidates all downstream)
- Replayable (replay from genesis = full audit)
- Verifiable (recompute `T_i` and check match)
- Divergence-detectable (conflicting `T` hashes = fork)

**Invariant:** Transition chain is immutable and cryptographically linked.

---

### 6. Snapshots (`core/snapshots.ts`)
**Periodic checkpoints**

Replaying from genesis doesn't scale. Solution: periodic snapshots.

```
Genesis → E_1..1000 → Snapshot(1000)
                       ↓
                    E_1001..2000 → Snapshot(2000)
                                    ↓
                                   ...
```

**Recovery:**
```
Load Snapshot(2000)
Replay E_2001..N
Final state = Snapshot state + suffix
```

**Key function:**
```typescript
createSnapshot(height, state): StateSnapshot
  ├─ height: number
  ├─ state: State
  └─ snapshotHash: string  // hash(height, timestamp, state.stateHash)
```

**Invariant:** Snapshot hash is part of consensus proof (in transition chain).

---

## Integration

### Event Processing Pipeline

```
Receive Event E
  ↓
verifyEvent(E)
  ├─ PASS → canonicalize + execute
  └─ FAIL → createRejectionRecord
  ↓
for each entry in canonical order:
  ├─ exec(S, E) → S′  (if event)
  ├─ skip (if rejection)
  ├─ createTransitionRecord(E, S, S′)
  └─ append to ledger + chain
  ↓
[if height % SNAPSHOT_INTERVAL == 0]
  └─ createSnapshot(S′)
  ↓
Broadcast canonical event (exact hash, not reconstruction)
```

### Example

```typescript
const kernel = new LockedKernel();

const event1 = createEvent('TASK', 'alice', { id: 'task-1' });
const event2 = createEvent('TASK', 'bob', { id: 'task-2' });

await kernel.processBatch([event2, event1]);  // Out of order

// Kernel automatically:
// 1. Verifies both events
// 2. Canonicalizes (sorts by hash)
// 3. Executes in canonical order
// 4. Records transitions
// 5. Snapshots if needed
```

---

## Security Properties

| Property | Mechanism | Status |
|----------|-----------|--------|
| **Deterministic** | No `Date.now()`, no `Math.random()` in exec | ✓ |
| **Canonical** | Same events, same order → same state | ✓ |
| **Immutable** | Events, states, transitions frozen | ✓ |
| **Auditable** | Full ledger (accepts + rejections) | ✓ |
| **Replayable** | `replay(genesis, ledger) ≡ final state` | ✓ |
| **Verifiable** | Hash chain catches tampering | ✓ |
| **Recoverable** | Snapshot + suffix replay | ✓ |
| **Convergent** | Multi-node consensus on final state | ✓ |

---

## Next Failure Modes

**Now prevented:**
- ✓ Silent corruption (nondeterminism)
- ✓ Undetectable divergence
- ✓ History loss

**Still possible (future work):**
- ✗ Byzantine nodes (propose conflicting events)
- ✗ Network partition (two ledger branches)
- ✗ Sybil attack (attacker creates many nodes)
- ✗ Long-range attack (rewrite old history)

**Solution:** Add Byzantine Fault Tolerant consensus
- Validator set + threshold signatures
- Slashing for bad behavior
- Finality rules (e.g., 2/3 + 1)

---

## Testing

```bash
# Run test suite (all six mechanisms)
npm test -- core/tests.ts

# Tests cover:
# 1. Protocol freeze (version immutability)
# 2. Ingress verification (I1–I6)
# 3. Rejection records (first-class ledger)
# 4. Event ordering (deterministic total order)
# 5. Transition chain (full history)
# 6. Snapshots (periodic checkpoints)
```

---

## Files

```
rekernel_locked/
├── core/
│   ├── protocol.ts           # Lock 1: Protocol freeze
│   ├── ingress.ts            # Lock 2: Mandatory verification
│   ├── rejections.ts         # Lock 3: Rejection records
│   ├── ordering.ts           # Lock 4: Event ordering
│   ├── chain.ts              # Lock 5: Transition chain
│   ├── snapshots.ts          # Lock 6: Snapshots
│   ├── LOCKING_GUIDE.ts      # Integration guide
│   ├── integration_example.ts # Example: LockedKernel class
│   └── tests.ts              # Test suite
├── ARCHITECTURE.ts           # Visual architecture
└── README.md                 # This file
```

---

## Key Invariants

1. **Protocol version is immutable:** `HASH_PROTOCOL_VERSION` never changes in place.
2. **Every event is verified:** No event enters execution without `verifyEvent()` passing.
3. **Rejections are recorded:** Failed events become ledger entries, not disappear.
4. **Events are ordered:** Canonical sort by hash ensures deterministic execution.
5. **Transitions are chained:** `T_i = hash(T_{i-1}, E_i, S_i)` makes history tamper-evident.
6. **Snapshots are included:** `snapshotHash` is part of consensus proof.

---

## Quick Start

```typescript
import { LockedKernel } from './core/integration_example';

const kernel = new LockedKernel();

// Process events
await kernel.processBatch([event1, event2]);

// Verify integrity
const { valid, violations } = kernel.verifyIntegrity();

// Get state
const state = kernel.getState();

// Export ledger
const { height, entries, transitions } = kernel.exportLedger();
```

---

## References

- **Core Kernel:** Deterministic state machine with canonical hashing
- **Event Structure:** Immutable, frozen, with content-derived IDs
- **Execution:** Pure function `exec(state, event) → state`
- **Consensus:** Deterministic ordering + transition chaining
- **Recovery:** Snapshot + suffix replay (O(n) suffix, not O(n) full replay)

---

**Status:** Locked and verified. Ready for Byzantine consensus layer.
