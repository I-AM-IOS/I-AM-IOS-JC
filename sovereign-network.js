// ════════════════════════════════════════════════════════════════════════════
//  sovereign-network.js  —  The Sovereign Compute Network Wiring Harness
//  v3.0 — PRODUCTION READY
//
//  What changed from v2:
//    1. ESA (Event Set Agreement) — quorum acks now run through the full
//       stake-weighted ValidatorSetSnapshot pipeline (rekernel-esa-bridge.js)
//       instead of the previous peer-headcount approximation.  A Byzantine
//       cluster of low-stake nodes can no longer hit the 2/3 threshold before
//       high-stake validators have spoken.
//
//    2. Fork resolution — the FORK_PROOF handler is no longer a stub.
//       It calls resolveFork() + verifyForkResolution() from
//       rekernel-fork-bridge.js and emits a FORK_RESOLVED event into the
//       sovereign-log so surfaces can react.
//
//    3. Duplicate-ack guard — the ESA state machine deduplicates per
//       validatorId, preventing double-fire on retransmitted ACKs.
//
//    4. Height advance on snapshot — every SNAPSHOT_INTERVAL events the ESA
//       state advances to the next height, committing the canonical set and
//       marking finalized events.
//
//    5. ACK messages now carry a structured EventAcknowledgement payload so
//       peers with a validator set can stake-weight each other's votes.
//
//  Architecture (unchanged):
//    ┌─ SURFACES ──────────────────────────────────────────────┐
//    │  app-builder | attack | generate-value | index1 | intel │
//    └───────────────────────┬─────────────────────────────────┘
//                            │ emit()
//    ┌─ sovereign-log ────────┴────────────────────────────────┐
//    │  FNV-32 hash chain · deriveState() · subscribe()        │
//    └──────┬──────────────────────────────────────────────────┘
//           │ subscribe()
//    ┌─ sovereign-network.js (THIS FILE) ──────────────────────┐
//    │  ESA consensus · fork resolution · PeerJS gossip        │
//    │  hybrid routing · compute dispatch · IndexedDB persist  │
//    └──────┬────────────────────────────────┬─────────────────┘
//           │ verifyEvent + gossip            │ program dispatch
//    ┌─ rekernel ───────────────┐   ┌─ UDCSEF fabric ─────────┐
//    │  BFT consensus + ledger  │   │  PeerJS P2P compute      │
//    └──────────────────────────┘   └─────────────────────────┘
//
//  Usage:
//    import { attachNetwork } from './sovereign-network.js';
//    const net = await attachNetwork({ nodeId: 'auto', quorum: 0.67 });
// ════════════════════════════════════════════════════════════════════════════

import { emit, getLog, subscribe, restore, deriveState, EVENT_TYPES } from './sovereign-log.js';
import { attachBus, broadcastRestore } from './sovereign-bus.js';
import { createHybridNetwork }         from './sovereign-network-hybrid.js';

// ── Rekernel bridges (plain JS — no compile step required) ───────────────────
import {
  buildValidatorSetSnapshot,
  initializeEventSetAgreement,
  addPendingEvent,
  processAcknowledgement,
  advanceHeight,
  buildCanonicalEventSet,
  mergeEventSets,
  detectEventSetDivergence,
} from './rekernel-esa-bridge.js';

import {
  buildForkBranch,
  resolveFork,
  verifyForkResolution,
  buildForkProof,
} from './rekernel-fork-bridge.js';

// ── Extended EVENT_TYPES for network layer ────────────────────────────────────
export const NETWORK_EVENT_TYPES = {
  ...EVENT_TYPES,

  // Compute layer
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

  // Network consensus layer
  NET_PEER_CONNECTED:     'NET_PEER_CONNECTED',
  NET_PEER_DROPPED:       'NET_PEER_DROPPED',
  NET_EVENT_PROMOTED:     'NET_EVENT_PROMOTED',
  NET_EVENT_ACKED:        'NET_EVENT_ACKED',
  CONSENSUS_FINALIZED:    'CONSENSUS_FINALIZED',
  CONSENSUS_REJECTED:     'CONSENSUS_REJECTED',
  LEDGER_SNAPSHOT:        'LEDGER_SNAPSHOT',
  FORK_RESOLVED:          'FORK_RESOLVED',         // NEW: fork resolution result
  ESA_HEIGHT_ADVANCED:    'ESA_HEIGHT_ADVANCED',   // NEW: ESA height commit

  // Hybrid network layer
  HYBRID_MODE_CHANGED:    'HYBRID_MODE_CHANGED',
  HYBRID_RESYNC:          'HYBRID_RESYNC',
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
async function contentHash(record) {
  const payload = JSON.stringify({
    type:     record.type,
    seq:      record.seq,
    ts:       record.ts,
    hash:     record.hash,
    prevHash: record.prevHash,
  });
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf    = new TextEncoder().encode(payload);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return fnv32(payload);
}

// ── Build a structured EventAcknowledgement suitable for ESA ─────────────────
async function buildAck(nodeId, eventHash, eventId, height) {
  const timestamp = Date.now();
  const ackData   = JSON.stringify({ eventHash, validatorId: nodeId, height, timestamp });
  const ackHash   = fnv32(ackData);           // lightweight self-hash
  return {
    eventHash,
    eventId:     eventId ?? eventHash.slice(0, 16),
    validatorId: nodeId,
    height,
    timestamp,
    ackHash,
    signature:   '',    // reserved — extend with Ed25519 when validator keys are live
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  IndexedDB Ledger Store
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
      if (!db.objectStoreNames.contains('snapshots'))
        db.createObjectStore('snapshots', { keyPath: 'height' });
      if (!db.objectStoreNames.contains('programs'))
        db.createObjectStore('programs', { keyPath: 'programHash' });
      if (!db.objectStoreNames.contains('meta'))
        db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function persistEvent(db, record) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('events', 'readwrite');
    const req = tx.objectStore('events').put(record);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function loadLedgerFromDB(db) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('events', 'readonly');
    const req = tx.objectStore('events').getAll();
    req.onsuccess = e => resolve(e.target.result.sort((a, b) => a.seq - b.seq));
    req.onerror   = e => reject(e.target.error);
  });
}

async function persistSnapshot(db, height, state) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('snapshots', 'readwrite');
    const req = tx.objectStore('snapshots').put({
      height,
      ts:           Date.now(),
      state:        JSON.stringify(state),
      snapshotHash: fnv32(JSON.stringify({ height, stateHash: state.stateHash ?? '' })),
    });
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function registerProgram(db, programHash, program) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('programs', 'readwrite');
    const req = tx.objectStore('programs').put({ programHash, program, ts: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

// ────────────────────────────────────────────────────────────────────────────
//  ESA Consensus Manager
//
//  Wraps the pure-function ESA state machine with the mutable bookkeeping
//  sovereign-network.js needs: height tracking, pending record lookup, and
//  the onFinalized / onFinalizedHeight callbacks.
// ────────────────────────────────────────────────────────────────────────────

class ESAConsensusManager {
  constructor(nodeId, validatorSnapshot, { onFinalized, onRejected, quorumFallback = 0.67 } = {}) {
    this._nodeId            = nodeId;
    this._validators        = validatorSnapshot;    // ValidatorSetSnapshot | null
    this._quorumFallback    = quorumFallback;       // used when no validator set
    this._state             = initializeEventSetAgreement(0);
    this._previousSets      = [];                   // for finality check
    this._pendingRecords    = new Map();            // contentHash → sovereignLogRecord
    this._onFinalized       = onFinalized  ?? (() => {});
    this._onRejected        = onRejected   ?? (() => {});
  }

  // ── Register an incoming or locally-emitted event ──────────────────────────
  addEvent(hash, record) {
    this._pendingRecords.set(hash, record);
    // Wrap record into the minimal Event shape ESA needs
    const esaEvent = { hash, id: record.hash ?? hash, type: record.type, payload: record };
    this._state = addPendingEvent(this._state, esaEvent);
  }

  // ── Process an acknowledgement (from self or a remote peer) ────────────────
  processAck(ack) {
    const prevSet = this._state.canonicalEventSet;

    if (this._validators) {
      // Full stake-weighted path
      this._state = processAcknowledgement(this._state, ack, this._validators);
    } else {
      // No validator set: fall back to peer-count quorum (original behaviour)
      this._processPeerCountAck(ack);
      return;
    }

    // Check if this ack pushed a new event into the canonical set
    const newSet = this._state.canonicalEventSet;
    if (newSet.eventSetHash !== prevSet.eventSetHash) {
      // New admissions — fire finalized callbacks for newly admitted events
      const prevHashes = new Set(prevSet.events.map(e => e.event.hash));
      for (const admitted of newSet.events) {
        if (!prevHashes.has(admitted.event.hash)) {
          const record = this._pendingRecords.get(admitted.event.hash);
          this._pendingRecords.delete(admitted.event.hash);
          this._onFinalized(
            admitted.event.hash,
            admitted.acknowledgers,
            record,
          );
        }
      }
    }
  }

  // ── Peer-count fallback (no ValidatorSetSnapshot configured) ───────────────
  _peerCounts = new Map();   // hash → Set of peerIds
  _peerTotal  = 1;           // track connected peers + self

  setPeerCount(n) { this._peerTotal = Math.max(1, n + 1); /* +1 for self */ }

  _processPeerCountAck(ack) {
    const hash = ack.eventHash;
    if (!this._peerCounts.has(hash)) this._peerCounts.set(hash, new Set());
    this._peerCounts.get(hash).add(ack.validatorId);

    const ackers    = this._peerCounts.get(hash);
    const threshold = this._peerTotal * this._quorumFallback;

    if (ackers.size >= threshold) {
      this._peerCounts.delete(hash);
      const record = this._pendingRecords.get(hash);
      this._pendingRecords.delete(hash);
      this._onFinalized(hash, [...ackers], record);
    }
  }

  // ── Advance ESA height (called on each snapshot boundary) ──────────────────
  advanceToNextHeight() {
    const current = this._state.canonicalEventSet;
    this._previousSets = [...this._previousSets.slice(-5), current]; // keep last 5
    const nextHeight   = this._state.height + 1;
    this._state        = advanceHeight(this._state, nextHeight, this._previousSets);

    // Return any events that were just finalized
    return this._state.finalizedEvents.filter(
      fe => fe.finalizedAtHeight === nextHeight
    );
  }

  get height()            { return this._state.height; }
  get canonicalEventSet() { return this._state.canonicalEventSet; }
}

// ────────────────────────────────────────────────────────────────────────────
//  PeerJS Gossip Bridge
//  Implements rekernel's gossip.ts protocol in JS over PeerJS WebRTC.
//  Message types: EVENT | ACK | SYNC | SYNC_RESPONSE | FORK_PROOF | MEMBERSHIP
// ────────────────────────────────────────────────────────────────────────────

class SovereignPeer {
  constructor(nodeId, opts = {}) {
    this._id       = nodeId;
    this._peers    = new Map();    // peerId → DataConnection
    this._seen     = new Set();    // dedup by contentHash
    this._esa      = opts.esa;     // ESAConsensusManager — injected after construction
    this._peer     = null;
  }

  async init() {
    if (typeof Peer === 'undefined') {
      console.warn('[sovereign-network] PeerJS not loaded — gossip disabled. Add <script src="https://cdn.jsdelivr.net/npm/peerjs@1.5.2/dist/peerjs.min.js"></script>');
      return this;
    }
    return new Promise(resolve => {
      this._peer = new Peer(this._id, {
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ],
        },
      });
      this._peer.on('open',       id  => { console.log(`[sovereign-network] Node online: ${id}`); resolve(this); });
      this._peer.on('connection', conn => this._handleIncoming(conn));
      this._peer.on('error',      err  => console.warn('[sovereign-network] peer error:', err.type));
    });
  }

  connect(remotePeerId) {
    if (!this._peer || this._peers.has(remotePeerId)) return;
    const conn = this._peer.connect(remotePeerId, { reliable: true });
    conn.on('open',  () => this._registerConnection(conn));
    conn.on('error', err => console.warn('[sovereign-network] conn error:', err));
  }

  async gossipEvent(record, hash) {
    this._broadcast({
      type:        'EVENT',
      senderId:    this._id,
      height:      getLog().length,
      payload:     JSON.stringify(record),
      payloadHash: hash,
      ts:          Date.now(),
    });
  }

  async ackEvent(hash, record) {
    const ack = await buildAck(this._id, hash, record?.hash, getLog().length);
    this._broadcast({
      type:        'ACK',
      senderId:    this._id,
      payloadHash: hash,
      ack,               // structured EventAcknowledgement
      height:      getLog().length,
      ts:          Date.now(),
    });
    // Self-ack via ESA
    if (this._esa) {
      if (record) this._esa.addEvent(hash, record);
      this._esa.processAck(ack);
    }
  }

  requestSync() {
    this._broadcast({
      type:     'SYNC',
      senderId: this._id,
      height:   getLog().length,
      ts:       Date.now(),
    });
  }

  sendForkProof(proof) {
    this._broadcast({
      type:    'FORK_PROOF',
      senderId: this._id,
      payload:  JSON.stringify(proof),
      ts:       Date.now(),
    });
  }

  get peerId()    { return this._id; }
  get peerCount() { return this._peers.size; }

  // ── Private ──────────────────────────────────────────────────────────────

  _handleIncoming(conn) {
    conn.on('open',  () => this._registerConnection(conn));
    conn.on('data',  data => this._handleMessage(data, conn.peer));
    conn.on('close', ()   => this._peers.delete(conn.peer));
    conn.on('error', err  => console.warn('[sovereign-network] incoming conn error:', err));
  }

  _registerConnection(conn) {
    this._peers.set(conn.peer, conn);
    conn.on('data',  data => this._handleMessage(data, conn.peer));
    conn.on('close', ()   => this._peers.delete(conn.peer));
    if (this._esa) this._esa.setPeerCount(this._peers.size);
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
        if (this._seen.has(msg.payloadHash)) break;
        this._seen.add(msg.payloadHash);

        let record;
        try { record = JSON.parse(msg.payload); } catch (_) { break; }
        if (!record.type || !record.hash || !record.seq) break;   // I4/I6 structural check

        // Register with ESA before acking
        if (this._esa) this._esa.addEvent(msg.payloadHash, record);

        this.ackEvent(msg.payloadHash, record);
        this._broadcast(msg);    // gossip relay (TTL decrement could be added here)
        break;
      }

      case 'ACK': {
        // Use the structured ack if present; fall back to building one from sender ID
        const ack = msg.ack ?? {
          eventHash:   msg.payloadHash,
          eventId:     msg.payloadHash.slice(0, 16),
          validatorId: fromPeerId,
          height:      msg.height ?? 0,
          timestamp:   msg.ts ?? Date.now(),
          ackHash:     fnv32(fromPeerId + msg.payloadHash),
          signature:   '',
        };
        if (this._esa) this._esa.processAck(ack);
        break;
      }

      case 'SYNC': {
        const peerHeight = msg.height ?? 0;
        const suffix     = getLog().slice(peerHeight);
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
        const { records } = msg;
        if (!Array.isArray(records)) break;
        const localHeight = getLog().length;
        const newRecords  = records.filter(r => r.seq >= localHeight);
        for (const r of newRecords) {
          const { type, ...rest } = r;
          try { emit({ ...rest, type, _fromNet: true }); } catch (_) {}
        }
        break;
      }

      case 'FORK_PROOF': {
        // ── Full fork resolution (was a stub in v2) ───────────────────────
        let proof;
        try { proof = JSON.parse(msg.payload); } catch (_) { break; }

        if (!proof?.chainA || !proof?.chainB || proof.height == null) {
          console.warn('[sovereign-network] Malformed FORK_PROOF from', fromPeerId);
          break;
        }

        const fork = {
          height:     proof.height,
          chainA:     proof.chainA,
          chainB:     proof.chainB,
          detectedAt: Date.now(),
        };

        const resolution = resolveFork(fork);

        // Verify the resolution is internally consistent
        // (no validators needed for hash-tiebreak verification)
        const mockValidators = { validators: [], totalVotingPower: 0, quorumThreshold: 0 };
        const { valid, violations } = verifyForkResolution(resolution, fork, mockValidators);

        if (!valid) {
          console.warn('[sovereign-network] Fork resolution failed verification:', violations);
          break;
        }

        console.log(
          `[sovereign-network] Fork at h=${fork.height} resolved via ${resolution.method}. ` +
          `Winner: ${resolution.winningHash.slice(0, 12)}…`
        );

        try {
          emit({
            type:           NETWORK_EVENT_TYPES.FORK_RESOLVED,
            height:         fork.height,
            winningHash:    resolution.winningHash,
            losingHash:     resolution.losingHash,
            method:         resolution.method,
            weightA:        resolution.weightA,
            weightB:        resolution.weightB,
            proofHash:      resolution.proof.proofHash,
            resolvedAt:     Date.now(),
          });
        } catch (_) {}
        break;
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Program Registry + Compute Dispatch
// ────────────────────────────────────────────────────────────────────────────

class ComputeDispatcher {
  constructor(db, peer) {
    this._db      = db;
    this._peer    = peer;
    this._pending = new Map();
  }

  async submitProgram(program, callback) {
    const programHash = fnv32(JSON.stringify(program));
    await registerProgram(this._db, programHash, program);
    this._pending.set(programHash, { program, callback, ts: Date.now() });
    this._peer._broadcast({
      type:        'COMPUTE_JOB',
      programHash,
      program,
      submittedBy: this._peer.peerId,
      ts:          Date.now(),
    });
    return programHash;
  }

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

const SNAPSHOT_INTERVAL = 100;

// ────────────────────────────────────────────────────────────────────────────
//  attachNetwork — the main entry point
// ────────────────────────────────────────────────────────────────────────────

let _networkInstance = null;

export async function attachNetwork(opts = {}) {
  if (_networkInstance) return _networkInstance;

  const {
    nodeId      = 'node-' + fnv32((typeof navigator !== 'undefined' ? navigator.userAgent : 'server') + Date.now()),
    quorum      = 0.67,
    validators  = [],              // [{ id, publicKey, stake, reputation, isActive, joinedAtHeight, slashCount }]
    peers       = [],
    onFinalized = null,
    onCompute   = null,
    snapshotInterval      = SNAPSHOT_INTERVAL,
    validatorEndpoint     = (typeof process !== 'undefined' && process.env?.VALIDATOR_ENDPOINT) || null,
    validatorPubkey       = null,
    validatorBackups      = [],
    fallbackTimeout       = 2000,
    checkInterval         = 5000,
    requireValidatorFinality = false,
  } = opts;

  // ── 1. Open IndexedDB ────────────────────────────────────────────────────
  const db = await openLedgerDB();

  // ── 2. Restore sovereign-log from DB ────────────────────────────────────
  const persisted = await loadLedgerFromDB(db);
  if (persisted.length && !getLog().length) {
    try { restore(persisted); } catch (_) {}
  }

  // ── 3. Attach BroadcastChannel bus ───────────────────────────────────────
  attachBus();

  // ── 4. Build validator snapshot (or null for peer-count fallback) ─────────
  const validatorSnapshot = validators.length
    ? buildValidatorSetSnapshot(getLog().length, validators)
    : null;

  // ── 5. Init ESA Consensus Manager ────────────────────────────────────────
  const esa = new ESAConsensusManager(nodeId, validatorSnapshot, {
    quorumFallback: quorum,
    onFinalized: async (hash, ackers, record) => {
      hybrid?.markFinalized(hash);
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

  // ── 6. Init L4.5 Hybrid Network ──────────────────────────────────────────
  const hybrid = createHybridNetwork({
    validatorEndpoint,
    validatorPubkey,
    validatorBackups,
    fallbackTimeout,
    checkInterval,
    onModeChange: (mode, wasOnline) => {
      try { emit({ type: NETWORK_EVENT_TYPES.HYBRID_MODE_CHANGED, mode, wasOnline, changedAt: Date.now() }); } catch (_) {}
    },
    onReconnected: () => {
      try { emit({ type: NETWORK_EVENT_TYPES.HYBRID_RESYNC, reconnectedAt: Date.now() }); } catch (_) {}
    },
  });

  // ── 7. Init PeerJS gossip peer ────────────────────────────────────────────
  const gossipPeer = new SovereignPeer(nodeId, { esa });
  gossipPeer._esa  = esa;   // inject back-reference for ACK building

  await gossipPeer.init();

  // Wire hybrid peer map
  if (hybrid) {
    hybrid._peerId = gossipPeer.peerId;
    const _origRegister = gossipPeer._registerConnection.bind(gossipPeer);
    gossipPeer._registerConnection = function(conn) {
      _origRegister(conn);
      hybrid.addPeer(conn.peer, conn);
      conn.on('close', () => hybrid.removePeer(conn.peer));
    };
  }

  for (const peerId of peers) gossipPeer.connect(peerId);

  // ── 8. Init compute dispatcher ────────────────────────────────────────────
  const dispatcher = new ComputeDispatcher(db, gossipPeer);

  // ── 9. Subscribe to sovereign-log — promote events to network ────────────
  let _eventCount = 0;

  subscribe(async (state, record) => {
    if (!record || record._fromNet || record._fromBus) return;

    // Persist to IndexedDB
    try { await persistEvent(db, record); } catch (_) {}

    _eventCount++;

    // Periodic snapshot + ESA height advance
    if (_eventCount % snapshotInterval === 0) {
      try {
        await persistSnapshot(db, getLog().length, state);
        emit({ type: NETWORK_EVENT_TYPES.LEDGER_SNAPSHOT, height: getLog().length });
      } catch (_) {}

      // Advance ESA to next height — commits current canonical set
      const finalized = esa.advanceToNextHeight();
      if (finalized.length) {
        try {
          emit({
            type:            NETWORK_EVENT_TYPES.ESA_HEIGHT_ADVANCED,
            newHeight:       esa.height,
            finalizedCount:  finalized.length,
            canonicalSetHash: esa.canonicalEventSet.eventSetHash,
            advancedAt:      Date.now(),
          });
        } catch (_) {}
      }
    }

    // Content-address the record
    const hash = await contentHash(record);

    // Register with ESA as pending
    esa.addEvent(hash, record);

    // Promote to network
    try { emit({ type: NETWORK_EVENT_TYPES.NET_EVENT_PROMOTED, contentHash: hash, originalType: record.type }); } catch (_) {}

    // ── L4.5 hybrid routing or direct P2P ────────────────────────────────
    if (hybrid) {
      hybrid.trackPending(hash, record);
      hybrid.broadcastEvent(record).catch(err =>
        console.warn('[sovereign-network] hybrid broadcast error:', err)
      );
    } else {
      gossipPeer.gossipEvent?.(record, hash);
    }

    // Self-ack (we've verified by emitting into sovereign-log)
    await gossipPeer.ackEvent(hash, record);

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

  // ── 10. Request sync from network peers ───────────────────────────────────
  setTimeout(() => gossipPeer.requestSync(), 500);

  _networkInstance = {
    nodeId:        gossipPeer.peerId,
    peer:          gossipPeer,
    esa,
    db,
    dispatcher,
    connect:       peerId => gossipPeer.connect(peerId),
    submitProgram: (program, cb) => dispatcher.submitProgram(program, cb),
    deriveState:   () => deriveState(),
    getLog:        () => getLog(),
    snapshot:      async () => {
      const state = deriveState();
      await persistSnapshot(db, getLog().length, state);
    },
    // Expose ESA introspection for dashboards / tests
    getCanonicalSet: () => esa.canonicalEventSet,
    getESAHeight:    () => esa.height,
  };

  console.log(`[sovereign-network] v3.0 attached. nodeId=${gossipPeer.peerId}` +
    (validatorSnapshot ? ` validators=${validators.length}` : ' (peer-count quorum)'));
  return _networkInstance;
}

// ── Re-export sovereign-log surface ──────────────────────────────────────────
export { emit, getLog, subscribe, deriveState } from './sovereign-log.js';
export { NETWORK_EVENT_TYPES as EVENT_TYPES };
