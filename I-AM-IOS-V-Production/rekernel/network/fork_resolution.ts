/**
 * FORK RESOLUTION — The Missing Invariant
 *
 * The deepest question in distributed systems:
 *
 *   "When two valid histories diverge,
 *    which one becomes canonical?"
 *
 * This is NOT the same as "which is valid."
 * Both may be valid. Only one can become global history.
 *
 * ═════════════════════════════════════════════════════════════════
 * THE FORK RESOLUTION RULE
 * ═════════════════════════════════════════════════════════════════
 *
 * A fork occurs when two nodes have different transition chains
 * at the same height that are both locally valid.
 *
 * Cause:    Network partition splits validator quorums
 * Symptom:  Two canonical sets at same height, different hashes
 * Problem:  Kernel is deterministic but input set diverged
 * Solution: One globally agreed selection rule
 *
 * THE RULE (single invariant):
 *
 *   The canonical chain is the one with the greatest
 *   cumulative finality weight at the fork point.
 *
 * Where:
 *   finality_weight(block) = sum of voting_power of validators
 *                            who precommitted to that block
 *
 * Secondary tiebreak (both chains have equal weight):
 *   Lower block hash wins (deterministic, no coordinator needed)
 *
 * Why this works:
 *   - Finality weight > 2/3 total → quorum proved
 *   - Equal finality weight → one partition had more honest stake
 *   - Hash tiebreak → no subjective choice, globally computable
 *
 * ═════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import { ConsensusCommit, ConsensusBlock } from '../consensus/messages';
import { ValidatorSetSnapshot } from '../consensus/validators';
import { TransitionRecord } from '../core/chain';

// ─── Core Types ──────────────────────────────────────────────────────────────

/**
 * A fork: two conflicting chains at the same height.
 */
export interface Fork {
  readonly height:      number;
  readonly chainA:      ForkBranch;
  readonly chainB:      ForkBranch;
  readonly detectedAt:  number;        // Wall clock when detected
}

/**
 * A branch in a fork.
 */
export interface ForkBranch {
  readonly blockHash:       string;
  readonly transitionHash:  string;    // Kernel chain tip at this height
  readonly commits:         readonly ConsensusCommit[];  // Finality proofs
  readonly finalityWeight:  number;    // Sum of precommit stake
}

/**
 * The resolution decision.
 */
export interface ForkResolution {
  readonly winningBranch:   'A' | 'B';
  readonly winningHash:     string;
  readonly losingHash:      string;
  readonly method:          'finality_weight' | 'hash_tiebreak';
  readonly weightA:         number;
  readonly weightB:         number;
  readonly proof:           ForkProof;
}

/**
 * Cryptographic proof that resolution was correct.
 * Any node can verify this independently.
 */
export interface ForkProof {
  readonly height:          number;
  readonly winnerHash:      string;
  readonly loserHash:       string;
  readonly winnerWeight:    number;
  readonly loserWeight:     number;
  readonly proofHash:       string;   // Hash of this proof (tamper-evident)
}

// ─── Finality Weight Calculation ─────────────────────────────────────────────

/**
 * Compute the finality weight of a branch.
 *
 * Finality weight = total voting power of validators who precommitted.
 * This is the core security metric — it tells you how much stake
 * was locked behind this branch becoming canonical.
 */
export function computeFinalityWeight(
  commits:    readonly ConsensusCommit[],
  validators: ValidatorSetSnapshot,
): number {
  const counted = new Set<string>();
  let totalWeight = 0;

  for (const commit of commits) {
    for (const precommit of commit.precommits) {
      if (counted.has(precommit.validatorId)) continue;
      counted.add(precommit.validatorId);

      const validator = validators.validators.find(
        (v) => v.id === precommit.validatorId && v.isActive
      );
      if (validator) {
        // Weight = stake × reputation
        totalWeight += validator.stake * Math.max(0, Math.min(1, validator.reputation));
      }
    }
  }

  return totalWeight;
}

/**
 * Build a ForkBranch from a block and its commits.
 */
export function buildForkBranch(
  block:      ConsensusBlock,
  transition: TransitionRecord,
  commits:    readonly ConsensusCommit[],
  validators: ValidatorSetSnapshot,
): ForkBranch {
  const finalityWeight = computeFinalityWeight(commits, validators);

  return Object.freeze({
    blockHash:      block.blockHash,
    transitionHash: transition.transitionHash,
    commits:        Object.freeze([...commits]),
    finalityWeight,
  }) as ForkBranch;
}

// ─── The Resolution Rule ─────────────────────────────────────────────────────

/**
 * Resolve a fork.
 *
 * This is the single rule that determines global truth
 * when local rules produce incompatible histories.
 *
 * Algorithm:
 *   1. Compare finality weights (cumulative precommit stake)
 *   2. Higher weight wins — more stake committed = more finality
 *   3. If equal: lower block hash wins (deterministic tiebreak)
 *
 * Properties:
 *   - Deterministic: any node reaches the same decision
 *   - Coordinator-free: no leader needed
 *   - Cryptographically verifiable: produces a proof
 *   - Safe: winner had more stake committed → more slashing cost to overturn
 */
export function resolveFork(
  fork: Fork,
): ForkResolution {
  const { chainA, chainB } = fork;

  let winningBranch: 'A' | 'B';
  let method: 'finality_weight' | 'hash_tiebreak';

  if (chainA.finalityWeight !== chainB.finalityWeight) {
    // Primary: higher finality weight wins
    winningBranch = chainA.finalityWeight > chainB.finalityWeight ? 'A' : 'B';
    method = 'finality_weight';
  } else {
    // Tiebreak: lower block hash wins (lexicographic)
    winningBranch = chainA.blockHash < chainB.blockHash ? 'A' : 'B';
    method = 'hash_tiebreak';
  }

  const winner = winningBranch === 'A' ? chainA : chainB;
  const loser  = winningBranch === 'A' ? chainB : chainA;

  const proof = buildForkProof(fork.height, winner, loser);

  return Object.freeze({
    winningBranch,
    winningHash:  winner.blockHash,
    losingHash:   loser.blockHash,
    method,
    weightA:      chainA.finalityWeight,
    weightB:      chainB.finalityWeight,
    proof,
  }) as ForkResolution;
}

/**
 * Build a verifiable proof of fork resolution.
 */
function buildForkProof(
  height:  number,
  winner:  ForkBranch,
  loser:   ForkBranch,
): ForkProof {
  const proofData = JSON.stringify({
    height,
    winnerHash:   winner.blockHash,
    loserHash:    loser.blockHash,
    winnerWeight: winner.finalityWeight,
    loserWeight:  loser.finalityWeight,
  });

  const proofHash = crypto
    .createHash('sha256')
    .update(proofData, 'utf8')
    .digest('hex');

  return Object.freeze({
    height,
    winnerHash:   winner.blockHash,
    loserHash:    loser.blockHash,
    winnerWeight: winner.finalityWeight,
    loserWeight:  loser.finalityWeight,
    proofHash,
  }) as ForkProof;
}

/**
 * Verify a fork resolution proof independently.
 * Any node can run this to confirm the resolution was applied correctly.
 */
export function verifyForkResolution(
  resolution: ForkResolution,
  fork:       Fork,
  validators: ValidatorSetSnapshot,
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  // Recompute weights
  const computedWeightA = computeFinalityWeight(fork.chainA.commits, validators);
  const computedWeightB = computeFinalityWeight(fork.chainB.commits, validators);

  if (Math.abs(computedWeightA - resolution.weightA) > 0.001) {
    violations.push(
      `Weight A mismatch: computed=${computedWeightA.toFixed(2)} stored=${resolution.weightA.toFixed(2)}`
    );
  }
  if (Math.abs(computedWeightB - resolution.weightB) > 0.001) {
    violations.push(
      `Weight B mismatch: computed=${computedWeightB.toFixed(2)} stored=${resolution.weightB.toFixed(2)}`
    );
  }

  // Recompute proof hash
  const proofData = JSON.stringify({
    height:       resolution.proof.height,
    winnerHash:   resolution.proof.winnerHash,
    loserHash:    resolution.proof.loserHash,
    winnerWeight: resolution.proof.winnerWeight,
    loserWeight:  resolution.proof.loserWeight,
  });
  const expectedProofHash = crypto
    .createHash('sha256')
    .update(proofData, 'utf8')
    .digest('hex');

  if (resolution.proof.proofHash !== expectedProofHash) {
    violations.push('Fork proof hash is invalid (tampered)');
  }

  // Verify the winner is actually the correct choice
  const expectedWinner = computedWeightA !== computedWeightB
    ? (computedWeightA > computedWeightB ? fork.chainA.blockHash : fork.chainB.blockHash)
    : (fork.chainA.blockHash < fork.chainB.blockHash ? fork.chainA.blockHash : fork.chainB.blockHash);

  if (resolution.winningHash !== expectedWinner) {
    violations.push(
      `Wrong winner: resolution says ${resolution.winningHash.slice(0, 12)}… ` +
      `but rule computes ${expectedWinner.slice(0, 12)}…`
    );
  }

  return { valid: violations.length === 0, violations };
}
