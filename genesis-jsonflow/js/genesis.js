/**
 * genesis.js
 * Genesis — Stage 1: natural-language → Genesis module via Ollama
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
// js/genesis.js — Stage 1: Genesis module generation via Ollama
'use strict';

// ─── Slug helper ──────────────────────────────────────────────────────────────
function slugify(text) {
  return text.toLowerCase()
    .replace(/^build\s+(an?\s+)?/i, '')
    .replace(/\s+(app|module|system|platform|tool|service).*/i, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 40) || 'custom';
}

// ─── System prompt builder ────────────────────────────────────────────────────
function buildSystemPrompt(appDescription, moduleType) {
  return `You are a deterministic module compiler for the Genesis event-sourced substrate.
Output ONLY a single raw JSON object — no prose, no markdown fences, no code blocks, no comments.

APP TO BUILD: ${appDescription}
MODULE TYPE: ${moduleType}

━━━ STRUCTURE RULES ━━━
• "derived_state" and "emitted_events" are SEPARATE TOP-LEVEL KEYS. emitted_events is NEVER nested inside derived_state.
• "invariants" must be an array of plain strings, not objects.
• Every key in "events" must include: type, ordering_key, enforced, description, schema.
• All schema property types use JSON Schema: "string", "number", "array", "object", "boolean".
• Use "number" for all integer/u64 ID and timestamp fields. Do NOT use type aliases like "u64".

OUTPUT SKELETON:
{
  "name": "Genesis/${moduleType}", "version": "1.0.0", "description": "...", "module_type": "${moduleType}",
  "derived_state": { "description": "...", "structure": { "value": "::derived_state", "type": "array", "enforced": true, "items": { "type": "object", "required": ["<id>"], "properties": { "<id>": { "type": "number" } } } } },
  "emitted_events": { "description": "...", "structure": { "value": "::emitted_events", "type": "array", "enforced": true, "items": { "type": "object", "required": ["event_type","args"], "properties": { "event_type": { "type": "string" }, "args": { "type": "object" } } } } },
  "events": { "<EventName>": { "type": "event", "ordering_key": "<id_field>", "enforced": true, "description": "...", "schema": { "type": "object", "required": ["<id>","timestamp"], "properties": { "<id>": { "type": "number" }, "timestamp": { "type": "number" } } } } },
  "reducers": { "deriveState": { "description": "...", "structure": { "value": "::reducers.deriveState", "type": "function", "parameters": [{"name":"eventLog","type":"array"}], "returns": {"type":"object"}, "enforced": true } } },
  "signal_functions": {
    "energy":   { "description": "...", "formula": "count(primary_event, window=100)/max(1,total)", "range": [0,1], "structure": { "value": "::signal_functions.energy",   "type": "function", "parameters": [{"name":"eventLog","type":"array"}], "returns": {"type":"number"}, "enforced": true } },
    "decay":    { "description": "...", "formula": "1-(events_since_last/log_length)",              "range": [0,1], "structure": { "value": "::signal_functions.decay",    "type": "function", "parameters": [{"name":"eventLog","type":"array"}], "returns": {"type":"number"}, "enforced": true } },
    "priority": { "description": "...", "formula": "(energy*0.6)+((1-decay)*0.4)",                  "range": [0,1], "structure": { "value": "::signal_functions.priority", "type": "function", "parameters": [{"name":"eventLog","type":"array"}], "returns": {"type":"number"}, "enforced": true } }
  },
  "schedulers": { "scheduleNextAction": { "description": "...", "structure": { "value": "::schedulers.scheduleNextAction", "type": "function", "parameters": [{"name":"state","type":"object"},{"name":"eventLog","type":"array"}], "returns": {"type":"string"}, "enforced": true } } },
  "invariants": ["Replay(state) == Live(state)","No hidden or mutable state outside the log","All outputs traceable to explicit events","Signals are functions of history, not stored values","Same input sequence → identical execution path","Same event log → identical emitted event sequence","Every event has a deterministic total ordering key","Reducers are pure functions of (state, event)","Schedulers are pure functions of event history with deterministic tie-breaking","Signal functions are pure functions of event history","Given the same event log, emitted event sequence is identical"],
  "outputs": { "derived_state": {"type":"array","enforced":true}, "emitted_events": {"type":"array","enforced":true}, "ENFORCED_OUTPUTS": {"type":"object","enforced":true}, "canonical_module": {"type":"object","enforced":true} },
  "dependencies": [{"name":"Genesis/Hashing","version":"1.0.0"},{"name":"Genesis/Addressing","version":"1.0.0"}]
}

Design domain-appropriate events for: ${appDescription}
Output ONLY the JSON — no prose, no markdown.`;
}

// Initialise on load
document.addEventListener('DOMContentLoaded', () => {
  currentSystemPrompt = buildSystemPrompt('a user identity system', 'identity');
  checkConnection();
});

// ─── Stage 1: send prompt to Ollama ──────────────────────────────────────────
async function sendGenesis() {
  const input   = document.getElementById('userInput');
  const message = input.value.trim();
  if (!message || isGenerating) return;

  isGenerating = true;
  document.getElementById('sendBtn').disabled = true;
  input.value = '';

  addMsg('user', message);
  conversationHistory.push({ role: 'user', content: message });

  if (/build|create|make|generate/i.test(message)) {
    currentAppDescription = message;
    currentSystemPrompt   = buildSystemPrompt(message, slugify(message));
  }

  try {
    const resp = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [{ role: 'system', content: currentSystemPrompt }, ...conversationHistory],
        stream: true,
        options: { temperature: ollamaTemp, seed: 42 }
      })
    });

    const reader = resp.body.getReader();
    const dec    = new TextDecoder('utf-8', { fatal: false });
    let full     = '';
    let carry    = '';
    const msgEl  = addMsg('ai', '', true);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = carry + dec.decode(value, { stream: true });
      const lines = chunk.split('\n');
      carry = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.message?.content) { full += j.message.content; msgEl.textContent = full; }
        } catch {}
      }
    }
    if (carry.trim()) {
      try { const j = JSON.parse(carry); if (j.message?.content) full += j.message.content; } catch {}
    }

    msgEl.classList.remove('streaming');
    conversationHistory.push({ role: 'assistant', content: full });
    tryParseGenesis(full);

  } catch (err) {
    addMsg('system', `Error: ${err.message}`);
  }

  isGenerating = false;
  document.getElementById('sendBtn').disabled = false;
}

// ─── Clean raw model output into parseable JSON object ────────────────────────
function cleanGenesisOutput(text) {
  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/im, '');
  // Remove // comments (outside strings)
  text = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (m, str) => str !== undefined ? str : '');
  // Extract outermost {...}
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, end = -1, inStr = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape)        { escape = false; continue; }
    if (ch === '\\')   { escape = true;  continue; }
    if (ch === '"')    { inStr = !inStr; continue; }
    if (inStr)         continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  let raw = end !== -1 ? text.slice(start, end + 1) : text.slice(start);
  // Fix trailing commas
  raw = raw.replace(/,(\s*[}\]])/g, '$1');
  return raw;
}

// ─── Parse + normalise JSON from model response ───────────────────────────────
function tryParseGenesis(text) {
  const cleaned = cleanGenesisOutput(text);
  const m = cleaned ? [cleaned] : text.match(/\{[\s\S]*\}/);
  if (!m) return;
  let parsed;
  try { parsed = JSON.parse(m[0]); }
  catch { addMsg('system', 'Invalid JSON returned'); return; }

  const normalized = normalizeModule(parsed);
  if (!validateModule(normalized)) {
    addMsg('system', 'Module failed deterministic validation');
    return;
  }

  currentModule = normalized;
  renderGenesisModule(normalized);
  setStage(2);

  // Inject Stage 2 action button into pipeline
  const c   = document.getElementById('msgs');
  const btn = document.createElement('button');
  btn.className = 'pipeline-action stage2';
  btn.innerHTML = '◈ Stage 2: Convert to JSONFlow Programs';
  btn.onclick   = () => { btn.disabled = true; convertToJSONFlow(); };
  c.appendChild(btn);
  c.scrollTop = c.scrollHeight;
}

// ─── Render helpers ───────────────────────────────────────────────────────────
function renderGenesisModule(mod) {
  const d = document.getElementById('genesisDisplay');
  d.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'code-block';
  block.innerHTML = `
    <div class="code-hdr">
      <span class="code-file">${mod.name || 'module'}.json</span>
      <div class="code-actions">
        <button class="code-btn" onclick="copyJSON()">Copy</button>
      </div>
    </div>
    <div class="code-body"><pre>${escHtml(JSON.stringify(mod, null, 2))}</pre></div>`;
  d.appendChild(block);
  document.getElementById('badge-genesis').textContent = '✓';
  renderValidation(mod);
  switchOutTab('genesis');
}

function renderValidation(mod) {
  const panel = document.getElementById('valPanel');
  const items = document.getElementById('valItems');
  panel.style.display = 'block';

  const checks = [
    ['derived_state enforced',      !!(mod.derived_state?.structure?.enforced)],
    ['emitted_events enforced',     !!(mod.emitted_events?.structure?.enforced)],
    ['reducers.deriveState present', !!(mod.reducers?.deriveState)],
    ['signal_functions present',    !!(mod.signal_functions?.energy)],
    ['schedulers present',          !!(mod.schedulers?.scheduleNextAction)],
    ['All 11 invariants',           !!(mod.invariants?.length >= 11)],
    ['Canonical outputs',           !!(mod.outputs?.ENFORCED_OUTPUTS)],
    ['Genesis dependencies',        !!(mod.dependencies?.length >= 2)],
  ];

  items.innerHTML = checks.map(([lbl, ok]) =>
    `<div class="val-item">
       <div class="val-icon ${ok ? 'pass' : 'fail'}">${ok ? '✓' : '✗'}</div>
       <div>${lbl}</div>
     </div>`
  ).join('');
}

function copyJSON() {
  if (currentModule) navigator.clipboard.writeText(JSON.stringify(currentModule, null, 2));
}
