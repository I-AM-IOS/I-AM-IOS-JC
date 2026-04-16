// ════════════════════════════════════════════════════════════════════════════
//  sovereign-compute-bridge.js  —  JSONFlow ↔ UDCSEF Compute Bridge
//
//  Connects:
//    index1.html (Genesis/JSONFlow compiler) → UDCSEF distributed fabric
//    generate-value.html (UDCSEF fabric)     → sovereign-log audit trail
//
//  Flow:
//    index1.html emits JSONFLOW_COMPILED { ir: <JSONFlow module> }
//      → this bridge content-addresses the program (fnv32 of JSON)
//      → broadcasts COMPUTE_JOB to UDCSEF fabric peers via PeerJS
//      → fabric nodes execute the JSONFlow IR
//      → results arrive as FABRIC_COMPUTE events
//      → this bridge emits COMPUTE_RESULT into sovereign-log
//      → rekernel finalizes the result (consensus on output)
//
//  JSONFlow IR shape (from index1.html):
//    {
//      module_name: string,
//      version: string,
//      inputs: [{ name, type }],
//      outputs: [{ name, type }],
//      steps: [{ id, op, inputs, outputs }],
//      constraints: [...],
//    }
//
//  Usage (in generate-value.html, inside peer.on('data') handler):
//    import { attachComputeBridge } from './sovereign-compute-bridge.js';
//    attachComputeBridge({ peer, emit, subscribe });
// ════════════════════════════════════════════════════════════════════════════

// ── FNV-32 hash (program content address) ────────────────────────────────────
function fnv32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── Content-address a JSONFlow program ───────────────────────────────────────
export function programHash(ir) {
  return fnv32(JSON.stringify({
    module_name: ir.module_name,
    version:     ir.version,
    inputs:      ir.inputs,
    outputs:     ir.outputs,
    steps:       ir.steps,
  }));
}

// ────────────────────────────────────────────────────────────────────────────
//  JSONFlow IR Executor
//  Minimal deterministic executor for JSONFlow IR.
//  Each step is a pure function: { op, inputs → outputs }.
//  No side effects, no I/O, no timestamps — deterministic by construction.
// ────────────────────────────────────────────────────────────────────────────

export class JSONFlowExecutor {
  constructor() {
    this._ops = new Map();
    this._registerBuiltins();
  }

  // ── Register a custom op ─────────────────────────────────────────────────
  registerOp(name, fn) {
    this._ops.set(name, fn);
    return this;
  }

  // ── Execute a JSONFlow IR module ─────────────────────────────────────────
  // Returns { outputs, trace, success, error? }
  execute(ir, inputs = {}) {
    const env   = { ...inputs };
    const trace = [];

    for (const step of (ir.steps ?? [])) {
      const fn = this._ops.get(step.op);
      if (!fn) {
        const error = `Unknown op: ${step.op}`;
        trace.push({ step: step.id, op: step.op, error });
        return { outputs: null, trace, success: false, error };
      }

      // Gather step inputs from env
      const stepInputs = {};
      for (const [key, ref] of Object.entries(step.inputs ?? {})) {
        stepInputs[key] = typeof ref === 'string' && ref.startsWith('$')
          ? env[ref.slice(1)]
          : ref;
      }

      try {
        const result = fn(stepInputs, env);
        // Write outputs to env
        for (const [key, ref] of Object.entries(step.outputs ?? {})) {
          const outputKey = typeof ref === 'string' && ref.startsWith('$')
            ? ref.slice(1)
            : ref;
          env[outputKey] = result[key];
        }
        trace.push({ step: step.id, op: step.op, inputs: stepInputs, outputs: result });
      } catch (err) {
        trace.push({ step: step.id, op: step.op, error: err.message });
        return { outputs: null, trace, success: false, error: err.message };
      }
    }

    // Collect declared outputs
    const outputs = {};
    for (const decl of (ir.outputs ?? [])) {
      outputs[decl.name] = env[decl.name];
    }

    return { outputs, trace, success: true };
  }

  // ── Built-in ops ─────────────────────────────────────────────────────────
  _registerBuiltins() {
    // Arithmetic
    this._ops.set('add',      ({ a, b }) => ({ result: a + b }));
    this._ops.set('subtract', ({ a, b }) => ({ result: a - b }));
    this._ops.set('multiply', ({ a, b }) => ({ result: a * b }));
    this._ops.set('divide',   ({ a, b }) => ({ result: b !== 0 ? a / b : null }));
    this._ops.set('mod',      ({ a, b }) => ({ result: a % b }));

    // String
    this._ops.set('concat',   ({ parts })  => ({ result: parts.join('') }));
    this._ops.set('split',    ({ str, sep }) => ({ result: str.split(sep) }));
    this._ops.set('trim',     ({ str })    => ({ result: str.trim() }));
    this._ops.set('upper',    ({ str })    => ({ result: str.toUpperCase() }));
    this._ops.set('lower',    ({ str })    => ({ result: str.toLowerCase() }));

    // Array
    this._ops.set('map',      ({ arr, fn }) => ({ result: arr.map(fn) }));
    this._ops.set('filter',   ({ arr, fn }) => ({ result: arr.filter(fn) }));
    this._ops.set('reduce',   ({ arr, fn, init }) => ({ result: arr.reduce(fn, init) }));
    this._ops.set('length',   ({ arr })    => ({ result: arr.length }));
    this._ops.set('head',     ({ arr, n }) => ({ result: arr.slice(0, n ?? 1) }));
    this._ops.set('tail',     ({ arr, n }) => ({ result: arr.slice(-(n ?? 1)) }));
    this._ops.set('sort',     ({ arr })    => ({ result: [...arr].sort() }));
    this._ops.set('unique',   ({ arr })    => ({ result: [...new Set(arr)] }));
    this._ops.set('flatten',  ({ arr })    => ({ result: arr.flat() }));
    this._ops.set('zip',      ({ a, b })   => ({ result: a.map((v, i) => [v, b[i]]) }));

    // Object
    this._ops.set('get',      ({ obj, key })        => ({ result: obj[key] }));
    this._ops.set('set',      ({ obj, key, value }) => ({ result: { ...obj, [key]: value } }));
    this._ops.set('keys',     ({ obj })             => ({ result: Object.keys(obj) }));
    this._ops.set('values',   ({ obj })             => ({ result: Object.values(obj) }));
    this._ops.set('entries',  ({ obj })             => ({ result: Object.entries(obj) }));
    this._ops.set('merge',    ({ a, b })            => ({ result: { ...a, ...b } }));
    this._ops.set('pick',     ({ obj, keys })       => ({
      result: Object.fromEntries(keys.map(k => [k, obj[k]])),
    }));

    // Logic
    this._ops.set('if',   ({ cond, then: t, else: e }) => ({ result: cond ? t : e }));
    this._ops.set('and',  ({ a, b }) => ({ result: a && b }));
    this._ops.set('or',   ({ a, b }) => ({ result: a || b }));
    this._ops.set('not',  ({ val })  => ({ result: !val }));
    this._ops.set('eq',   ({ a, b }) => ({ result: a === b }));
    this._ops.set('lt',   ({ a, b }) => ({ result: a < b }));
    this._ops.set('gt',   ({ a, b }) => ({ result: a > b }));

    // Hash / identity
    this._ops.set('hash', ({ val }) => ({ result: fnv32(JSON.stringify(val)) }));
    this._ops.set('identity', ({ val }) => ({ result: val }));
    this._ops.set('constant', ({ value }) => ({ result: value }));
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  attachComputeBridge
//  Wire generate-value.html's PeerJS peer to sovereign-log events
//  and JSONFlow execution.
//
//  Call this ONCE inside generate-value.html after PeerJS peer is ready.
//  It intercepts COMPUTE_JOB messages from peers and runs them locally.
// ────────────────────────────────────────────────────────────────────────────

export function attachComputeBridge({ peer, emit, subscribe }) {
  const executor = new JSONFlowExecutor();
  const jobsSeen = new Set();

  // ── Handle incoming COMPUTE_JOB from peers ──────────────────────────────
  // Monkey-patch into PeerJS data handler
  const _originalOnData = peer.options?.onData;
  function handleData(data, fromPeerId) {
    if (data?.type !== 'COMPUTE_JOB') return false;

    const { programHash: hash, program, submittedBy, ts } = data;
    if (jobsSeen.has(hash)) return true;
    jobsSeen.add(hash);

    // Execute the JSONFlow program deterministically
    const result = executor.execute(program, program.defaultInputs ?? {});

    // Emit result into sovereign-log
    try {
      emit({
        type:        'FABRIC_COMPUTE',
        nodeId:      peer.id,
        programHash: hash,
        programName: program.module_name,
        result:      result.outputs,
        trace:       result.trace,
        success:     result.success,
        submittedBy,
        executedAt:  Date.now(),
        jobTs:       ts,
      });
    } catch (_) {}

    // Send result back to submitter
    const submitterConn = [...(peer._connections?.values() ?? [])]
      .flat()
      .find(c => c.peer === submittedBy);
    if (submitterConn) {
      submitterConn.send({
        type:        'COMPUTE_RESULT',
        programHash: hash,
        result:      result.outputs,
        success:     result.success,
        executedBy:  peer.id,
        ts:          Date.now(),
      });
    }

    return true;   // handled
  }

  // ── Subscribe to sovereign-log to catch JSONFLOW_COMPILED from other tabs ──
  subscribe((state, record) => {
    if (!record || record.type !== 'JSONFLOW_COMPILED') return;
    const { ir } = record;
    if (!ir) return;

    const hash = programHash(ir);
    if (jobsSeen.has(hash)) return;
    jobsSeen.add(hash);

    // Execute locally and emit result
    const result = executor.execute(ir, ir.defaultInputs ?? {});
    try {
      emit({
        type:        'FABRIC_COMPUTE',
        nodeId:      'local:' + (typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 20) : 'node'),
        programHash: hash,
        programName: ir.module_name,
        result:      result.outputs,
        trace:       result.trace,
        success:     result.success,
        submittedBy: 'bus',
        executedAt:  Date.now(),
      });
    } catch (_) {}
  });

  return {
    executor,
    handleData,
    registerOp: (name, fn) => executor.registerOp(name, fn),
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  addComputeEventTypes
//  Call this BEFORE attachNetwork to register compute event types.
//  Merges into sovereign-log's EVENT_TYPES registry.
// ────────────────────────────────────────────────────────────────────────────

export function addComputeEventTypes(EVENT_TYPES) {
  const newTypes = {
    FABRIC_NODE_ADDED:      'FABRIC_NODE_ADDED',
    FABRIC_NODE_LEFT:       'FABRIC_NODE_LEFT',
    FABRIC_COMPUTE:         'FABRIC_COMPUTE',
    FABRIC_COMPUTE_FAILED:  'FABRIC_COMPUTE_FAILED',
    APP_BUILT:              'APP_BUILT',
    JSONFLOW_COMPILED:      'JSONFLOW_COMPILED',
    JSONFLOW_CODE_EMITTED:  'JSONFLOW_CODE_EMITTED',
    ATTACK_RUN:             'ATTACK_RUN',
    ATTACK_FINDING:         'ATTACK_FINDING',
    NET_PEER_CONNECTED:     'NET_PEER_CONNECTED',
    NET_PEER_DROPPED:       'NET_PEER_DROPPED',
    NET_EVENT_PROMOTED:     'NET_EVENT_PROMOTED',
    CONSENSUS_FINALIZED:    'CONSENSUS_FINALIZED',
    CONSENSUS_REJECTED:     'CONSENSUS_REJECTED',
    LEDGER_SNAPSHOT:        'LEDGER_SNAPSHOT',
  };
  Object.assign(EVENT_TYPES, newTypes);
  return EVENT_TYPES;
}

// ────────────────────────────────────────────────────────────────────────────
//  addComputeReducers
//  Add deriveState() reducer cases for compute events.
//  Call this by patching your deriveState switch.
//
//  Example:
//    function deriveState(log) {
//      const s = { ...baseState };
//      for (const r of log) {
//        switch (r.type) {
//          // ... existing cases ...
//          default: deriveComputeState(s, r);
//        }
//      }
//      return s;
//    }
// ────────────────────────────────────────────────────────────────────────────

export function deriveComputeState(state, record) {
  switch (record.type) {

    case 'FABRIC_NODE_ADDED':
      if (!state.fabricNodes) state.fabricNodes = [];
      if (!state.fabricNodes.find(n => n.nodeId === record.nodeId)) {
        state.fabricNodes.push({ nodeId: record.nodeId, joinedAt: record.ts });
      }
      break;

    case 'FABRIC_NODE_LEFT':
      if (state.fabricNodes) {
        state.fabricNodes = state.fabricNodes.filter(n => n.nodeId !== record.nodeId);
      }
      break;

    case 'FABRIC_COMPUTE':
      if (!state.computeResults) state.computeResults = [];
      state.computeResults.push({
        programHash: record.programHash,
        programName: record.programName,
        result:      record.result,
        success:     record.success,
        nodeId:      record.nodeId,
        executedAt:  record.executedAt,
      });
      // Also index by hash for fast lookup
      if (!state.computeIndex) state.computeIndex = {};
      state.computeIndex[record.programHash] = record.result;
      break;

    case 'APP_BUILT':
      if (!state.builtApps) state.builtApps = [];
      state.builtApps.push({
        name:     record.name,
        template: record.template,
        theme:    record.theme,
        ts:       record.ts,
      });
      break;

    case 'JSONFLOW_COMPILED':
      if (!state.jsonflowModules) state.jsonflowModules = [];
      state.jsonflowModules.push({
        name:    record.name ?? record.ir?.module_name,
        ir:      record.ir,
        ts:      record.ts,
      });
      break;

    case 'JSONFLOW_CODE_EMITTED':
      if (!state.emittedCode) state.emittedCode = [];
      state.emittedCode.push({
        name: record.name,
        lang: record.lang,
        code: record.code,
        ts:   record.ts,
      });
      break;

    case 'ATTACK_RUN':
      if (!state.attackRuns) state.attackRuns = [];
      state.attackRuns.push({
        target:   record.target,
        scanType: record.scanType,
        ts:       record.ts,
      });
      break;

    case 'ATTACK_FINDING':
      if (!state.attackFindings) state.attackFindings = [];
      state.attackFindings.push({
        findingType: record.findingType,
        severity:    record.severity,
        detail:      record.detail,
        ts:          record.ts,
      });
      break;

    case 'CONSENSUS_FINALIZED':
      if (!state.finalizedEvents) state.finalizedEvents = [];
      state.finalizedEvents.push({
        contentHash:  record.contentHash,
        originalType: record.originalType,
        ackerCount:   record.ackerCount,
        finalizedAt:  record.finalizedAt,
      });
      break;

    case 'LEDGER_SNAPSHOT':
      state.lastSnapshotHeight = record.height;
      state.lastSnapshotTs     = record.ts;
      break;
  }
}
