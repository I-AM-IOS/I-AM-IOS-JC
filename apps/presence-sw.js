// ════════════════════════════════════════════════════════════════════════════
//  presence-sw.js  —  I-AM Social · Presence & Capability Service Worker
//
//  Responsibilities:
//    1. Probe Ollama (localhost:11434) — if up, local AI + server.js available
//    2. Probe server.js presence WS endpoint (/api/peers)
//    3. Detect device capability tier (HIGH / MID / LOW / MINIMAL)
//    4. Broadcast result to all controlled clients via postMessage
//    5. On "WAKE" message from page → re-probe immediately
//    6. Periodic re-probe every 30s to catch server start/stop
//
//  Capability Tiers:
//    HIGH    — Ollama running locally  → full local AI + WS presence
//    MID     — No Ollama, good device  → WebLLM/transformers.js in-browser
//    LOW     — No Ollama, weak device  → lightweight WASM model
//    MINIMAL — No Ollama, no AI cap.   → pure P2P manual mode
// ════════════════════════════════════════════════════════════════════════════

const SW_VERSION       = 'presence-sw-v1';
const OLLAMA_URL       = 'http://localhost:11434/api/tags';
const PRESENCE_API_URL = '/api/peers';
const PROBE_INTERVAL   = 30_000; // re-probe every 30s

// ── State ────────────────────────────────────────────────────────────────────
let _lastStatus = null;
let _probeTimer = null;

// ── Install / Activate — take control immediately ────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

// ── Message handler — page can request a probe or ask for last status ────────
self.addEventListener('message', async evt => {
  const { type } = evt.data || {};

  if (type === 'WAKE' || type === 'PROBE') {
    const status = await probe();
    broadcast(status);
  }

  if (type === 'STATUS_REQUEST') {
    if (_lastStatus) {
      evt.source?.postMessage(_lastStatus);
    } else {
      const status = await probe();
      broadcast(status);
    }
  }
});

// ── Periodic probe ────────────────────────────────────────────────────────────
function scheduleProbe() {
  clearTimeout(_probeTimer);
  _probeTimer = setTimeout(async () => {
    const status = await probe();
    // Only broadcast if something changed
    if (JSON.stringify(status) !== JSON.stringify(_lastStatus)) {
      broadcast(status);
    }
    scheduleProbe();
  }, PROBE_INTERVAL);
}

scheduleProbe();

// ── Core probe logic ──────────────────────────────────────────────────────────
async function probe() {
  const [ollamaUp, serverUp, deviceTier] = await Promise.all([
    checkOllama(),
    checkPresenceServer(),
    detectDeviceTier(),
  ]);

  // Determine capability tier
  let tier;
  if (ollamaUp) {
    tier = 'HIGH';       // Ollama local — full local AI, WS presence via server.js
  } else if (deviceTier === 'HIGH' || deviceTier === 'MID') {
    tier = 'MID';        // No Ollama but capable device — WebLLM in-browser
  } else if (deviceTier === 'LOW') {
    tier = 'LOW';        // Weak device — tiny WASM model
  } else {
    tier = 'MINIMAL';    // No AI at all — pure P2P
  }

  const status = {
    type:        'CAPABILITY_STATUS',
    tier,
    ollamaUp,
    serverUp,
    deviceTier,
    timestamp:   Date.now(),
    // Recommendations for the page
    usePresenceWS:  serverUp,
    useOllamaAI:    ollamaUp,
    useWebLLM:      !ollamaUp && (deviceTier === 'HIGH' || deviceTier === 'MID'),
    useWasmModel:   !ollamaUp && deviceTier === 'LOW',
    aiDisabled:     !ollamaUp && deviceTier === 'MINIMAL',
  };

  _lastStatus = status;
  return status;
}

// ── Probe: Ollama ─────────────────────────────────────────────────────────────
async function checkOllama() {
  try {
    const r = await fetch(OLLAMA_URL, {
      method:  'GET',
      cache:   'no-store',
      signal:  AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch (_) {
    return false;
  }
}

// ── Probe: server.js presence REST endpoint ───────────────────────────────────
async function checkPresenceServer() {
  try {
    const r = await fetch(PRESENCE_API_URL, {
      method:  'GET',
      cache:   'no-store',
      signal:  AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch (_) {
    return false;
  }
}

// ── Device capability detection ───────────────────────────────────────────────
// Returns 'HIGH' | 'MID' | 'LOW' | 'MINIMAL'
// Uses available navigator hints — all optional, graceful fallback
async function detectDeviceTier() {
  try {
    const mem     = navigator.deviceMemory;          // GB, undefined if not supported
    const cores   = navigator.hardwareConcurrency;   // logical CPU count
    const conn    = navigator.connection;
    const netType = conn?.effectiveType;             // '4g'|'3g'|'2g'|'slow-2g'

    // Score: memory (0-3), cores (0-3), network (0-2)
    let score = 0;

    // Memory
    if      (mem === undefined) score += 1;  // unknown — assume mid
    else if (mem >= 8)          score += 3;
    else if (mem >= 4)          score += 2;
    else if (mem >= 2)          score += 1;

    // CPU cores
    if      (cores === undefined) score += 1;
    else if (cores >= 8)          score += 3;
    else if (cores >= 4)          score += 2;
    else if (cores >= 2)          score += 1;

    // Network (only relevant for downloading models)
    if      (!netType || netType === '4g') score += 2;
    else if (netType === '3g')             score += 1;

    // GPU — try to detect via WebGL
    const hasGPU = await checkWebGL();
    if (hasGPU) score += 2;

    if      (score >= 8) return 'HIGH';
    else if (score >= 5) return 'MID';
    else if (score >= 3) return 'LOW';
    else                 return 'MINIMAL';

  } catch (_) {
    return 'MID'; // unknown → assume mid
  }
}

// WebGL Context Pool (prevent "Too many active WebGL contexts" warning)
const _glPool = { max: 1, active: 0 };
const _glCache = { value: null, checked: false };

// Check for WebGL2 support (proxy for GPU capability)
async function checkWebGL() {
  try {
    if (_glCache.checked) return _glCache.value;
    
    if (typeof OffscreenCanvas !== 'undefined') {
      if (_glPool.active >= _glPool.max) {
        return _glCache.value || false;
      }
      
      _glPool.active++;
      try {
        const canvas = new OffscreenCanvas(1, 1);
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        const result = !!gl;
        _glCache.value = result;
        _glCache.checked = true;
        return result;
      } finally {
        _glPool.active--;
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

// ── Broadcast to all controlled clients ──────────────────────────────────────
async function broadcast(msg) {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      try {
        client.postMessage(msg);
      } catch (e) {
        // Client might be closed, ignore
      }
    }
  } catch (e) {
    // matchAll failed, ignore
  }
}
