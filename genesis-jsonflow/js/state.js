/**
 * state.js
 * Genesis — App state, schema registry, DDC enforcement constants
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
// js/state.js — Genesis app state, schema registry, and enforcement constants
'use strict';

// ─── App state ────────────────────────────────────────────────────────────────
let ollamaUrl             = 'http://localhost:11434';
let ollamaModel           = 'llama3.2';
let ollamaTemp            = 0;
let isGenerating          = false;
let conversationHistory   = [];
let currentModule         = null;   // Genesis module JSON
let jfPrograms            = [];     // array of JSONFlow programs
let selectedJfIdx         = 0;      // which function is selected in JSONFlow tab
let currentAppDescription = 'a user identity system';
let currentSystemPrompt   = '';

// ─── MODULE_SCHEMAS registry stub ────────────────────────────────────────────
// Populated by schemas/identity.js, schemas/messaging.js, etc.
const MODULE_SCHEMAS = {};

// ─── Canonical enforcement constants ─────────────────────────────────────────
const REQUIRED_INVARIANTS = [
  "Replay(state) == Live(state)",
  "No hidden or mutable state outside the log",
  "All outputs traceable to explicit events",
  "Signals are functions of history, not stored values",
  "Same input sequence → identical execution path",
  "Same event log → identical emitted event sequence",
  "Every event has a deterministic total ordering key",
  "Reducers are pure functions of (state, event)",
  "Schedulers are pure functions of event history with deterministic tie-breaking",
  "Signal functions are pure functions of event history",
  "Given the same event log, emitted event sequence is identical"
];

const CANONICAL_OUTPUTS = {
  derived_state:    { type: "array",  enforced: true },
  emitted_events:   { type: "array",  enforced: true },
  ENFORCED_OUTPUTS: { type: "object", enforced: true },
  canonical_module: { type: "object", enforced: true }
};

const CANONICAL_DEPS = [
  { name: "Genesis/Hashing",    version: "1.0.0" },
  { name: "Genesis/Addressing", version: "1.0.0" }
];

const CANONICAL_REDUCER = {
  description: "Deterministic reducer to compute full state from event log.",
  structure: {
    value: "::reducers.deriveState", type: "function",
    parameters: [{ name: "eventLog", type: "array" }],
    returns: { type: "object" }, enforced: true
  }
};

const CANONICAL_SCHEDULER = {
  description: "Deterministically select the next action based on current state and event log.",
  structure: {
    value: "::schedulers.scheduleNextAction", type: "function",
    parameters: [{ name: "state", type: "object" }, { name: "eventLog", type: "array" }],
    returns: { type: "string" }, enforced: true
  }
};

// ─── Generic schema fallback ──────────────────────────────────────────────────
const GENERIC_SCHEMA = {
  events: {},
  derived_state: {
    description: 'Module state derived from event log.',
    structure: { value: '::derived_state', type: 'array', enforced: true, items: { type: 'object' } }
  },
  emitted_events: {
    description: 'Events emitted by this module.',
    structure: { value: '::emitted_events', type: 'array', enforced: true,
      items: { type: 'object', required: ['event_type', 'args'],
        properties: { event_type: { type: 'string' }, args: { type: 'object' } } }
    }
  },
  signal_functions: {
    energy:   { description: 'Primary activity rate.',        formula: 'count(primary_events, window=100) / max(1, total_entities)', range: [0,1] },
    decay:    { description: 'Staleness since last activity.',formula: '1 - (events_since_last_activity / log_length)',               range: [0,1] },
    priority: { description: 'Composite scheduling priority.',formula: '(energy * 0.6) + ((1 - decay) * 0.4)',                        range: [0,1] }
  }
};

// ─── Schema resolution + normalization ───────────────────────────────────────
function resolveSchema(mod) {
  if (mod.module_type && MODULE_SCHEMAS[mod.module_type]) return MODULE_SCHEMAS[mod.module_type];
  const evts = Object.keys(mod.events || {}).join(' ').toLowerCase();
  if (evts.includes('message')  || evts.includes('conversation')) return MODULE_SCHEMAS.messaging;
  if (evts.includes('contact')  || evts.includes('deal'))         return MODULE_SCHEMAS.crm;
  if (evts.includes('agent')    || evts.includes('tool') || evts.includes('enrichment')) return MODULE_SCHEMAS.agent;
  if (evts.includes('proposal') || evts.includes('vote'))         return MODULE_SCHEMAS.governance;
  return GENERIC_SCHEMA;
}

function normalizeModule(mod) {
  const schema    = resolveSchema(mod);
  const isGeneric = schema === GENERIC_SCHEMA;

  if (isGeneric) {
    if (!mod.derived_state)  mod.derived_state  = JSON.parse(JSON.stringify(schema.derived_state));
    if (!mod.emitted_events) mod.emitted_events = JSON.parse(JSON.stringify(schema.emitted_events));
    if (!mod.events || !Object.keys(mod.events).length) mod.events = {};
  } else {
    mod.derived_state  = Object.assign({}, schema.derived_state,  mod.derived_state  || {});
    mod.emitted_events = Object.assign({}, schema.emitted_events, mod.emitted_events || {});
    if (!mod.events || !Object.keys(mod.events).length)
      mod.events = JSON.parse(JSON.stringify(schema.events));
    else
      mod.events = Object.assign({}, schema.events, mod.events);
  }

  if (!mod.reducers) mod.reducers = {};
  mod.reducers.deriveState = Object.assign({}, CANONICAL_REDUCER, mod.reducers.deriveState || {});

  if (!mod.signal_functions) mod.signal_functions = {};
  ['energy', 'decay', 'priority'].forEach(sig => {
    const dd   = schema.signal_functions[sig];
    const md   = mod.signal_functions[sig] || {};
    const base = isGeneric
      ? { description: md.description || dd.description, formula: md.formula || dd.formula, range: md.range || dd.range || [0,1] }
      : { description: dd.description, formula: dd.formula, range: dd.range };
    mod.signal_functions[sig] = Object.assign(base, md, {
      structure: {
        value: '::signal_functions.' + sig, type: 'function',
        parameters: [{ name: 'eventLog', type: 'array' }],
        returns: { type: 'number' }, enforced: true
      }
    });
  });
  mod.signalFunctions = JSON.parse(JSON.stringify(mod.signal_functions));

  if (!mod.schedulers) mod.schedulers = {};
  mod.schedulers.scheduleNextAction = Object.assign({}, CANONICAL_SCHEDULER, mod.schedulers.scheduleNextAction || {});

  mod.outputs = Object.assign({}, CANONICAL_OUTPUTS, mod.outputs || {});

  const existingDeps  = Array.isArray(mod.dependencies) ? mod.dependencies : [];
  const canonNames    = CANONICAL_DEPS.map(d => d.name);
  mod.dependencies    = [...CANONICAL_DEPS, ...existingDeps.filter(d => !canonNames.includes(d.name))];

  const existingInv = Array.isArray(mod.invariants) ? mod.invariants.map(i => i.name || i) : [];
  mod.invariants    = [...new Set([...REQUIRED_INVARIANTS, ...existingInv])].map(name => ({ name }));

  return mod;
}

function validateModule(mod) {
  if (!mod.invariants || mod.invariants.length < 11)                return false;
  if (!mod.reducers   || !mod.reducers.deriveState)                  return false;
  if (!mod.signal_functions || !mod.signal_functions.energy)         return false;
  if (!mod.schedulers || !mod.schedulers.scheduleNextAction)         return false;
  if (!mod.outputs)                                                   return false;
  if (!mod.dependencies || mod.dependencies.length < 2)             return false;
  return true;
}
