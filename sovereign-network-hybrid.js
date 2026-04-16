// ════════════════════════════════════════════════════════════════════════════
//  sovereign-network-hybrid.js  —  L4.5 Hybrid Network Transport
//
//  Implements the hybrid network layer described in:
//    docs/I-AM-IOS-HYBRID-NETWORK.md
//
//  Three network modes (automatic, transparent):
//    Mode 1 — Internet-Primary:   event → public validator → BFT consensus
//    Mode 2 — Offline / P2P:      event → WebRTC gossip mesh (current I-AM-IOS)
//    Mode 3 — Degraded:           try validator (2s) → fallback to P2P → resync
//
//  Invariants preserved:
//    • L3 (sovereign-log / deriveState) is NEVER touched
//    • L5 (rekernel locks) is NEVER touched
//    • Pure P2P path is the same code as before — HybridNetwork is opt-in
//    • Zero state loss: events persist in IndexedDB and resync on reconnect
//
//  Usage:
//    // Opt-in to hybrid by passing validatorEndpoint to attachNetwork():
//    const net = await attachNetwork({
//      validatorEndpoint: 'https://validator.example.com',
//      validatorPubkey:   'abcd1234...',   // optional — for future sig verify
//      fallbackTimeout:   2000,            // ms before falling back to P2P
//    });
//
//    // To use pure P2P unchanged, simply don't pass validatorEndpoint.
// ════════════════════════════════════════════════════════════════════════════

import { getLog } from './sovereign-log.js';

// ── Internal constants ────────────────────────────────────────────────────────

const DEFAULT_FALLBACK_TIMEOUT_MS = 2000;    // 2 s to declare validator unreachable
const DEFAULT_CHECK_INTERVAL_MS   = 5000;    // re-check connectivity every 5 s
const DEFAULT_FINALITY_TIMEOUT_MS = 6000;    // wait up to 6 s for validator finality
const DEFAULT_FINALITY_POLL_MS    = 1000;    // poll validator status every 1 s

// ── FNV-32 (local copy — keeps this module self-contained) ───────────────────
function fnv32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ────────────────────────────────────────────────────────────────────────────
//  HybridNetwork — L4.5 transport router
//
//  Public API (mirrors the P2P layer's surface so sovereign-network.js can
//  swap it in transparently):
//    await hybrid.broadcastEvent(record)         → { mode, receipt?, estimatedFinality? }
//    await hybrid.awaitFinality(hash, timeoutMs) → { final, mode, height?, timeout? }
//    hybrid.checkConnectivity()                  → Promise<boolean>
//    hybrid.get isOnline()                       → boolean (last known state)
//    hybrid.addPeer(conn)                        → void   (called by SovereignPeer)
//    hybrid.removePeer(peerId)                   → void
//    await hybrid.onReconnect()                  → void   (resync unfinalized events)
//    hybrid.trackPending(hash, record)           → void   (register for finality wait)
//    hybrid.markFinalized(hash)                  → void   (called after quorum ack)
//    hybrid.destroy()                            → void   (clear timers)
// ────────────────────────────────────────────────────────────────────────────

export class HybridNetwork {
  /**
   * @param {object} opts
   * @param {string}   opts.validatorEndpoint  — Base URL of the validator node
   * @param {string}   [opts.validatorPubkey]  — Hex pubkey (reserved for future signature verification)
   * @param {string[]} [opts.validatorBackups] — Fallback validator URLs tried in order
   * @param {number}   [opts.fallbackTimeout]  — ms before giving up on validator (default 2000)
   * @param {number}   [opts.checkInterval]    — ms between background connectivity probes (default 5000)
   * @param {Function} [opts.onModeChange]     — called with ('validator'|'p2p', wasOnline) on transitions
   * @param {Function} [opts.onReconnected]    — called after successful resync following reconnection
   */
  constructor(opts = {}) {
    this._endpoint        = opts.validatorEndpoint;
    this._pubkey          = opts.validatorPubkey   ?? null;
    this._backups         = opts.validatorBackups  ?? [];
    this._fallbackTimeout = opts.fallbackTimeout   ?? DEFAULT_FALLBACK_TIMEOUT_MS;
    this._checkInterval   = opts.checkInterval     ?? DEFAULT_CHECK_INTERVAL_MS;
    this._onModeChange    = opts.onModeChange      ?? null;
    this._onReconnected   = opts.onReconnected     ?? null;

    this._isOnline        = false;          // last known connectivity state
    this._activeEndpoint  = this._endpoint; // current live endpoint URL

    // Finality tracking: hash → { record, resolve, reject, timer }
    this._pendingFinality = new Map();

    // Unfinalized events: records that have been broadcast but not yet confirmed
    this._unfinalizedByHash = new Map();    // contentHash → record

    // P2P peer connections (set by sovereign-network.js via addPeer/removePeer)
    this._peers = new Map();                // peerId → DataConnection

    // Background probe timer
    this._probeTimer = setInterval(() => this._backgroundProbe(), this._checkInterval);
    this._backgroundProbe();               // probe immediately at construction
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  get isOnline() { return this._isOnline; }

  // ── Connectivity detection ────────────────────────────────────────────────

  /**
   * Attempt a lightweight HTTPS handshake to the validator's /health endpoint.
   * Falls back through backup validators before declaring offline.
   * Updates this._isOnline and fires onModeChange if state flipped.
   *
   * @returns {Promise<boolean>}
   */
  async checkConnectivity() {
    const wasOnline = this._isOnline;
    const endpoints = [this._endpoint, ...this._backups].filter(Boolean);

    for (const url of endpoints) {
      try {
        const response = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(this._fallbackTimeout),
          // Avoid caching the probe response
          cache: 'no-store',
        });
        if (response.ok) {
          this._isOnline        = true;
          this._activeEndpoint  = url;
          if (!wasOnline) {
            this._onModeChange?.('validator', wasOnline);
            // Resync any events that accumulated while offline
            this.onReconnect().catch(err =>
              console.warn('[hybrid-network] resync error:', err)
            );
          }
          return true;
        }
      } catch (_) {
        // This endpoint is unreachable — try the next backup
      }
    }

    this._isOnline = false;
    if (wasOnline) {
      this._onModeChange?.('p2p', wasOnline);
    }
    return false;
  }

  // ── Event routing (main entry point called by sovereign-network.js) ───────

  /**
   * Route an event to the validator (online) or WebRTC peers (offline).
   *
   * @param {object} record     — sovereign-log EventRecord
   * @param {string} signature  — optional hex signature over record
   * @returns {Promise<{ mode: 'validator'|'p2p', receipt?: object, estimatedFinality?: number }>}
   */
  async broadcastEvent(record, signature = '') {
    // Always register as unfinalized until confirmed
    this._unfinalizedByHash.set(record.hash, record);

    const online = await this.checkConnectivity();

    if (online) {
      const result = await this._sendToValidator(record, signature);
      if (result) return result;
      // Validator accepted the connection but failed — fall through to P2P
    }

    // P2P fallback
    this._broadcastToP2P(record);
    return {
      mode:              'p2p',
      receipt:           null,
      estimatedFinality: null,
    };
  }

  // ── Finality waiting ──────────────────────────────────────────────────────

  /**
   * Wait for finality from whichever path is active.
   * In validator mode: polls /events/:hash/status up to timeoutMs.
   * In P2P mode: waits for this._peers quorum ack (resolved externally via markFinalized).
   *
   * @param {string} hash       — content hash of the event (not the FNV-32 chain hash)
   * @param {number} timeoutMs
   * @returns {Promise<{ final: boolean, mode: string, height?: number, timeout?: boolean }>}
   */
  awaitFinality(hash, timeoutMs = DEFAULT_FINALITY_TIMEOUT_MS) {
    if (this._isOnline) {
      return this._waitForValidatorFinality(hash, timeoutMs);
    }
    return this._waitForP2PFinality(hash, timeoutMs);
  }

  /**
   * Called by sovereign-network.js when P2P quorum is reached for a given
   * content hash, so we can resolve any pending awaitFinality() promise.
   *
   * @param {string} hash
   */
  markFinalized(hash) {
    this._unfinalizedByHash.delete(hash);
    const pending = this._pendingFinality.get(hash);
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingFinality.delete(hash);
      pending.resolve({ final: true, mode: 'p2p' });
    }
  }

  /**
   * Register a pending record so finality can be matched back to it.
   *
   * @param {string} hash
   * @param {object} record
   */
  trackPending(hash, record) {
    this._unfinalizedByHash.set(hash, record);
  }

  // ── Peer management (called by SovereignPeer in sovereign-network.js) ─────

  addPeer(peerId, conn) {
    this._peers.set(peerId, conn);
  }

  removePeer(peerId) {
    this._peers.delete(peerId);
  }

  // ── Reconnection resync ───────────────────────────────────────────────────

  /**
   * Called automatically when connectivity is restored.
   * Replays all events that are still pending finality to the validator,
   * so nothing accumulated offline is lost.
   */
  async onReconnect() {
    if (!this._isOnline || this._unfinalizedByHash.size === 0) return;

    const unfinalized = [...this._unfinalizedByHash.values()];
    console.log(`[hybrid-network] Reconnected — resyncing ${unfinalized.length} unfinalized event(s)`);

    for (const record of unfinalized) {
      try {
        await this._sendToValidator(record, '');
      } catch (err) {
        console.warn('[hybrid-network] resync send failed for seq', record.seq, err);
      }
    }

    this._onReconnected?.();
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  destroy() {
    clearInterval(this._probeTimer);
    for (const { timer, reject } of this._pendingFinality.values()) {
      clearTimeout(timer);
      reject(new Error('HybridNetwork destroyed'));
    }
    this._pendingFinality.clear();
  }

  // ── Private: validator path ───────────────────────────────────────────────

  /**
   * POST the event to the active validator endpoint.
   * Returns null if the POST itself fails (so the caller can fall back to P2P).
   */
  async _sendToValidator(record, signature) {
    try {
      const response = await fetch(`${this._activeEndpoint}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event:       record,
          signature,
          browserPeerId: this._peerId ?? 'unknown',
        }),
        signal: AbortSignal.timeout(this._fallbackTimeout),
      });

      if (!response.ok) {
        console.warn(`[hybrid-network] Validator returned ${response.status} — falling back to P2P`);
        return null;
      }

      const receipt = await response.json();
      return {
        mode:              'validator',
        receipt,
        estimatedFinality: Date.now() + DEFAULT_FINALITY_TIMEOUT_MS,
      };
    } catch (err) {
      // Timeout or network error — don't rethrow; let caller fall back
      console.warn('[hybrid-network] Validator send failed:', err.message ?? err);
      return null;
    }
  }

  /**
   * Poll the validator's /events/:hash/status until finalized or timeout.
   */
  async _waitForValidatorFinality(hash, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(
          `${this._activeEndpoint}/events/${hash}/status`,
          { signal: AbortSignal.timeout(this._fallbackTimeout) }
        );
        if (response.ok) {
          const status = await response.json();
          if (status.final) {
            this._unfinalizedByHash.delete(hash);
            return { final: true, mode: 'validator', height: status.height ?? null };
          }
        }
      } catch (_) {
        // Validator temporarily unreachable — keep polling until deadline
      }

      await _sleep(DEFAULT_FINALITY_POLL_MS);
    }

    return { final: false, mode: 'validator', timeout: true };
  }

  /**
   * Wait for P2P quorum finality to be signalled via markFinalized().
   */
  _waitForP2PFinality(hash, timeoutMs) {
    // Already finalized before we even asked?
    if (!this._unfinalizedByHash.has(hash)) {
      return Promise.resolve({ final: true, mode: 'p2p' });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingFinality.delete(hash);
        resolve({ final: false, mode: 'p2p', timeout: true });
      }, timeoutMs);

      this._pendingFinality.set(hash, { resolve, reject, timer });
    });
  }

  // ── Private: P2P fallback path ────────────────────────────────────────────

  /**
   * Broadcast a record to all connected WebRTC peers.
   * Mirrors SovereignPeer._broadcast but lives here so we can call it
   * independently from the validator path.
   */
  _broadcastToP2P(record) {
    const msg = {
      type:        'EVENT',
      senderId:    this._peerId ?? 'unknown',
      height:      getLog().length,
      payload:     JSON.stringify(record),
      payloadHash: record.hash,
      ts:          Date.now(),
    };
    for (const [, conn] of this._peers) {
      try { conn.send(msg); } catch (_) {}
    }
  }

  // ── Private: background connectivity probe ────────────────────────────────

  async _backgroundProbe() {
    await this.checkConnectivity();
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Factory: build a HybridNetwork only when validatorEndpoint is provided ───

/**
 * Create a HybridNetwork instance from attachNetwork() opts, or return null
 * if no validatorEndpoint is configured (pure P2P mode, unchanged behaviour).
 *
 * @param {object} opts — same opts object passed to attachNetwork()
 * @returns {HybridNetwork|null}
 */
export function createHybridNetwork(opts) {
  if (!opts?.validatorEndpoint) return null;

  return new HybridNetwork({
    validatorEndpoint: opts.validatorEndpoint,
    validatorPubkey:   opts.validatorPubkey   ?? null,
    validatorBackups:  opts.validatorBackups  ?? [],
    fallbackTimeout:   opts.fallbackTimeout   ?? DEFAULT_FALLBACK_TIMEOUT_MS,
    checkInterval:     opts.checkInterval     ?? DEFAULT_CHECK_INTERVAL_MS,
    onModeChange: (mode, wasOnline) => {
      console.log(`[hybrid-network] Mode → ${mode} (was ${wasOnline ? 'validator' : 'p2p'})`);
    },
  });
}
