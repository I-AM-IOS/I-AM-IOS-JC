/**
 * planespace-theme.js — updated to reference Planespace v2 (planespace.min.js)
 * Planespace v2 dist available at: ./planespace.min.js (or ../planespace_2/dist/)
 * Usage: <script src="planespace.min.js"></script> for full v2 engine
 */
/**
 * planespace-theme.js
 * Planespace Theme — shared CSS design system for all Planespace apps
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
/**
 * planespace-theme.js
 * Injected CSS design system module for all Planespace apps.
 * Usage: <script src="planespace-theme.js"></script>
 *   or:  import PlaneTheme from './planespace-theme.js';
 *        PlaneTheme.apply({ theme: 'void', accent: 'electric' });
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PlaneTheme = factory();
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {

  // ── Token palettes ──────────────────────────────────────────────────────────
  const THEMES = {
    void: {
      '--ps-bg':        '#07080d',
      '--ps-bg2':       '#0d0f14',
      '--ps-bg3':       '#13161d',
      '--ps-bg4':       '#1a1e28',
      '--ps-bg5':       '#22273a',
      '--ps-txt':       '#dde0ea',
      '--ps-txt2':      '#8b92a8',
      '--ps-muted':     'rgba(221,224,234,0.35)',
      '--ps-faint':     'rgba(221,224,234,0.10)',
      '--ps-border':    'rgba(255,255,255,0.07)',
      '--ps-border-hi': 'rgba(255,255,255,0.16)',
      '--ps-shadow':    'rgba(0,0,0,0.55)',
    },
    slate: {
      '--ps-bg':        '#0a0c12',
      '--ps-bg2':       '#10131c',
      '--ps-bg3':       '#171b27',
      '--ps-bg4':       '#1e2333',
      '--ps-bg5':       '#262d42',
      '--ps-txt':       '#e2e6f3',
      '--ps-txt2':      '#7e88a3',
      '--ps-muted':     'rgba(226,230,243,0.35)',
      '--ps-faint':     'rgba(226,230,243,0.08)',
      '--ps-border':    'rgba(255,255,255,0.06)',
      '--ps-border-hi': 'rgba(255,255,255,0.14)',
      '--ps-shadow':    'rgba(0,0,0,0.6)',
    },
    carbon: {
      '--ps-bg':        '#080808',
      '--ps-bg2':       '#0f0f0f',
      '--ps-bg3':       '#161616',
      '--ps-bg4':       '#1e1e1e',
      '--ps-bg5':       '#282828',
      '--ps-txt':       '#f0f0f0',
      '--ps-txt2':      '#888888',
      '--ps-muted':     'rgba(240,240,240,0.35)',
      '--ps-faint':     'rgba(240,240,240,0.08)',
      '--ps-border':    'rgba(255,255,255,0.08)',
      '--ps-border-hi': 'rgba(255,255,255,0.18)',
      '--ps-shadow':    'rgba(0,0,0,0.65)',
    },
    ash: {
      '--ps-bg':        '#111318',
      '--ps-bg2':       '#181b22',
      '--ps-bg3':       '#1f222c',
      '--ps-bg4':       '#272b38',
      '--ps-bg5':       '#2f3444',
      '--ps-txt':       '#d8dce8',
      '--ps-txt2':      '#7a8299',
      '--ps-muted':     'rgba(216,220,232,0.35)',
      '--ps-faint':     'rgba(216,220,232,0.08)',
      '--ps-border':    'rgba(255,255,255,0.065)',
      '--ps-border-hi': 'rgba(255,255,255,0.15)',
      '--ps-shadow':    'rgba(0,0,0,0.5)',
    },
  };

  // ── Accent palettes ─────────────────────────────────────────────────────────
  const ACCENTS = {
    electric: {
      '--ps-acc':       '#5c7cfa',
      '--ps-acc2':      '#3b5bdb',
      '--ps-acc3':      'rgba(92,124,250,0.13)',
      '--ps-acc-glow':  'rgba(92,124,250,0.35)',
    },
    violet: {
      '--ps-acc':       '#8b5cf6',
      '--ps-acc2':      '#6d28d9',
      '--ps-acc3':      'rgba(139,92,246,0.13)',
      '--ps-acc-glow':  'rgba(139,92,246,0.35)',
    },
    cyan: {
      '--ps-acc':       '#4af0c4',
      '--ps-acc2':      '#00c896',
      '--ps-acc3':      'rgba(74,240,196,0.13)',
      '--ps-acc-glow':  'rgba(74,240,196,0.35)',
    },
    amber: {
      '--ps-acc':       '#fbbf24',
      '--ps-acc2':      '#d97706',
      '--ps-acc3':      'rgba(251,191,36,0.13)',
      '--ps-acc-glow':  'rgba(251,191,36,0.35)',
    },
    rose: {
      '--ps-acc':       '#f43f5e',
      '--ps-acc2':      '#be123c',
      '--ps-acc3':      'rgba(244,63,94,0.13)',
      '--ps-acc-glow':  'rgba(244,63,94,0.35)',
    },
    lime: {
      '--ps-acc':       '#84cc16',
      '--ps-acc2':      '#4d7c0f',
      '--ps-acc3':      'rgba(132,204,22,0.13)',
      '--ps-acc-glow':  'rgba(132,204,22,0.35)',
    },
  };

  // ── Semantic tokens (always the same, reference accent/theme vars) ──────────
  const SEMANTIC = `
    --ps-ok:          #40c057;
    --ps-ok-bg:       rgba(64,192,87,0.12);
    --ps-warn:        #fab005;
    --ps-warn-bg:     rgba(250,176,5,0.12);
    --ps-err:         #fa5252;
    --ps-err-bg:      rgba(250,82,82,0.12);
    --ps-radius:      10px;
    --ps-radius-lg:   14px;
    --ps-radius-xl:   20px;
  `;

  // ── Base CSS ─────────────────────────────────────────────────────────────────
  const BASE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500&family=Syne:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  width: 100%; height: 100%;
  background: var(--ps-bg);
  color: var(--ps-txt);
  font-family: 'Syne', sans-serif;
}

::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--ps-border-hi); border-radius: 3px; }

/* ── Typography ────────────────────────────────────────────────────────────── */
.ps-mono    { font-family: 'DM Mono', 'IBM Plex Mono', monospace; }
.ps-display { font-family: 'Syne', sans-serif; font-weight: 800; letter-spacing: -0.03em; }

/* ── Layout shell ──────────────────────────────────────────────────────────── */
.ps-shell {
  display: flex; flex-direction: column;
  height: 100vh; overflow: hidden;
}

/* ── Header ────────────────────────────────────────────────────────────────── */
.ps-header {
  flex-shrink: 0;
  height: 52px;
  background: var(--ps-bg2);
  border-bottom: 1px solid var(--ps-border);
  display: flex; align-items: center;
  padding: 0 18px; gap: 14px;
  z-index: 50;
}
.ps-logo {
  display: flex; align-items: center; gap: 9px;
  font-size: 15px; font-weight: 800;
  letter-spacing: -0.03em; color: var(--ps-txt);
  white-space: nowrap;
}
.ps-logo-mark {
  width: 28px; height: 28px; flex-shrink: 0;
  background: linear-gradient(135deg, var(--ps-acc), var(--ps-acc2));
  border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
}
.ps-logo-mark svg { width: 14px; height: 14px; fill: none; stroke: #fff; stroke-width: 2; }
.ps-header-spacer { flex: 1; }
.ps-header-right { display: flex; align-items: center; gap: 8px; }

/* ── Status badge ──────────────────────────────────────────────────────────── */
.ps-status {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 12px;
  background: var(--ps-bg3); border: 1px solid var(--ps-border);
  border-radius: 20px; font-size: 11px; font-weight: 600;
  color: var(--ps-txt2);
}
.ps-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--ps-muted); flex-shrink: 0; transition: all .4s;
}
.ps-dot.ok  { background: var(--ps-ok);  box-shadow: 0 0 6px var(--ps-ok); }
.ps-dot.err { background: var(--ps-err); }
.ps-dot.warn{ background: var(--ps-warn);}

/* ── Body / main area ──────────────────────────────────────────────────────── */
.ps-body {
  flex: 1; display: flex; overflow: hidden; min-height: 0;
}

/* ── Sidebar ───────────────────────────────────────────────────────────────── */
.ps-sidebar {
  width: 220px; flex-shrink: 0;
  background: var(--ps-bg2);
  border-right: 1px solid var(--ps-border);
  display: flex; flex-direction: column;
  overflow: hidden;
}
.ps-sidebar-mini {
  width: 52px; flex-shrink: 0;
  background: var(--ps-bg2);
  border-right: 1px solid var(--ps-border);
  display: flex; flex-direction: column;
  align-items: center; padding: 10px 0; gap: 4px;
}

/* ── Panel ─────────────────────────────────────────────────────────────────── */
.ps-panel {
  background: var(--ps-bg2);
  border: 1px solid var(--ps-border);
  border-radius: var(--ps-radius-lg);
  overflow: hidden;
}
.ps-panel-hdr {
  padding: 10px 14px;
  border-bottom: 1px solid var(--ps-border);
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
.ps-panel-title {
  font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .08em;
  color: var(--ps-txt2);
}

/* ── Tabs ──────────────────────────────────────────────────────────────────── */
.ps-tabs {
  display: flex; gap: 2px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--ps-border);
  background: var(--ps-bg3); flex-shrink: 0;
}
.ps-tab {
  padding: 5px 13px;
  border: none; background: transparent;
  font-family: 'Syne', sans-serif; font-size: 11px; font-weight: 700;
  color: var(--ps-txt2); cursor: pointer;
  border-radius: 7px; transition: all .2s;
  display: flex; align-items: center; gap: 5px;
}
.ps-tab:hover { background: var(--ps-bg4); }
.ps-tab.active {
  background: var(--ps-bg4); color: var(--ps-acc);
  box-shadow: 0 0 0 1px var(--ps-border);
}
.ps-badge {
  min-width: 16px; height: 16px; padding: 0 3px;
  border-radius: 8px; background: var(--ps-border);
  color: var(--ps-txt2); font-size: 9px; font-weight: 800;
  display: flex; align-items: center; justify-content: center;
}
.ps-tab.active .ps-badge { background: var(--ps-acc3); color: var(--ps-acc); }

/* ── Buttons ───────────────────────────────────────────────────────────────── */
.ps-btn {
  padding: 7px 16px;
  border: none; border-radius: 8px;
  font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700;
  cursor: pointer; transition: all .2s; display: inline-flex;
  align-items: center; gap: 6px; white-space: nowrap;
}
.ps-btn-primary { background: var(--ps-acc); color: #fff; }
.ps-btn-primary:hover { background: var(--ps-acc2); }
.ps-btn-secondary {
  background: var(--ps-bg4); color: var(--ps-txt2);
  border: 1px solid var(--ps-border);
}
.ps-btn-secondary:hover { color: var(--ps-txt); border-color: var(--ps-border-hi); }
.ps-btn-ghost {
  background: transparent; color: var(--ps-txt2);
  border: 1px solid var(--ps-border);
}
.ps-btn-ghost:hover { background: var(--ps-bg3); color: var(--ps-acc); border-color: var(--ps-acc); }
.ps-btn-success { background: var(--ps-ok-bg); color: var(--ps-ok); border: 1px solid var(--ps-ok); }
.ps-btn-success:hover { background: var(--ps-ok); color: #fff; }
.ps-btn-danger  { background: var(--ps-err-bg); color: var(--ps-err); border: 1px solid var(--ps-err); }
.ps-btn-danger:hover { background: var(--ps-err); color: #fff; }
.ps-btn-icon {
  width: 32px; height: 32px; padding: 0;
  border: 1px solid var(--ps-border);
  background: var(--ps-bg3); color: var(--ps-txt2);
  border-radius: 8px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all .2s;
}
.ps-btn-icon:hover { background: var(--ps-bg4); color: var(--ps-acc); border-color: var(--ps-acc); }
.ps-btn-icon svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; }
.ps-btn:disabled, .ps-btn-icon:disabled { opacity: .4; cursor: not-allowed; pointer-events: none; }

/* ── Pill / chip ───────────────────────────────────────────────────────────── */
.ps-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: 20px;
  border: 1px solid var(--ps-border);
  background: var(--ps-bg3);
  font-size: 11px; font-weight: 600; color: var(--ps-txt2);
  cursor: pointer; transition: all .2s;
}
.ps-chip:hover  { border-color: var(--ps-acc); color: var(--ps-acc); background: var(--ps-acc3); }
.ps-chip.active { border-color: var(--ps-acc); color: var(--ps-acc); background: var(--ps-acc3); }

/* ── Form controls ─────────────────────────────────────────────────────────── */
.ps-label {
  display: block; font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .07em;
  color: var(--ps-txt2); margin-bottom: 5px;
}
.ps-input, .ps-select, .ps-textarea {
  width: 100%; padding: 9px 12px;
  border: 1px solid var(--ps-border); border-radius: 8px;
  background: var(--ps-bg3); color: var(--ps-txt);
  font-family: 'DM Mono', monospace; font-size: 12px;
  transition: border-color .2s;
}
.ps-input:focus, .ps-select:focus, .ps-textarea:focus {
  outline: none; border-color: var(--ps-acc);
}
.ps-input::placeholder, .ps-textarea::placeholder { color: var(--ps-muted); }
.ps-textarea { resize: vertical; min-height: 80px; }
.ps-select { cursor: pointer; }
.ps-form-group { margin-bottom: 14px; }

/* ── Code block ────────────────────────────────────────────────────────────── */
.ps-code-block {
  background: var(--ps-bg3); border: 1px solid var(--ps-border);
  border-radius: var(--ps-radius-lg); overflow: hidden; margin-bottom: 10px;
}
.ps-code-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 14px; background: var(--ps-bg4);
  border-bottom: 1px solid var(--ps-border);
}
.ps-code-file { font-family: 'DM Mono', monospace; font-size: 11px; color: var(--ps-txt2); }
.ps-code-body { padding: 14px; overflow: auto; }
.ps-code-body pre {
  font-family: 'IBM Plex Mono', 'DM Mono', monospace;
  font-size: 12px; line-height: 1.7; color: #c9d1e9;
  margin: 0; white-space: pre;
}

/* ── Messages / chat ───────────────────────────────────────────────────────── */
.ps-messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.ps-msg { display: flex; gap: 10px; animation: ps-fadeup .22s ease; }
@keyframes ps-fadeup { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
.ps-msg-av {
  width: 26px; height: 26px; border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; font-size: 11px; font-weight: 700;
}
.ps-msg.system .ps-msg-av { background: var(--ps-acc3); color: var(--ps-acc); }
.ps-msg.user   .ps-msg-av { background: var(--ps-bg4);  color: var(--ps-txt2); }
.ps-msg.ai     .ps-msg-av { background: linear-gradient(135deg,var(--ps-acc),var(--ps-acc2)); color:#fff; }
.ps-msg-body { flex:1; min-width:0; }
.ps-msg-role { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--ps-muted); margin-bottom:3px; }
.ps-msg-text { font-family:'DM Mono',monospace; font-size:12px; line-height:1.7; color:var(--ps-txt); white-space:pre-wrap; word-break:break-word; }

/* ── Input row ─────────────────────────────────────────────────────────────── */
.ps-input-row {
  padding: 10px 14px; border-top: 1px solid var(--ps-border);
  background: var(--ps-bg3); flex-shrink: 0;
  display: flex; gap: 8px; align-items: flex-end;
}
.ps-input-row .ps-textarea {
  min-height: 40px; max-height: 120px; resize: none;
  background: var(--ps-bg2); border-radius: var(--ps-radius);
}
.ps-send-btn {
  width: 40px; height: 40px; border: none;
  background: var(--ps-acc); color: #fff;
  border-radius: var(--ps-radius); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all .2s; flex-shrink: 0;
}
.ps-send-btn:hover { background: var(--ps-acc2); transform: translateY(-1px); }
.ps-send-btn:disabled { background: var(--ps-muted); cursor: not-allowed; transform: none; }
.ps-send-btn svg { width: 15px; height: 15px; fill:none; stroke:#fff; stroke-width:2; }

/* ── Thinking dots ─────────────────────────────────────────────────────────── */
.ps-thinking { display:flex; gap:4px; padding:6px 0; }
.ps-dot-anim { width:5px; height:5px; background:var(--ps-acc); border-radius:50%; animation:ps-bounce 1.4s infinite ease-in-out both; }
.ps-dot-anim:nth-child(1){ animation-delay:-.32s; }
.ps-dot-anim:nth-child(2){ animation-delay:-.16s; }
@keyframes ps-bounce { 0%,80%,100%{transform:scale(0)} 40%{transform:scale(1)} }
.ps-streaming::after { content:'▋'; animation:ps-blink .9s infinite; color:var(--ps-acc); }
@keyframes ps-blink { 0%,100%{opacity:1} 50%{opacity:0} }

/* ── Modal ─────────────────────────────────────────────────────────────────── */
.ps-modal-ov {
  position:fixed; inset:0; background:rgba(0,0,0,.6);
  display:none; align-items:center; justify-content:center;
  z-index:200; backdrop-filter:blur(4px);
}
.ps-modal-ov.open { display:flex; }
.ps-modal {
  background:var(--ps-bg2); border:1px solid var(--ps-border);
  border-radius:var(--ps-radius-lg); width:100%; max-width:460px;
  box-shadow:0 24px 60px var(--ps-shadow);
}
.ps-modal-hdr {
  padding:16px 20px; border-bottom:1px solid var(--ps-border);
  display:flex; align-items:center; justify-content:space-between;
}
.ps-modal-title { font-size:15px; font-weight:800; letter-spacing:-.02em; }
.ps-modal-body  { padding:20px; }
.ps-modal-footer {
  padding:12px 20px; border-top:1px solid var(--ps-border);
  display:flex; justify-content:flex-end; gap:8px;
}

/* ── Empty state ───────────────────────────────────────────────────────────── */
.ps-empty {
  display:flex; flex-direction:column;
  align-items:center; justify-content:center;
  height:100%; text-align:center; padding:40px; color:var(--ps-muted);
}
.ps-empty-icon {
  width:50px; height:50px; background:var(--ps-bg3);
  border-radius:14px; display:flex; align-items:center;
  justify-content:center; margin-bottom:14px;
}
.ps-empty-icon svg { width:22px; height:22px; fill:none; stroke:var(--ps-muted); stroke-width:1.5; }
.ps-empty-title { font-size:14px; font-weight:700; color:var(--ps-txt2); margin-bottom:5px; }
.ps-empty-sub   { font-size:11px; line-height:1.6; }

/* ── Validation checks ─────────────────────────────────────────────────────── */
.ps-checks { display:grid; grid-template-columns:1fr 1fr; gap:2px; }
.ps-check  { display:flex; align-items:center; gap:6px; padding:4px 0; font-size:11px; color:var(--ps-txt2); }
.ps-check-icon {
  width:15px; height:15px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  flex-shrink:0; font-size:9px; font-weight:800;
}
.ps-check-icon.pass { background:var(--ps-ok-bg); color:var(--ps-ok); }
.ps-check-icon.fail { background:var(--ps-err-bg); color:var(--ps-err); }

/* ── Grid helpers ──────────────────────────────────────────────────────────── */
.ps-grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.ps-grid-3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }
.ps-flex   { display:flex; align-items:center; }
.ps-flex-col { display:flex; flex-direction:column; }
.ps-gap-2  { gap:8px; }
.ps-gap-3  { gap:12px; }
.ps-gap-4  { gap:16px; }
.ps-flex-1 { flex:1; min-width:0; min-height:0; }
.ps-overflow-auto { overflow:auto; }
.ps-overflow-hidden { overflow:hidden; }
.ps-p3  { padding:12px; }
.ps-p4  { padding:16px; }
.ps-mb2 { margin-bottom:8px; }
.ps-mb3 { margin-bottom:12px; }

/* ── Background texture ────────────────────────────────────────────────────── */
.ps-bg-grid {
  background-image:
    linear-gradient(var(--ps-faint) 1px, transparent 1px),
    linear-gradient(90deg, var(--ps-faint) 1px, transparent 1px);
  background-size: 40px 40px;
}
.ps-bg-glow::before {
  content:''; position:absolute; inset:0; pointer-events:none;
  background:
    radial-gradient(ellipse 60% 50% at 35% 35%, var(--ps-acc-glow) 0%, transparent 65%),
    radial-gradient(ellipse 40% 60% at 70% 65%, color-mix(in srgb, var(--ps-acc2) 20%, transparent) 0%, transparent 65%);
  opacity:.5;
}

/* ── Stage pipeline bar ────────────────────────────────────────────────────── */
.ps-pipeline-bar { display:flex; align-items:center; gap:0; }
.ps-stage {
  display:flex; align-items:center; gap:6px;
  padding:5px 12px; border-radius:20px;
  font-size:11px; font-weight:700; color:var(--ps-muted);
  transition:all .2s; letter-spacing:.02em;
}
.ps-stage.active { color:var(--ps-acc); background:var(--ps-acc3); }
.ps-stage.done   { color:var(--ps-ok); }
.ps-stage-num {
  width:17px; height:17px; border-radius:50%;
  border:2px solid currentColor;
  display:flex; align-items:center; justify-content:center;
  font-size:9px; font-weight:800;
}
.ps-stage-arrow { color:var(--ps-muted); font-size:13px; margin:0 2px; }

/* ── Template card ─────────────────────────────────────────────────────────── */
.ps-card {
  background:var(--ps-bg3); border:1px solid var(--ps-border);
  border-radius:var(--ps-radius-lg); padding:16px;
  transition:border-color .2s, background .2s;
}
.ps-card:hover { border-color:var(--ps-border-hi); }
.ps-card.selected { border-color:var(--ps-acc); background:var(--ps-acc3); }
.ps-card-title { font-size:13px; font-weight:700; margin-bottom:4px; }
.ps-card-sub   { font-size:11px; color:var(--ps-muted); line-height:1.5; }

/* ── Progress bar ──────────────────────────────────────────────────────────── */
.ps-progress { height:3px; background:var(--ps-bg4); border-radius:2px; overflow:hidden; }
.ps-progress-bar {
  height:100%; background:var(--ps-acc);
  border-radius:2px; transition:width .4s ease;
  box-shadow:0 0 8px var(--ps-acc-glow);
}
.ps-progress-pulse {
  height:100%; background:linear-gradient(90deg,transparent,var(--ps-acc),transparent);
  border-radius:2px; animation:ps-progress-sweep 1.5s infinite;
}
@keyframes ps-progress-sweep { 0%{transform:translateX(-200%)} 100%{transform:translateX(400%)} }

/* ── Toast notification ────────────────────────────────────────────────────── */
.ps-toast-area {
  position:fixed; bottom:20px; right:20px;
  display:flex; flex-direction:column; gap:8px; z-index:999;
}
.ps-toast {
  padding:10px 16px; border-radius:10px;
  border:1px solid var(--ps-border); background:var(--ps-bg2);
  font-size:12px; font-weight:600; color:var(--ps-txt);
  box-shadow:0 8px 24px var(--ps-shadow);
  animation:ps-toast-in .25s ease;
  display:flex; align-items:center; gap:8px;
}
.ps-toast.ok   { border-color:var(--ps-ok);   color:var(--ps-ok);   background:var(--ps-ok-bg); }
.ps-toast.err  { border-color:var(--ps-err);  color:var(--ps-err);  background:var(--ps-err-bg); }
.ps-toast.warn { border-color:var(--ps-warn); color:var(--ps-warn); background:var(--ps-warn-bg); }
@keyframes ps-toast-in { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
`;

  // ── Public API ──────────────────────────────────────────────────────────────
  const PlaneTheme = {
    THEMES, ACCENTS,

    /**
     * Apply theme to document.
     * @param {Object} opts
     * @param {'void'|'slate'|'carbon'|'ash'} opts.theme
     * @param {'electric'|'violet'|'cyan'|'amber'|'rose'|'lime'} opts.accent
     * @param {HTMLElement} opts.target  (default: document.documentElement)
     */
    apply(opts = {}) {
      const theme  = opts.theme  || 'void';
      const accent = opts.accent || 'electric';
      const target = opts.target || document.documentElement;

      // inject tokens
      const tokens = { ...THEMES[theme], ...ACCENTS[accent] };
      for (const [k, v] of Object.entries(tokens)) {
        target.style.setProperty(k, v);
      }

      // inject semantic (static) tokens once
      if (!document.getElementById('ps-semantic')) {
        const s = document.createElement('style');
        s.id = 'ps-semantic';
        s.textContent = `:root { ${SEMANTIC} }`;
        document.head.appendChild(s);
      }

      // inject base CSS once
      if (!document.getElementById('ps-base')) {
        const s = document.createElement('style');
        s.id = 'ps-base';
        s.textContent = BASE_CSS;
        document.head.appendChild(s);
      }

      PlaneTheme._current = { theme, accent };
    },

    /** Switch only the accent, keep theme */
    setAccent(accent) {
      PlaneTheme.apply({ theme: PlaneTheme._current?.theme || 'void', accent });
    },

    /** Switch only the theme, keep accent */
    setTheme(theme) {
      PlaneTheme.apply({ theme, accent: PlaneTheme._current?.accent || 'electric' });
    },

    /** List available theme/accent IDs */
    list() {
      return { themes: Object.keys(THEMES), accents: Object.keys(ACCENTS) };
    },

    /** Utility: show a transient toast */
    toast(msg, type = '', duration = 3000) {
      let area = document.getElementById('ps-toast-area');
      if (!area) {
        area = document.createElement('div');
        area.id = 'ps-toast-area';
        area.className = 'ps-toast-area';
        document.body.appendChild(area);
      }
      const t = document.createElement('div');
      t.className = `ps-toast ${type}`;
      t.textContent = msg;
      area.appendChild(t);
      setTimeout(() => t.remove(), duration);
    },

    _current: null,
  };

  // Auto-apply defaults if loaded as a plain <script> tag
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      if (!PlaneTheme._current) PlaneTheme.apply();
    });
  }

  return PlaneTheme;
});
