/**
 * jsonflow.js
 * Genesis — Stage 2: Genesis module → JSONFlow IR (deterministic, no LLM)
 *
 * Copyright (c) 2026 Sovereign OS Contributors
 *
 * This file is part of Sovereign Net OS / DDC Infrastructure.
 * Licensed under the Sovereign OS Community License (LICENSE-COMMUNITY).
 * Commercial use requires a separate Commercial License (LICENSE-COMMERCIAL).
 *
 * Core invariant: VM_stateₙ = deriveState(eventLog[0…n])
 *
 * Retain this notice in all copies and derivative works.
 */
// js/jsonflow.js — Stage 2: Genesis → JSONFlow (deterministic compiler, no LLM)
'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _cmp(left, op, right) {
  return { compare: { left, op, right } };
}
function _get(name)        { return { get: name }; }
function _getP(obj, prop)  { return { get: [obj, prop] }; }  // property access
function _val(v)           { return { value: v }; }
function _add(a, b)        { return { add: [a, b] }; }
function _sub(a, b)        { return { subtract: [a, b] }; }
function _mul(a, b)        { return { multiply: [a, b] }; }
function _div(a, b)        { return { divide: [a, b] }; }
function _set(target, val) { return { type: 'set', target, value: val }; }
function _ret(val)         { return { type: 'return', value: val }; }
function _if(cond, thn, els) {
  return { type: 'if', condition: cond, then: thn, else: els || [] };
}
function _foreach(itemVar, iterable, body) {
  return { type: 'foreach', item_var: itemVar, iterable, body };
}
function _log(msg) { return { type: 'log', level: 'info', message: _val(msg) }; }

// ─── Classify events by role ──────────────────────────────────────────────────
function classifyEvents(events) {
  const names = Object.keys(events);
  const REQUEST_RE  = /request|creat|add|book|register|send|open|start|init|place/i;
  const RESPONSE_RE = /response|complet|cancel|delet|close|end|reject|confirm|approv/i;
  // A name ending in "Response" is always a response, regardless of other words.
  // Otherwise fall back to regex matching with conflict resolution.
  const responses = names.filter(n =>
    /Response$/i.test(n) || (RESPONSE_RE.test(n) && !REQUEST_RE.test(n))
  );
  const responseSet = new Set(responses);
  const requests = names.filter(n => REQUEST_RE.test(n) && !responseSet.has(n));
  const primary   = requests[0] || names[0] || 'Event';
  return { names, requests, responses, primary };
}

// ─── Build context schema for per-event counters ──────────────────────────────
function buildCounterCtx(eventNames, extras = {}) {
  const ctx = { total: { type: 'integer', default: 0 } };
  eventNames.forEach(n => { ctx[`cnt_${n}`] = { type: 'integer', default: 0 }; });
  return Object.assign(ctx, extras);
}

// ─── Shared: foreach that counts every event type ─────────────────────────────
function countingForeach(eventNames, extraBody = []) {
  const body = [
    _set('total', _add(_get('total'), 1)),
    ...eventNames.map(evtName => _if(
      _cmp(_getP('event', 'event_type'), '==', evtName),
      [_set(`cnt_${evtName}`, _add(_get(`cnt_${evtName}`), 1))],
      []
    )),
    ...extraBody
  ];
  return _foreach('event', _get('eventLog'), body);
}

// ─── 1. deriveState ───────────────────────────────────────────────────────────
function makeDeriveState(mod) {
  const events   = mod.events || {};
  const { names, requests, responses } = classifyEvents(events);

  // Collect unique entity keys (ordering_keys) from event schemas
  const entityKeys = [...new Set(names.map(n => events[n]?.ordering_key).filter(Boolean))];
  const primaryKey = entityKeys[0] || 'id';

  // Context: counters + last-seen entity id + entity count estimate
  const ctxSchema = buildCounterCtx(names, {
    lastId:       { type: 'integer', default: 0 },
    activeCount:  { type: 'integer', default: 0 },
    closedCount:  { type: 'integer', default: 0 }
  });

  // foreach body: count + track active/closed per request/response pairing
  const extraBody = [];
  if (requests.length > 0) {
    const reqEvt = requests[0];
    const orderKey = events[reqEvt]?.ordering_key || primaryKey;
    extraBody.push(
      _if(
        _cmp(_getP('event', 'event_type'), '==', reqEvt),
        [
          _set('lastId', _getP('event', orderKey)),
          _set('activeCount', _add(_get('activeCount'), 1))
        ],
        []
      )
    );
  }
  if (responses.length > 0) {
    const resEvt = responses[0];
    extraBody.push(
      _if(
        _cmp(_getP('event', 'event_type'), '==', resEvt),
        [_set('closedCount', _add(_get('closedCount'), 1))],
        []
      )
    );
  }

  // Build full state object return: collects every context variable
  const stateFields = {};
  Object.keys(ctxSchema).forEach(k => { stateFields[k] = _get(k); });
  const stateReturnExpr = { object: stateFields };

  const steps = [
    _log(`deriveState: processing ${mod.module_type || 'module'} event log`),
    countingForeach(names, extraBody),
    _ret(stateReturnExpr)
  ];

  return {
    function: 'deriveState',
    metadata: {
      schema_version: '1.1.0',
      description: `Iterate eventLog to build state for ${mod.name || 'module'} tracking: ${names.join(', ')}.`,
      deterministic: true
    },
    schema: {
      inputs:  { eventLog: { type: 'array' } },
      context: ctxSchema,
      outputs: { state: { type: 'object' } }
    },
    context: {},
    steps
  };
}

// ─── 2. scheduleNextAction ────────────────────────────────────────────────────
function makeScheduleNextAction(mod) {
  const events = mod.events || {};
  const { names, requests, responses } = classifyEvents(events);
  const schedDesc = mod.schedulers?.scheduleNextAction?.description
    || 'Deterministically select the next action from the event log.';

  const ctxSchema = buildCounterCtx(names);

  // Logic: if open requests exceed closed responses → schedule the response action
  //        if requests == responses → schedule next request
  //        else → idle
  const schedSteps = [
    countingForeach(names),
  ];

  if (requests.length > 0 && responses.length > 0) {
    const req = requests[0], res = responses[0];
    schedSteps.push(
      _if(
        _cmp(_get(`cnt_${req}`), '>', _get(`cnt_${res}`)),
        [_ret(_val(res))],
        [
          _if(
            _cmp(_get(`cnt_${req}`), '==', _get(`cnt_${res}`)),
            [_ret(_val(req))],
            [_ret(_val('Idle'))]
          )
        ]
      )
    );
  } else if (requests.length > 0) {
    schedSteps.push(_ret(_val(requests[0])));
  } else {
    schedSteps.push(_ret(_val(names[0] || 'Idle')));
  }

  return {
    function: 'scheduleNextAction',
    metadata: { schema_version: '1.1.0', description: schedDesc, deterministic: true },
    schema: {
      inputs:  { state: { type: 'object' }, eventLog: { type: 'array' } },
      context: ctxSchema,
      outputs: { action: { type: 'string' } }
    },
    context: {},
    steps: schedSteps
  };
}

// ─── 3. computeEnergy ────────────────────────────────────────────────────────
function makeComputeEnergy(mod) {
  const events    = mod.events || {};
  const { names, primary } = classifyEvents(events);
  const sf        = mod.signal_functions?.energy || {};
  const desc      = sf.description || `Energy: ${sf.formula || 'primary event rate over log window'}.`;

  return {
    function: 'computeEnergy',
    metadata: { schema_version: '1.1.0', description: desc, deterministic: true },
    schema: {
      inputs:  { eventLog: { type: 'array' } },
      context: {
        total:      { type: 'integer', default: 0 },
        primaryCnt: { type: 'integer', default: 0 },
        denom:      { type: 'number',  default: 1.0 },
        energy:     { type: 'number',  default: 0.0 }
      },
      outputs: { energy: { type: 'number' } }
    },
    context: {},
    steps: [
      _set('total', { length: _get('eventLog') }),
      // Count primary events across the whole log
      _foreach('event', _get('eventLog'), [
        _if(
          _cmp(_getP('event', 'event_type'), '==', primary),
          [_set('primaryCnt', _add(_get('primaryCnt'), 1))],
          []
        )
      ]),
      // denom = max(1, total)
      _if(_cmp(_get('total'), '>', 0),
        [_set('denom', _get('total'))],
        [_set('denom', 1.0)]
      ),
      // energy = primaryCnt / denom
      _set('energy', _div(_get('primaryCnt'), _get('denom'))),
      // clamp to [0, 1]
      _if(_cmp(_get('energy'), '>', 1.0), [_set('energy', 1.0)], []),
      _if(_cmp(_get('energy'), '<', 0.0), [_set('energy', 0.0)], []),
      _ret(_get('energy'))
    ]
  };
}

// ─── 4. computeDecay ─────────────────────────────────────────────────────────
function makeComputeDecay(mod) {
  const { primary } = classifyEvents(mod.events || {});
  const sf   = mod.signal_functions?.decay || {};
  const desc = sf.description || `Decay: ${sf.formula || 'staleness since last primary event'}.`;

  return {
    function: 'computeDecay',
    metadata: { schema_version: '1.1.0', description: desc, deterministic: true },
    schema: {
      inputs:  { eventLog: { type: 'array' } },
      context: {
        total:       { type: 'integer', default: 0 },
        i:           { type: 'integer', default: 0 },
        lastPos:     { type: 'integer', default: 0 },
        eventsSince: { type: 'integer', default: 0 },
        denom:       { type: 'number',  default: 1.0 },
        decay:       { type: 'number',  default: 1.0 }
      },
      outputs: { decay: { type: 'number' } }
    },
    context: {},
    steps: [
      _set('total', { length: _get('eventLog') }),
      // Walk the log, record position of last primary event
      _foreach('event', _get('eventLog'), [
        _set('i', _add(_get('i'), 1)),
        _if(
          _cmp(_getP('event', 'event_type'), '==', primary),
          [_set('lastPos', _get('i'))],
          []
        )
      ]),
      _set('eventsSince', _sub(_get('total'), _get('lastPos'))),
      _if(_cmp(_get('total'), '>', 0),
        [_set('denom', _get('total'))],
        [_set('denom', 1.0)]
      ),
      // decay = 1 - (eventsSince / denom)
      _set('decay', _sub(1.0, _div(_get('eventsSince'), _get('denom')))),
      _if(_cmp(_get('decay'), '<', 0.0), [_set('decay', 0.0)], []),
      _if(_cmp(_get('decay'), '>', 1.0), [_set('decay', 1.0)], []),
      _ret(_get('decay'))
    ]
  };
}

// ─── 5. computePriority ──────────────────────────────────────────────────────
function makeComputePriority(mod) {
  const sf   = mod.signal_functions?.priority || {};
  const desc = sf.description || `Priority: ${sf.formula || '(energy * 0.6) + ((1 - decay) * 0.4)'}.`;

  return {
    function: 'computePriority',
    metadata: { schema_version: '1.1.0', description: desc, deterministic: true },
    schema: {
      inputs:  { energy: { type: 'number' }, decay: { type: 'number' } },
      context: { priority: { type: 'number', default: 0.0 } },
      outputs: { priority: { type: 'number' } }
    },
    context: {},
    steps: [
      // priority = (energy * 0.6) + ((1 - decay) * 0.4)
      _set('priority',
        _add(
          _mul(_get('energy'), 0.6),
          _mul(_sub(1.0, _get('decay')), 0.4)
        )
      ),
      _if(_cmp(_get('priority'), '<', 0.0), [_set('priority', 0.0)], []),
      _if(_cmp(_get('priority'), '>', 1.0), [_set('priority', 1.0)], []),
      _ret(_get('priority'))
    ]
  };
}

// ─── Master builder ───────────────────────────────────────────────────────────
function buildJSONFlowFromModule(mod) {
  return [
    makeDeriveState(mod),
    makeScheduleNextAction(mod),
    makeComputeEnergy(mod),
    makeComputeDecay(mod),
    makeComputePriority(mod)
  ];
}

// ─── Stage 2: deterministic conversion (no Ollama) ────────────────────────────
function convertToJSONFlow() {
  addMsg('system', '◈ Stage 2: Compiling JSONFlow programs from Genesis module…');
  setStage(2);

  const stage2Btn = [...document.querySelectorAll('.pipeline-action.stage2')].at(-1);
  if (stage2Btn) stage2Btn.disabled = true;

  let programs;
  try {
    programs = buildJSONFlowFromModule(currentModule);
  } catch (err) {
    addMsg('system', `JSONFlow compiler error: ${err.message}`);
    if (stage2Btn) stage2Btn.disabled = false;
    return;
  }

  jfPrograms    = programs;
  selectedJfIdx = 0;
  renderJSONFlowPane();

  addMsg('system', `✓ Compiled ${programs.length} JSONFlow programs from module structure.`);
  document.getElementById('badge-jsonflow').textContent = programs.length;
  setStage(3);

  if (stage2Btn) stage2Btn.disabled = false;

  const c   = document.getElementById('msgs');
  const btn = document.createElement('button');
  btn.className = 'pipeline-action stage3';
  btn.innerHTML = '◆ Stage 3: Compile to Code → (pick language in JSONFlow tab)';
  btn.onclick   = () => switchOutTab('jsonflow');
  c.appendChild(btn);
  c.scrollTop = c.scrollHeight;

  switchOutTab('jsonflow');
}

// ─── Render the JSONFlow tab ──────────────────────────────────────────────────
function renderJSONFlowPane() {
  const bar     = document.getElementById('jfFuncBar');
  const compBar = document.getElementById('jfCompileBar');
  bar.style.display     = 'flex';
  compBar.style.display = 'flex';

  bar.innerHTML = jfPrograms.map((p, i) =>
    `<button class="jf-func-btn ${i === selectedJfIdx ? 'active' : ''}" onclick="selectJfFunc(${i})">${p.function || 'program' + i}</button>`
  ).join('');

  renderSelectedJfFunc();
}

function selectJfFunc(idx) {
  selectedJfIdx = idx;
  document.querySelectorAll('.jf-func-btn').forEach((b, i) =>
    b.className = 'jf-func-btn' + (i === idx ? ' active' : '')
  );
  renderSelectedJfFunc();
}

function renderSelectedJfFunc() {
  const prog = jfPrograms[selectedJfIdx];
  if (!prog) return;
  const d = document.getElementById('jfDisplay');
  d.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'code-block';
  block.innerHTML = `
    <div class="code-hdr">
      <span class="code-file">${prog.function}.json</span>
      <div class="code-actions">
        <button class="code-btn" onclick="copyJF()">Copy JSON</button>
      </div>
    </div>
    <div class="code-body"><pre>${escHtml(JSON.stringify(prog, null, 2))}</pre></div>`;
  d.appendChild(block);
  document.getElementById('compileInfo').textContent =
    `Function: ${prog.function} — select language and compile`;
}

function copyJF() {
  const prog = jfPrograms[selectedJfIdx];
  if (prog) navigator.clipboard.writeText(JSON.stringify(prog, null, 2));
}
