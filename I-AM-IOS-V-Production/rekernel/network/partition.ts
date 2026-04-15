/**
 * PARTITION HANDLING — Network Splits and Reconciliation
 *
 * A network partition occurs when the validator set splits into two
 * groups that cannot communicate. Each group may independently reach
 * quorum (if both halves exceed 2/3) or stall (if neither does).
 *
 * ═════════════════════════════════════════════════════════════════
 * PARTITION BEHAVIOR RULES
 * ═════════════════════════════════════════════════════════════════
 *
 * Case 1: Both partitions have > 2/3 stake (impossible with honest nodes)
 *   → Both could finalize → Fork detected → fork_resolution.ts applies
 *   → At least 1/3 of validators are Byzantine (by math)
 *   → Slashing is triggered automatically on reunion
 *
 * Case 2: One partition has > 2/3 stake, the other does not
 *   → Majority side: continues finalizing (live)
 *   → Minority side: stalls (cannot reach quorum)
 *   → On reconnection: minority syncs from majority
 *   → No fork needed: minority never finalized anything
 *
 * Case 3: Neither partition has > 2/3 stake
 *   → Both sides stall
 *   → No finality until partition heals
 *   → This is correct: safety > liveness under partition
 *
 * Recovery rule (universal):
 *   On reconnection, the node with lower cumulative finality weight
 *   rolls back to the last common ancestor and re-applies the
 *   canonical chain from fork_resolution.
 *
 * ═════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import { ConsensusCommit } from '../consensus/messages';
import { ValidatorSetSnapshot } from '../consensus/validators';
import { TransitionRecord } from '../core/chain';
import { ForkResolution, ForkBranch, buildForkBranch, resolveFork } from './fork_resolution';

// ─── Partition Types ──────────────────────────────────────────────────────────

export type PartitionStatus =
  | 'CONNECTED'     // Normal operation
  | 'SUSPECTED'     // Peer timeout, not yet confirmed
  | 'PARTITIONED'   // Confirmed: cannot reach quorum peers
  | 'HEALING'       // Reconnection in progress
  | 'HEALED';       // Fully synced after reconnection

/**
 * A partition event: the moment the network split was detected.
 */
export interface PartitionEvent {
  readonly detectedAt:     number;          // Wall clock
  readonly detectedAtHeight: number;        // Kernel height when detected
  readonly unreachableNodes: readonly string[];  // Node IDs we lost contact with
  readonly localStake:     number;          // Our partition's voting power
  readonly totalStake:     number;          // Known total voting power
  readonly hasQuorum:      boolean;         // Can we still finalize?
}

/**
 * A node's view of network connectivity.
 */
export interface NetworkView {
  readonly nodeId:         string;
  readonly peers:          ReadonlyMap<string, PeerState>;
  readonly partitions:     readonly PartitionEvent[];
  readonly status:         PartitionStatus;
  readonly lastHeardAt:    ReadonlyMap<string, number>;  // nodeId → timestamp
}

export interface PeerState {
  readonly nodeId:     string;
  readonly reachable:  boolean;
  readonly lastSeen:   number;
  readonly stake:      number;
  readonly latestHeight: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** If a peer hasn't responded in this many ms, suspect partition. */
export const PEER_TIMEOUT_MS = 10_000;

/** If suspected for this long with no recovery, declare partition. */
export const PARTITION_CONFIRM_MS = 30_000;

// ─── Partition Detection ─────────────────────────────────────────────────────

/**
 * Update peer state based on incoming message.
 * Returns a new NetworkView.
 */
export function recordPeerMessage(
  view:   NetworkView,
  peerId: string,
  peerHeight: number,
  nowMs:  number = Date.now(),
): NetworkView {
  const peerState = view.peers.get(peerId);
  if (!peerState) return view;

  const updated: PeerState = {
    ...peerState,
    reachable: true,
    lastSeen: nowMs,
    latestHeight: Math.max(peerState.latestHeight, peerHeight),
  };

  const newPeers = new Map(view.peers);
  newPeers.set(peerId, updated);

  const newLastHeard = new Map(view.lastHeardAt);
  newLastHeard.set(peerId, nowMs);

  return Object.freeze({
    ...view,
    peers: newPeers,
    lastHeardAt: newLastHeard,
  }) as NetworkView;
}

/**
 * Detect partition by checking peer timeouts.
 * Returns updated view and whether a new partition was detected.
 */
export function detectPartition(
  view:       NetworkView,
  validators: ValidatorSetSnapshot,
  height:     number,
  nowMs:      number = Date.now(),
): { view: NetworkView; partitioned: boolean; event?: PartitionEvent } {
  const timedOut: string[] = [];
  let reachableStake = 0;

  for (const [peerId, peer] of view.peers) {
    const lastSeen = view.lastHeardAt.get(peerId) ?? 0;
    const silent = nowMs - lastSeen;

    if (silent > PARTITION_CONFIRM_MS) {
      timedOut.push(peerId);
    } else {
      const validator = validators.validators.find((v) => v.id === peerId && v.isActive);
      if (validator) {
        reachableStake += validator.stake * Math.max(0, validator.reputation);
      }
    }
  }

  // Include our own stake
  const selfValidator = validators.validators.find(
    (v) => v.id === view.nodeId && v.isActive
  );
  if (selfValidator) {
    reachableStake += selfValidator.stake * Math.max(0, selfValidator.reputation);
  }

  const hasQuorum = reachableStake > validators.quorumThreshold;

  if (timedOut.length === 0) {
    // All peers reachable
    const newView = Object.freeze({
      ...view,
      status: 'CONNECTED' as PartitionStatus,
    }) as NetworkView;
    return { view: newView, partitioned: false };
  }

  const event: PartitionEvent = Object.freeze({
    detectedAt: nowMs,
    detectedAtHeight: height,
    unreachableNodes: Object.freeze(timedOut),
    localStake: reachableStake,
    totalStake: validators.totalVotingPower,
    hasQuorum,
  }) as PartitionEvent;

  const newView = Object.freeze({
    ...view,
    status: hasQuorum ? 'PARTITIONED' : 'PARTITIONED',
    partitions: Object.freeze([...view.partitions, event]),
  }) as NetworkView;

  return { view: newView, partitioned: true, event };
}

// ─── Reconciliation State ─────────────────────────────────────────────────────

/**
 * When a partition heals, the two sides must reconcile.
 * This is the state for that process.
 */
export interface ReconciliationState {
  readonly localNodeId:      string;
  readonly remoteNodeId:     string;
  readonly localHeight:      number;
  readonly remoteHeight:     number;
  readonly commonAncestor?:  CommonAncestor;
  readonly phase:            ReconciliationPhase;
  readonly startedAt:        number;
}

export type ReconciliationPhase =
  | 'FIND_ANCESTOR'   // Searching for last common block
  | 'COMPARE_CHAINS'  // Comparing branches from ancestor
  | 'RESOLVE_FORK'    // Applying fork resolution rule
  | 'SYNC_BLOCKS'     // Downloading missing blocks
  | 'COMPLETE'        // Fully reconciled
  | 'FAILED';         // Irreconcilable (should not happen with valid nodes)

/**
 * The last common block between two diverged chains.
 */
export interface CommonAncestor {
  readonly height:          number;
  readonly blockHash:       string;
  readonly transitionHash:  string;
}

/**
 * Begin reconciliation with a newly reconnected peer.
 */
export function beginReconciliation(
  localNodeId:  string,
  remoteNodeId: string,
  localHeight:  number,
  remoteHeight: number,
): ReconciliationState {
  return Object.freeze({
    localNodeId,
    remoteNodeId,
    localHeight,
    remoteHeight,
    phase: 'FIND_ANCESTOR',
    startedAt: Date.now(),
  }) as ReconciliationState;
}

/**
 * Record the found common ancestor.
 */
export function recordCommonAncestor(
  state:    ReconciliationState,
  ancestor: CommonAncestor,
): ReconciliationState {
  return Object.freeze({
    ...state,
    commonAncestor: ancestor,
    phase: 'COMPARE_CHAINS',
  }) as ReconciliationState;
}

/**
 * Apply fork resolution and determine which chain to follow.
 *
 * This is the moment the partition heals:
 * - If local chain wins: remote node rolls back and syncs forward
 * - If remote chain wins: we roll back and sync from remote
 * - No fork (one side never finalized): the finalizing side is canonical
 */
export function resolvePartitionFork(
  state:          ReconciliationState,
  localBranch:    ForkBranch,
  remoteBranch:   ForkBranch,
  validators:     ValidatorSetSnapshot,
): { reconciliation: ReconciliationState; resolution: ForkResolution } {
  if (!state.commonAncestor) {
    throw new Error('Cannot resolve fork without common ancestor');
  }

  const fork = {
    height:      state.commonAncestor.height + 1,  // Fork begins after ancestor
    chainA:      localBranch,
    chainB:      remoteBranch,
    detectedAt:  Date.now(),
  };

  const resolution = resolveFork(fork);

  const newState = Object.freeze({
    ...state,
    phase: 'SYNC_BLOCKS',
  }) as ReconciliationState;

  return { reconciliation: newState, resolution };
}

/**
 * Mark reconciliation complete.
 */
export function completeReconciliation(
  state: ReconciliationState,
): ReconciliationState {
  return Object.freeze({
    ...state,
    phase: 'COMPLETE',
  }) as ReconciliationState;
}

// ─── Rollback Instruction ─────────────────────────────────────────────────────

/**
 * What a losing node must do to sync back to canonical chain.
 *
 * The rollback instruction tells a node:
 *   1. Which height to roll back to (the common ancestor)
 *   2. Which canonical chain to replay from there
 *   3. The proof that this is correct (fork resolution proof)
 */
export interface RollbackInstruction {
  readonly rollbackToHeight:   number;
  readonly rollbackToHash:     string;
  readonly applyFromHeight:    number;
  readonly canonicalTip:       string;
  readonly proofHash:          string;   // Links to ForkResolution.proof
}

/**
 * Build a rollback instruction for the losing node.
 */
export function buildRollbackInstruction(
  ancestor:    CommonAncestor,
  resolution:  ForkResolution,
): RollbackInstruction {
  return Object.freeze({
    rollbackToHeight:  ancestor.height,
    rollbackToHash:    ancestor.blockHash,
    applyFromHeight:   ancestor.height + 1,
    canonicalTip:      resolution.winningHash,
    proofHash:         resolution.proof.proofHash,
  }) as RollbackInstruction;
}
