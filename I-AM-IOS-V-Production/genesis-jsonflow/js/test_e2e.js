/**
 * test_e2e.js
 * Genesis — End-to-end test: Stage 1→4 with hotel booking module
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
// End-to-end test: Genesis → JSONFlow → Compile → Execute
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const base = '/home/claude/genesis-jsonflow/genesis-jsonflow';

// Create a shared VM context that all files can share globals in
const ctx = { console, process, require };
vm.createContext(ctx);
ctx.document = { getElementById: () => ({ innerHTML: '', appendChild: () => {}, textContent: '' }) };
try { ctx.navigator = { clipboard: { writeText: () => {} } }; } catch(e) {}
ctx.jfPrograms = [];
ctx.selectedJfIdx = 0;

function load(f) {
  const code = fs.readFileSync(path.join(base, f), 'utf8').replace(/'use strict';/, '');
  vm.runInContext(code, ctx);
}

// Load in dependency order
load('jsonflow/types.js');        // JF_TYPES, JF_DEFAULTS, LANG_EXT, LANG_LABEL
load('jsonflow/lang-configs.js'); // LANG_CFGS, toCamel, toPascal, toSnake
load('js/jsonflow.js');           // makeDeriveState, etc.
load('js/compiler.js');           // jfCompile

const { makeDeriveState, jfCompile } = ctx;

// ── Stage 1: define a hotel_booking Genesis module ──────────────────────────
const hotelMod = {
  name: 'hotel_booking',
  module_type: 'hotel_booking',
  events: {
    BookRoomRequest:       { ordering_key: 'room_id' },
    BookRoomResponse:      { ordering_key: 'room_id' },
    CancelBookingRequest:  { ordering_key: 'room_id' },
    CancelBookingResponse: { ordering_key: 'room_id' }
  }
};

// ── Stage 2: Genesis → JSONFlow ─────────────────────────────────────────────
const flow = makeDeriveState(hotelMod);
console.log('✓ Stage 2 — JSONFlow generated');
const returnStep = flow.steps[flow.steps.length - 1];
console.log('  return step:', JSON.stringify(returnStep, null, 2));

// ── Stage 3: JSONFlow → JavaScript ──────────────────────────────────────────
const code = jfCompile(flow, 'javascript');
console.log('\n✓ Stage 3 — Compiled JavaScript:\n');
console.log(code);

// ── Stage 4: Execute the compiled function ───────────────────────────────────
const execCode = code.replace(/if \(typeof module[^\n]+\n?/, '');
vm.runInContext(execCode, ctx);
const deriveState = ctx.deriveState;

const events = [
  { event_type: 'BookRoomRequest',       room_id: 101 },
  { event_type: 'BookRoomResponse',      room_id: 101 },
  { event_type: 'BookRoomRequest',       room_id: 102 },
  { event_type: 'CancelBookingRequest',  room_id: 101 },
  { event_type: 'CancelBookingResponse', room_id: 101 },
];

const result = deriveState(events);
console.log('✓ Stage 4 — Executed with 5 events');
console.log('  Result:', JSON.stringify(result, null, 2));

// ── Assertions ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${label}: ${actual}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

console.log('\n── Assertions ──');
check('total',                    result.total,                    5);
check('cnt_BookRoomRequest',      result.cnt_BookRoomRequest,      2);
check('cnt_BookRoomResponse',     result.cnt_BookRoomResponse,     1);
check('cnt_CancelBookingRequest', result.cnt_CancelBookingRequest, 1);
check('cnt_CancelBookingResponse',result.cnt_CancelBookingResponse,1);
check('lastId (last BookRoomRequest room_id)', result.lastId,      102);
check('activeCount',              result.activeCount,              2);
check('closedCount',              result.closedCount,              1);
check('returns object (not number)', typeof result,                'object');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

