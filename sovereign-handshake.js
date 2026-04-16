// ════════════════════════════════════════════════════════════════════════════
//  sovereign-handshake.js  —  Identity-Routed Network Entry Protocol
//
//  Implements the three-phase handshake described in the design document:
//
//    Phase 1 — Identity Exchange
//      Each side announces its nodeId (public key placeholder) + a capability
//      fingerprint signed with FNV-32.  Future Ed25519 signatures slot in here.
//
//    Phase 2 — Capability Exchange
//      Supported transports, protocol version, and feature flags are exchanged
//      so both sides know exactly what the other node can do before sending data.
//
//    Phase 3 — Peer Introduction
//      The receiving node sends back up to MAX_PEER_INTRO peers from its known
//      set.  Each entry carries: peerId, transports, and an optional score.
//      The connecting node can now expand into the graph without a full-mesh.
//
//  Integration (in sovereign-network.js):
//    The SovereignPeer._registerConnection() method currently sends a bare SYNC
//    immediately on open.  This module replaces that with a HANDSHAKE_HELLO /
//    HANDSHAKE_ACK exchange.  Once both sides have shaken hands, the normal
//    SYNC flow proceeds exactly as before — nothing else changes.
//
//  Deterministic peer selection (optional):
//    Pass deterministicEpoch to HandshakeManager to make peer selection
//    repeatable across nodes, converging on a stable topology.
//
//  Usage:
//    import { HandshakeManager } from './sovereign-handshake.js';
//
//    // In attachNetwork(), after gossipPeer.init():
//    const handshake = new HandshakeManager(nodeId, gossipPeer, {
//      peerRegistry: myPeerRegistry,   // Map<peerId, PeerEntry>
//      onHandshakeComplete,            // called after phase 3
//      deterministicEpoch: true,
//    });
//    gossipPeer.setHandshakeManager(handshake);
//
// ════════════════════════════════════════════════════════════════════════════

// ── Constants ─────────────────────────────────────────────────────────────────

export const HANDSHAKE_VERSION    = '1.0';
export const MAX_PEER_INTRO       = 8;         // max peers to introduce per handshake
export const HANDSHAKE_TIMEOUT_MS = 8000;      // ms before declaring handshake failed

// ── FNV-32 (local copy — keeps this module self-contained) ───────────────────

function fnv32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── Capability fingerprint ────────────────────────────────────────────────────
//  A lightweight summary of what this node supports.
//  Extend this as new transports / features are added.

function buildCapabilities() {
  return {
    version:    HANDSHAKE_VERSION,
    transports: ['webrtc'],          // 'tcp', 'mesh' added as transports come online
    features:   ['dag-sync', 'esa', 'fork-resolution', 'hybrid-routing'],
    role:       'peer',              // 'validator' | 'peer' | 'observer'
  };
}

// ── Deterministic peer selection ──────────────────────────────────────────────
//  When deterministicEpoch is true, the set of peers to introduce is chosen
//  by sorting registry entries by hash(peerId + epochKey) rather than randomly.
//  This causes all nodes in the same epoch window to converge on similar
//  topology slices — reducing randomness and improving graph stability.

function selectPeersToIntroduce(registry, forPeerId, deterministic = false) {
  // registry is Map<peerId, PeerEntry> — exclude the target node itself
  const candidates = [...registry.entries()]
    .filter(([pid]) => pid !== forPeerId)
    .slice(0, 64);                             // cap candidates to avoid O(n) on huge nets

  if (!candidates.length) return [];

  if (deterministic) {
    const epochKey = Math.floor(Date.now() / 30_000).toString(); // 30-second epoch window
    candidates.sort((a, b) => {
      const ha = fnv32(a[0] + epochKey);
      const hb = fnv32(b[0] + epochKey);
      return ha < hb ? -1 : ha > hb ? 1 : 0;
    });
  } else {
    // Fisher-Yates shuffle — true random selection
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
  }

  return candidates
    .slice(0, MAX_PEER_INTRO)
    .map(([pid, entry]) => ({
      peerId:     pid,
      transports: entry.transports ?? ['webrtc'],
      score:      entry.score ?? null,         // { latency, reliability } or null
    }));
}

// ── PeerEntry helper ──────────────────────────────────────────────────────────
//  The shape of a record in the peer registry.

export function makePeerEntry(peerId, opts = {}) {
  return {
    peerId,
    transports: opts.transports ?? ['webrtc'],
    capabilities: opts.capabilities ?? null,
    score:      { latency: opts.latency ?? null, reliability: opts.reliability ?? null },
    firstSeen:  Date.now(),
    lastSeen:   Date.now(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  HandshakeManager
//
//  Plugs into SovereignPeer and intercepts the initial connection open event.
//  It drives Phase 1 → 2 → 3 before handing control back to the existing
//  gossip pipeline (SYNC / EVENT / ACK / etc.).
// ────────────────────────────────────────────────────────────────────────────

export class HandshakeManager {
  /**
   * @param {string} nodeId                   — this node's ID
   * @param {object} gossipPeer               — SovereignPeer instance
   * @param {object} [opts]
   * @param {Map}    [opts.peerRegistry]       — shared Map<peerId, PeerEntry>
   * @param {Function} [opts.onHandshakeComplete] — called(peerId, peerInfo) after phase 3
   * @param {boolean} [opts.deterministicEpoch]   — use deterministic peer selection
   */
  constructor(nodeId, gossipPeer, opts = {}) {
    this._nodeId       = nodeId;
    this._gossipPeer   = gossipPeer;
    this._registry     = opts.peerRegistry         ?? new Map();
    this._onComplete   = opts.onHandshakeComplete  ?? null;
    this._deterministic = opts.deterministicEpoch  ?? false;
    this._caps         = buildCapabilities();

    // Track in-flight handshakes: peerId → { conn, timer, state, peerInfo }
    this._inflight = new Map();
  }

  // ── Public: called by SovereignPeer when a connection opens ──────────────

  /**
   * Initiate Phase 1 on an outbound connection (we called connect()).
   * @param {DataConnection} conn
   */
  initiateHandshake(conn) {
    const peerId = conn.peer;
    this._trackHandshake(conn);
    conn.send({
      type:       'HANDSHAKE_HELLO',
      senderId:   this._nodeId,
      caps:       this._caps,
      sig:        fnv32(this._nodeId + JSON.stringify(this._caps)),  // lightweight sig
      ts:         Date.now(),
    });
    console.log(`[handshake] → HELLO to ${peerId}`);
  }

  /**
   * Receive and dispatch handshake messages.
   * Returns true if the message was a handshake message (consumed),
   * false if it should be passed to the normal gossip handler.
   *
   * @param {object} msg
   * @param {string} fromPeerId
   * @param {DataConnection} conn
   * @returns {boolean}
   */
  handleMessage(msg, fromPeerId, conn) {
    if (!msg?.type) return false;

    switch (msg.type) {

      case 'HANDSHAKE_HELLO':
        this._onHello(msg, fromPeerId, conn);
        return true;

      case 'HANDSHAKE_ACK':
        this._onAck(msg, fromPeerId, conn);
        return true;

      case 'HANDSHAKE_PEERS':
        this._onPeers(msg, fromPeerId);
        return true;

      default:
        return false;
    }
  }

  // ── Phase 1 inbound: we received a HELLO (we are the accepting side) ──────

  _onHello(msg, fromPeerId, conn) {
    // Verify lightweight sig
    const expectedSig = fnv32(fromPeerId + JSON.stringify(msg.caps));
    if (msg.sig !== expectedSig) {
      console.warn(`[handshake] HELLO from ${fromPeerId} — bad signature, dropping`);
      return;
    }

    this._trackHandshake(conn);
    const hs = this._inflight.get(fromPeerId);
    hs.peerInfo = { peerId: fromPeerId, caps: msg.caps };
    hs.state = 'hello-received';

    // Record peer in registry
    this._upsertRegistry(fromPeerId, msg.caps);

    // Phase 2: send our identity + capabilities back (ACK)
    conn.send({
      type:     'HANDSHAKE_ACK',
      senderId: this._nodeId,
      caps:     this._caps,
      sig:      fnv32(this._nodeId + JSON.stringify(this._caps)),
      ts:       Date.now(),
    });
    console.log(`[handshake] ← ACK to ${fromPeerId}`);

    // Phase 3: introduce peers
    this._sendPeerIntroduction(fromPeerId, conn);
  }

  // ── Phase 2 inbound: we receive the ACK (we are the initiating side) ──────

  _onAck(msg, fromPeerId, conn) {
    const expectedSig = fnv32(fromPeerId + JSON.stringify(msg.caps));
    if (msg.sig !== expectedSig) {
      console.warn(`[handshake] ACK from ${fromPeerId} — bad signature, dropping`);
      return;
    }

    const hs = this._inflight.get(fromPeerId);
    if (!hs) return;

    hs.peerInfo = { peerId: fromPeerId, caps: msg.caps };
    hs.state = 'ack-received';

    this._upsertRegistry(fromPeerId, msg.caps);
    console.log(`[handshake] ✓ identity confirmed with ${fromPeerId}`);

    // Initiating side also sends peer introduction (bidirectional sharing)
    this._sendPeerIntroduction(fromPeerId, conn);
  }

  // ── Phase 3 send: push peer introduction ─────────────────────────────────

  _sendPeerIntroduction(toPeerId, conn) {
    const peers = selectPeersToIntroduce(this._registry, toPeerId, this._deterministic);
    conn.send({
      type:     'HANDSHAKE_PEERS',
      senderId: this._nodeId,
      peers,
      ts:       Date.now(),
    });
    console.log(`[handshake] → PEERS (${peers.length} introductions) to ${toPeerId}`);
  }

  // ── Phase 3 receive: process peer introductions ───────────────────────────

  _onPeers(msg, fromPeerId) {
    const hs = this._inflight.get(fromPeerId);
    if (!hs) return;

    const introduced = msg.peers ?? [];
    const newPeers   = [];

    for (const entry of introduced) {
      if (!entry?.peerId || entry.peerId === this._nodeId) continue;
      if (!this._registry.has(entry.peerId)) {
        // Net-new peer — store and schedule a connection attempt
        this._registry.set(entry.peerId, makePeerEntry(entry.peerId, {
          transports: entry.transports,
          latency:    entry.score?.latency,
          reliability: entry.score?.reliability,
        }));
        newPeers.push(entry.peerId);
      } else {
        // Known peer — update score if provided
        const existing = this._registry.get(entry.peerId);
        existing.lastSeen = Date.now();
        if (entry.score) existing.score = entry.score;
      }
    }

    // Complete the handshake
    this._completeHandshake(fromPeerId, newPeers);
  }

  // ── Handshake completion ──────────────────────────────────────────────────

  _completeHandshake(peerId, newPeers) {
    const hs = this._inflight.get(fromPeerId = peerId);
    if (!hs) return;

    clearTimeout(hs.timer);
    hs.state = 'complete';
    this._inflight.delete(peerId);

    const peerInfo = { ...hs.peerInfo, introducedPeers: newPeers };
    console.log(`[handshake] ✓ complete with ${peerId} — ${newPeers.length} new peer(s) queued`);

    // Expand the graph: connect to newly introduced peers
    for (const newPeerId of newPeers) {
      console.log(`[handshake] ↳ connecting to introduced peer: ${newPeerId}`);
      try { this._gossipPeer.connect(newPeerId); } catch (_) {}
    }

    // Notify caller (sovereign-network.js can emit a NET_PEER_CONNECTED event here)
    this._onComplete?.(peerId, peerInfo);

    // Now trigger the normal SYNC flow (handshake is done, gossip can begin)
    this._gossipPeer._triggerSyncAfterHandshake(peerId);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _trackHandshake(conn) {
    const peerId = conn.peer;
    if (this._inflight.has(peerId)) return;

    const timer = setTimeout(() => {
      if (this._inflight.has(peerId)) {
        console.warn(`[handshake] timeout with ${peerId} — aborting`);
        this._inflight.delete(peerId);
      }
    }, HANDSHAKE_TIMEOUT_MS);

    this._inflight.set(peerId, { conn, timer, state: 'initiated', peerInfo: null });
  }

  _upsertRegistry(peerId, caps) {
    if (this._registry.has(peerId)) {
      const entry = this._registry.get(peerId);
      entry.capabilities = caps;
      entry.lastSeen     = Date.now();
    } else {
      this._registry.set(peerId, makePeerEntry(peerId, { capabilities: caps }));
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get registry()     { return this._registry; }
  get inflightCount() { return this._inflight.size; }

  /**
   * Returns the known network as a snapshot of peer entries.
   * Useful for diagnostics / rekernel-dashboard.
   */
  getNetworkView() {
    return [...this._registry.entries()].map(([pid, e]) => ({
      peerId:       pid,
      transports:   e.transports,
      capabilities: e.capabilities,
      score:        e.score,
      firstSeen:    e.firstSeen,
      lastSeen:     e.lastSeen,
    }));
  }
}
