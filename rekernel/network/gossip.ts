/**
 * GOSSIP PROTOCOL — Message Propagation
 *
 * Gossip is the transport layer. It does not determine truth —
 * it determines who knows what, and when.
 *
 * ═════════════════════════════════════════════════════════════════
 * PROPERTIES REQUIRED
 * ═════════════════════════════════════════════════════════════════
 *
 * 1. Eventual delivery
 *    Any message sent by an honest node is eventually received
 *    by all honest nodes. (Liveness requirement.)
 *
 * 2. Duplicate suppression
 *    A message seen before is not rebroadcast. (Efficiency.)
 *
 * 3. Source independence
 *    Validity is checked on receipt, not assumed from sender.
 *    (Security — you don't trust peers, only content hashes.)
 *
 * 4. Bounded message size
 *    No unbounded aggregation before broadcast.
 *    (Prevents single node becoming a bottleneck.)
 *
 * ═════════════════════════════════════════════════════════════════
 * MESSAGE TYPES
 * ═════════════════════════════════════════════════════════════════
 *
 * EVENT:      "I have event E (content-addressed)"
 * ACK:        "I acknowledge event E (signed by validator)"
 * SLASH:      "I have evidence of Byzantine behavior"
 * SYNC:       "Here is my latest canonical set and height"
 * MEMBERSHIP: "A join/leave/emergency-remove has occurred"
 *
 * ═════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';

// ─── Message Types ────────────────────────────────────────────────────────────

export type GossipMessageType =
  | 'EVENT'
  | 'ACK'
  | 'SLASH'
  | 'SYNC'
  | 'MEMBERSHIP'
  | 'FORK_PROOF';

/**
 * A gossip message envelope.
 * All messages are self-describing and content-addressed.
 */
export interface GossipMessage {
  readonly type:       GossipMessageType;
  readonly senderId:   string;
  readonly height:     number;         // Sender's current height
  readonly payload:    string;         // JSON-serialized payload
  readonly payloadHash: string;        // sha256(payload) — tamper-evident
  readonly timestamp:  number;
  readonly ttl:        number;         // Hops remaining before drop
}

/**
 * A gossip envelope with origin tracking (for dedup).
 */
export interface GossipEnvelope {
  readonly message:    GossipMessage;
  readonly messageId:  string;         // sha256(type + senderId + payloadHash)
  readonly seenAt:     number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum hops a message travels before being dropped. */
export const DEFAULT_TTL = 7;

/** How long to remember seen message IDs (ms). */
export const DEDUP_WINDOW_MS = 60_000;

/** How many peers to forward a message to. */
export const FANOUT = 3;

// ─── Gossip Node State ────────────────────────────────────────────────────────

/**
 * The gossip state for a single node.
 */
export interface GossipState {
  readonly nodeId:      string;
  readonly peers:       readonly string[];       // Known peer node IDs
  readonly seen:        ReadonlyMap<string, number>; // messageId → timestamp seen
  readonly outbox:      readonly GossipEnvelope[]; // Messages to forward
  readonly inbox:       readonly GossipEnvelope[]; // Messages received, not yet processed
}

/**
 * Initialize a gossip node.
 */
export function initializeGossip(nodeId: string, peers: readonly string[]): GossipState {
  return Object.freeze({
    nodeId,
    peers:   Object.freeze([...peers]),
    seen:    new Map(),
    outbox:  Object.freeze([]),
    inbox:   Object.freeze([]),
  }) as GossipState;
}

// ─── Message Creation ─────────────────────────────────────────────────────────

/**
 * Create a gossip message.
 */
export function createGossipMessage(
  type:     GossipMessageType,
  senderId: string,
  height:   number,
  payload:  unknown,
  ttl:      number = DEFAULT_TTL,
): GossipMessage {
  const payloadStr  = JSON.stringify(payload);
  const payloadHash = crypto.createHash('sha256').update(payloadStr, 'utf8').digest('hex');

  return Object.freeze({
    type,
    senderId,
    height,
    payload:     payloadStr,
    payloadHash,
    timestamp:   Date.now(),
    ttl,
  }) as GossipMessage;
}

/**
 * Wrap a message in an envelope with a stable ID.
 */
export function wrapEnvelope(message: GossipMessage): GossipEnvelope {
  const messageId = crypto
    .createHash('sha256')
    .update(`${message.type}:${message.senderId}:${message.payloadHash}`, 'utf8')
    .digest('hex');

  return Object.freeze({
    message,
    messageId,
    seenAt: Date.now(),
  }) as GossipEnvelope;
}

// ─── Receive ──────────────────────────────────────────────────────────────────

/**
 * Receive an incoming gossip envelope.
 *
 * Steps:
 *   1. Verify payload hash (tamper check)
 *   2. Deduplicate (already seen?)
 *   3. Verify TTL > 0
 *   4. Accept into inbox
 *   5. Schedule forward (fanout to peers)
 *
 * Returns updated state and whether the message was accepted (new).
 */
export function receiveGossip(
  state:    GossipState,
  envelope: GossipEnvelope,
  nowMs:    number = Date.now(),
): { state: GossipState; accepted: boolean } {
  const { message, messageId } = envelope;

  // 1. Payload hash check
  const computedHash = crypto
    .createHash('sha256')
    .update(message.payload, 'utf8')
    .digest('hex');

  if (computedHash !== message.payloadHash) {
    return { state, accepted: false };  // Tampered
  }

  // 2. Dedup
  if (state.seen.has(messageId)) {
    return { state, accepted: false };  // Already processed
  }

  // 3. TTL check
  if (message.ttl <= 0) {
    return { state, accepted: false };  // Expired
  }

  // 4. Record as seen
  const newSeen = new Map(state.seen);
  newSeen.set(messageId, nowMs);

  // Prune expired dedup entries
  for (const [id, ts] of newSeen) {
    if (nowMs - ts > DEDUP_WINDOW_MS) newSeen.delete(id);
  }

  // 5. Add to inbox and outbox (for forwarding with decremented TTL)
  const forwardEnvelope = wrapEnvelope({
    ...message,
    ttl: message.ttl - 1,
  });

  const newState = Object.freeze({
    ...state,
    seen:   newSeen,
    inbox:  Object.freeze([...state.inbox, envelope]),
    outbox: Object.freeze([...state.outbox, forwardEnvelope]),
  }) as GossipState;

  return { state: newState, accepted: true };
}

// ─── Drain ────────────────────────────────────────────────────────────────────

/**
 * Drain the inbox — return messages ready for processing, clear inbox.
 */
export function drainInbox(
  state: GossipState,
): { state: GossipState; messages: readonly GossipEnvelope[] } {
  const messages = state.inbox;
  const newState = Object.freeze({
    ...state,
    inbox: Object.freeze([]),
  }) as GossipState;
  return { state: newState, messages };
}

/**
 * Drain the outbox — return messages to forward, clear outbox.
 * Caller is responsible for selecting FANOUT peers and sending.
 */
export function drainOutbox(
  state: GossipState,
): { state: GossipState; toForward: readonly GossipEnvelope[] } {
  const toForward = state.outbox;
  const newState = Object.freeze({
    ...state,
    outbox: Object.freeze([]),
  }) as GossipState;
  return { state: newState, toForward };
}

// ─── Specific Payload Helpers ─────────────────────────────────────────────────

/** Create an EVENT gossip message. */
export function gossipEvent(
  senderId: string,
  height:   number,
  eventHash: string,
  eventPayload: unknown,
): GossipMessage {
  return createGossipMessage('EVENT', senderId, height, { eventHash, event: eventPayload });
}

/** Create an ACK gossip message. */
export function gossipAck(
  senderId:    string,
  height:      number,
  eventHash:   string,
  validatorId: string,
  signature:   string,
): GossipMessage {
  return createGossipMessage('ACK', senderId, height, { eventHash, validatorId, signature });
}

/** Create a SLASH gossip message. */
export function gossipSlash(
  senderId:     string,
  height:       number,
  validatorId:  string,
  evidenceHash: string,
  evidence:     unknown,
): GossipMessage {
  return createGossipMessage('SLASH', senderId, height, { validatorId, evidenceHash, evidence });
}

/** Create a SYNC message (state advertisement). */
export function gossipSync(
  senderId:      string,
  height:        number,
  canonicalHash: string,
  membershipHash: string,
): GossipMessage {
  return createGossipMessage('SYNC', senderId, height, { canonicalHash, membershipHash });
}

/** Create a FORK_PROOF message. */
export function gossipForkProof(
  senderId:  string,
  height:    number,
  proofHash: string,
  proof:     unknown,
): GossipMessage {
  return createGossipMessage('FORK_PROOF', senderId, height, { proofHash, proof });
}

// ─── Sync State Advertisement ─────────────────────────────────────────────────

/**
 * Parse a SYNC payload into a structured state advertisement.
 */
export interface SyncAdvertisement {
  readonly senderId:       string;
  readonly height:         number;
  readonly canonicalHash:  string;
  readonly membershipHash: string;
}

export function parseSyncMessage(envelope: GossipEnvelope): SyncAdvertisement | null {
  if (envelope.message.type !== 'SYNC') return null;

  try {
    const payload = JSON.parse(envelope.message.payload);
    return Object.freeze({
      senderId:       envelope.message.senderId,
      height:         envelope.message.height,
      canonicalHash:  payload.canonicalHash,
      membershipHash: payload.membershipHash,
    }) as SyncAdvertisement;
  } catch {
    return null;
  }
}

/**
 * Determine if we need to sync with a peer based on their advertisement.
 */
export function needsSync(
  localHeight:         number,
  localCanonicalHash:  string,
  advertisement:       SyncAdvertisement,
): boolean {
  // Peer is ahead of us
  if (advertisement.height > localHeight) return true;

  // Same height but different canonical hash — potential fork
  if (advertisement.height === localHeight && advertisement.canonicalHash !== localCanonicalHash) {
    return true;
  }

  return false;
}
