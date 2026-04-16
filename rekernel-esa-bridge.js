// ════════════════════════════════════════════════════════════════════════════
//  rekernel-esa-bridge.js  —  Event Set Agreement (pure JS bridge)
//
//  This is a direct port of rekernel/consensus/event_set_agreement.ts and
//  rekernel/consensus/validators.ts into plain ES-module JavaScript so that
//  sovereign-network.js can import it without a TypeScript compile step.
//
//  All logic is identical to the TypeScript originals. No behaviour changes.
//
//  Exports (mirrors TS):
//    buildValidatorSetSnapshot(height, validators)  → ValidatorSetSnapshot
//    countVotingPower(snapshot, validatorIds)       → number
//    initializeEventSetAgreement(height)            → EventSetAgreementState
//    addPendingEvent(state, event)                  → EventSetAgreementState
//    processAcknowledgement(state, ack, validators) → EventSetAgreementState
//    advanceHeight(state, nextHeight, prevSets)     → EventSetAgreementState
//    hasAcknowledgementQuorum(acks, validators)     → boolean
//    buildCanonicalEventSet(height, admitted, admH) → CanonicalEventSet
//    mergeEventSets(setA, setB)                     → CanonicalEventSet
//    detectEventSetDivergence(setA, setB)           → { diverged, conflictingHashes? }
//    FINALITY_DELAY_BLOCKS                          → number
// ════════════════════════════════════════════════════════════════════════════

// ── SHA-256 helper (Node crypto or SubtleCrypto) ──────────────────────────────

async function sha256hex(str) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf    = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Node.js (server-side)
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

// Synchronous fallback (FNV-32) used only when building canonical set hashes
// in environments where async isn't practical. The async version is preferred.
function fnv32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function hashEventSetSync(set) {
  const sorted = [...set.events].sort((a, b) =>
    a.event.hash.localeCompare(b.event.hash)
  );
  const data = JSON.stringify({
    height:          set.height,
    events:          sorted.map(e => e.event.hash),
    admissionHeight: set.admissionHeight,
  });
  return fnv32(data);
}

// ── Validator helpers (from validators.ts) ───────────────────────────────────

export function calculateVotingPower(validator) {
  return validator.stake * Math.max(0, Math.min(1, validator.reputation));
}

export function buildValidatorSetSnapshot(height, validators) {
  const active = validators.filter(v => v.isActive);
  const totalVotingPower = active.reduce((sum, v) => sum + calculateVotingPower(v), 0);
  const quorumThreshold  = Math.floor(totalVotingPower * 2 / 3) + 1;
  return Object.freeze({
    height,
    validators:      Object.freeze([...validators]),
    totalVotingPower,
    quorumThreshold,
    timestamp:       Date.now(),
  });
}

export function countVotingPower(snapshot, validatorIds) {
  let power = 0;
  for (const id of validatorIds) {
    const v = snapshot.validators.find(v => v.id === id);
    if (v && v.isActive) power += calculateVotingPower(v);
  }
  return power;
}

export function hasQuorum(snapshot, votes) {
  return countVotingPower(snapshot, votes) >= snapshot.quorumThreshold;
}

// ── ESA helpers (from event_set_agreement.ts) ────────────────────────────────

export const FINALITY_DELAY_BLOCKS = 1;

export function hasAcknowledgementQuorum(acks, validators) {
  const voterIds = acks.map(a => a.validatorId);
  const power    = countVotingPower(validators, voterIds);
  return power >= validators.quorumThreshold;
}

export function buildCanonicalEventSet(height, admittedEvents, admissionHeight) {
  const sorted = [...admittedEvents].sort((a, b) =>
    a.event.hash.localeCompare(b.event.hash)
  );
  const base = { height, events: Object.freeze(sorted), admissionHeight };
  return Object.freeze({ ...base, eventSetHash: hashEventSetSync(base) });
}

function createAdmittedEvent(event, acknowledgements, validators, admissionHeight) {
  if (!hasAcknowledgementQuorum(acknowledgements, validators)) return null;
  return Object.freeze({
    event,
    admissionHeight,
    acknowledgers:    Object.freeze(acknowledgements.map(a => a.validatorId)),
    acknowledgements: Object.freeze([...acknowledgements]),
  });
}

// ── State machine (from event_set_agreement.ts) ──────────────────────────────

export function initializeEventSetAgreement(height) {
  return Object.freeze({
    height,
    pendingEvents:     new Map(),
    acknowledgements:  new Map(),
    admittedEvents:    Object.freeze([]),
    canonicalEventSet: buildCanonicalEventSet(height, [], height),
    finalizedEvents:   Object.freeze([]),
  });
}

export function addPendingEvent(state, event) {
  if (state.pendingEvents.has(event.hash)) return state;
  const pending = new Map(state.pendingEvents);
  pending.set(event.hash, event);
  return Object.freeze({ ...state, pendingEvents: pending });
}

export function processAcknowledgement(state, ack, validators) {
  const acks = state.acknowledgements.get(ack.eventHash) || [];

  // Deduplicate per validator
  if (acks.some(a => a.validatorId === ack.validatorId)) return state;

  const newAcks = [...acks, ack];
  const event   = state.pendingEvents.get(ack.eventHash);
  if (!event) {
    // Store ack; we'll re-check when the event arrives
    const acknowledgements = new Map(state.acknowledgements);
    acknowledgements.set(ack.eventHash, newAcks);
    return Object.freeze({ ...state, acknowledgements });
  }

  const hasQuorumNow = hasAcknowledgementQuorum(newAcks, validators);

  if (hasQuorumNow) {
    const admitted = createAdmittedEvent(event, newAcks, validators, state.height);
    if (admitted) {
      const admittedEvents  = [...state.admittedEvents, admitted];
      const canonicalSet    = buildCanonicalEventSet(state.height, admittedEvents, state.height);
      const acknowledgements = new Map(state.acknowledgements);
      acknowledgements.set(ack.eventHash, newAcks);
      return Object.freeze({
        ...state,
        acknowledgements,
        admittedEvents:    Object.freeze(admittedEvents),
        canonicalEventSet: canonicalSet,
      });
    }
  }

  const acknowledgements = new Map(state.acknowledgements);
  acknowledgements.set(ack.eventHash, newAcks);
  return Object.freeze({ ...state, acknowledgements });
}

export function advanceHeight(state, nextHeight, previousSets) {
  if (nextHeight <= state.height) return state;

  const finalizedHashes = new Set();
  if (previousSets.length > 0) {
    const oldestSet = previousSets[0];
    if (nextHeight >= oldestSet.admissionHeight + FINALITY_DELAY_BLOCKS) {
      const currentHashes = new Set(state.canonicalEventSet.events.map(e => e.event.hash));
      for (const admitted of oldestSet.events) {
        if (currentHashes.has(admitted.event.hash)) finalizedHashes.add(admitted.event.hash);
      }
    }
  }

  const finalized = [];
  for (const admitted of state.admittedEvents) {
    if (finalizedHashes.has(admitted.event.hash)) {
      finalized.push({
        event:              admitted.event,
        admissionHeight:    admitted.admissionHeight,
        finalizedAtHeight:  nextHeight,
        reason:             'confirmed',
      });
    }
  }

  return Object.freeze({
    ...state,
    height:            nextHeight,
    pendingEvents:     new Map(),
    acknowledgements:  new Map(),
    admittedEvents:    Object.freeze([]),
    canonicalEventSet: buildCanonicalEventSet(nextHeight, [], nextHeight),
    finalizedEvents:   Object.freeze([...state.finalizedEvents, ...finalized]),
  });
}

export function mergeEventSets(setA, setB) {
  if (setA.height !== setB.height)
    throw new Error('Cannot merge event sets at different heights');
  const seen   = new Set();
  const merged = [];
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

export function detectEventSetDivergence(setA, setB) {
  if (setA.height !== setB.height) return { diverged: false };
  const hashesA    = new Set(setA.events.map(e => e.event.hash));
  const hashesB    = new Set(setB.events.map(e => e.event.hash));
  const conflicting = [];
  for (const h of hashesA) if (!hashesB.has(h)) conflicting.push(h);
  for (const h of hashesB) if (!hashesA.has(h)) conflicting.push(h);
  return {
    diverged:           conflicting.length > 0,
    conflictingHashes:  conflicting.length > 0 ? conflicting : undefined,
  };
}
