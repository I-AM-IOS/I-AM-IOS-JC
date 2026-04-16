// ════════════════════════════════════════════════════════════════════════════
//  migration-shim.js
//
//  Backward-compatible bridge. Lets existing modules keep reading from
//  `state.X` while you migrate them one at a time to sovereign-log.
//
//  Usage: replace the import in each module:
//
//    // Before:
//    import { state } from './state.js';
//
//    // After (no other changes needed yet):
//    import { state } from './migration-shim.js';
//
//  state.X reads are now live projections of deriveState().
//  Writes to state.X are translated to emit() calls.
//  Once all modules are migrated, delete this file.
// ════════════════════════════════════════════════════════════════════════════

import { emit, deriveState, subscribe, EVENT_TYPES } from './sovereign-log.js';

// Proxy handler: reads derive from log, writes translate to events
const _handler = {
  get(_target, prop) {
    return deriveState()[prop];
  },

  set(_target, prop, value) {
    // Translate legacy direct-assignment writes into typed events
    switch (prop) {
      case 'currentModel':
        emit({ type: EVENT_TYPES.MODEL_SELECTED, model: value });
        break;
      case 'activeTab':
        emit({ type: EVENT_TYPES.TAB_CHANGED, tab: value });
        break;
      case 'streaming':
        emit({ type: value ? EVENT_TYPES.STREAMING_STARTED : EVENT_TYPES.STREAMING_ENDED });
        break;
      case 'ollamaOk':
        emit({ type: EVENT_TYPES.OLLAMA_STATUS, ok: value });
        break;
      case 'kernelMode':
        emit({ type: EVENT_TYPES.KERNEL_MODE_TOGGLED, enabled: value });
        break;
      case 'kernelModelA':
        emit({ type: EVENT_TYPES.MODEL_SELECTED, model: value, slot: 'A' });
        break;
      case 'kernelModelB':
        emit({ type: EVENT_TYPES.MODEL_SELECTED, model: value, slot: 'B' });
        break;
      default:
        // Unmapped write: warn loudly, do not silently drop
        console.warn(
          `[migration-shim] Unmapped state write: state.${prop} = ${JSON.stringify(value)}. ` +
          `Add a case to migration-shim.js or migrate this module to emit() directly.`
        );
    }
    return true;   // Proxy set must return true
  },
};

// The exported `state` object. Modules import this exactly like the old state.js.
// Reads are live. Writes are event-translated.
export const state = new Proxy({}, _handler);

// ── intel.js message helper ───────────────────────────────────────────────────
// Replace the direct array push in sendIntel() with this:
export function addIntelMessage(role, content) {
  emit({ type: EVENT_TYPES.INTEL_MESSAGE_ADDED, role, content });
  return deriveState().intelHistory;
}

export function resetIntelHistory() {
  emit({ type: EVENT_TYPES.INTEL_HISTORY_RESET });
}

// ── memory-manager.js import helpers ─────────────────────────────────────────
export function importConversations(conversations, source = 'manual') {
  emit({
    type: EVENT_TYPES.MEMORY_IMPORTED,
    conversations: conversations.map(c => ({ ...c, source })),
  });
}

export function mergeConversations(conversations, source = 'merged') {
  emit({
    type: EVENT_TYPES.MEMORY_MERGED,
    conversations: conversations.map(c => ({ ...c, source })),
  });
}

// ── Subscribe to state for UI re-render ──────────────────────────────────────
// Drop-in for any module that was watching state manually.
export { subscribe };
