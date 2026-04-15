/**
 * TRANSITION CHAIN — Persistence & Auditability
 *
 * A transition chain is a cryptographically-linked sequence of (S, E, T) tuples.
 *
 * Instead of storing only the current state S_n, we persist:
 *   - S_0, E_1, T_1
 *   - S_1, E_2, T_2
 *   - ...
 *   - S_n, E_{n+1}, T_{n+1}
 *
 * Where:
 *   S_i    = state after applying first i events
 *   E_i    = i-th event
 *   T_i    = transition proof: hash(T_{i-1}, E_i, S_i)
 *
 * Benefits:
 *   - Replay: given genesis + chain, recompute every state
 *   - Proof: show divergence explicitly (conflicting T hashes)
 *   - Audit: full history is immutable and verifiable
 */

import { Event } from '../events/event';
import { State } from '../state/state';
import { hashTransition } from '../hash';
import { RejectionRecord } from './rejections';

export type ChainEntry = Event | RejectionRecord;

/**
 * A single transition record in the chain.
 */
export interface TransitionRecord {
  readonly index:              number;        // Position in chain (0-indexed)
  readonly prevTransitionHash: string | null; // Hash of T_{i-1} (null for T_0)
  readonly eventHash:          string;        // hash(E_i)
  readonly eventId:            string;        // id(E_i)
  readonly preStateHash:       string;        // hash(S_{i-1})
  readonly postStateHash:      string;        // hash(S_i)
  readonly transitionHash:     string;        // hash(T_i) — computed from above
}

/**
 * Compute a transition record.
 */
export function createTransitionRecord(
  index: number,
  prevTransitionHash: string | null,
  event: ChainEntry,
  preStateHash: string,
  postStateHash: string,
): TransitionRecord {
  const transitionHash = hashTransition(prevTransitionHash, event.hash, postStateHash);

  return Object.freeze({
    index,
    prevTransitionHash,
    eventHash: event.hash,
    eventId: event.id,
    preStateHash,
    postStateHash,
    transitionHash,
  }) as TransitionRecord;
}

/**
 * Verify a single transition record.
 * Checks:
 *   1. Transition hash is correctly computed
 *   2. Causal chain is intact (prevTransitionHash matches previous)
 */
export function verifyTransitionRecord(
  record: TransitionRecord,
  prevTransitionHash: string | null = null,
): string[] {
  const violations: string[] = [];

  // Check causal chain
  if (record.prevTransitionHash !== prevTransitionHash) {
    violations.push(
      `Causal chain broken at index ${record.index}: ` +
      `prevTransitionHash=${record.prevTransitionHash?.slice(0, 12)}… ` +
      `expected=${prevTransitionHash?.slice(0, 12)}…`
    );
  }

  // Recompute transition hash
  const expectedHash = hashTransition(
    record.prevTransitionHash,
    record.eventHash,
    record.postStateHash,
  );

  if (record.transitionHash !== expectedHash) {
    violations.push(
      `Transition hash mismatch at index ${record.index}: ` +
      `stored=${record.transitionHash.slice(0, 12)}… ` +
      `expected=${expectedHash.slice(0, 12)}…`
    );
  }

  return violations;
}

/**
 * A transition chain stores the full history.
 * Used for auditing, recovery, and proof generation.
 */
export interface TransitionChain {
  readonly genesis:       State;                    // Initial state
  readonly entries:       readonly ChainEntry[];    // All events + rejections, in order
  readonly transitions:   readonly TransitionRecord[]; // Transition proofs
  readonly currentState:  State;                    // Latest state (cached)
}

/**
 * Build a transition chain from a sequence of entries and states.
 */
export function buildTransitionChain(
  genesis: State,
  entries: readonly ChainEntry[],
  states: readonly State[],
): TransitionChain {
  if (entries.length !== states.length) {
    throw new Error(
      `Entry-state mismatch: ${entries.length} entries but ${states.length} states`
    );
  }

  const transitions: TransitionRecord[] = [];
  let prevTransitionHash: string | null = null;

  for (let i = 0; i < entries.length; i++) {
    const preHash = i === 0 ? genesis.stateHash : states[i - 1].stateHash;
    const postHash = states[i].stateHash;

    const rec = createTransitionRecord(
      i,
      prevTransitionHash,
      entries[i],
      preHash,
      postHash,
    );

    transitions.push(rec);
    prevTransitionHash = rec.transitionHash;
  }

  const currentState = entries.length > 0
    ? states[states.length - 1]
    : genesis;

  return Object.freeze({
    genesis,
    entries: Object.freeze([...entries]),
    transitions: Object.freeze(transitions),
    currentState,
  }) as TransitionChain;
}

/**
 * Verify the entire transition chain.
 * Checks that all transitions are linked correctly.
 */
export function verifyTransitionChain(chain: TransitionChain): string[] {
  const violations: string[] = [];

  // Verify genesis state has a valid hash
  if (!chain.genesis.stateHash) {
    violations.push('Genesis state lacks stateHash');
  }

  // Verify each transition
  let prevHash: string | null = null;
  for (const transition of chain.transitions) {
    const recViolations = verifyTransitionRecord(transition, prevHash);
    violations.push(...recViolations);
    prevHash = transition.transitionHash;
  }

  return violations;
}

/**
 * Replay the transition chain from genesis to verify correctness.
 * Requires access to an execution engine.
 */
export async function replayTransitionChain(
  chain: TransitionChain,
  execFn: (state: State, entry: ChainEntry) => State,
): Promise<{ finalState: State; violations: string[] }> {
  const violations = verifyTransitionChain(chain);
  if (violations.length > 0) {
    return { finalState: chain.genesis, violations };
  }

  let state = chain.genesis;

  for (let i = 0; i < chain.entries.length; i++) {
    const entry = chain.entries[i];
    const expectedPostHash = chain.transitions[i].postStateHash;

    try {
      state = execFn(state, entry);
    } catch (e) {
      violations.push(`Execution failed at index ${i}: ${String(e)}`);
      break;
    }

    if (state.stateHash !== expectedPostHash) {
      violations.push(
        `State hash mismatch at index ${i}: ` +
        `computed=${state.stateHash.slice(0, 12)}… ` +
        `expected=${expectedPostHash.slice(0, 12)}…`
      );
    }
  }

  return { finalState: state, violations };
}

/**
 * Detect divergence: if two chains have different transitions at the same index,
 * they've forked.
 */
export function detectChainDivergence(
  chain1: TransitionChain,
  chain2: TransitionChain,
): { hasDiverged: boolean; divergeIndex?: number } {
  const minLen = Math.min(chain1.transitions.length, chain2.transitions.length);

  for (let i = 0; i < minLen; i++) {
    if (chain1.transitions[i].transitionHash !== chain2.transitions[i].transitionHash) {
      return { hasDiverged: true, divergeIndex: i };
    }
  }

  return { hasDiverged: false };
}

/**
 * Snapshot-aware transition chain: include pointers to snapshots for faster recovery.
 */
export interface TransitionChainWithSnapshots extends TransitionChain {
  readonly snapshots: Map<number, { snapshotHash: string }>;  // index → snapshot
}

/**
 * Storage interface for transition chains.
 */
export interface TransitionChainStore {
  append(transition: TransitionRecord, entry: ChainEntry): Promise<void>;
  getLatestTransition(): Promise<TransitionRecord | null>;
  getChain(fromIndex: number, toIndex: number): Promise<TransitionChain | null>;
}

/**
 * In-memory transition chain store (for testing).
 */
export class InMemoryTransitionChainStore implements TransitionChainStore {
  private transitions: TransitionRecord[] = [];
  private entries: ChainEntry[] = [];

  async append(transition: TransitionRecord, entry: ChainEntry): Promise<void> {
    this.transitions.push(transition);
    this.entries.push(entry);
  }

  async getLatestTransition(): Promise<TransitionRecord | null> {
    return this.transitions[this.transitions.length - 1] || null;
  }

  async getChain(fromIndex: number, toIndex: number): Promise<TransitionChain | null> {
    if (fromIndex < 0 || toIndex >= this.transitions.length) {
      return null;
    }

    // Reconstruct genesis (stub)
    const genesis: State = {
      memory: {},
      tasks: {},
      files: {},
      ledger: [],
      budget: 1000,
      stateHash: '',
    };

    const entries = this.entries.slice(fromIndex, toIndex + 1);
    const transitions = this.transitions.slice(fromIndex, toIndex + 1);

    return {
      genesis,
      entries,
      transitions,
      currentState: genesis,
    };
  }
}
