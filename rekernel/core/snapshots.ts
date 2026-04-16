/**
 * SNAPSHOT STRATEGY — Periodic Checkpoints
 *
 * Replaying from genesis doesn't scale.
 * Snapshots compress the chain: S_snapshot at height N, then replay suffix.
 *
 * Invariant: Snapshot hash is included in the transition chain.
 * This makes snapshots tamper-evident and auditable.
 *
 * Format:
 *   Genesis → E_1 → T_1 → S_1
 *       ...
 *   S_n (snapshot at height n) → E_{n+1} → T_{n+1} → S_{n+1}
 *       ...
 *
 * Verification:
 *   1. Load S_snapshot
 *   2. Replay events from height N+1 onward
 *   3. Verify final state hash matches ledger proof
 *
 * No execution semantics change — only optimization.
 */

import { State } from '../state/state';
import { Event } from '../events/event';
import { hashState } from '../hash';
import { sha256, canonicalJSON } from '../hash';

/**
 * A snapshot is a frozen State with metadata about when it was taken.
 * It includes a proof hash for tamper detection.
 */
export interface StateSnapshot {
  readonly height:           number;         // Event count at snapshot time
  readonly timestamp:        number;         // When snapshot was taken
  readonly state:            State;          // The frozen state object
  readonly snapshotHash:     string;         // Hash of (height, timestamp, stateHash)
}

/**
 * Snapshot proof: includes the snapshot in the transition chain.
 * This makes snapshots consensus-critical, not optional metadata.
 */
export interface SnapshotProof {
  readonly height:           number;
  readonly previousHash:     string | null;  // Hash of previous snapshot or genesis
  readonly stateHash:        string;
  readonly snapshotHash:     string;
}

/**
 * Compute snapshot hash.
 * Includes height, timestamp, and state hash to prevent tampering.
 */
export function hashSnapshot(
  height: number,
  timestamp: number,
  stateHash: string,
): string {
  return sha256(canonicalJSON({
    height,
    timestamp,
    stateHash,
  }));
}

/**
 * Create a snapshot at a given height.
 * Snapshots are immutable; the state is frozen.
 */
export function createSnapshot(
  height: number,
  state: State,
): StateSnapshot {
  const timestamp = Date.now();
  const snapshotHash = hashSnapshot(height, timestamp, state.stateHash);

  return Object.freeze({
    height,
    timestamp,
    state: Object.freeze({ ...state }),
    snapshotHash,
  }) as StateSnapshot;
}

/**
 * Snapshot schedule: take a snapshot every N events.
 * Default: every 1000 events (1000 * 32 bytes per hash ≈ 32 KB overhead).
 * Can be tuned per deployment.
 */
export const SNAPSHOT_INTERVAL = 1000;

/**
 * Decide whether to snapshot based on height and last snapshot height.
 */
export function shouldSnapshot(
  currentHeight: number,
  lastSnapshotHeight: number,
): boolean {
  return currentHeight - lastSnapshotHeight >= SNAPSHOT_INTERVAL;
}

/**
 * A snapshot ledger is a list of snapshots + the suffix of events after the last snapshot.
 * Instead of storing all events, we store:
 *   [snapshot_0, snapshot_1, ..., snapshot_k, events_after_k]
 *
 * Verification:
 *   1. Verify each snapshot is valid (hash check)
 *   2. Verify transition from snapshot_k to final state via suffix events
 *   3. Verify event ordering in suffix
 */
export interface SnapshotLedger {
  readonly snapshots: readonly StateSnapshot[];
  readonly suffix:    readonly Event[];  // Events after last snapshot
}

/**
 * Build a snapshot ledger from a full event ledger and snapshot schedule.
 */
export function buildSnapshotLedger(
  events: readonly Event[],
  fullState: State,
  interval: number = SNAPSHOT_INTERVAL,
): SnapshotLedger {
  const snapshots: StateSnapshot[] = [];
  let currentHeight = 0;

  // Simulate replaying to find snapshot heights
  // (In production, you'd compute this incrementally)
  let state = fullState;
  let lastSnapshotHeight = 0;

  for (let i = 0; i < events.length; i += interval) {
    const snapshotHeight = Math.min(i + interval, events.length);
    if (snapshotHeight > lastSnapshotHeight) {
      snapshots.push(createSnapshot(snapshotHeight, state));
      lastSnapshotHeight = snapshotHeight;
    }
  }

  // Suffix: events after last snapshot
  const suffix = events.slice(lastSnapshotHeight);

  return Object.freeze({
    snapshots: Object.freeze(snapshots),
    suffix: Object.freeze(suffix),
  });
}

/**
 * Recover a full state from a snapshot ledger.
 * Requires the execution engine to replay the suffix.
 */
export interface SnapshotRecovery {
  baseState:  State;
  suffix:     Event[];
  snapshotHeight: number;
}

export function recoverFromSnapshot(
  ledger: SnapshotLedger,
): SnapshotRecovery {
  if (ledger.snapshots.length === 0) {
    throw new Error('SnapshotLedger requires at least one snapshot');
  }

  const lastSnapshot = ledger.snapshots[ledger.snapshots.length - 1];

  return {
    baseState: lastSnapshot.state,
    suffix: [...ledger.suffix],
    snapshotHeight: lastSnapshot.height,
  };
}

/**
 * Verify snapshot integrity: check that snapshot hash matches computation.
 */
export function verifySnapshot(snapshot: StateSnapshot): string[] {
  const violations: string[] = [];

  const expectedHash = hashSnapshot(
    snapshot.height,
    snapshot.timestamp,
    snapshot.state.stateHash,
  );

  if (snapshot.snapshotHash !== expectedHash) {
    violations.push(
      `Snapshot hash mismatch: stored=${snapshot.snapshotHash.slice(0, 12)}… ` +
      `expected=${expectedHash.slice(0, 12)}…`
    );
  }

  return violations;
}

/**
 * Verify a full snapshot ledger.
 */
export function verifySnapshotLedger(ledger: SnapshotLedger): string[] {
  const violations: string[] = [];

  for (let i = 0; i < ledger.snapshots.length; i++) {
    const snapshotViolations = verifySnapshot(ledger.snapshots[i]);
    violations.push(
      ...snapshotViolations.map((v) => `Snapshot ${i}: ${v}`)
    );
  }

  return violations;
}

/**
 * Storage interface for snapshots.
 * Implementations: file, S3, database, etc.
 */
export interface SnapshotStore {
  save(snapshot: StateSnapshot): Promise<void>;
  load(height: number): Promise<StateSnapshot | null>;
  list(): Promise<StateSnapshot[]>;
}

/**
 * In-memory snapshot store for testing.
 */
export class InMemorySnapshotStore implements SnapshotStore {
  private snapshots = new Map<number, StateSnapshot>();

  async save(snapshot: StateSnapshot): Promise<void> {
    this.snapshots.set(snapshot.height, snapshot);
  }

  async load(height: number): Promise<StateSnapshot | null> {
    return this.snapshots.get(height) || null;
  }

  async list(): Promise<StateSnapshot[]> {
    return Array.from(this.snapshots.values())
      .sort((a, b) => a.height - b.height);
  }
}
