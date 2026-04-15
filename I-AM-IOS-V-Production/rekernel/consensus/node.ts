/**
 * CONSENSUS NODE — Event Set Agreement + Byzantine Safety
 *
 * A full node in the consensus system.
 *
 * Responsibilities:
 *   1. Receive events (from clients, network)
 *   2. Store immutable, content-addressed
 *   3. Acknowledge events seen (if valid)
 *   4. Monitor acknowledgements for quorum
 *   5. Admit events when quorum reached
 *   6. Order admitted events deterministically (by hash)
 *   7. Execute against kernel
 *   8. Monitor for Byzantine behavior
 *   9. Finalize after k block confirmations
 *  10. Slash violators
 *
 * State machine:
 *   - Core kernel: locked, deterministic execution
 *   - Event set agreement: consensus on which events are canonical
 *   - Slashing ledger: enforcement of Byzantine penalty
 *   - Finalized blocks: history of committed states
 */

import { Event, verifyEvent } from '../events/event';
import { State } from '../state/state';
import { LockedKernel } from '../core/integration_example';
import {
  ValidatorSetSnapshot,
  Validator,
  buildValidatorSetSnapshot,
} from './validators';
import {
  EventAcknowledgement,
  CanonicalEventSet,
  FinalizedEvent,
  EventSetAgreementState,
  initializeEventSetAgreement,
  addPendingEvent,
  processAcknowledgement,
  advanceHeight,
  buildCanonicalEventSet,
} from './event_set_agreement';
import { SlashingEvidence, detectAutoSlashes } from './slashing';

/**
 * A node's local state in consensus.
 */
export interface ConsensusNodeState {
  readonly nodeId:             string;
  readonly validators:         ValidatorSetSnapshot;
  readonly kernel:             LockedKernel;
  readonly eventSetAgreement:  EventSetAgreementState;
  readonly slashes:            readonly SlashingEvidence[];
  readonly finalizedBlocks:    readonly CanonicalEventSet[];
}

/**
 * Initialize a consensus node.
 */
export function initializeConsensusNode(
  nodeId: string,
  validators: ValidatorSetSnapshot,
  kernel?: LockedKernel,
): ConsensusNodeState {
  return Object.freeze({
    nodeId,
    validators,
    kernel: kernel || new LockedKernel(),
    eventSetAgreement: initializeEventSetAgreement(0),
    slashes: Object.freeze([]),
    finalizedBlocks: Object.freeze([]),
  }) as ConsensusNodeState;
}

/**
 * Main consensus action: node receives an event.
 *
 * Steps:
 *   1. Verify event (locked kernel)
 *   2. Add to pending
 *   3. Broadcast acknowledgement
 *   4. Process own acknowledgement
 *   5. Check for auto-slashes
 */
export function receiveEvent(
  state: ConsensusNodeState,
  event: Event,
): { state: ConsensusNodeState; acknowledge: boolean } {
  // Verify event (using locked kernel rules)
  const verification = verifyEvent(event);
  if (!verification.valid) {
    return { state, acknowledge: false };  // Don't acknowledge invalid events
  }

  // Add to pending
  const newESA = addPendingEvent(state.eventSetAgreement, event);

  const newState = Object.freeze({
    ...state,
    eventSetAgreement: newESA,
  }) as ConsensusNodeState;

  return {
    state: newState,
    acknowledge: true,  // Signal to broadcast ack
  };
}

/**
 * Acknowledge an event seen (part of consensus agreement).
 * This is signed by the node and broadcast to peers.
 */
export function acknowledgeEvent(
  state: ConsensusNodeState,
  eventHash: string,
  eventId: string,
  nowMs: number = Date.now(),
): EventAcknowledgement {
  return Object.freeze({
    eventHash,
    eventId,
    validatorId: state.nodeId,
    height: state.eventSetAgreement.height,
    timestamp: nowMs,
    ackHash: '',  // Will be filled in by caller
    signature: '',  // Will be signed by node
  }) as EventAcknowledgement;
}

/**
 * Process an incoming acknowledgement from peer.
 * Check for double-signing, update quorum status.
 */
export function receiveAcknowledgement(
  state: ConsensusNodeState,
  ack: EventAcknowledgement,
): ConsensusNodeState {
  // Ignore acks for wrong height
  if (ack.height !== state.eventSetAgreement.height) {
    return state;
  }

  // Process acknowledgement (may trigger admission)
  const newESA = processAcknowledgement(
    state.eventSetAgreement,
    ack,
    state.validators
  );

  // Check for double-signing
  const ackList = newESA.acknowledgements.get(ack.eventHash) || [];
  const slashes: SlashingEvidence[] = [];

  for (const otherAck of ackList) {
    if (otherAck.validatorId === ack.validatorId && otherAck.eventHash !== ack.eventHash) {
      // This validator double-signed
      slashes.push({
        validatorId: ack.validatorId,
        condition: 'DOUBLE_SIGN',
        height: ack.height,
        timestamp: Date.now(),
        evidence1: otherAck,
        evidence2: ack,
        explanation: `Validator ${ack.validatorId} acknowledged both events at height ${ack.height}`,
      });
    }
  }

  // Apply slashes
  let newValidators = state.validators;
  const allSlashes = [...state.slashes, ...slashes];

  for (const slash of slashes) {
    newValidators = applySlashToValidators(newValidators, slash);
  }

  return Object.freeze({
    ...state,
    validators: newValidators,
    eventSetAgreement: newESA,
    slashes: Object.freeze(allSlashes),
  }) as ConsensusNodeState;
}

/**
 * Apply a slash to the validator set.
 */
function applySlashToValidators(
  validators: ValidatorSetSnapshot,
  evidence: SlashingEvidence,
): ValidatorSetSnapshot {
  const validator = validators.validators.find((v) => v.id === evidence.validatorId);
  if (!validator) return validators;

  const slashed: Validator = {
    ...validator,
    stake: validator.stake * 0.9,  // 10% slash
    reputation: Math.max(0, validator.reputation - 0.1),
    slashCount: validator.slashCount + 1,
  };

  const newValidators = validators.validators.map((v) =>
    v.id === evidence.validatorId ? slashed : v
  );

  return buildValidatorSetSnapshot(validators.height, newValidators);
}

/**
 * Advance to next height.
 * Called when:
 *   1. Canonical event set is finalized
 *   2. Node is ready for new events
 */
export function advanceToNextHeight(
  state: ConsensusNodeState,
): ConsensusNodeState {
  // Check which events are finalized
  const finalized: FinalizedEvent[] = [];

  for (const admitted of state.eventSetAgreement.admittedEvents) {
    if (state.eventSetAgreement.height >= admitted.admissionHeight + 1) {
      // After 1 block of confirmation, consider final
      finalized.push({
        event: admitted.event,
        admissionHeight: admitted.admissionHeight,
        finalizedAtHeight: state.eventSetAgreement.height,
        reason: 'confirmed',
      });
    }
  }

  // Execute all finalized events against kernel
  const kernel = new LockedKernel(state.kernel.getState());
  const events = finalized.map((f) => f.event);

  // Process batch in kernel
  let kernelState = kernel.getState();

  for (const event of events) {
    const exec = require('../core/exec/exec');
    const engine = new exec.ExecutionEngine();
    kernelState = engine.exec(kernelState, event);
  }

  // Build new canonical set
  const newCanonicalSet = buildCanonicalEventSet(
    state.eventSetAgreement.height,
    state.eventSetAgreement.admittedEvents,
    state.eventSetAgreement.height
  );

  // Advance height
  const newESA = advanceHeight(
    state.eventSetAgreement,
    state.eventSetAgreement.height + 1,
    [...state.finalizedBlocks, newCanonicalSet]
  );

  return Object.freeze({
    ...state,
    kernel,
    eventSetAgreement: newESA,
    finalizedBlocks: Object.freeze([
      ...state.finalizedBlocks,
      newCanonicalSet,
    ]),
  }) as ConsensusNodeState;
}

/**
 * Get current consensus state for querying.
 */
export function queryConsensusState(state: ConsensusNodeState): {
  height: number;
  phase: string;
  pendingEvents: number;
  admittedEvents: number;
  finalizedBlocks: number;
  slashes: number;
  kernelHeight: number;
} {
  return {
    height: state.eventSetAgreement.height,
    phase: 'commitment',
    pendingEvents: state.eventSetAgreement.pendingEvents.size,
    admittedEvents: state.eventSetAgreement.admittedEvents.length,
    finalizedBlocks: state.finalizedBlocks.length,
    slashes: state.slashes.length,
    kernelHeight: state.kernel.getHeight(),
  };
}

/**
 * Consensus health check.
 */
export function checkNodeHealth(state: ConsensusNodeState): {
  healthy: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];

  // Check if validator set is healthy
  const activeValidators = state.validators.validators.filter((v) => v.isActive);
  if (activeValidators.length < 3) {
    warnings.push('Less than 3 active validators');
  }

  // Check if consensus is progressing
  if (state.eventSetAgreement.pendingEvents.size > 1000) {
    warnings.push('Large pending event queue');
  }

  // Check slashing
  if (state.slashes.length > 10) {
    warnings.push('Unusual number of slashes');
  }

  return {
    healthy: warnings.length === 0,
    warnings,
  };
}

/**
 * Export consensus state for audit/sync.
 */
export function exportConsensusState(state: ConsensusNodeState): {
  nodeId: string;
  height: number;
  finalizedBlocks: readonly CanonicalEventSet[];
  validators: ValidatorSetSnapshot;
  slashes: readonly SlashingEvidence[];
} {
  return {
    nodeId: state.nodeId,
    height: state.eventSetAgreement.height,
    finalizedBlocks: [...state.finalizedBlocks],
    validators: state.validators,
    slashes: [...state.slashes],
  };
}
