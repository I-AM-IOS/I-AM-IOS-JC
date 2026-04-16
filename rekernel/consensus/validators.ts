/**
 * VALIDATOR SET — Stake-Weighted Consensus Authority
 *
 * A validator is a node with voting power weighted by stake.
 * Consensus requires a supermajority (2/3 + 1) of the validator set.
 *
 * Validators:
 *   - Hold stake (economic security deposit)
 *   - Sign consensus messages
 *   - Can be slashed (lose stake) for bad behavior
 *   - Have reputation that affects voting power
 *
 * Rules:
 *   - Voting power = stake × reputation
 *   - Consensus threshold = 2/3 of total power + 1 vote
 *   - Byzantine tolerance: up to 1/3 of validators can be malicious
 */

import crypto from 'crypto';

export interface ValidatorPower {
  validatorId: string;
  stake:       number;          // Economic deposit
  reputation:  number;          // 0 to 1 (affects voting power)
  votingPower: number;          // stake × reputation
}

/**
 * A validator in the set.
 */
export interface Validator {
  readonly id:                 string;
  readonly publicKey:          string;
  readonly stake:              number;
  readonly reputation:         number;  // 0 to 1
  readonly delegatedStake?:    number;  // Optional: stake delegated by others
  readonly joinedAtHeight:     number;
  readonly isActive:           boolean;
  readonly slashCount:         number;  // Times slashed
}

/**
 * Validator set snapshot at a height.
 * Immutable; used to determine consensus rules for that height.
 */
export interface ValidatorSetSnapshot {
  readonly height:             number;
  readonly validators:         readonly Validator[];
  readonly totalVotingPower:   number;
  readonly quorumThreshold:    number;  // Votes needed (>2/3)
  readonly timestamp:          number;
}

/**
 * Calculate voting power for a validator.
 */
export function calculateVotingPower(validator: Validator): number {
  return validator.stake * Math.max(0, Math.min(1, validator.reputation));
}

/**
 * Build a validator set snapshot.
 */
export function buildValidatorSetSnapshot(
  height: number,
  validators: readonly Validator[],
): ValidatorSetSnapshot {
  const totalVotingPower = validators
    .filter((v) => v.isActive)
    .reduce((sum, v) => sum + calculateVotingPower(v), 0);

  // Quorum threshold: >2/3 of total power
  // This ensures Byzantine tolerance: up to 1/3 can be dishonest
  const quorumThreshold = Math.floor(totalVotingPower * 2 / 3) + 1;

  return Object.freeze({
    height,
    validators: Object.freeze([...validators]),
    totalVotingPower,
    quorumThreshold,
    timestamp: Date.now(),
  }) as ValidatorSetSnapshot;
}

/**
 * Check if a validator set is well-formed.
 * Returns violations.
 */
export function validateValidatorSet(snapshot: ValidatorSetSnapshot): string[] {
  const violations: string[] = [];

  if (snapshot.validators.length === 0) {
    violations.push('Validator set is empty');
  }

  const activeCount = snapshot.validators.filter((v) => v.isActive).length;
  if (activeCount === 0) {
    violations.push('No active validators');
  }

  // Check for duplicate IDs
  const ids = new Set<string>();
  for (const v of snapshot.validators) {
    if (ids.has(v.id)) {
      violations.push(`Duplicate validator id: ${v.id}`);
    }
    ids.add(v.id);
  }

  // Check stake values
  for (const v of snapshot.validators) {
    if (v.stake <= 0) {
      violations.push(`Invalid stake for ${v.id}: ${v.stake}`);
    }
    if (v.reputation < 0 || v.reputation > 1) {
      violations.push(`Invalid reputation for ${v.id}: ${v.reputation}`);
    }
  }

  // Check quorum is possible
  if (snapshot.quorumThreshold > snapshot.totalVotingPower) {
    violations.push(
      `Quorum threshold (${snapshot.quorumThreshold}) exceeds total voting power (${snapshot.totalVotingPower})`
    );
  }

  return violations;
}

/**
 * Get a validator by ID.
 */
export function getValidator(
  snapshot: ValidatorSetSnapshot,
  id: string,
): Validator | undefined {
  return snapshot.validators.find((v) => v.id === id);
}

/**
 * Check if a validator is in the active set.
 */
export function isValidatorActive(
  snapshot: ValidatorSetSnapshot,
  id: string,
): boolean {
  const v = getValidator(snapshot, id);
  return v ? v.isActive : false;
}

/**
 * Count voting power from a set of validator IDs.
 * Used to check if votes reach quorum.
 */
export function countVotingPower(
  snapshot: ValidatorSetSnapshot,
  validatorIds: readonly string[],
): number {
  let power = 0;
  for (const id of validatorIds) {
    const v = getValidator(snapshot, id);
    if (v && v.isActive) {
      power += calculateVotingPower(v);
    }
  }
  return power;
}

/**
 * Check if a set of votes reaches quorum.
 */
export function hasQuorum(
  snapshot: ValidatorSetSnapshot,
  votes: readonly string[],
): boolean {
  return countVotingPower(snapshot, votes) >= snapshot.quorumThreshold;
}

/**
 * Validator set update: add, remove, or modify validators.
 * Returns a new snapshot.
 */
export interface ValidatorSetChange {
  type:       'ADD' | 'REMOVE' | 'UPDATE';
  validator?:  Validator;
  validatorId?: string;
}

/**
 * Apply a batch of validator changes.
 * Each change is validated.
 */
export function applyValidatorChanges(
  snapshot: ValidatorSetSnapshot,
  changes: readonly ValidatorSetChange[],
  newHeight: number,
): { snapshot: ValidatorSetSnapshot; violations: string[] } {
  const violations: string[] = [];
  let validators = [...snapshot.validators];

  for (const change of changes) {
    switch (change.type) {
      case 'ADD': {
        if (!change.validator) {
          violations.push('ADD requires validator field');
          continue;
        }
        if (validators.some((v) => v.id === change.validator!.id)) {
          violations.push(`Validator already exists: ${change.validator.id}`);
          continue;
        }
        validators.push(change.validator);
        break;
      }

      case 'REMOVE': {
        if (!change.validatorId) {
          violations.push('REMOVE requires validatorId field');
          continue;
        }
        const idx = validators.findIndex((v) => v.id === change.validatorId);
        if (idx === -1) {
          violations.push(`Validator not found: ${change.validatorId}`);
          continue;
        }
        validators.splice(idx, 1);
        break;
      }

      case 'UPDATE': {
        if (!change.validator) {
          violations.push('UPDATE requires validator field');
          continue;
        }
        const idx = validators.findIndex((v) => v.id === change.validator!.id);
        if (idx === -1) {
          violations.push(`Validator not found: ${change.validator.id}`);
          continue;
        }
        validators[idx] = change.validator;
        break;
      }
    }
  }

  if (violations.length > 0) {
    return { snapshot, violations };
  }

  const newSnapshot = buildValidatorSetSnapshot(newHeight, validators);
  const setViolations = validateValidatorSet(newSnapshot);

  return {
    snapshot: setViolations.length === 0 ? newSnapshot : snapshot,
    violations: setViolations,
  };
}

/**
 * Reputation decay: reduce reputation over time if validator hasn't voted.
 * Used to handle long-absent validators.
 */
export function decayValidatorReputation(
  snapshot: ValidatorSetSnapshot,
  validatorId: string,
  decayFactor: number = 0.99,
): ValidatorSetSnapshot {
  const validator = getValidator(snapshot, validatorId);
  if (!validator) return snapshot;

  const updated: Validator = {
    ...validator,
    reputation: Math.max(0, validator.reputation * decayFactor),
  };

  const newValidators = snapshot.validators.map((v) =>
    v.id === validatorId ? updated : v
  );

  return buildValidatorSetSnapshot(snapshot.height, newValidators);
}

/**
 * Slash a validator: reduce stake and reputation.
 * Used when validator misbehaves.
 */
export function slashValidator(
  snapshot: ValidatorSetSnapshot,
  validatorId: string,
  slashPercent: number = 0.1,  // 10% by default
): ValidatorSetSnapshot {
  const validator = getValidator(snapshot, validatorId);
  if (!validator) return snapshot;

  const slashed: Validator = {
    ...validator,
    stake: validator.stake * (1 - slashPercent),
    reputation: Math.max(0, validator.reputation - 0.2),
    slashCount: validator.slashCount + 1,
  };

  const newValidators = snapshot.validators.map((v) =>
    v.id === validatorId ? slashed : v
  );

  return buildValidatorSetSnapshot(snapshot.height, newValidators);
}

/**
 * Validator summary for monitoring.
 */
export interface ValidatorSummary {
  validatorId: string;
  stake:       number;
  reputation:  number;
  votingPower: number;
  isActive:    boolean;
  slashCount:  number;
}

export function getValidatorSummaries(
  snapshot: ValidatorSetSnapshot,
): ValidatorSummary[] {
  return snapshot.validators.map((v) => ({
    validatorId: v.id,
    stake: v.stake,
    reputation: v.reputation,
    votingPower: calculateVotingPower(v),
    isActive: v.isActive,
    slashCount: v.slashCount,
  }));
}

/**
 * Check if validator set is healthy (no single validator > 1/3 power).
 */
export function isValidatorSetHealthy(snapshot: ValidatorSetSnapshot): boolean {
  const maxPower = Math.max(
    ...snapshot.validators
      .filter((v) => v.isActive)
      .map((v) => calculateVotingPower(v))
  );

  return maxPower <= snapshot.totalVotingPower / 3;
}

/**
 * Find validators with low reputation (likely to be slashed soon).
 */
export function findAtRiskValidators(
  snapshot: ValidatorSetSnapshot,
  threshold: number = 0.3,
): Validator[] {
  return snapshot.validators.filter((v) => v.isActive && v.reputation < threshold);
}
