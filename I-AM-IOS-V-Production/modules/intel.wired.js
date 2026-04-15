// ════════════════════════════════════════════════════════════════════════════
//  modules/intel.js  —  SOVEREIGN-LOG WIRED VERSION
//
//  Changes from original:
//    1. `state` import → migration-shim (reads = live projections, writes = events)
//    2. `runKernel` import → kernel-adapter (runKernel now emits to sovereign-log)
//    3. `runKernelIntel` reads result from deriveState() not return value
//    4. `addIntelMessage` helper replaces direct state.intelHistory.push
//    5. Kernel model state changes go through shim → EVENT_TYPES.MODEL_SELECTED
//
//  Everything else is structurally identical — no UI changes, no new deps.
// ════════════════════════════════════════════════════════════════════════════

import { state, addIntelMessage, resetIntelHistory } from '../migration-shim.js';
import { deriveState, subscribe }                     from '../sovereign-log.js';
import { PROJECTS, CONVOS, QUICK_PROMPTS, INTEL_WELCOME, INTEL_SUB, buildSystemPrompt } from './config.js';
import { appendMsg, showToast, scrollBot, mdToHtml, typingBubble } from './ui.js';
import { streamOllama }     from './ollama.js';
import { runKernel as _runKernelAdapter, getContradictionGraph } from '../kernel-adapter.js';
import { renderKernelResult, createKernelLogger, ALL_VIEWS } from './kernel.js';

// ── Subscribe so UI re-renders when log changes ───────────────────────────────
// (replaces the implicit reactivity from direct state mutation)
let _unsubscribe = null;
function _onStateChange(s, record) {
  if (!record) return;
  // Re-enable send button if kernel finished
  if (record.type === 'KERNEL_ANALYSIS' || record.type === 'KERNEL_ERROR') {
    document.getElementById('intelSend').disabled = false;
  }
}

export function initIntel() {
  _unsubscribe = subscribe(_onStateChange);

  document.getElementById('intelSub').textContent = INTEL_SUB;
  const welcomeEl = document.querySelector('#intelMessages .bubble');
  if (welcomeEl) welcomeEl.innerHTML = INTEL_WELCOME;

  document.getElementById('intelQuicks').innerHTML = QUICK_PROMPTS
    .map(q => `<div class="qp" data-prompt="${escAttr(q.prompt)}">${q.label}</div>`)
    .join('');
  document.getElementById('intelQuicks').addEventListener('click', e => {
    const el = e.target.closest('.qp');
    if (el) { document.getElementById('intelInput').value = el.dataset.prompt; sendIntel(); }
  });

  document.getElementById('intelInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIntel(); }
  });
  document.getElementById('intelSend').addEventListener('click', sendIntel);

  injectKernelControls();
}

function injectKernelControls() {
  const sendBtn = document.getElementById('intelSend');
  if (!sendBtn) return;
  const inputRow  = sendBtn.parentElement;
  const inputArea = inputRow?.parentElement;

  const toggle = document.createElement('button');
  toggle.id        = 'kernelToggle';
  toggle.className = 'kernel-toggle-btn';
  toggle.title     = '2×3 Multi-Model Kernel — outputs emit to sovereign-log';
  toggle.textContent = '⊛ KERNEL';
  toggle.addEventListener('click', () => {
    // Write goes through shim → KERNEL_MODE_TOGGLED event
    state.kernelMode = !state.kernelMode;
    const active = deriveState().kernelMode;
    toggle.classList.toggle('active', active);
    toggle.textContent = active ? '⊛ ON' : '⊛ KERNEL';
    kernelPanel.style.display = active ? 'block' : 'none';
  });
  inputRow.insertBefore(toggle, sendBtn);

  const kernelPanel = document.createElement('div');
  kernelPanel.id        = 'kernelPanel';
  kernelPanel.className = 'kernel-panel';
  kernelPanel.style.display = 'none';
  kernelPanel.innerHTML = `
    <div class="kp-header">
      <span class="kp-title">⊛ 2×3 KERNEL — assign models to slots</span>
      <span class="kp-hint">Outputs logged to sovereign-log as KERNEL_ANALYSIS events</span>
    </div>
    <div class="kp-slots">
      <div class="kp-slot kp-a">
        <div class="kp-slot-label">MODEL A</div>
        <div class="kp-slot-views">structural · causal · boundary</div>
        <select class="kp-select" id="kernelModelASelect">
          <option value="">— same as chat model —</option>
        </select>
      </div>
      <div class="kp-divider">×</div>
      <div class="kp-slot kp-b">
        <div class="kp-slot-label">MODEL B</div>
        <div class="kp-slot-views">functional · analogy · failure</div>
        <select class="kp-select" id="kernelModelBSelect">
          <option value="">— same as chat model —</option>
        </select>
      </div>
    </div>
    <div class="kp-footer">
      Iterations: <select class="kp-iter-select" id="kernelIterSelect">
        <option value="1">1 (fast)</option>
        <option value="2">2 (balanced)</option>
        <option value="3" selected>3 (full convergence)</option>
      </select>
    </div>`;
  inputArea.insertBefore(kernelPanel, inputRow);

  const masterSelect = document.getElementById('modelSelect');
  function syncModelOptions() {
    const options = [...masterSelect.options].filter(o => o.value);
    ['kernelModelASelect','kernelModelBSelect'].forEach((id, idx) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = '<option value="">— same as chat model —</option>';
      options.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.textContent;
        sel.appendChild(opt);
      });
      if (!cur && options.length >= 2) sel.value = options[idx % options.length]?.value || '';
      else if (cur) sel.value = cur;
      _syncKernelModels();
    });
  }
  if (masterSelect) {
    masterSelect.addEventListener('change', syncModelOptions);
    setTimeout(syncModelOptions, 2000);
  }

  function _syncKernelModels() {
    const selA = document.getElementById('kernelModelASelect');
    const selB = document.getElementById('kernelModelBSelect');
    // Writes go through shim → MODEL_SELECTED { slot: 'A' | 'B' } events
    state.kernelModelA = selA?.value || '';
    state.kernelModelB = selB?.value || '';
  }

  document.getElementById('kernelModelASelect')?.addEventListener('change', _syncKernelModels);
  document.getElementById('kernelModelBSelect')?.addEventListener('change', _syncKernelModels);
}

function escAttr(s) { return s.replace(/"/g, '&quot;'); }

export async function sendIntel() {
  const s = deriveState();
  if (s.streaming || s.kernelRunning) return;

  const input = document.getElementById('intelInput');
  const text  = input.value.trim();
  if (!text) return;
  if (!s.ollamaOk)     { showToast('Ollama not connected', true); return; }
  if (!s.model)        { showToast('Select a model', true); return; }
  input.value = '';

  if (s.kernelMode) { await _runKernelIntel(text); return; }

  // ── Standard streaming path ───────────────────────────────────────────────
  appendMsg('intelMessages', 'user', text);
  addIntelMessage('user', text);    // ← shim: emits INTEL_MESSAGE_ADDED

  state.streaming = true;           // ← shim: emits STREAMING_STARTED
  document.getElementById('intelSend').disabled = true;
  const { bubble } = typingBubble('intelMessages', 'assistant');
  let full = '';
  try {
    const history = deriveState().intelHistory;
    const gen = streamOllama(history, buildSystemPrompt(CONVOS, PROJECTS));
    let first = true;
    for await (const chunk of gen) {
      if (first) { bubble.innerHTML = ''; first = false; }
      full += chunk;
      bubble.innerHTML = mdToHtml(full);
      scrollBot('intelMessages');
    }
    addIntelMessage('assistant', full);   // ← shim: INTEL_MESSAGE_ADDED
  } catch (e) {
    bubble.innerHTML = `<p style="color:var(--accent3)">Error: ${e.message}</p>`;
  }
  state.streaming = false;          // ← shim: STREAMING_ENDED
  document.getElementById('intelSend').disabled = false;
}

// ── Kernel path ───────────────────────────────────────────────────────────────
async function _runKernelIntel(concept) {
  // kernel-adapter.js emits KERNEL_STARTED, KERNEL_VIEW_RESOLVED, KERNEL_ANALYSIS
  // into sovereign-log — we don't touch state directly here.
  document.getElementById('intelSend').disabled = true;
  appendMsg('intelMessages', 'user', `⊛ KERNEL: ${concept}`);

  const container = document.getElementById('intelMessages');
  const wrapper   = document.createElement('div');
  wrapper.className = 'msg assistant';
  const bubble    = document.createElement('div');
  bubble.className = 'bubble';
  wrapper.appendChild(bubble);
  container.appendChild(wrapper);
  scrollBot('intelMessages');

  const logger = createKernelLogger(bubble);

  try {
    // runKernel from kernel-adapter emits events; returns the KERNEL_ANALYSIS seq
    const seq = await _runKernelAdapter(concept);

    // Read result from log (not from return value — we trust the log)
    const s   = deriveState();
    const run = s.kernelRuns.find(r => r.seq === seq);

    if (run) {
      bubble.innerHTML = '';
      // renderKernelResult expects the original result shape — reconstruct it
      renderKernelResult({
        modelA:            s.kernelModelA,
        modelB:            s.kernelModelB,
        stable:            true,
        iterations:        [{ views: run.views }],
        intersection:      { invariants: [] },   // derived below
        contradictionGraph: run.contradictionGraph,
        clusters:          run.clusters,
        truthHash:         run.truthHash,
      }, bubble);
      scrollBot('intelMessages');

      const inv = run.views?.flatMap(v => v.invariants) ?? [];
      const summary =
        `[2×3 Kernel · "${concept}" · hash:${run.truthHash}]\n` +
        `${inv.length} invariants across ${run.views?.length ?? 0} views`;
      addIntelMessage('user', concept);
      addIntelMessage('assistant', summary);
    }
  } catch (e) {
    bubble.innerHTML = `<div style="color:var(--accent3);padding:12px">Kernel error: ${e.message}</div>`;
  }
  // send button re-enabled by subscribe(_onStateChange) on KERNEL_ANALYSIS event
}

export function askAbout(name) {
  if (state.activeTab !== 'intel') document.querySelector('[data-view="intel"]').click();
  document.getElementById('intelInput').value =
    `Tell me about ${name} — what was built, the key architectural decisions, current state, and what remains to be done.`;
  document.getElementById('intelInput').focus();
}

export function selectConvo(uuid) {
  document.querySelectorAll('.convo-item').forEach(el => el.classList.remove('sel'));
  const el = document.getElementById('ci_' + uuid);
  if (el) el.classList.add('sel');
  const c = CONVOS.find(x => x.uuid === uuid);
  if (!c) return;
  document.getElementById('intelInput').value =
    `Tell me about the conversation "${c.name}" from ${c.date}. What was I trying to do, what was the approach, and what came out of it?`;
  document.getElementById('intelInput').focus();
}
