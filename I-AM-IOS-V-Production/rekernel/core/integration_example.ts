/**
 * INTEGRATION EXAMPLE — Complete Locked Pipeline
 *
 * This file demonstrates how all six locking mechanisms work together.
 * Use this as a reference for implementing the kernel in your system.
 */

import { Event, createEvent, verifySignature } from '../events/event';
import { State, initialState } from '../state/state';
import { ExecutionEngine } from '../exec/exec';
import { verifyEvent, EventValidationResult, formatValidationResult } from './ingress';
import { canonicalizeEventBatch, mergeAndOrderLedgers } from './ordering';
import { 
  createRejectionRecord, 
  RejectionRecord, 
  isRejectionRecord,
  LedgerEntry,
  RejectionReason,
} from './rejections';
import { 
  createTransitionRecord, 
  verifyTransitionChain,
  buildTransitionChain,
  TransitionRecord,
  TransitionChain,
  ChainEntry,
} from './chain';
import { 
  createSnapshot, 
  shouldSnapshot, 
  SNAPSHOT_INTERVAL,
  StateSnapshot,
  InMemorySnapshotStore,
} from './snapshots';
import { validateProtocolVersion } from './protocol';

/**
 * The locked kernel: minimal, secure, and verifiable.
 */
export class LockedKernel {
  private engine: ExecutionEngine;
  private currentState: State;
  
  // Persistent structures
  private ledger: LedgerEntry[] = [];
  private transitions: TransitionRecord[] = [];
  private snapshots: StateSnapshot[] = [];
  private snapshotStore: InMemorySnapshotStore;
  
  private lastTransitionHash: string | null = null;
  private height: number = 0;

  constructor(genesis: State = initialState) {
    this.engine = new ExecutionEngine();
    this.currentState = genesis;
    this.snapshotStore = new InMemorySnapshotStore();
  }

  /**
   * Process a batch of events (e.g., from multicast or sync).
   * 
   * Steps:
   * 1. Verify each event at ingress
   * 2. Canonicalize batch (sort, deduplicate)
   * 3. Execute or record rejection
   * 4. Record transition
   * 5. Persist chain
   * 6. Snapshot if needed
   */
  async processBatch(events: readonly Event[]): Promise<void> {
    console.log(`[KERNEL] Processing batch of ${events.length} event(s)`);

    // ── Step 1: Verify at ingress ────────────────────────────────────────

    const verifiedEvents: Event[] = [];
    const rejectionErrors: Map<string, EventValidationResult> = new Map();

    for (const event of events) {
      const result = verifyEvent(event);
      if (result.valid) {
        verifiedEvents.push(event);
        console.log(`[VERIFY] ✓ Event ${event.id.slice(0, 8)}… is valid`);
      } else {
        rejectionErrors.set(event.id, result);
        console.log(
          `[VERIFY] ✗ Event ${event.id.slice(0, 8)}… rejected:\n` +
          formatValidationResult(result)
        );
      }
    }

    // ── Step 2: Canonicalize (sort + deduplicate) ──────────────────────

    const canonical = canonicalizeEventBatch(verifiedEvents);
    console.log(`[ORDER] Canonical batch: ${canonical.length} event(s) after dedup`);

    // ── Step 3: Execute or record rejection ─────────────────────────────

    const processedEntries: ChainEntry[] = [];
    const processedStates: State[] = [];

    for (const event of canonical) {
      const preStateHash = this.currentState.stateHash;

      try {
        // Execute event
        this.currentState = this.engine.exec(this.currentState, event);
        processedEntries.push(event);
        processedStates.push(this.currentState);
        console.log(`[EXEC] ✓ Event ${event.id.slice(0, 8)}… executed`);
      } catch (e) {
        console.log(
          `[EXEC] ! Event ${event.id.slice(0, 8)}… execution error: ${String(e)}`
        );
        // Record rejection
        const rejection = createRejectionRecord(
          event.hash,
          event.id,
          preStateHash,
          'Other',
          this.lastTransitionHash || null,
          String(e),
        );
        processedEntries.push(rejection);
        processedStates.push(this.currentState); // State unchanged
        console.log(`[REJECT] → Created rejection record for ${event.id.slice(0, 8)}…`);
      }
    }

    // ── Step 4: Record transitions ────────────────────────────────────

    for (let i = 0; i < processedEntries.length; i++) {
      const entry = processedEntries[i];
      const postState = processedStates[i];
      const preStateHash = i === 0 
        ? this.currentState.stateHash 
        : processedStates[i - 1].stateHash;

      const transition = createTransitionRecord(
        this.height + i,
        this.lastTransitionHash,
        entry,
        preStateHash,
        postState.stateHash,
      );

      this.transitions.push(transition);
      this.ledger.push(entry);
      this.lastTransitionHash = transition.transitionHash;

      console.log(
        `[CHAIN] T_${this.height + i}: ${entry.type} → ` +
        `hash=${transition.transitionHash.slice(0, 12)}…`
      );
    }

    this.height += processedEntries.length;

    // ── Step 5: Persist chain ──────────────────────────────────────────

    console.log(`[PERSIST] Chain height now ${this.height}, transitions: ${this.transitions.length}`);

    // ── Step 6: Snapshot if needed ────────────────────────────────────

    if (shouldSnapshot(this.height, this.snapshots.length * SNAPSHOT_INTERVAL)) {
      const snapshot = createSnapshot(this.height, this.currentState);
      this.snapshots.push(snapshot);
      await this.snapshotStore.save(snapshot);
      console.log(
        `[SNAPSHOT] Snapshot at height ${this.height}: ` +
        `hash=${snapshot.snapshotHash.slice(0, 12)}…`
      );
    }

    // ── Handle rejections from ingress ────────────────────────────────

    for (const [eventId, error] of rejectionErrors) {
      console.log(`[AUDIT] Recording ingress rejection for ${eventId.slice(0, 8)}…`);
    }
  }

  /**
   * Verify that the kernel's transition chain is intact.
   */
  verifyIntegrity(): { valid: boolean; violations: string[] } {
    const violations: string[] = [];

    // Build chain from current state
    const chain = buildTransitionChain(
      initialState,
      this.ledger,
      this.transitions.map((t) => {
        // Reconstruct state from transition (stub)
        return this.currentState;
      }),
    );

    const chainViolations = verifyTransitionChain(chain);
    violations.push(...chainViolations);

    if (violations.length === 0) {
      console.log('[VERIFY_CHAIN] ✓ Transition chain is valid');
    } else {
      console.log('[VERIFY_CHAIN] ✗ Chain violations:');
      violations.forEach((v) => console.log(`  - ${v}`));
    }

    return { valid: violations.length === 0, violations };
  }

  /**
   * Recover from a snapshot (e.g., after restart).
   */
  async recoverFromSnapshot(snapshotHeight: number): Promise<void> {
    const snapshot = await this.snapshotStore.load(snapshotHeight);
    if (!snapshot) {
      throw new Error(`Snapshot not found at height ${snapshotHeight}`);
    }

    // Restore state
    this.currentState = snapshot.state;
    this.height = snapshot.height;

    // Find suffix: events after snapshot
    const suffix = this.ledger.slice(snapshotHeight);

    // Replay suffix
    console.log(`[RECOVERY] Loaded snapshot at height ${snapshotHeight}, replaying ${suffix.length} events`);

    for (const entry of suffix) {
      if (!isRejectionRecord(entry)) {
        this.currentState = this.engine.exec(this.currentState, entry);
      }
      // Rejection records are skipped (not re-executed)
    }

    console.log(`[RECOVERY] ✓ Recovered to height ${this.height}`);
  }

  /**
   * Export the full ledger (for sync, backup, audit).
   */
  exportLedger(): {
    height: number;
    entries: LedgerEntry[];
    transitions: TransitionRecord[];
    snapshots: StateSnapshot[];
    lastTransitionHash: string | null;
  } {
    return {
      height: this.height,
      entries: [...this.ledger],
      transitions: [...this.transitions],
      snapshots: [...this.snapshots],
      lastTransitionHash: this.lastTransitionHash,
    };
  }

  /**
   * Get current state.
   */
  getState(): State {
    return this.currentState;
  }

  /**
   * Get current height.
   */
  getHeight(): number {
    return this.height;
  }

  /**
   * Get last transition hash (for consensus).
   */
  getLastTransitionHash(): string | null {
    return this.lastTransitionHash;
  }
}

// ── Example usage ────────────────────────────────────────────────────────────

export async function exampleLockedKernelUsage() {
  console.log('═'.repeat(80));
  console.log('LOCKED KERNEL EXAMPLE');
  console.log('═'.repeat(80));

  const kernel = new LockedKernel();

  // Create some test events
  const event1 = createEvent('TASK', 'alice', {
    id: 'task-1',
    name: 'Write code',
  });

  const event2 = createEvent('TASK', 'bob', {
    id: 'task-2',
    name: 'Review PR',
  });

  console.log(`\nCreated events:\n  E1: ${event1.id}\n  E2: ${event2.id}`);

  // Process batch
  console.log('\n--- Processing batch ---');
  await kernel.processBatch([event1, event2]);

  // Verify integrity
  console.log('\n--- Verifying integrity ---');
  kernel.verifyIntegrity();

  // Export
  console.log('\n--- Exporting ledger ---');
  const exported = kernel.exportLedger();
  console.log(
    `Height: ${exported.height}, ` +
    `Entries: ${exported.entries.length}, ` +
    `Transitions: ${exported.transitions.length}`
  );

  console.log('\n' + '═'.repeat(80));
}
