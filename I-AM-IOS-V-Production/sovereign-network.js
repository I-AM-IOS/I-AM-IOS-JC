// ════════════════════════════════════════════════════════════════════════════
//  sovereign-network.js  —  The Sovereign Compute Network Wiring Harness
//
//  This is the integration glue layer. It connects:
//    sovereign-log  →  rekernel (event promotion + finality)
//    sovereign-log  →  UDCSEF fabric (compute dispatch)
//    PeerJS         →  rekernel gossip (same transport, bridged)
//    sovereign-log  →  IndexedDB (persistent ledger)
//
//  Invariant:
//    local event (sovereign-log) → network promotion → consensus (>2/3 ack)
//    → CONSENSUS_FINALIZED event → sovereign-log (canonical truth)
//
//  Architecture:
//    ┌─ SURFACES ──────────────────────────────────────────────┐
//    │  app-builder | attack | generate-value | index1 | intel │
//    └───────────────────────┬─────────────────────────────────┘
//                            │ emit()
//    ┌─ sovereign-log ────────┴────────────────────────────────┐
//    │  FNV-32 hash chain · deriveState() · subscribe()        │
//    └──────┬──────────────────────────────────────────────────┘
//           │ subscribe()
//    ┌─ sovereign-network.js (THIS FILE) ──────────────────────┐
//    │  event promotion · PeerJS gossip · finality tracking    │
//    │  compute dispatch · IndexedDB persistence               │
//    └──────┬────────────────────────────────┬─────────────────┘
//           │ verifyEvent + gossip            │ program dispatch
//    ┌─ rekernel ───────────────┐   ┌─ UDCSEF fabric ─────────┐
//    │  BFT consensus + ledger  │   │  PeerJS P2P compute      │
//    └──────────────────────────┘   └─────────────────────────┘
//
//  Usage (add to each surface's init):
//    import { attachNetwork } from './sovereign-network.js';
//    const net = await attachNetwork({ nodeId: 'auto', quorum: 0.67 });
// ════════════════════════════════════════════════════════════════════════════

import { emit, getLog, subscribe, restore, deriveState, EVENT_TYPES } from './sovereign-log.js';
import { attachBus, broadcastRestore } from './sovereign-bus.js';
import { createHybridNetwork } from './sovereign-network-hybrid.js';

// ── Extended EVENT_TYPES for network layer ────────────────────────────────────
// Merge into sovereign-log.js EVENT_TYPES (or extend here and re-export)
export const NETWORK_EVENT_TYPES = {
  ...EVENT_TYPES,

  // Compute layer (generate-value.html / UDCSEF)
  FABRIC_NODE_ADDED:      'FABRIC_NODE_ADDED',
  FABRIC_NODE_LEFT:       'FABRIC_NODE_LEFT',
  FABRIC_COMPUTE:         'FABRIC_COMPUTE',
  FABRIC_COMPUTE_FAILED:  'FABRIC_COMPUTE_FAILED',

  // Surface events
  APP_BUILT:              'APP_BUILT',
  JSONFLOW_COMPILED:      'JSONFLOW_COMPILED',
  JSONFLOW_CODE_EMITTED:  'JSONFLOW_CODE_EMITTED',
  ATTACK_RUN:             'ATTACK_RUN',
  ATTACK_FINDING:         'ATTACK_FINDING',

  // Network consensus layer (emitted by this harness)
  NET_PEER_CONNECTED:     'NET_PEER_CONNECTED',
  NET_PEER_DROPPED:       'NET_PEER_DROPPED',
  NET_EVENT_PROMOTED:     'NET_EVENT_PROMOTED',   // local event sent to network
  NET_EVENT_ACKED:        'NET_EVENT_ACKED',       // one peer acked
  CONSENSUS_FINALIZED:    'CONSENSUS_FINALIZED',   // quorum reached → canonical
  CONSENSUS_REJECTED:     'CONSENSUS_REJECTED',    // quorum rejected
  LEDGER_SNAPSHOT:        'LEDGER_SNAPSHOT',       // IndexedDB checkpoint

  // Hybrid network layer (L4.5) — emitted when mode switches
  HYBRID_MODE_CHANGED:    'HYBRID_MODE_CHANGED',   // switched validator ↔ p2p
  HYBRID_RESYNC:          'HYBRID_RESYNC',         // reconnected and resynced events
};

// ── FNV-32 (local — no dep on sovereign-log internals) ───────────────────────
function fnv32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── Content-address a sovereign-log record for network promotion ──────────────
// Produces a stable network-level hash (not the FNV-32 in sovereign-log).
// Uses SubtleCrypto when available, falls back to FNV-32.
async function contentHash(record) {
  const payload = JSON.stringify({
    type:    record.type,
    seq:     record.seq,
    ts:      record.ts,
    hash:    record.hash,        // FNV-32 from sovereign-log
    prevHash: record.prevHash,
  });

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = new TextEncoder().encode(payload);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return fnv32(payload);
}

// ────────────────────────────────────────────────────────────────────────────
//  IndexedDB Ledger Store
//  Persists sovereign-log records and snapshots across sessions.
// ────────────────────────────────────────────────────────────────────────────

const DB_NAME    = 'sovereign-ledger';
const DB_VERSION = 1;

function openLedgerDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('events')) {
        const store = db.createObjectStore('events', { keyPath: 'seq' });
        store.createIndex('by_type', 'type', { unique: false });
        store.createIndex('by_hash', 'hash', { unique: true });
      }
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'height' });
      }
      if (!db.objectStoreNames.contains('programs')) {
        // Content-addressed program registry (JSONFlow → UDCSEF)
        db.createObjectStore('programs', { keyPath: 'programHash' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function persistEvent(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('events', 'readwrite');
    const req = tx.objectStore('events').put(record);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function loadLedgerFromDB(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('events', 'readonly');
    const req = tx.objectStore('events').getAll();
    req.onsuccess = e => resolve(e.target.result.sort((a, b) => a.seq - b.seq));
    req.onerror   = e => reject(e.target.error);
  });
}

async function persistSnapshot(db, height, state) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readwrite');
    const req = tx.objectStore('snapshots').put({
      height,
      ts:          Date.now(),
      state:       JSON.stringify(state),
      snapshotHash: fnv32(JSON.stringify({ height, stateHash: state.stateHash ?? '' })),
    });
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function registerProgram(db, programHash, program) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('programs', 'readwrite');
    const req = tx.objectStore('programs').put({ programHash, program, ts: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

// ────────────────────────────────────────────────────────────────────────────
//  PeerJS Gossip Bridge
//  Implements rekernel's gossip.ts protocol in JS over PeerJS WebRTC.
//  Message types: EVENT | ACK | SYNC | MEMBERSHIP | FORK_PROOF
// ────────────────────────────────────────────────────────────────────────────

class SovereignPeer {
  constructor(nodeId, opts = {}) {
    this._id          = nodeId;
    this._peers       = new Map();   // peerId → DataConnection
    this._seen        = new Set();   // dedup by contentHash
    this._ackCounts   = new Map();   // contentHash → Set of peerIds who acked
    this._quorum      = opts.quorum ?? 0.67;
    this._onFinalized = opts.onFinalized ?? (() => {});
    this._onRejected  = opts.onRejected  ?? (() => {});
    this._peer        = null;
    this._validators  = opts.validators ?? [];   // [{ id, votingPower }]
    this._totalPower  = this._validators.reduce((s, v) => s + v.votingPower, 0) || 1;
  }

  // ── Initialize PeerJS ────────────────────────────────────────────────────
  async init() {
    if (typeof Peer === 'undefined') {
      console.warn('[sovereign-network] PeerJS not loaded — gossip disabled. Add <script src="https://cdn.jsdelivr.net/npm/peerjs@1.5.2/dist/peerjs.min.js"></script>');
      return this;
    }

    return new Promise((resolve) => {
      this._peer = new Peer(this._id, {
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ],
        },
      });

      this._peer.on('open', id => {
        console.log(`[sovereign-network] Node online: ${id}`);
        resolve(this);
      });

      this._peer.on('connection', conn => this._handleIncoming(conn));
      this._peer.on('error',      err => console.warn('[sovereign-network] peer error:', err.type));
    });
  }

  // ── Connect to a known peer ──────────────────────────────────────────────
  connect(remotePeerId) {
    if (!this._peer || this._peers.has(remotePeerId)) return;
    const conn = this._peer.connect(remotePeerId, { reliable: true });
    conn.on('open',    () => this._registerConnection(conn));
    conn.on('error',   err => console.warn('[sovereign-network] conn error:', err));
  }

  // ── Broadcast an event to the gossip layer ───────────────────────────────
  async gossipEvent(record, contentHash_) {
    const msg = {
      type:       'EVENT',
      senderId:   this._id,
      height:     getLog().length,
      payload:    JSON.stringify(record),
      payloadHash: contentHash_,
      ts:         Date.now(),
    };
    this._broadcast(msg);
  }

  // ── Ack an event (we've verified it) ────────────────────────────────────
  async ackEvent(contentHash_, record) {
    const msg = {
      type:        'ACK',
      senderId:    this._id,
      payloadHash: contentHash_,
      height:      getLog().length,
      ts:          Date.now(),
    };
    this._broadcast(msg);
    this._recordAck(contentHash_, this._id, record);
  }

  // ── Request sync from peers (on reconnect) ───────────────────────────────
  requestSync() {
    const msg = {
      type:     'SYNC',
      senderId: this._id,
      height:   getLog().length,
      ts:       Date.now(),
    };
    this._broadcast(msg);
  }

  // ── Send fork proof to peers ─────────────────────────────────────────────
  sendForkProof(proof) {
    const msg = {
      type:     'FORK_PROOF',
      senderId: this._id,
      payload:  JSON.stringify(proof),
      ts:       Date.now(),
    };
    this._broadcast(msg);
  }

  get peerId()    { return this._id; }
  get peerCount() { return this._peers.size; }

  // ── Private ──────────────────────────────────────────────────────────────

  _handleIncoming(conn) {
    conn.on('open',    () => this._registerConnection(conn));
    conn.on('data',    data => this._handleMessage(data, conn.peer));
    conn.on('close',   () => this._peers.delete(conn.peer));
    conn.on('error',   err => console.warn('[sovereign-network] incoming conn error:', err));
  }

  _registerConnection(conn) {
    this._peers.set(conn.peer, conn);
    conn.on('data',  data => this._handleMessage(data, conn.peer));
    conn.on('close', ()   => this._peers.delete(conn.peer));
    // Send our current height for sync
    conn.send({ type: 'SYNC', senderId: this._id, height: getLog().length, ts: Date.now() });
  }

  _broadcast(msg) {
    for (const [, conn] of this._peers) {
      try { conn.send(msg); } catch (_) {}
    }
  }

  _handleMessage(msg, fromPeerId) {
    if (!msg?.type) return;

    switch (msg.type) {
      case 'EVENT': {
        // Validate + relay if not seen
        if (this._seen.has(msg.payloadHash)) break;
        this._seen.add(msg.payloadHash);

        let record;
        try { record = JSON.parse(msg.payload); } catch (_) { break; }

        // Verify structural integrity (mirrors rekernel ingress I4/I6)
        if (!record.type || !record.hash || !record.seq) break;

        // Ack and relay
        this.ackEvent(msg.payloadHash, record);
        this._broadcast(msg);    // gossip relay
        break;
      }

      case 'ACK': {
        // Track acknowledgement toward quorum
        const record = this._pendingRecords?.get(msg.payloadHash);
        this._recordAck(msg.payloadHash, fromPeerId, record);
        break;
      }

      case 'SYNC': {
        // Peer at lower height — send our suffix
        const peerHeight = msg.height ?? 0;
        const suffix = getLog().slice(peerHeight);
        if (suffix.length && this._peers.has(fromPeerId)) {
          this._peers.get(fromPeerId).send({
            type:     'SYNC_RESPONSE',
            senderId: this._id,
            records:  suffix,
            ts:       Date.now(),
          });
        }
        break;
      }

      case 'SYNC_RESPONSE': {
        // Replay suffix into sovereign-log if we're behind
        const { records } = msg;
        if (!Array.isArray(records)) break;
        const localHeight = getLog().length;
        const newRecords = records.filter(r => r.seq >= localHeight);
        if (newRecords.length) {
          // Re-emit each new event (sovereign-log will reject duplicates by seq)
          for (const r of newRecords) {
            const { type, ...rest } = r;
            try { emit({ ...rest, type, _fromNet: true }); } catch (_) {}
          }
        }
        break;
      }

      case 'FORK_PROOF': {
        console.warn('[sovereign-network] Fork proof received from', fromPeerId);
        // Apply fork resolution rule: higher finality weight wins
        // (Full implementation deferred to rekernel fork_resolution.ts bridge)
        break;
      }
    }
  }

  _pendingRecords = new Map();   // contentHash → record (for ACK lookup)

  _recordAck(hash, fromPeerId, record) {
    if (!this._ackCounts.has(hash)) this._ackCounts.set(hash, new Set());
    this._ackCounts.get(hash).add(fromPeerId);
    if (record) this._pendingRecords.set(hash, record);

    // Check quorum
    const ackers    = this._ackCounts.get(hash);
    const ackPower  = this._computeVotingPower(ackers);
    const threshold = this._totalPower * this._quorum;

    if (ackPower >= threshold) {
      this._ackCounts.delete(hash);   // clear to prevent double-fire
      const finalRecord = this._pendingRecords.get(hash);
      this._pendingRecords.delete(hash);
      this._onFinalized(hash, [...ackers], finalRecord);
    }
  }

  _computeVotingPower(peerIds) {
    if (!this._validators.length) {
      // No validator set — count peers equally (1 vote each, include self)
      return peerIds.size;
    }
    let power = 0;
    for (const id of peerIds) {
      const v = this._validators.find(v => v.id === id);
      power += v?.votingPower ?? 0;
    }
    return power;
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Program Registry + Compute Dispatch
//  Routes JSONFLOW_COMPILED events to UDCSEF fabric nodes.
// ────────────────────────────────────────────────────────────────────────────

class ComputeDispatcher {
  constructor(db, peer) {
    this._db      = db;
    this._peer    = peer;
    this._pending = new Map();   // programHash → { program, callback }
  }

  // Called when index1.html emits JSONFLOW_COMPILED
  async submitProgram(program, callback) {
    const programHash = fnv32(JSON.stringify(program));
    await registerProgram(this._db, programHash, program);
    this._pending.set(programHash, { program, callback, ts: Date.now() });

    // Broadcast to fabric via PeerJS gossip
    // UDCSEF nodes listening for COMPUTE_JOB messages will pick this up
    const job = {
      type:        'COMPUTE_JOB',
      programHash,
      program,
      submittedBy: this._peer.peerId,
      ts:          Date.now(),
    };
    this._peer._broadcast(job);

    return programHash;
  }

  // Called when generate-value.html emits FABRIC_COMPUTE
  handleResult(programHash, result, nodeId) {
    const pending = this._pending.get(programHash);
    if (pending?.callback) {
      pending.callback({ programHash, result, nodeId });
      this._pending.delete(programHash);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  SNAPSHOT_INTERVAL — mirrors rekernel's snapshots.ts
// ────────────────────────────────────────────────────────────────────────────

const SNAPSHOT_INTERVAL = 100;   // checkpoint every N events

// ────────────────────────────────────────────────────────────────────────────
//  attachNetwork — the main entry point
//  Call once per surface at init time.
// ────────────────────────────────────────────────────────────────────────────

let _networkInstance = null;

export async function attachNetwork(opts = {}) {
  if (_networkInstance) return _networkInstance;   // idempotent

  const {
    nodeId      = 'node-' + fnv32(navigator.userAgent + Date.now()),
    quorum      = 0.67,
    validators  = [],
    peers       = [],              // [peerId, ...] — known bootstrap peers
    onFinalized = null,            // hook: (hash, ackers, record) => void
    onCompute   = null,            // hook: (programHash, result, nodeId) => void
    snapshotInterval = SNAPSHOT_INTERVAL,
    // ── L4.5 Hybrid opts (all optional — omit to keep pure P2P behaviour) ──
    validatorEndpoint  = (typeof process !== 'undefined' && process.env?.VALIDATOR_ENDPOINT) || null,
    validatorPubkey    = null,     // hex pubkey (reserved for future sig verify)
    validatorBackups   = [],       // fallback validator URLs
    fallbackTimeout    = 2000,     // ms before giving up on validator
    checkInterval      = 5000,     // ms between background connectivity probes
    requireValidatorFinality = false, // if true, don't use P2P finality path
  } = opts;

  // 1. Open IndexedDB
  const db = await openLedgerDB();

  // 2. Restore sovereign-log from DB (replay persisted events)
  const persisted = await loadLedgerFromDB(db);
  if (persisted.length && !getLog().length) {
    try { restore(persisted); } catch (_) {}
  }

  // 3. Attach BroadcastChannel bus
  attachBus();

  // 4. Init L4.5 Hybrid Network layer (only when validatorEndpoint is provided)
  //    If not configured this is null and all behaviour is pure P2P (unchanged).
  const hybrid = createHybridNetwork({
    validatorEndpoint,
    validatorPubkey,
    validatorBackups,
    fallbackTimeout,
    checkInterval,
    onModeChange: (mode, wasOnline) => {
      try {
        emit({
          type:      NETWORK_EVENT_TYPES.HYBRID_MODE_CHANGED,
          mode,
          wasOnline,
          changedAt: Date.now(),
        });
      } catch (_) {}
    },
    onReconnected: () => {
      try {
        emit({
          type:        NETWORK_EVENT_TYPES.HYBRID_RESYNC,
          reconnnectedAt: Date.now(),
        });
      } catch (_) {}
    },
  });

  // 5. Init PeerJS gossip peer
  const gossipPeer = new SovereignPeer(nodeId, {
    quorum,
    validators,
    onFinalized: async (hash, ackers, record) => {
      // Notify L4.5 hybrid layer so it can resolve pending awaitFinality()
      hybrid?.markFinalized(hash);

      // Quorum reached — emit canonical finality event into sovereign-log
      if (record) {
        try {
          emit({
            type:           NETWORK_EVENT_TYPES.CONSENSUS_FINALIZED,
            contentHash:    hash,
            ackers,
            ackerCount:     ackers.length,
            originalSeq:    record.seq,
            originalType:   record.type,
            finalizedAt:    Date.now(),
          });
        } catch (_) {}
      }
      onFinalized?.(hash, ackers, record);
    },
    onRejected: (hash, reason) => {
      try {
        emit({
          type:        NETWORK_EVENT_TYPES.CONSENSUS_REJECTED,
          contentHash: hash,
          reason,
          rejectedAt:  Date.now(),
        });
      } catch (_) {}
    },
  });

  await gossipPeer.init();

  // Wire hybrid peer map to PeerJS connection lifecycle so L4.5 can also
  // reach peers directly for P2P fallback broadcasts.
  if (hybrid) {
    hybrid._peerId = gossipPeer.peerId;
    const _origRegister = gossipPeer._registerConnection.bind(gossipPeer);
    gossipPeer._registerConnection = function(conn) {
      _origRegister(conn);
      hybrid.addPeer(conn.peer, conn);
      conn.on('close', () => hybrid.removePeer(conn.peer));
    };
  }

  // Connect to bootstrap peers
  for (const peerId of peers) gossipPeer.connect(peerId);

  // 6. Init compute dispatcher
  const dispatcher = new ComputeDispatcher(db, gossipPeer);

  // 7. Subscribe to sovereign-log — promote new events to network
  let _eventCount = 0;
  subscribe(async (state, record) => {
    if (!record || record._fromNet || record._fromBus) return;

    // Persist to IndexedDB
    try { await persistEvent(db, record); } catch (_) {}

    // Periodic snapshot
    _eventCount++;
    if (_eventCount % snapshotInterval === 0) {
      try {
        await persistSnapshot(db, getLog().length, state);
        emit({ type: NETWORK_EVENT_TYPES.LEDGER_SNAPSHOT, height: getLog().length });
      } catch (_) {}
    }

    // Content-address the record for network layer
    const hash = await contentHash(record);

    // Promote to network
    try {
      emit({ type: NETWORK_EVENT_TYPES.NET_EVENT_PROMOTED, contentHash: hash, originalType: record.type });
    } catch (_) {}

    // ── L4.5 Hybrid routing ────────────────────────────────────────────────
    // If a validator endpoint is configured, route through HybridNetwork which
    // will pick validator (online) or P2P gossip (offline) automatically.
    // Otherwise fall through to the direct PeerJS gossip path (pure P2P, unchanged).
    if (hybrid) {
      hybrid.trackPending(hash, record);
      hybrid.broadcastEvent(record).catch(err =>
        console.warn('[sovereign-network] hybrid broadcast error:', err)
      );
    } else {
      // Pure P2P path — original behaviour unchanged
      gossipPeer.gossipEvent?.(record, hash);   // no-op if PeerJS not loaded
    }

    // Immediately self-ack (we've verified by emitting)
    gossipPeer.ackEvent(hash, record);

    // Route JSONFLOW_COMPILED → compute fabric
    if (record.type === NETWORK_EVENT_TYPES.JSONFLOW_COMPILED && record.ir) {
      dispatcher.submitProgram(record.ir, result => {
        onCompute?.(result.programHash, result.result, result.nodeId);
      });
    }

    // Route FABRIC_COMPUTE → compute dispatcher callback
    if (record.type === NETWORK_EVENT_TYPES.FABRIC_COMPUTE) {
      dispatcher.handleResult(record.programHash, record.result, record.nodeId);
    }
  });

  // 7. Request sync from network peers
  setTimeout(() => gossipPeer.requestSync(), 500);

  _networkInstance = {
    nodeId:       gossipPeer.peerId,
    peer:         gossipPeer,
    db,
    dispatcher,
    connect:      peerId => gossipPeer.connect(peerId),
    submitProgram: (program, cb) => dispatcher.submitProgram(program, cb),
    deriveState:  () => deriveState(),
    getLog:       () => getLog(),
    snapshot:     async () => {
      const state = deriveState();
      await persistSnapshot(db, getLog().length, state);
    },
  };

  console.log(`[sovereign-network] Attached. nodeId=${gossipPeer.peerId}`);
  return _networkInstance;
}

// ── Expose for surfaces that import this file ─────────────────────────────────
export { emit, getLog, subscribe, deriveState } from './sovereign-log.js';
export { NETWORK_EVENT_TYPES as EVENT_TYPES };
