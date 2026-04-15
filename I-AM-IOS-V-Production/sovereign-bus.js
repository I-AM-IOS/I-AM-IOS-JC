// ════════════════════════════════════════════════════════════════════════════
//  sovereign-bus.js  —  Cross-App Event Bus
//
//  Invariant: All apps sharing this bus see the same event log.
//
//  Uses BroadcastChannel so sovereign-log events emitted in one tab/window
//  propagate to all others (app-builder, attack, generate-value, index1,
//  personal-AI-assistant). Each app still has its own in-memory log (sovereign-log
//  is module-private) — the bus syncs new events across the boundary.
//
//  Protocol:
//    EMIT    sender → all:  { op:'EMIT',  record }          new event
//    SYNC_REQ sender → all: { op:'SYNC_REQ', fromSeq }      "give me log from seq N"
//    SYNC_RES sender → all: { op:'SYNC_RES', records[] }    answer
//    RESTORE  any → all:   { op:'RESTORE', records[] }      full log replace
//
//  Usage (each app, once):
//    import { attachBus } from './sovereign-bus.js';
//    attachBus(); // after sovereign-log is loaded
// ════════════════════════════════════════════════════════════════════════════

import { emit, getLog, restore, subscribe, deriveState } from './sovereign-log.js';

const CHANNEL = 'sovereign-os-bus';
let _ch  = null;
let _own = false;   // are we the log-owner (first tab)?

export function attachBus() {
  if (_ch) return;   // idempotent

  _ch = new BroadcastChannel(CHANNEL);
  _isBusReady = true;

  // ── Outbound: forward every local emit to the channel ──────────────────────
  subscribe((_state, record) => {
    if (!record) return;               // initial fire (no record)
    if (record._fromBus) return;       // don't re-broadcast what came in
    _ch.postMessage({ op: 'EMIT', record });
  });

  // ── Inbound: receive events from other tabs ────────────────────────────────
  _ch.onmessage = ({ data }) => {
    if (!data?.op) return;

    switch (data.op) {

      case 'EMIT': {
        // Re-emit into our local log so our deriveState stays current.
        // Mark it so our subscribe handler won't re-broadcast.
        const r = data.record;
        // Only replay if we haven't seen this seq yet
        const log = getLog();
        if (log.some(e => e.seq === r.seq)) break;
        // Directly re-emit the typed event (sovereign-log will assign new hash
        // from its own prevHash, that's fine — within-tab chain is always consistent)
        const { type, ...rest } = r;
        const synthetic = { ...rest, type, _fromBus: true };
        try { emit(synthetic); } catch (_) { /* unknown type guard — safe to ignore */ }
        break;
      }

      case 'SYNC_REQ': {
        // Another tab just loaded and wants our log from seq N
        const fromSeq = data.fromSeq ?? 0;
        const records = getLog().filter(e => e.seq >= fromSeq);
        if (records.length) _ch.postMessage({ op: 'SYNC_RES', records });
        break;
      }

      case 'SYNC_RES': {
        // We received a catch-up log from another tab
        const existing = getLog();
        if (!existing.length && data.records?.length) {
          // We're fresh — accept their log
          try { restore(data.records); } catch (_) { /* tamper guard fires — ignore */ }
        }
        break;
      }

      case 'RESTORE': {
        // Full log replacement broadcast (e.g. after import)
        if (data.records?.length) {
          try { restore(data.records); } catch (_) { /* */ }
        }
        break;
      }
    }
  };

  // ── On load: ask other tabs for their log if we're empty ───────────────────
  if (!getLog().length) {
    _ch.postMessage({ op: 'SYNC_REQ', fromSeq: 0 });
  }

  window.addEventListener('unload', () => _ch?.close());
}

// ── broadcastRestore — call after import/restore to push to all tabs ─────────
export function broadcastRestore() {
  _ch?.postMessage({ op: 'RESTORE', records: getLog() });
}

let _isBusReady = false;
export const isBusReady = () => _isBusReady;
