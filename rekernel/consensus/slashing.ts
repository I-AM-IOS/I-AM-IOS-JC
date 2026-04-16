/**
 * SLASHING RULES — Incentive Alignment
 *
 * A validator is slashed (loses stake + reputation) for:
 *   1. Double-signing (two different events at same height)
 *   2. Equivocation (conflicting acknowledgements)
 *   3. Timeout (failing to acknowledge before deadline)
 *
 * Slashing is the enforcement mechanism that makes consensus binding.
 * Without it, validators could fork costlessly.
 *
 * Key property: Cost of attacking > benefit of attack
 *   - Attacking (creating conflicting fork): lose X% of stake
 *   - Honest behavior: earn rewards (future)
 *   - Therefore: rational validators don't fork
 */

import { Event } from '../events/event';
import {
  ValidatorSetSnapshot,
  Validator,
  slashValidator,
  buildValidatorSetSnapshot,
} from './validators';
import { EventAcknowledgement } from './event_set_agreement';

/**
 * A slashing condition: evidence of misbehavior.
 */
export type SlashingCondition =
  | 'DOUBLE_SIGN'      // Two acknowledgements for conflicting events
  | 'EQUIVOCATION'      // Contradictory votes in same round
  | 'TIMEOUT'           // Failed to acknowledge within deadline
  | 'INVALID_ACK'       // Acknowledged invalid event
  | 'BYZANTINE_PROPOSAL'; // Proposed conflicting blocks

/**
 * Evidence of slashing: proof that validator misbehaved.
 */
export interface SlashingEvidence {
  readonly validatorId:    string;
  readonly condition:      SlashingCondition;
  readonly height:         number;
  readonly timestamp:      number;
  readonly evidence1:      any;  // First proof (e.g., ack1)
  readonly evidence2?:     any;  // Second proof (e.g., ack2)
  readonly explanation:    string;
}

/**
 * Detect double-signing: validator acknowledged two different events.
 */
export function detectDoubleSigning(
  ack1: EventAcknowledgement,
  ack2: EventAcknowledgement,
): boolean {
  return (
    ack1.validatorId === ack2.validatorId &&
    ack1.height === ack2.height &&
    ack1.eventHash !== ack2.eventHash
  );
}

/**
 * Detect equivocation: validator signed contradictory positions.
 * For example: voted for block A, then voted for block B at same height.
 */
export function detectEquivocation(
  vote1: { validatorId: string; blockHash: string; height: number },
  vote2: { validatorId: string; blockHash: string; height: number },
): boolean {
  return (
    vote1.validatorId === vote2.validatorId &&
    vote1.height === vote2.height &&
    vote1.blockHash !== vote2.blockHash
  );
}

/**
 * Create slashing evidence.
 */
export function createSlashingEvidence(
  validatorId: string,
  condition: SlashingCondition,
  height: number,
  evidence1: any,
  evidence2?: any,
  explanation?: string,
): SlashingEvidence {
  return Object.freeze({
    validatorId,
    condition,
    height,
    timestamp: Date.now(),
    evidence1,
    evidence2,
    explanation: explanation || `Validator ${validatorId} violated: ${condition}`,
  }) as SlashingEvidence;
}

/**
 * Apply a slash: reduce validator stake and reputation.
 */
export function applySlash(
  validators: ValidatorSetSnapshot,
  evidence: SlashingEvidence,
  slashPercent: number = 0.1,  // 10% by default
): ValidatorSetSnapshot {
  return slashValidator(validators, evidence.validatorId, slashPercent);
}

/**
 * Slashing ledger: history of slashes (for audit).
 */
export interface SlashingRecord {
  readonly evidenceList:   readonly SlashingEvidence[];
  readonly totalSlashed:   number;  // Total stake slashed
  readonly slashedValidators: Set<string>;
}

/**
 * Accumulate slashing evidence into ledger.
 */
export function recordSlash(
  record: SlashingRecord,
  evidence: SlashingEvidence,
  slashAmount: number,
): SlashingRecord {
  const slashed = new Set(record.slashedValidators);
  slashed.add(evidence.validatorId);

  return Object.freeze({
    evidenceList: Object.freeze([...record.evidenceList, evidence]),
    totalSlashed: record.totalSlashed + slashAmount,
    slashedValidators: slashed,
  }) as SlashingRecord;
}

/**
 * Minimal slashing enforcement: three rules
 *
 * Rule 1: Double-signing at same height
 *   Slash 10% of stake
 *   Rationale: prevents forking
 *
 * Rule 2: Equivocation (conflicting votes)
 *   Slash 5% of stake
 *   Rationale: prevents validator confusion
 *
 * Rule 3: Timeout (no acknowledgement within deadline)
 *   Slash 1% of stake + reputation decay
 *   Rationale: ensures liveness
 *
 * Total slashing budget: prevent infinite dilution
 *   - Max 1/3 of total stake can be slashed per era
 *   - Excess is burned (not redistributed)
 */

export const SLASHING_AMOUNTS = {
  DOUBLE_SIGN: 0.10,      // 10%
  EQUIVOCATION: 0.05,      // 5%
  TIMEOUT: 0.01,           // 1%
  INVALID_ACK: 0.15,       // 15%
  BYZANTINE_PROPOSAL: 0.20, // 20%
};

export const SLASHING_LIMITS = {
  MAX_PER_ERA: 1 / 3,  // Max 1/3 of stake slashed per era
  MIN_SLASH: 0.001,    // At least 0.1%
};

/**
 * Check if a slash would exceed budget.
 */
export function wouldExceedSlashingBudget(
  validators: ValidatorSetSnapshot,
  evidence: SlashingEvidence,
  totalSlashed: number,
): boolean {
  const slashAmount = SLASHING_AMOUNTS[evidence.condition as keyof typeof SLASHING_AMOUNTS] || 0;
  const newTotal = totalSlashed + slashAmount;
  const maxAllowed = validators.totalVotingPower * SLASHING_LIMITS.MAX_PER_ERA;

  return newTotal > maxAllowed;
}

/**
 * Automatic slashing: check all acknowledgements for violations.
 * Called at end of each height.
 */
export function detectAutoSlashes(
  acknowledgements: Map<string, EventAcknowledgement[]>,
  validators: ValidatorSetSnapshot,
  height: number,
): SlashingEvidence[] {
  const evidence: SlashingEvidence[] = [];
  const seen = new Map<string, EventAcknowledgement>();

  // Check for double-signing
  for (const [eventHash, acks] of acknowledgements) {
    for (const ack of acks) {
      const key = `${ack.validatorId}:${ack.height}`;
      const prev = seen.get(key);

      if (prev && prev.eventHash !== eventHash) {
        // Double-signed: same validator, same height, different events
        evidence.push(
          createSlashingEvidence(
            ack.validatorId,
            'DOUBLE_SIGN',
            height,
            prev,
            ack,
            `Validator ${ack.validatorId} acknowledged both ${prev.eventHash.slice(0, 8)} and ${eventHash.slice(0, 8)} at height ${height}`
          )
        );
      } else {
        seen.set(key, ack);
      }
    }
  }

  return evidence;
}

/**
 * Slashing challenge: a third party (auditor or another validator) can submit evidence.
 * System must accept and apply the slash within a grace period.
 */
export interface SlashingChallenge {
  readonly challenger:  string;
  readonly evidence:    SlashingEvidence;
  readonly timestamp:   number;
  readonly resolved:    boolean;
}

/**
 * Grace period: how long to collect evidence before locking in slashes.
 * Allows auditors to submit evidence before next era.
 */
export const SLASHING_GRACE_PERIOD_BLOCKS = 100;

/**
 * Process a slashing challenge.
 * Verify evidence is well-formed, then apply.
 */
export function processSlashingChallenge(
  challenge: SlashingChallenge,
  validators: ValidatorSetSnapshot,
): { approved: boolean; validators: ValidatorSetSnapshot; reason?: string } {
  // Verify evidence structure
  if (!challenge.evidence.validatorId || !challenge.evidence.condition) {
    return {
      approved: false,
      validators,
      reason: 'Malformed evidence',
    };
  }

  // Verify challenged validator exists
  const validator = validators.validators.find(
    (v) => v.id === challenge.evidence.validatorId
  );
  if (!validator) {
    return {
      approved: false,
      validators,
      reason: 'Validator not found',
    };
  }

  // Apply slash
  const newValidators = applySlash(validators, challenge.evidence);

  return {
    approved: true,
    validators: newValidators,
  };
}

/**
 * Summary for monitoring.
 */
export interface SlashingSummary {
  totalEvidence:        number;
  totalSlashed:         number;
  slashedValidators:    number;
  mostCommonCondition:  SlashingCondition;
}

export function summarizeSlashing(record: SlashingRecord): SlashingSummary {
  const conditions = new Map<SlashingCondition, number>();

  for (const ev of record.evidenceList) {
    conditions.set(ev.condition, (conditions.get(ev.condition) || 0) + 1);
  }

  let mostCommon: SlashingCondition = 'DOUBLE_SIGN';
  let maxCount = 0;

  for (const [condition, count] of conditions) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = condition;
    }
  }

  return {
    totalEvidence: record.evidenceList.length,
    totalSlashed: record.totalSlashed,
    slashedValidators: record.slashedValidators.size,
    mostCommonCondition: mostCommon,
  };
}
