/**
 * CONSENSUS MESSAGES — Proposals, Votes, Commits
 *
 * Three-phase protocol (simplified PBFT):
 *
 * Phase 1 (PROPOSE):
 *   - Leader proposes a block (events + transitions)
 *   - Includes a proof hash (state commitment)
 *   - All nodes gossip their proposal votes
 *
 * Phase 2 (PREVOTE):
 *   - If 2/3 + 1 votes on proposal, enter prevote phase
 *   - Nodes sign prevote (tentative agreement)
 *
 * Phase 3 (PRECOMMIT):
 *   - If 2/3 + 1 prevotes, enter precommit phase
 *   - Nodes sign precommit (commitment to finality)
 *
 * Finality:
 *   - Block is final when 2/3 + 1 validators precommit
 *   - Cannot be reverted (slashing prevents fork)
 *
 * Liveness:
 *   - If <1/3 nodes are malicious, protocol makes progress
 *   - Leader rotation after timeout (round-robin)
 *   - View change (new leader) if stuck
 */

import crypto from 'crypto';

export type ConsensusPhase = 'PROPOSE' | 'PREVOTE' | 'PRECOMMIT';

/**
 * A block: the unit of consensus.
 * Contains a batch of events to be committed.
 */
export interface ConsensusBlock {
  readonly height:              number;
  readonly round:               number;              // For leader rotation
  readonly leaderId:            string;
  readonly transitionHash:      string;              // Hash of last transition
  readonly proposedStateHash:   string;              // State after executing events
  readonly timestamp:           number;
  readonly blockHash:           string;              // Self-hash
  readonly signature:           string;              // Leader's signature
}

/**
 * Compute block hash.
 */
export function hashBlock(block: Omit<ConsensusBlock, 'blockHash' | 'signature'>): string {
  const data = JSON.stringify({
    height: block.height,
    round: block.round,
    leaderId: block.leaderId,
    transitionHash: block.transitionHash,
    proposedStateHash: block.proposedStateHash,
    timestamp: block.timestamp,
  });
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Sign a block with a private key.
 */
export function signBlock(block: Omit<ConsensusBlock, 'blockHash' | 'signature'>, privateKey: string): string {
  const hash = hashBlock(block);
  return crypto.createHmac('sha256', privateKey).update(hash, 'utf8').digest('hex');
}

/**
 * Verify a block signature.
 */
export function verifyBlockSignature(block: ConsensusBlock, publicKey: string): boolean {
  const expected = crypto.createHmac('sha256', publicKey).update(block.blockHash, 'utf8').digest('hex');
  return expected === block.signature;
}

/**
 * A vote on a block.
 */
export interface ConsensusVote {
  readonly phase:               ConsensusPhase;
  readonly height:              number;
  readonly round:               number;
  readonly blockHash:           string;
  readonly validatorId:         string;
  readonly timestamp:           number;
  readonly voteHash:            string;
  readonly signature:           string;
}

/**
 * Compute vote hash.
 */
export function hashVote(vote: Omit<ConsensusVote, 'voteHash' | 'signature'>): string {
  const data = JSON.stringify({
    phase: vote.phase,
    height: vote.height,
    round: vote.round,
    blockHash: vote.blockHash,
    validatorId: vote.validatorId,
    timestamp: vote.timestamp,
  });
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Sign a vote with a validator's private key.
 */
export function signVote(vote: Omit<ConsensusVote, 'voteHash' | 'signature'>, privateKey: string): string {
  const hash = hashVote(vote);
  return crypto.createHmac('sha256', privateKey).update(hash, 'utf8').digest('hex');
}

/**
 * Verify a vote signature.
 */
export function verifyVoteSignature(vote: ConsensusVote, publicKey: string): boolean {
  const expected = crypto.createHmac('sha256', publicKey).update(vote.voteHash, 'utf8').digest('hex');
  return expected === vote.signature;
}

/**
 * A commit: proof that a block is final.
 * Includes 2/3 + 1 precommit signatures.
 */
export interface ConsensusCommit {
  readonly height:              number;
  readonly blockHash:           string;
  readonly round:               number;
  readonly precommits:          readonly ConsensusVote[];  // 2/3 + 1 precommits
  readonly commitHash:          string;                     // Self-hash
}

/**
 * Compute commit hash (deterministic over votes).
 */
export function hashCommit(commit: Omit<ConsensusCommit, 'commitHash'>): string {
  const sorted = [...commit.precommits]
    .sort((a, b) => a.validatorId.localeCompare(b.validatorId));
  
  const data = JSON.stringify({
    height: commit.height,
    blockHash: commit.blockHash,
    round: commit.round,
    precommits: sorted.map((v) => ({
      validatorId: v.validatorId,
      voteHash: v.voteHash,
    })),
  });
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Create a commit (requires 2/3 + 1 precommit votes).
 */
export function createCommit(
  height: number,
  blockHash: string,
  round: number,
  precommits: readonly ConsensusVote[],
): ConsensusCommit {
  const commitHash = hashCommit({
    height,
    blockHash,
    round,
    precommits,
  });

  return Object.freeze({
    height,
    blockHash,
    round,
    precommits: Object.freeze([...precommits]),
    commitHash,
  }) as ConsensusCommit;
}

/**
 * Consensus protocol state for a node at a given height.
 */
export interface ConsensusRound {
  readonly height:              number;
  readonly round:               number;
  readonly phase:               ConsensusPhase;
  readonly proposedBlock?:      ConsensusBlock;
  readonly proposeVotes:        Map<string, ConsensusVote>;    // validatorId → vote
  readonly prevoteVotes:        Map<string, ConsensusVote>;
  readonly precommitVotes:      Map<string, ConsensusVote>;
  readonly commit?:             ConsensusCommit;
  readonly timestamp:           number;
}

/**
 * Initialize a new round.
 */
export function initializeRound(
  height: number,
  round: number,
): ConsensusRound {
  return Object.freeze({
    height,
    round,
    phase: 'PROPOSE',
    proposeVotes: new Map(),
    prevoteVotes: new Map(),
    precommitVotes: new Map(),
    timestamp: Date.now(),
  }) as ConsensusRound;
}

/**
 * Record a vote in a round.
 * Returns a new round if vote is processed.
 */
export function recordVote(
  round: ConsensusRound,
  vote: ConsensusVote,
): ConsensusRound {
  // Only accept votes for this height and round
  if (vote.height !== round.height || vote.round !== round.round) {
    return round;
  }

  const mapName = vote.phase === 'PROPOSE' ? 'proposeVotes'
                : vote.phase === 'PREVOTE' ? 'prevoteVotes'
                : 'precommitVotes';

  const map = new Map(round[mapName as keyof ConsensusRound] as any);
  map.set(vote.validatorId, vote);

  return Object.freeze({
    ...round,
    [mapName]: map,
  }) as ConsensusRound;
}

/**
 * Get all votes for a block in a round (across all phases).
 */
export function getVotesForBlock(
  round: ConsensusRound,
  blockHash: string,
): ConsensusVote[] {
  const votes: ConsensusVote[] = [];

  for (const vote of round.proposeVotes.values()) {
    if (vote.blockHash === blockHash) votes.push(vote);
  }
  for (const vote of round.prevoteVotes.values()) {
    if (vote.blockHash === blockHash) votes.push(vote);
  }
  for (const vote of round.precommitVotes.values()) {
    if (vote.blockHash === blockHash) votes.push(vote);
  }

  return votes;
}

/**
 * Check if a block has quorum for a phase.
 */
export function hasQuorumForPhase(
  round: ConsensusRound,
  blockHash: string,
  phase: ConsensusPhase,
  quorumThreshold: number,
): boolean {
  const votes = phase === 'PROPOSE' ? round.proposeVotes
              : phase === 'PREVOTE' ? round.prevoteVotes
              : round.precommitVotes;

  let power = 0;
  for (const vote of votes.values()) {
    if (vote.blockHash === blockHash) {
      power++;  // Simplified: count votes, not stake
    }
  }

  return power >= quorumThreshold;
}

/**
 * Timeout for each phase.
 * If phase doesn't reach quorum, move to next round (different leader).
 */
export const PHASE_TIMEOUTS = {
  PROPOSE:   10_000,  // 10 seconds for leader to propose
  PREVOTE:   5_000,   // 5 seconds for 2/3 prevotes
  PRECOMMIT: 5_000,   // 5 seconds for 2/3 precommits
};

/**
 * Timeout check: if phase duration exceeds threshold, move to next round.
 */
export function shouldTimeoutPhase(
  round: ConsensusRound,
  phase: ConsensusPhase,
  nowMs: number = Date.now(),
): boolean {
  const elapsed = nowMs - round.timestamp;
  const timeout = PHASE_TIMEOUTS[phase as keyof typeof PHASE_TIMEOUTS] || 10_000;
  return elapsed > timeout;
}
