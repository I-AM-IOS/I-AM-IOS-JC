// ════════════════════════════════════════════════════════════════════════════
//  sovereign-log-inline.js
//
//  Self-contained version of sovereign-log + bus for standalone HTML apps
//  (app-builder-v2.html, attack.html, generate-value.html, index1.html).
//
//  These apps are single-file HTML with no module bundler — paste the
//  contents of this file into their <script> block, then call:
//
//    sovereignLog.attachBus();        // join the cross-app bus
//    sovereignLog.emit({ type: 'X', ... });
//    sovereignLog.subscribe(fn);
//    const s = sovereignLog.deriveState();
//
//  The EVENT_TYPES for the shared bus are declared below. Each app may
//  extend with its own (just add to the LOCAL_TYPES object and handle in
//  your own reducer — the bus will carry them transparently).
// ════════════════════════════════════════════════════════════════════════════

(function(global) {
'use strict';

// ── FNV-32 ────────────────────────────────────────────────────────────────────
function fnv32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function hashEvent(payload, prevHash) { return fnv32(JSON.stringify(payload) + '|' + prevHash); }

// ── Shared EVENT_TYPES (must match sovereign-log.js) ─────────────────────────
const EVENT_TYPES = {
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
  // ── App-specific ────────────────────────────────────────────────────────
  APP_BUILT:             'APP_BUILT',           // app-builder: new app generated
  ATTACK_RUN:            'ATTACK_RUN',           // attack: security scan executed
  ATTACK_FINDING:        'ATTACK_FINDING',       // attack: finding recorded
  FABRIC_NODE_ADDED:     'FABRIC_NODE_ADDED',    // generate-value: P2P node joined
  FABRIC_COMPUTE:        'FABRIC_COMPUTE',       // generate-value: compute executed
  JSONFLOW_COMPILED:     'JSONFLOW_COMPILED',    // index1: NL→JSONFlow compilation
  JSONFLOW_CODE_EMITTED: 'JSONFLOW_CODE_EMITTED',// index1: code emission
};

// ── L4.5 Hybrid validator config ──────────────────────────────────────────────
// Reads from window.SOVEREIGN_CONFIG (injected by server.js or a manual <script>
// block placed before this file loads). Falls back to pure P2P if absent.
const _cfg = (typeof window !== 'undefined' && window.SOVEREIGN_CONFIG) || {};
const _validatorEndpoint  = _cfg.validatorEndpoint  || null;
const _fallbackTimeout    = _cfg.fallbackTimeout    || 2000;
const _checkInterval      = _cfg.checkInterval      || 5000;
let   _validatorOnline    = false;
let   _validatorProbeTimer = null;

// Lightweight fire-and-forget POST to the validator.
// Never throws — P2P behaviour is always the baseline.
function _postToValidator(record) {
  if (!_validatorEndpoint) return;
  const peerId = (typeof window !== 'undefined' && window._sovereignPeerId) || 'inline-unknown';
  fetch(_validatorEndpoint + '/events', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ event: record, browserPeerId: peerId }),
    signal:  AbortSignal.timeout(_fallbackTimeout),
  }).then(r => {
    _validatorOnline = r.ok;
  }).catch(() => {
    _validatorOnline = false;
  });
}

// Probe /health every _checkInterval so _validatorOnline stays fresh.
function _startValidatorProbe() {
  if (!_validatorEndpoint || _validatorProbeTimer) return;
  const probe = () => {
    fetch(_validatorEndpoint + '/health', {
      cache:  'no-store',
      signal: AbortSignal.timeout(_fallbackTimeout),
    }).then(r => { _validatorOnline = r.ok; }).catch(() => { _validatorOnline = false; });
  };
  probe();
  _validatorProbeTimer = setInterval(probe, _checkInterval);
}

// ── Core log ──────────────────────────────────────────────────────────────────
const _log        = [];
const _subs       = new Set();
let   _seq        = 0;
let   _prevHash   = '0000000000000000';

function emit(event) {
  const { type } = event ?? {};
  if (!EVENT_TYPES[type]) {
    // Unknown type: warn but don't throw in cross-app bus context
    console.warn(`[sovereign-log] Unknown type "${type}" — register in EVENT_TYPES`);
    return null;
  }
  const payload = { type, seq: _seq++, ts: Date.now(), ...event };
  const hash    = hashEvent(payload, _prevHash);
  const record  = { ...payload, hash, prevHash: _prevHash };
  _prevHash = hash;
  _log.push(record);
  // L4.5: forward to validator when endpoint is configured (non-blocking)
  if (!event._fromBus) _postToValidator(record);
  const state = deriveState(_log);
  for (const fn of _subs) { try { fn(state, record); } catch(_) {} }
  return record;
}

function subscribe(fn) {
  _subs.add(fn);
  fn(deriveState(_log), null);
  return () => _subs.delete(fn);
}

function getLog() { return _log.slice(); }

function deriveState(log) {
  log = log ?? _log;
  // Shared state fields (mirrors sovereign-log.js)
  let model = null, kernelModelA = '', kernelModelB = '';
  let activeTab = 'intel', streaming = false, ollamaOk = false;
  let kernelMode = false, kernelRunning = false;
  let intelHistory = [], kernelRuns = [], kernelViews = [];
  let flowModules = [], flowStage = 0, conversations = {};
  // App-specific accumulators
  let builtApps = [], attackFindings = [], fabricNodes = [], jsonflowModules = [];

  for (const e of log) {
    switch (e.type) {
      case 'OLLAMA_STATUS':    ollamaOk = e.ok; if (e.model) model = e.model; break;
      case 'MODEL_SELECTED':   model = e.model; if (e.slot==='A') kernelModelA=e.model; if (e.slot==='B') kernelModelB=e.model; break;
      case 'TAB_CHANGED':      activeTab = e.tab; break;
      case 'STREAMING_STARTED':streaming = true; break;
      case 'STREAMING_ENDED':  streaming = false; break;
      case 'INTEL_MESSAGE_ADDED': intelHistory = intelHistory.concat({role:e.role,content:e.content}); break;
      case 'INTEL_HISTORY_RESET': intelHistory = []; break;
      case 'KERNEL_MODE_TOGGLED': kernelMode = e.enabled; break;
      case 'KERNEL_STARTED':   kernelRunning = true; kernelViews = []; break;
      case 'KERNEL_VIEW_RESOLVED': kernelViews = kernelViews.concat(e.view); break;
      case 'KERNEL_ANALYSIS':  kernelRunning = false; kernelRuns = kernelRuns.concat({concept:e.concept,views:e.views,contradictionGraph:e.contradictionGraph,clusters:e.clusters,truthHash:e.truthHash,seq:e.seq,ts:e.ts}); kernelViews = []; break;
      case 'KERNEL_ERROR':     kernelRunning = false; break;
      case 'FLOW_STAGE_ENTERED': flowStage = e.stage; break;
      case 'FLOW_MODULE_DEFINED': flowModules = flowModules.filter(m=>m.name!==e.name).concat({name:e.name,ir:e.ir,outputs:{}}); break;
      case 'FLOW_CODE_EMITTED': flowModules = flowModules.map(m=>m.name===e.moduleName?{...m,outputs:{...m.outputs,[e.lang]:e.code}}:m); break;
      case 'MEMORY_IMPORTED':
      case 'MEMORY_MERGED': {
        const next = {...conversations};
        for (const c of (e.conversations??[])) { if (!next[c.uuid]) next[c.uuid]=c; }
        conversations = next; break;
      }
      case 'MEMORY_CLEARED': conversations = {}; break;
      // App-specific
      case 'APP_BUILT':          builtApps = builtApps.concat({name:e.name,html:e.html,ts:e.ts,seq:e.seq}); break;
      case 'ATTACK_FINDING':     attackFindings = attackFindings.concat({type:e.findingType,severity:e.severity,detail:e.detail,ts:e.ts}); break;
      case 'FABRIC_NODE_ADDED':  fabricNodes = fabricNodes.concat({id:e.nodeId,ts:e.ts}); break;
      case 'JSONFLOW_COMPILED':  jsonflowModules = jsonflowModules.filter(m=>m.name!==e.name).concat({name:e.name,ir:e.ir,ts:e.ts}); break;
    }
  }

  const convList = Object.values(conversations);
  return {
    model, kernelModelA, kernelModelB, activeTab, streaming, ollamaOk,
    kernelMode, kernelRunning, intelHistory, kernelViews,
    kernelRuns, flowModules, flowStage, conversations,
    memoryStats:{ total:convList.length, messages:convList.reduce((n,c)=>n+(c.msg_count??c.messages?.length??0),0) },
    eventCount: log.length,
    headHash: log.length ? log[log.length-1].hash : '0000000000000000',
    // App-specific projections
    builtApps, attackFindings, fabricNodes, jsonflowModules,
  };
}

function restore(savedLog) {
  // Verify chain, then replace log
  let p = '0000000000000000';
  for (const record of savedLog) {
    const { hash, prevHash, ...payload } = record;
    const expected = hashEvent(payload, p);
    if (hash !== expected) throw new Error(`[sovereign-log] Integrity failure at seq ${record.seq}`);
    p = hash;
  }
  _log.length = 0;
  _log.push(...savedLog);
  _seq = savedLog.length ? savedLog[savedLog.length-1].seq + 1 : 0;
  _prevHash = savedLog.length ? savedLog[savedLog.length-1].hash : '0000000000000000';
  const state = deriveState(_log);
  for (const fn of _subs) { try { fn(state, null); } catch(_) {} }
  return state;
}

// ── Cross-app BroadcastChannel bus ────────────────────────────────────────────
const CHANNEL = 'sovereign-os-bus';
let _ch = null;

function attachBus() {
  if (_ch) return;
  _startValidatorProbe();   // kick off L4.5 health probing
  _ch = new BroadcastChannel(CHANNEL);

  subscribe((_s, record) => {
    if (!record || record._fromBus) return;
    _ch.postMessage({ op: 'EMIT', record });
  });

  _ch.onmessage = ({ data }) => {
    if (!data?.op) return;
    switch (data.op) {
      case 'EMIT': {
        const r = data.record;
        if (_log.some(e => e.seq === r.seq)) break;
        const { type, ...rest } = r;
        try { emit({ ...rest, type, _fromBus: true }); } catch(_) {}
        break;
      }
      case 'SYNC_REQ': {
        const records = _log.filter(e => e.seq >= (data.fromSeq ?? 0));
        if (records.length) _ch.postMessage({ op: 'SYNC_RES', records });
        break;
      }
      case 'SYNC_RES': {
        if (!_log.length && data.records?.length) {
          try { restore(data.records); } catch(_) {}
        }
        break;
      }
      case 'RESTORE': {
        if (data.records?.length) { try { restore(data.records); } catch(_) {} }
        break;
      }
    }
  };

  if (!_log.length) _ch.postMessage({ op: 'SYNC_REQ', fromSeq: 0 });
  window.addEventListener('unload', () => _ch?.close());
}

function broadcastRestore() {
  _ch?.postMessage({ op: 'RESTORE', records: _log.slice() });
}

// ── Expose on global ──────────────────────────────────────────────────────────
global.sovereignLog = {
  emit, subscribe, getLog, deriveState, restore, attachBus, broadcastRestore, EVENT_TYPES,
  // L4.5 hybrid status — readable from app UI
  get validatorOnline() { return _validatorOnline; },
  get validatorEndpoint() { return _validatorEndpoint; },
};

})(window);
