// ════════════════════════════════════════════════════════════════════════════
//  sovereign-log.js  —  v2 (production)
//
//  Invariant: SystemState(n) = deriveState(eventLog[0..n])
//
//  Hard rules enforced structurally:
//    1. log is never exposed by reference — getLog() returns a copy
//    2. deriveState is a pure function — no in-place mutation, no shared refs
//    3. hash input = payload fields only + prevHash threaded separately
//       (record's own hash/prevHash are NOT hashed — avoids circular dependency)
//    4. emit() is synchronous — no async leaking into the invariant core
//    5. Unknown event types throw — silent drops hide bugs
// ════════════════════════════════════════════════════════════════════════════

// ── Deterministic sync hash (FNV-1a 32-bit) ──────────────────────────────────
function fnv32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function hashEvent(payload, prevHash) {
  return fnv32(JSON.stringify(payload) + '|' + prevHash);
}

// ── Event registry ───────────────────────────────────────────────────────────
export const EVENT_TYPES = {
  MODEL_SELECTED:        'MODEL_SELECTED',
  TAB_CHANGED:           'TAB_CHANGED',
  STREAMING_STARTED:     'STREAMING_STARTED',
  STREAMING_ENDED:       'STREAMING_ENDED',
  OLLAMA_STATUS:         'OLLAMA_STATUS',

  INTEL_MESSAGE_ADDED:   'INTEL_MESSAGE_ADDED',
  INTEL_HISTORY_RESET:   'INTEL_HISTORY_RESET',

  KERNEL_MODE_TOGGLED:   'KERNEL_MODE_TOGGLED',
  KERNEL_STARTED:        'KERNEL_STARTED',
  KERNEL_VIEW_RESOLVED:  'KERNEL_VIEW_RESOLVED',
  KERNEL_ANALYSIS:       'KERNEL_ANALYSIS',
  KERNEL_ERROR:          'KERNEL_ERROR',

  FLOW_STAGE_ENTERED:    'FLOW_STAGE_ENTERED',
  FLOW_MODULE_DEFINED:   'FLOW_MODULE_DEFINED',
  FLOW_COMPILED:         'FLOW_COMPILED',
  FLOW_CODE_EMITTED:     'FLOW_CODE_EMITTED',

  MEMORY_IMPORTED:       'MEMORY_IMPORTED',
  MEMORY_MERGED:         'MEMORY_MERGED',
  MEMORY_CLEARED:        'MEMORY_CLEARED',

  SNAPSHOT:              'SNAPSHOT',
};

// ── Core log (module-private, never exposed by reference) ────────────────────
const _log        = [];
const _subscribers = new Set();
let _seq      = 0;
let _prevHash = '0000000000000000';

// ── emit — the only write operation in the entire system ─────────────────────
export function emit(event) {
  const { type } = event ?? {};
  if (!EVENT_TYPES[type]) {
    throw new Error(`[sovereign-log] Unknown event type: "${type}". Register it in EVENT_TYPES first.`);
  }

  const payload = { type, seq: _seq++, ts: Date.now(), ...event };
  const hash    = hashEvent(payload, _prevHash);
  const record  = { ...payload, hash, prevHash: _prevHash };

  _prevHash = hash;
  _log.push(record);

  const state = deriveState(_log);
  for (const fn of _subscribers) fn(state, record);

  return record;
}

// ── deriveState — pure function, no side effects, no shared refs ─────────────
export function deriveState(log = _log) {
  let model          = null;
  let kernelModelA   = '';
  let kernelModelB   = '';
  let activeTab      = 'intel';
  let streaming      = false;
  let ollamaOk       = false;
  let kernelMode     = false;
  let kernelRunning  = false;
  let intelHistory   = [];
  let kernelRuns     = [];
  let kernelViews    = [];
  let flowModules    = [];
  let flowStage      = 0;
  let conversations  = {};

  for (const e of log) {
    switch (e.type) {

      case EVENT_TYPES.OLLAMA_STATUS:
        ollamaOk = e.ok;
        if (e.model) model = e.model;
        break;

      case EVENT_TYPES.MODEL_SELECTED:
        model = e.model;
        if (e.slot === 'A') kernelModelA = e.model;
        if (e.slot === 'B') kernelModelB = e.model;
        break;

      case EVENT_TYPES.TAB_CHANGED:
        activeTab = e.tab;
        break;

      case EVENT_TYPES.STREAMING_STARTED:
        streaming = true;
        break;

      case EVENT_TYPES.STREAMING_ENDED:
        streaming = false;
        break;

      case EVENT_TYPES.INTEL_MESSAGE_ADDED:
        intelHistory = intelHistory.concat({ role: e.role, content: e.content });
        break;

      case EVENT_TYPES.INTEL_HISTORY_RESET:
        intelHistory = [];
        break;

      case EVENT_TYPES.KERNEL_MODE_TOGGLED:
        kernelMode = e.enabled;
        break;

      case EVENT_TYPES.KERNEL_STARTED:
        kernelRunning = true;
        kernelViews   = [];
        break;

      case EVENT_TYPES.KERNEL_VIEW_RESOLVED:
        kernelViews = kernelViews.concat(e.view);
        break;

      case EVENT_TYPES.KERNEL_ANALYSIS:
        kernelRunning = false;
        kernelRuns    = kernelRuns.concat({
          concept:            e.concept,
          views:              e.views,
          contradictionGraph: e.contradictionGraph,
          clusters:           e.clusters,
          truthHash:          e.truthHash,
          seq:                e.seq,
          ts:                 e.ts,
        });
        kernelViews = [];
        break;

      case EVENT_TYPES.KERNEL_ERROR:
        kernelRunning = false;
        break;

      case EVENT_TYPES.FLOW_STAGE_ENTERED:
        flowStage = e.stage;
        break;

      case EVENT_TYPES.FLOW_MODULE_DEFINED:
        flowModules = flowModules
          .filter(m => m.name !== e.name)
          .concat({ name: e.name, ir: e.ir, outputs: {} });
        break;

      case EVENT_TYPES.FLOW_CODE_EMITTED:
        flowModules = flowModules.map(m =>
          m.name === e.moduleName
            ? { ...m, outputs: { ...m.outputs, [e.lang]: e.code } }
            : m
        );
        break;

      case EVENT_TYPES.MEMORY_IMPORTED:
      case EVENT_TYPES.MEMORY_MERGED: {
        const next = { ...conversations };
        for (const c of (e.conversations ?? [])) {
          if (!next[c.uuid]) next[c.uuid] = c;
        }
        conversations = next;
        break;
      }

      case EVENT_TYPES.MEMORY_CLEARED:
        conversations = {};
        break;
    }
  }

  const convList    = Object.values(conversations);
  const memoryStats = {
    total:    convList.length,
    messages: convList.reduce((n, c) => n + (c.msg_count ?? c.messages?.length ?? 0), 0),
    sources:  new Set(convList.map(c => c.source).filter(Boolean)).size,
  };

  return {
    model, kernelModelA, kernelModelB,
    activeTab, streaming, ollamaOk,
    kernelMode, kernelRunning,
    intelHistory, kernelViews,
    kernelRuns, flowModules, flowStage,
    conversations, memoryStats,
    eventCount: log.length,
    headHash:   log.length ? log[log.length - 1].hash : '0000000000000000',
  };
}

// ── subscribe ────────────────────────────────────────────────────────────────
export function subscribe(fn) {
  _subscribers.add(fn);
  fn(deriveState(_log), null);
  return () => _subscribers.delete(fn);
}

// ── getLog ───────────────────────────────────────────────────────────────────
export function getLog() {
  return _log.slice();
}

// ── snapshot ─────────────────────────────────────────────────────────────────
export function snapshot() {
  return { log: _log.slice(), head: _prevHash, seq: _seq };
}

// ── replay — verifiable restore (throws on tamper) ───────────────────────────
// Reconstructs payload slice (strips hash + prevHash) to match what emit() hashed.
export function replay(savedLog) {
  let p = '0000000000000000';

  for (const record of savedLog) {
    const { hash, prevHash, ...payload } = record;
    const expected = hashEvent(payload, p);

    if (hash !== expected) {
      throw new Error(
        `[sovereign-log] Integrity failure at seq ${record.seq}. ` +
        `Expected ${expected}, got ${hash}. Log may be tampered.`
      );
    }
    p = hash;
  }

  return deriveState(savedLog);
}

// ── restore — load verified snapshot into live log ───────────────────────────
export function restore(savedLog) {
  const state   = replay(savedLog);       // throws if invalid — safe gate
  _log.length   = 0;
  _log.push(...savedLog);
  _seq          = savedLog.length ? savedLog[savedLog.length - 1].seq + 1 : 0;
  _prevHash     = savedLog.length ? savedLog[savedLog.length - 1].hash  : '0000000000000000';
  for (const fn of _subscribers) fn(state, null);
  return state;
}

// ── projections — named read-only views, never stored state ──────────────────
export const project = {

  kernelHistory: (log = _log) =>
    log
      .filter(e => e.type === EVENT_TYPES.KERNEL_ANALYSIS)
      .map(e => ({ concept: e.concept, graph: e.contradictionGraph, hash: e.truthHash, ts: e.ts })),

  viewsForConcept: (concept, log = _log) =>
    log
      .filter(e => e.type === EVENT_TYPES.KERNEL_VIEW_RESOLVED && e.concept === concept)
      .map(e => e.view),

  conceptAudit: (concept, log = _log) =>
    log
      .filter(e => e.type === EVENT_TYPES.KERNEL_ANALYSIS && e.concept === concept)
      .map(e => ({ truthHash: e.truthHash, seq: e.seq, ts: e.ts })),

  memoryTimeline: (log = _log) =>
    log
      .filter(e => [EVENT_TYPES.MEMORY_IMPORTED, EVENT_TYPES.MEMORY_MERGED, EVENT_TYPES.MEMORY_CLEARED].includes(e.type))
      .map(e => ({ type: e.type, count: e.conversations?.length ?? 0, seq: e.seq, ts: e.ts })),

  compiledFlows: (log = _log) =>
    log
      .filter(e => e.type === EVENT_TYPES.FLOW_COMPILED)
      .map(e => ({ moduleName: e.moduleName, ir: e.ir, seq: e.seq, ts: e.ts })),

  slice: (fromSeq, toSeq, log = _log) =>
    log.filter(e => e.seq >= fromSeq && e.seq <= toSeq),
};
