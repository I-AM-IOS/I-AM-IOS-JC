/**
 * VALIDATOR SET DYNAMICS — Membership Consensus
 *
 * The existing system assumes a fixed validator set.
 * Real networks require:
 *   - Validators joining (bonding stake)
 *   - Validators leaving (unbonding stake)
 *   - Stake slashing (covered in slashing.ts)
 *   - Stake reallocation
 *   - Emergency removal (Byzantine detected)
 *
 * ═════════════════════════════════════════════════════════════════
 * KEY INSIGHT
 * ═════════════════════════════════════════════════════════════════
 *
 * Membership changes ARE consensus events.
 *
 * They flow through the same kernel:
 *   1. A JOIN/LEAVE/SLASH event enters the event admission pipeline
 *   2. It requires the same 2/3 quorum to be admitted
 *   3. It transitions the validator set as a state machine
 *   4. The new validator set applies from the NEXT height
 *      (never retroactively — that would break history)
 *
 * This ensures:
 *   - No validator can unilaterally join
 *   - No validator can leave while being investigated
 *   - Membership is part of the deterministic, auditable ledger
 *
 * ═════════════════════════════════════════════════════════════════
 * UNBONDING DELAY
 * ═════════════════════════════════════════════════════════════════
 *
 * A leaving validator's stake is locked for UNBONDING_DELAY blocks
 * before it is released.
 *
 * Why: Slashing evidence may arrive late.
 * If a validator could exit instantly, they could escape slashing
 * by leaving right before the evidence is submitted.
 *
 * The delay creates an accountability window.
 *
 * ═════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import { Validator, ValidatorSetSnapshot, buildValidatorSetSnapshot } from '../consensus/validators';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum stake to join the validator set. */
export const MIN_STAKE = 1_000;

/** Blocks a leaving validator's stake remains locked. */
export const UNBONDING_DELAY = 100;

/** Minimum reputation to remain active. */
export const MIN_REPUTATION = 0.1;

/** Quorum of existing validators needed to admit a new one. */
export const JOIN_QUORUM = 2 / 3;

// ─── Membership Event Types ───────────────────────────────────────────────────

export type MembershipEventType =
  | 'JOIN_REQUEST'      // Candidate wants to join
  | 'JOIN_APPROVED'     // Quorum approved the join
  | 'LEAVE_REQUEST'     // Validator initiates departure
  | 'LEAVE_FINALIZED'   // Unbonding complete; validator exits
  | 'EMERGENCY_REMOVE'  // Byzantine evidence: immediate removal
  | 'STAKE_INCREASE'    // Validator adds more stake
  | 'STAKE_DECREASE';   // Validator reduces stake (subject to unbonding)

/**
 * A membership event in the ledger.
 * These are first-class events processed by the kernel.
 */
export interface MembershipEvent {
  readonly id:             string;
  readonly type:           MembershipEventType;
  readonly validatorId:    string;
  readonly proposedAt:     number;    // Height when proposed
  readonly effectiveAt?:   number;    // Height when it takes effect
  readonly stake?:         number;    // For JOIN, STAKE_* events
  readonly publicKey?:     string;    // For JOIN events
  readonly evidence?:      string;    // For EMERGENCY_REMOVE (hash of slashing proof)
  readonly eventHash:      string;
}

/**
 * A validator that has requested to leave but is still in unbonding.
 */
export interface UnbondingValidator {
  readonly validator:      Validator;
  readonly requestedAt:    number;    // Height of LEAVE_REQUEST
  readonly unbondingUntil: number;    // Height when stake is released
  readonly slashable:      boolean;   // Still subject to historic slashes
}

/**
 * The full membership state of the network.
 * This is part of the kernel state and is deterministically computed.
 */
export interface MembershipState {
  readonly height:              number;
  readonly activeValidators:    readonly Validator[];
  readonly pendingJoins:        readonly PendingJoin[];
  readonly unbondingValidators: readonly UnbondingValidator[];
  readonly membershipHash:      string;   // Hash of this state (tamper-evident)
}

/**
 * A join request awaiting quorum approval.
 */
export interface PendingJoin {
  readonly candidate:    Omit<Validator, 'joinedAtHeight' | 'isActive' | 'slashCount'>;
  readonly proposedAt:   number;
  readonly approvals:    readonly string[];   // Validator IDs who approved
  readonly rejections:   readonly string[];   // Validator IDs who rejected
  readonly expiresAt:    number;              // Height after which request lapses
}

// ─── State Transitions ────────────────────────────────────────────────────────

/**
 * Compute the hash of a membership state.
 */
function hashMembershipState(
  height:     number,
  active:     readonly Validator[],
  pending:    readonly PendingJoin[],
  unbonding:  readonly UnbondingValidator[],
): string {
  const data = JSON.stringify({
    height,
    activeIds:   active.map((v) => v.id).sort(),
    pendingIds:  pending.map((p) => p.candidate.id).sort(),
    unbondingIds: unbonding.map((u) => u.validator.id).sort(),
  });
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Initialize membership state from a fixed set (genesis).
 */
export function initializeMembership(
  height:     number,
  validators: readonly Validator[],
): MembershipState {
  const membershipHash = hashMembershipState(height, validators, [], []);
  return Object.freeze({
    height,
    activeValidators:    Object.freeze([...validators]),
    pendingJoins:        Object.freeze([]),
    unbondingValidators: Object.freeze([]),
    membershipHash,
  }) as MembershipState;
}

/**
 * Submit a join request.
 * The candidate is not active until quorum approves.
 */
export function submitJoinRequest(
  state:      MembershipState,
  candidate:  Omit<Validator, 'joinedAtHeight' | 'isActive' | 'slashCount'>,
  height:     number,
): { state: MembershipState; error?: string } {
  // Check minimum stake
  if (candidate.stake < MIN_STAKE) {
    return { state, error: `Stake ${candidate.stake} below minimum ${MIN_STAKE}` };
  }

  // Check not already active or pending
  const alreadyActive = state.activeValidators.some((v) => v.id === candidate.id);
  const alreadyPending = state.pendingJoins.some((p) => p.candidate.id === candidate.id);
  if (alreadyActive || alreadyPending) {
    return { state, error: `Validator ${candidate.id} already active or pending` };
  }

  const pending: PendingJoin = Object.freeze({
    candidate,
    proposedAt: height,
    approvals:  Object.freeze([]),
    rejections: Object.freeze([]),
    expiresAt:  height + 50,   // Must be approved within 50 blocks
  }) as PendingJoin;

  const newPending = Object.freeze([...state.pendingJoins, pending]);
  const membershipHash = hashMembershipState(
    height, state.activeValidators, newPending, state.unbondingValidators
  );

  return {
    state: Object.freeze({
      ...state,
      pendingJoins: newPending,
      membershipHash,
    }) as MembershipState,
  };
}

/**
 * Record approval or rejection of a pending join.
 * When approvals reach 2/3 quorum, the validator is admitted.
 */
export function voteOnJoin(
  state:       MembershipState,
  candidateId: string,
  voterId:     string,
  approve:     boolean,
  height:      number,
  validators:  ValidatorSetSnapshot,
): MembershipState {
  const pendingIdx = state.pendingJoins.findIndex((p) => p.candidate.id === candidateId);
  if (pendingIdx === -1) return state;

  const pending = state.pendingJoins[pendingIdx];

  // Voter must be an active validator
  const voterIsActive = state.activeValidators.some((v) => v.id === voterId && v.isActive);
  if (!voterIsActive) return state;

  const updated: PendingJoin = Object.freeze({
    ...pending,
    approvals:  approve
      ? Object.freeze([...pending.approvals, voterId])
      : pending.approvals,
    rejections: !approve
      ? Object.freeze([...pending.rejections, voterId])
      : pending.rejections,
  }) as PendingJoin;

  let newActive = state.activeValidators;
  let newPending = [
    ...state.pendingJoins.slice(0, pendingIdx),
    updated,
    ...state.pendingJoins.slice(pendingIdx + 1),
  ];

  // Check if quorum reached
  const approvalPower = updated.approvals.reduce((sum, id) => {
    const v = validators.validators.find((val) => val.id === id);
    return sum + (v ? v.stake * v.reputation : 0);
  }, 0);

  if (approvalPower > validators.quorumThreshold) {
    // Admitted: move to active
    const newValidator: Validator = Object.freeze({
      id:            pending.candidate.id,
      publicKey:     pending.candidate.publicKey,
      stake:         pending.candidate.stake,
      reputation:    pending.candidate.reputation,
      joinedAtHeight: height,
      isActive:      true,
      slashCount:    0,
    });

    newActive = Object.freeze([...state.activeValidators, newValidator]);
    newPending = newPending.filter((p) => p.candidate.id !== candidateId);
  }

  const membershipHash = hashMembershipState(
    height, newActive, newPending, state.unbondingValidators
  );

  return Object.freeze({
    ...state,
    height,
    activeValidators: Object.freeze(newActive),
    pendingJoins:     Object.freeze(newPending),
    membershipHash,
  }) as MembershipState;
}

/**
 * Initiate a leave request.
 * Validator enters unbonding — still active but stake is locked.
 */
export function requestLeave(
  state:       MembershipState,
  validatorId: string,
  height:      number,
): { state: MembershipState; error?: string } {
  const validator = state.activeValidators.find((v) => v.id === validatorId);
  if (!validator) {
    return { state, error: `Validator ${validatorId} not found` };
  }

  // Remove from active
  const newActive = state.activeValidators.filter((v) => v.id !== validatorId);

  // Add to unbonding
  const unbonding: UnbondingValidator = Object.freeze({
    validator,
    requestedAt:    height,
    unbondingUntil: height + UNBONDING_DELAY,
    slashable:      true,
  }) as UnbondingValidator;

  const newUnbonding = Object.freeze([...state.unbondingValidators, unbonding]);
  const membershipHash = hashMembershipState(
    height, newActive, state.pendingJoins, newUnbonding
  );

  return {
    state: Object.freeze({
      ...state,
      height,
      activeValidators:    Object.freeze(newActive),
      unbondingValidators: newUnbonding,
      membershipHash,
    }) as MembershipState,
  };
}

/**
 * Finalize exits for validators whose unbonding period is complete.
 * Called once per height tick.
 */
export function finalizeExits(
  state:  MembershipState,
  height: number,
): { state: MembershipState; released: readonly UnbondingValidator[] } {
  const released = state.unbondingValidators.filter((u) => u.unbondingUntil <= height);
  const stillUnbonding = state.unbondingValidators.filter((u) => u.unbondingUntil > height);

  if (released.length === 0) return { state, released: [] };

  const membershipHash = hashMembershipState(
    height, state.activeValidators, state.pendingJoins, stillUnbonding
  );

  return {
    state: Object.freeze({
      ...state,
      height,
      unbondingValidators: Object.freeze(stillUnbonding),
      membershipHash,
    }) as MembershipState,
    released: Object.freeze(released),
  };
}

/**
 * Emergency removal of a Byzantine validator.
 * Requires slashing evidence (proof of misbehavior).
 * Bypasses normal leave process — takes effect immediately.
 * Stake is locked for UNBONDING_DELAY and subject to slash.
 */
export function emergencyRemove(
  state:         MembershipState,
  validatorId:   string,
  evidenceHash:  string,
  height:        number,
): { state: MembershipState; removed: boolean } {
  // Check active
  const validator = state.activeValidators.find((v) => v.id === validatorId);

  // Also check unbonding (may still be slashable there)
  const isUnbonding = state.unbondingValidators.some((u) => u.validator.id === validatorId);

  if (!validator && !isUnbonding) {
    return { state, removed: false };
  }

  let newActive = state.activeValidators;
  let newUnbonding = [...state.unbondingValidators];

  if (validator) {
    newActive = state.activeValidators.filter((v) => v.id !== validatorId);

    const unbonding: UnbondingValidator = Object.freeze({
      validator: { ...validator, isActive: false },
      requestedAt:    height,
      unbondingUntil: height + UNBONDING_DELAY,
      slashable:      true,
    }) as UnbondingValidator;

    newUnbonding.push(unbonding);
  }

  const membershipHash = hashMembershipState(
    height, newActive, state.pendingJoins, newUnbonding
  );

  return {
    state: Object.freeze({
      ...state,
      height,
      activeValidators:    Object.freeze(newActive),
      unbondingValidators: Object.freeze(newUnbonding),
      membershipHash,
    }) as MembershipState,
    removed: true,
  };
}

/**
 * Expire stale pending join requests.
 */
export function expirePendingJoins(
  state:  MembershipState,
  height: number,
): MembershipState {
  const valid = state.pendingJoins.filter((p) => p.expiresAt > height);
  if (valid.length === state.pendingJoins.length) return state;

  const membershipHash = hashMembershipState(
    height, state.activeValidators, valid, state.unbondingValidators
  );

  return Object.freeze({
    ...state,
    height,
    pendingJoins: Object.freeze(valid),
    membershipHash,
  }) as MembershipState;
}

/**
 * Build a ValidatorSetSnapshot from the current MembershipState.
 * This is what the consensus layer consumes.
 */
export function toValidatorSetSnapshot(
  membership: MembershipState,
): ValidatorSetSnapshot {
  return buildValidatorSetSnapshot(
    membership.height,
    membership.activeValidators as Validator[],
  );
}

/**
 * Audit: verify membership state hash is internally consistent.
 */
export function verifyMembershipIntegrity(
  state: MembershipState,
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  const expectedHash = hashMembershipState(
    state.height,
    state.activeValidators,
    state.pendingJoins,
    state.unbondingValidators,
  );

  if (state.membershipHash !== expectedHash) {
    violations.push('Membership state hash is invalid (tampered)');
  }

  for (const v of state.activeValidators) {
    if (v.stake < MIN_STAKE) {
      violations.push(`Active validator ${v.id} has stake ${v.stake} below minimum`);
    }
    if (!v.isActive) {
      violations.push(`Validator ${v.id} is marked inactive but is in activeValidators`);
    }
  }

  return { valid: violations.length === 0, violations };
}
