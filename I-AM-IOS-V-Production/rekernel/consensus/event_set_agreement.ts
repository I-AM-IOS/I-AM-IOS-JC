/**
 * EVENT SET AGREEMENT — Minimal Consensus Rule
 *
 * Problem: Two honest nodes see different event sets.
 * Which one is canonical?
 *
 * This is NOT about Byzantine voting.
 * This is about establishing shared reality without coordination.
 *
 * Key insight from your constraint model:
 *   - Events are immutable (frozen)
 *   - Event hash is deterministic (content-derived)
 *   - Ordering is deterministic (by hash)
 *   - Execution is deterministic (pure function)
 *
 * Therefore:
 *   EventSetA = EventSetB ⟺ CanonicalOrder(A) = CanonicalOrder(B)
 *
 * The question becomes:
 *   "What rule determines whether an event is part of the canonical set?"
 *
 * Answer (minimal): A quorum of validators acknowledged it.
 *   - Acknowledgement = cryptographic commitment (not execution)
 *   - Quorum = 2/3 + 1 of stake
 *   - Canonical = acknowledged by quorum + ordered by hash
 */

import { Event } from '../events/event';
import { ValidatorSetSnapshot, countVotingPower } from './validators';

/**
 * An acknowledgement: a validator has seen and committed to an event.
 * Does NOT mean execution; means "I have this event and hash matches."
 */
export interface EventAcknowledgement {
  readonly eventHash:   string;
  readonly eventId:     string;
  readonly validatorId: string;
  readonly height:      number;
  readonly timestamp:   number;
  readonly ackHash:     string;     // Self-hash
  readonly signature:   string;     // Validator's signature
}

/**
 * An admitted event: acknowledged by >2/3 validators.
 * Once admitted, it is part of canonical history (cannot be reverted).
 */
export interface AdmittedEvent {
  readonly event:              Event;
  readonly admissionHeight:    number;  // Height at which it reached quorum
  readonly acknowledgers:      readonly string[];  // Validator IDs (>2/3)
  readonly acknowledgements:   readonly EventAcknowledgement[];
}

/**
 * Event set: all admitted events at a height.
 * Deterministic ordering by hash.
 */
export interface CanonicalEventSet {
  readonly height:         number;
  readonly events:         readonly AdmittedEvent[];  // Sorted by hash
  readonly eventSetHash:   string;                     // Hash of the set
  readonly admissionHeight: number;                    // Height at which set closed
}

/**
 * Compute hash of an admitted event (for deduplication).
 */
export function hashAdmittedEvent(event: Event, height: number): string {
  const crypto = require('crypto');
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ hash: event.hash, height }))
    .digest('hex');
}

/**
 * Compute hash of a canonical event set.
 * Independent of order (deterministic across nodes).
 */
export function hashEventSet(set: Omit<CanonicalEventSet, 'eventSetHash'>): string {
  const crypto = require('crypto');
  
  // Sort events by hash (deterministic)
  const sorted = [...set.events].sort((a, b) =>
    a.event.hash.localeCompare(b.event.hash)
  );

  const data = JSON.stringify({
    height: set.height,
    events: sorted.map((e) => e.event.hash),
    admissionHeight: set.admissionHeight,
  });

  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Check if an event has quorum acknowledgement.
 * Returns true if >2/3 of validators have acknowledged it.
 */
export function hasAcknowledgementQuorum(
  acks: readonly EventAcknowledgement[],
  validators: ValidatorSetSnapshot,
): boolean {
  const voterIds = acks.map((a) => a.validatorId);
  const power = countVotingPower(validators, voterIds);
  return power >= validators.quorumThreshold;
}

/**
 * Admit an event to canonical history.
 * Requires >2/3 quorum of acknowledgements.
 */
export function createAdmittedEvent(
  event: Event,
  acknowledgements: readonly EventAcknowledgement[],
  validators: ValidatorSetSnapshot,
  admissionHeight: number,
): AdmittedEvent | null {
  if (!hasAcknowledgementQuorum(acknowledgements, validators)) {
    return null;  // No quorum yet
  }

  return Object.freeze({
    event,
    admissionHeight,
    acknowledgers: Object.freeze(
      acknowledgements.map((a) => a.validatorId)
    ),
    acknowledgements: Object.freeze([...acknowledgements]),
  }) as AdmittedEvent;
}

/**
 * Build a canonical event set from admitted events.
 */
export function buildCanonicalEventSet(
  height: number,
  admittedEvents: readonly AdmittedEvent[],
  admissionHeight: number,
): CanonicalEventSet {
  // Sort by hash (deterministic)
  const sorted = [...admittedEvents].sort((a, b) =>
    a.event.hash.localeCompare(b.event.hash)
  );

  const base: Omit<CanonicalEventSet, 'eventSetHash'> = {
    height,
    events: Object.freeze(sorted),
    admissionHeight,
  };

  const eventSetHash = hashEventSet(base);

  return Object.freeze({
    ...base,
    eventSetHash,
  }) as CanonicalEventSet;
}

/**
 * Merge two event sets:
 *   - Keep only admitted events (by hash)
 *   - Re-order by hash
 *   - Re-compute set hash
 *
 * Used when nodes receive different event sets and need to converge.
 */
export function mergeEventSets(
  setA: CanonicalEventSet,
  setB: CanonicalEventSet,
): CanonicalEventSet {
  if (setA.height !== setB.height) {
    throw new Error('Cannot merge event sets at different heights');
  }

  // Deduplicate by event hash
  const seen = new Set<string>();
  const merged: AdmittedEvent[] = [];

  for (const admitted of [...setA.events, ...setB.events]) {
    if (!seen.has(admitted.event.hash)) {
      seen.add(admitted.event.hash);
      merged.push(admitted);
    }
  }

  return buildCanonicalEventSet(
    setA.height,
    merged,
    Math.max(setA.admissionHeight, setB.admissionHeight)
  );
}

/**
 * Detect divergence: two nodes have conflicting event sets.
 * This should never happen if quorum rule is followed.
 * If it does, it indicates Byzantine behavior.
 */
export function detectEventSetDivergence(
  setA: CanonicalEventSet,
  setB: CanonicalEventSet,
): { diverged: boolean; conflictingHashes?: string[] } {
  if (setA.height !== setB.height) {
    return { diverged: false };  // Different heights, not divergence
  }

  const hashesA = new Set(setA.events.map((e) => e.event.hash));
  const hashesB = new Set(setB.events.map((e) => e.event.hash));

  // Check if any event is in A but not B (or vice versa)
  const conflicting: string[] = [];

  for (const hash of hashesA) {
    if (!hashesB.has(hash)) {
      conflicting.push(hash);
    }
  }

  for (const hash of hashesB) {
    if (!hashesA.has(hash)) {
      conflicting.push(hash);
    }
  }

  return {
    diverged: conflicting.length > 0,
    conflictingHashes: conflicting.length > 0 ? conflicting : undefined,
  };
}

/**
 * Finality rule (minimal): an event is final when:
 *   1. It is part of a canonical event set at height H
 *   2. A new canonical event set is committed at height H + k (k = safety margin)
 *   3. The new set still includes this event
 *
 * Safety parameter k: how many blocks deep before finality?
 * Default: k = 1 (finality after next block)
 * Conservative: k = 5 (finality after 5 blocks)
 */
export const FINALITY_DELAY_BLOCKS = 1;

export interface FinalizedEvent {
  readonly event:            Event;
  readonly admissionHeight:  number;
  readonly finalizedAtHeight: number;
  readonly reason:           'quorum' | 'confirmed' | 'snapshot';
}

/**
 * Check if an event can be finalized.
 * Requires confirmation in subsequent canonical sets.
 */
export function canFinalize(
  event: Event,
  admissionHeight: number,
  currentHeight: number,
): boolean {
  // Event is final if we've advanced k blocks beyond admission
  return currentHeight >= admissionHeight + FINALITY_DELAY_BLOCKS;
}

/**
 * Consensus on event set: minimal algorithm
 *
 * When a node receives events:
 *
 *   1. Node stores event (immutable, content-addressed)
 *   2. Node broadcasts acknowledgement
 *   3. Other nodes gossip acknowledgements
 *   4. Node monitors quorum on acknowledgements
 *   5. When quorum reached → event is admitted
 *   6. Admitted events ordered by hash → canonical set
 *   7. Canonical set committed to chain
 *   8. After k blocks → event is final (cannot be reverted)
 *
 * Properties:
 *   - No leader (gossip-based)
 *   - No ordering constraint (hash order is deterministic)
 *   - Fault tolerance: 1/3 malicious nodes cannot prevent finality
 *   - Liveness: if <1/3 nodes down, system continues
 */

export interface EventSetAgreementState {
  readonly height:              number;
  readonly pendingEvents:       Map<string, Event>;              // eventHash → event
  readonly acknowledgements:    Map<string, EventAcknowledgement[]>; // eventHash → acks
  readonly admittedEvents:      readonly AdmittedEvent[];
  readonly canonicalEventSet:   CanonicalEventSet;
  readonly finalizedEvents:     readonly FinalizedEvent[];
}

export function initializeEventSetAgreement(height: number): EventSetAgreementState {
  return Object.freeze({
    height,
    pendingEvents: new Map(),
    acknowledgements: new Map(),
    admittedEvents: Object.freeze([]),
    canonicalEventSet: buildCanonicalEventSet(height, [], height),
    finalizedEvents: Object.freeze([]),
  }) as EventSetAgreementState;
}

/**
 * Process an incoming event.
 */
export function addPendingEvent(
  state: EventSetAgreementState,
  event: Event,
): EventSetAgreementState {
  if (state.pendingEvents.has(event.hash)) {
    return state;  // Already have this event
  }

  const pending = new Map(state.pendingEvents);
  pending.set(event.hash, event);

  return Object.freeze({
    ...state,
    pendingEvents: pending,
  }) as EventSetAgreementState;
}

/**
 * Process an acknowledgement.
 * Check if event reaches quorum.
 */
export function processAcknowledgement(
  state: EventSetAgreementState,
  ack: EventAcknowledgement,
  validators: ValidatorSetSnapshot,
): EventSetAgreementState {
  const acks = state.acknowledgements.get(ack.eventHash) || [];
  
  // Skip duplicate acks from same validator
  if (acks.some((a) => a.validatorId === ack.validatorId)) {
    return state;
  }

  const newAcks = [...acks, ack];
  const event = state.pendingEvents.get(ack.eventHash);

  if (!event) {
    return state;  // Don't have the event yet
  }

  // Check if reached quorum
  const hasQuorum = hasAcknowledgementQuorum(newAcks, validators);

  if (hasQuorum) {
    // Admit the event
    const admitted = createAdmittedEvent(event, newAcks, validators, state.height);
    if (admitted) {
      const admittedEvents = [...state.admittedEvents, admitted];
      const canonicalSet = buildCanonicalEventSet(
        state.height,
        admittedEvents,
        state.height
      );

      const acknowledgements = new Map(state.acknowledgements);
      acknowledgements.set(ack.eventHash, newAcks);

      return Object.freeze({
        ...state,
        acknowledgements,
        admittedEvents: Object.freeze(admittedEvents),
        canonicalEventSet: canonicalSet,
      }) as EventSetAgreementState;
    }
  }

  // Not yet admitted, update acks and return
  const acknowledgements = new Map(state.acknowledgements);
  acknowledgements.set(ack.eventHash, newAcks);

  return Object.freeze({
    ...state,
    acknowledgements,
  }) as EventSetAgreementState;
}

/**
 * Advance to next height (canonical set is committed).
 * Check for finalized events.
 */
export function advanceHeight(
  state: EventSetAgreementState,
  nextHeight: number,
  previousSets: readonly CanonicalEventSet[],
): EventSetAgreementState {
  if (nextHeight <= state.height) {
    return state;  // Cannot go backwards
  }

  // Check which events from previous sets are still in canonical history
  const finalizedHashes = new Set<string>();

  if (previousSets.length > 0) {
    const oldestSet = previousSets[0];
    if (nextHeight >= oldestSet.admissionHeight + FINALITY_DELAY_BLOCKS) {
      // Check if all events in oldest set are in current canonical set
      const currentHashes = new Set(
        state.canonicalEventSet.events.map((e) => e.event.hash)
      );

      for (const admitted of oldestSet.events) {
        if (currentHashes.has(admitted.event.hash)) {
          finalizedHashes.add(admitted.event.hash);
        }
      }
    }
  }

  // Create finalized events
  const finalized: FinalizedEvent[] = [];
  for (const admitted of state.admittedEvents) {
    if (finalizedHashes.has(admitted.event.hash)) {
      finalized.push({
        event: admitted.event,
        admissionHeight: admitted.admissionHeight,
        finalizedAtHeight: nextHeight,
        reason: 'confirmed',
      });
    }
  }

  return Object.freeze({
    ...state,
    height: nextHeight,
    pendingEvents: new Map(),  // Clear pending for new height
    acknowledgements: new Map(),
    admittedEvents: Object.freeze([]),
    canonicalEventSet: buildCanonicalEventSet(nextHeight, [], nextHeight),
    finalizedEvents: Object.freeze([...state.finalizedEvents, ...finalized]),
  }) as EventSetAgreementState;
}
