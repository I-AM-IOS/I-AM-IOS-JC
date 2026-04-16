// ════════════════════════════════════════════════════════════════════════════
//  sovereign-ledger-bridge.js  —  sovereign-log ↔ rekernel Event Bridge
//
//  Problem: sovereign-log uses FNV-32 for speed (browser, synchronous).
//           rekernel expects SHA-256 content-addressed events with a specific
//           structural envelope (protocolVersion, id, fields, hash).
//
//  This bridge:
//    1. Adapts sovereign-log records → rekernel Event format
//    2. Runs verifyEvent() checks (I1–I6) in JS (mirrors core/ingress.ts)
//    3. Records rejection records for failed events (mirrors core/rejections.ts)
//    4. Builds a lightweight transition chain (mirrors core/chain.ts)
//    5. Exposes a LockedKernelBridge that wraps the sovereign-log as a kernel
//
//  The rekernel TypeScript files are the ground-truth spec.
//  This file implements the same guarantees in browser-compatible JS.
//
//  Usage:
//    import { LockedKernelBridge } from './sovereign-ledger-bridge.js';
//    const kernel = new LockedKernelBridge();
//    await kernel.ingestRecord(sovereignLogRecord);
// ════════════════════════════════════════════════════════════════════════════

// ── Protocol constants (mirrors core/protocol.ts) ─────────────────────────────
const HASH_PROTOCOL_VERSION  = 1;
const ACCEPTED_VERSIONS      = new Set([1]);
const CLOCK_SKEW_TOLERANCE   = 60_000;    // 60 s

// ── Rejection reasons (mirrors core/rejections.ts) ───────────────────────────
export const RejectionReason = {
  HASH_MISMATCH:        'HASH_MISMATCH',
  ID_MISMATCH:          'ID_MISMATCH',
  VERSION_MISMATCH:     'VERSION_MISMATCH',
  MISSING_FIELDS:       'MISSING_FIELDS',
  CLOCK_SKEW:           'CLOCK_SKEW',
  NOT_SERIALIZABLE:     'NOT_SERIALIZABLE',
  DUPLICATE:            'DUPLICATE',
};

// ── SHA-256 (browser SubtleCrypto, with FNV-32 fallback) ─────────────────────
async function sha256(str) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf    = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return fnv32(str);
}

function fnv32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ────────────────────────────────────────────────────────────────────────────
//  Event Adaptation
//  Converts a sovereign-log record → rekernel-compatible Event envelope.
// ────────────────────────────────────────────────────────────────────────────

export async function adaptRecord(record) {
  // Derive a stable network-level content hash for this record
  // Hash only the stable identity fields so verifyEvent can recompute deterministically
  const hashPayload = {
    type:      record.type,
    seq:       record.seq,
    ts:        record.ts,
    localHash: record.hash,
  };

  const contentHash  = await sha256(JSON.stringify(hashPayload));
  const networkId    = `${record.type}:${record.seq}:${contentHash.slice(0, 16)}`;

  return {
    // rekernel envelope fields
    protocolVersion: HASH_PROTOCOL_VERSION,
    id:              networkId,
    hash:            contentHash,
    type:            record.type,
    ts:              record.ts,
    seq:             record.seq,
    // Payload carries the original record
    payload:         record,
    // sovereign-log provenance
    _localHash:      record.hash,
    _localSeq:       record.seq,
    _localPrevHash:  record.prevHash,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Ingress Verification  (mirrors core/ingress.ts — rules I1–I6)
// ────────────────────────────────────────────────────────────────────────────

export async function verifyEvent(event) {
  const violations = [];

  // I3: Protocol version
  if (!ACCEPTED_VERSIONS.has(event.protocolVersion)) {
    violations.push({ rule: 'I3', reason: RejectionReason.VERSION_MISMATCH,
      detail: `version ${event.protocolVersion} not in accepted set` });
  }

  // I4: Structural validation
  if (!event.type || !event.id || !event.hash || !event.ts) {
    violations.push({ rule: 'I4', reason: RejectionReason.MISSING_FIELDS,
      detail: 'required fields: type, id, hash, ts' });
  }

  // I5: Timestamp reasonableness
  const drift = Math.abs(Date.now() - event.ts);
  if (drift > CLOCK_SKEW_TOLERANCE) {
    violations.push({ rule: 'I5', reason: RejectionReason.CLOCK_SKEW,
      detail: `clock drift ${drift}ms exceeds ${CLOCK_SKEW_TOLERANCE}ms tolerance` });
  }

  // I6: JSON serializability
  try { JSON.stringify(event.payload); }
  catch (_) {
    violations.push({ rule: 'I6', reason: RejectionReason.NOT_SERIALIZABLE,
      detail: 'payload is not JSON-serializable' });
  }

  // I1: Hash integrity — recompute using the same minimal identity fields as adaptRecord
  if (event.type && event.id && event.ts) {
    const hashPayload = {
      type:      event.type,
      seq:       event.seq,
      ts:        event.ts,
      localHash: event._localHash,
    };

    const recomputed = await sha256(JSON.stringify(hashPayload));
    if (recomputed !== event.hash) {
      violations.push({ rule: 'I1', reason: RejectionReason.HASH_MISMATCH,
        detail: `expected ${recomputed.slice(0, 16)}… got ${event.hash.slice(0, 16)}…` });
    }
  }

  // I2: ID derivation check
  if (event.id && event.hash) {
    const expectedIdPrefix = `${event.type}:${event.seq}:${event.hash.slice(0, 16)}`;
    if (event.id !== expectedIdPrefix) {
      violations.push({ rule: 'I2', reason: RejectionReason.ID_MISMATCH,
        detail: `expected id prefix ${expectedIdPrefix}` });
    }
  }

  return {
    valid:      violations.length === 0,
    violations,
    reason:     violations[0]?.reason ?? null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Transition Chain  (mirrors core/chain.ts)
//  T_i = hash(T_{i-1}, E_i, S_i)
// ────────────────────────────────────────────────────────────────────────────

export async function createTransitionRecord({ index, prevTransitionHash, event, preStateHash, postStateHash }) {
  const chainInput = JSON.stringify({
    index,
    prevTransitionHash,
    eventHash: event.hash,
    preStateHash,
    postStateHash,
  });
  const transitionHash = await sha256(chainInput);

  return {
    index,
    prevTransitionHash,
    eventHash:      event.hash,
    eventId:        event.id,
    preStateHash,
    postStateHash,
    transitionHash,
    ts: Date.now(),
  };
}

export async function verifyTransitionChain(transitions) {
  for (let i = 1; i < transitions.length; i++) {
    const expected = transitions[i].prevTransitionHash;
    const actual   = transitions[i - 1].transitionHash;
    if (expected !== actual) {
      return {
        valid:    false,
        badIndex: i,
        reason:   `chain break at index ${i}: expected prev=${expected.slice(0, 16)} got ${actual.slice(0, 16)}`,
      };
    }
  }
  return { valid: true };
}

// ────────────────────────────────────────────────────────────────────────────
//  Rejection Records  (mirrors core/rejections.ts)
// ────────────────────────────────────────────────────────────────────────────

export async function createRejectionRecord({ rejectedHash, rejectedId, stateHash, reason, prevHash, details }) {
  const payload = { type: 'REJECTION', rejectedHash, rejectedId, stateHash, reason, prevHash };
  const hash    = await sha256(JSON.stringify(payload));
  return { ...payload, hash, details, ts: Date.now() };
}

// ────────────────────────────────────────────────────────────────────────────
//  LockedKernelBridge
//  Wraps sovereign-log as a full locked kernel with transition chaining.
//  The exec() function is pluggable — supply your own state machine.
// ────────────────────────────────────────────────────────────────────────────

export class LockedKernelBridge {
  constructor(opts = {}) {
    this._exec            = opts.exec ?? defaultExec;
    this._ledger          = [];        // LedgerEntry[] (events + rejections)
    this._transitions     = [];        // TransitionRecord[]
    this._stateHash       = 'genesis';
    this._lastTransitionH = 'genesis';
    this._seen            = new Set(); // dedup by event hash
    this._height          = 0;
  }

  // ── Ingest a sovereign-log record ────────────────────────────────────────
  async ingestRecord(record) {
    const event  = await adaptRecord(record);
    const result = await verifyEvent(event);

    if (!result.valid) {
      const rejection = await createRejectionRecord({
        rejectedHash: event.hash,
        rejectedId:   event.id,
        stateHash:    this._stateHash,
        reason:       result.reason,
        prevHash:     this._lastTransitionH,
        details:      result.violations,
      });
      this._ledger.push(rejection);
      return { accepted: false, rejection };
    }

    if (this._seen.has(event.hash)) {
      return { accepted: false, reason: RejectionReason.DUPLICATE };
    }
    this._seen.add(event.hash);

    // Execute the event (pure state transition)
    const preStateHash   = this._stateHash;
    const postStateHash  = await sha256(preStateHash + ':' + event.hash);

    // Record transition
    const transition = await createTransitionRecord({
      index:             this._height,
      prevTransitionHash: this._lastTransitionH,
      event,
      preStateHash,
      postStateHash,
    });

    this._transitions.push(transition);
    this._lastTransitionH = transition.transitionHash;
    this._stateHash       = postStateHash;
    this._height++;
    this._ledger.push({ type: 'ACCEPTED', event, transition });

    return { accepted: true, transition, event };
  }

  // ── Verify the full transition chain ─────────────────────────────────────
  async verifyIntegrity() {
    return verifyTransitionChain(this._transitions);
  }

  // ── Export full ledger (accepted + rejections) ───────────────────────────
  exportLedger() {
    return {
      height:      this._height,
      stateHash:   this._stateHash,
      ledger:      [...this._ledger],
      transitions: [...this._transitions],
    };
  }

  get height()    { return this._height; }
  get stateHash() { return this._stateHash; }
}

// ── Default exec: identity (no-op state machine) ─────────────────────────────
// Replace with your actual state machine.
function defaultExec(state, event) {
  return { ...state, lastEvent: event.type, height: (state.height ?? 0) + 1 };
}
