/**
 * ui.js
 * Genesis — UI helpers: stage indicator, message log, settings modal
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
// js/ui.js — UI helpers: stage indicator, messages, settings modal, connection badge, pipeline reset
'use strict';

// ─── Stage indicator ──────────────────────────────────────────────────────────
function setStage(n) {
  [1, 2, 3].forEach(i => {
    const el = document.getElementById('st' + i);
    el.className = 'stage' + (i < n ? ' done' : i === n ? ' active' : '');
  });
}

// ─── Message helpers ──────────────────────────────────────────────────────────
function addMsg(role, content, streaming = false) {
  const c = document.getElementById('msgs');
  const avIcons = { system: '◈', user: '▸', ai: '◆' };
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="msg-av">${avIcons[role] || '·'}</div>
    <div class="msg-body">
      <div class="msg-role">${role}</div>
      <div class="msg-text ${streaming ? 'streaming' : ''}">${content}</div>
    </div>`;
  c.appendChild(div);
  c.scrollTop = c.scrollHeight;
  return div.querySelector('.msg-text');
}

// ─── Output tab switcher ──────────────────────────────────────────────────────
function switchOutTab(tab) {
  ['genesis', 'jsonflow', 'code'].forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('active', t === tab);
    document.getElementById('pane-' + t).classList.toggle('active', t === tab);
  });
}

// ─── Settings modal ───────────────────────────────────────────────────────────
function openSettings()  { document.getElementById('settingsModal').classList.add('open'); }
function closeSettings() { document.getElementById('settingsModal').classList.remove('open'); }
function saveSettings()  {
  ollamaUrl   = document.getElementById('ollamaUrl').value;
  ollamaModel = document.getElementById('ollamaModel').value;
  ollamaTemp  = parseFloat(document.getElementById('ollamaTemp').value);
  closeSettings();
  checkConnection();
}

// ─── Connection check ─────────────────────────────────────────────────────────
function checkConnection() {
  fetch(`${ollamaUrl}/api/tags`).then(r => {
    const dot = document.getElementById('statusDot');
    const txt = document.getElementById('statusText');
    if (r.ok) { dot.className = 'dot ok'; txt.textContent = ollamaModel + ' ready'; }
    else       { dot.className = 'dot err'; txt.textContent = 'Error'; }
  }).catch(() => {
    document.getElementById('statusDot').className = 'dot err';
    document.getElementById('statusText').textContent = 'Disconnected';
  });
}

// ─── Pipeline clear ───────────────────────────────────────────────────────────
function clearPipeline() {
  document.getElementById('msgs').innerHTML = `
    <div class="msg system">
      <div class="msg-av">◈</div>
      <div class="msg-body">
        <div class="msg-role">System</div>
        <div class="msg-text">Pipeline cleared. Describe an app to build.</div>
      </div>
    </div>`;
  conversationHistory   = [];
  currentModule         = null;
  jfPrograms            = [];

  const emptyGenesis = `<div class="empty-state">
    <div class="empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg></div>
    <div class="empty-title">No Module Yet</div>
    <div class="empty-sub">Describe an app in the pipeline</div>
  </div>`;
  const emptyJF = `<div class="empty-state">
    <div class="empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></div>
    <div class="empty-title">No JSONFlow Programs</div>
    <div class="empty-sub">Generate a Genesis module first</div>
  </div>`;
  const emptyCode = `<div class="empty-state">
    <div class="empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></div>
    <div class="empty-title">No Code Yet</div>
    <div class="empty-sub">Convert to JSONFlow, then compile</div>
  </div>`;

  document.getElementById('genesisDisplay').innerHTML = emptyGenesis;
  document.getElementById('jfDisplay').innerHTML      = emptyJF;
  document.getElementById('codeDisplay').innerHTML    = emptyCode;

  document.getElementById('jfFuncBar').style.display    = 'none';
  document.getElementById('jfCompileBar').style.display = 'none';
  document.getElementById('valPanel').style.display     = 'none';

  ['genesis', 'jsonflow', 'code'].forEach(t =>
    document.getElementById('badge-' + t).textContent = '0'
  );
  setStage(1);
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────
function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGenesis(); }
}

function inject(text) {
  document.getElementById('userInput').value = text;
  currentAppDescription = text;
  currentSystemPrompt   = buildSystemPrompt(text, slugify(text));
}
