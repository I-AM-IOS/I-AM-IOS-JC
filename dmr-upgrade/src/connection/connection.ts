/**
 * CONNECTION LIFECYCLE
 *
 * Implements the four-step connection protocol:
 *   Step 1: Discovery  — resolve target CID to endpoint via routing table
 *   Step 2: Handshake  — mutual identity verification (challenge-response)
 *   Step 3: Capability — present CAP token; node enforces at boundary
 *   Step 4: Session    — derive shared key; establish encrypted session
 *
 * No trust is placed in the IP endpoint. Trust flows entirely from
 * cryptographic verification at each step.
 *
 * Integration:
 *   - Uses RoutingTable (overlay-routing.ts) for step 1
 *   - Produces overlay DAG events (dag-events.ts) at steps 2 and 4
 *   - Calls enforceCapability() (capability.ts) at step 3
 *   - Sessions are recorded in OverlayState via SESSION_ESTABLISHED event
 */

import { canonicalJsonHashSync } from '../canonical-json';
import {
  CIDRecord, verifyCIDRecord, parseCID, isValidCIDString,
} from '../cid/cid';
import {
  CAPToken, enforceCapability, CAPAction, RevocationStore,
} from '../capability/capability';
import {
  EndpointDescriptor,
} from '../endpoint/endpoint';
import {
  RoutingTable, selectRoute, SelectRouteOptions, RoutingPath,
} from '../routing/overlay-routing';
import {
  evtSessionEstablished, evtPeerDiscovered, OverlayEvent,
} from '../dag/dag-events';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Session {
  sessionId:     string;
  localCID:      string;
  remoteCID:     string;
  transport:     string;
  capId:         string;
  sharedKey:     string;   // Derived via ECDH; hex-encoded
  establishedAt: number;
  expiresAt:     number | null;
}

export type ConnectionStep =
  | 'discovery'
  | 'handshake'
  | 'capability'
  | 'session';

export type ConnectionResult =
  | { ok: true;  session: Session;   event: OverlayEvent }
  | { ok: false; step: ConnectionStep; reason: string };

// ── Crypto Interface ──────────────────────────────────────────────────────────

/**
 * Cryptographic operations injected at runtime.
 * In production: Ed25519 + X25519 ECDH via libsodium.
 * In tests: deterministic stubs.
 */
export interface CryptoProvider {
  /** Sign a message with our private key. Returns hex. */
  sign(message: string): string;
  /** Verify a signature against a pubkey. */
  verify(pubkey: string, message: string, signature: string): boolean;
  /** ECDH key derivation. Returns hex shared secret. */
  ecdh(ourPrivEphemeral: string, theirPubEphemeral: string): string;
  /** Generate an ephemeral keypair. */
  generateEphemeralKeypair(): { pub: string; priv: string };
  /** Cryptographically random hex string of `bytes` length. */
  randomHex(bytes: number): string;
}

// ── Transport Interface ───────────────────────────────────────────────────────

/**
 * Pluggable transport layer. Abstracts QUIC / WebRTC / TCP / relay.
 * The connection lifecycle does not care which transport is in use.
 */
export interface TransportChannel {
  /** Send a message to the remote endpoint. */
  send(message: object): Promise<void>;
  /** Receive next message from remote. */
  receive(): Promise<object>;
  /** Close the channel. */
  close(): Promise<void>;
  /** Underlying transport type (for logging). */
  readonly transport: string;
}

export interface TransportDialer {
  /** Open a channel to the given endpoint. */
  dial(epd: EndpointDescriptor): Promise<TransportChannel>;
}

// ── CID Registry Interface ────────────────────────────────────────────────────

export interface CIDRegistry {
  /** Resolve a CID string to its current CIDRecord. */
  resolve(cid: string): Promise<CIDRecord | null>;
  /** Store a CIDRecord (called when we learn about new peers). */
  store(record: CIDRecord): Promise<void>;
}

// ── Step 1: Discovery ─────────────────────────────────────────────────────────

export interface DiscoveryResult {
  cid:      string;
  record:   CIDRecord;
  path:     RoutingPath;
  endpoint: EndpointDescriptor;
}

/**
 * Step 1: Discover target CID.
 *
 * 1a. Validate the target CID string
 * 1b. Resolve to CIDRecord (local registry or DHT query)
 * 1c. Find best path via routing table
 * 1d. Return the winning endpoint
 */
export async function discoverCID(
  targetCID:    string,
  routingTable: RoutingTable,
  registry:     CIDRegistry,
  localCID:     string,
  opts?:        Partial<SelectRouteOptions>,
): Promise<DiscoveryResult | { error: string }> {
  // 1a: Validate CID format
  if (!isValidCIDString(targetCID)) {
    return { error: `Invalid CID format: ${targetCID}` };
  }

  // 1b: Resolve to CIDRecord
  const record = await registry.resolve(targetCID);
  if (!record) {
    return { error: `CID not found in registry or DHT: ${targetCID}` };
  }

  // 1c: Find best path
  const path = selectRoute(routingTable, {
    localCID,
    targetCID,
    requestedScope: opts?.requestedScope,
    maxHops:        opts?.maxHops,
    exclude:        opts?.exclude,
  });

  if (!path) {
    return { error: `No route to ${targetCID}` };
  }

  // 1d: Extract winning endpoint
  const endpoint = path.hops[path.hops.length - 1].endpoint;

  return { cid: targetCID, record, path, endpoint };
}

// ── Step 2: Handshake ─────────────────────────────────────────────────────────

export interface HandshakeResult {
  verified:       boolean;
  remotePubkey:   string;
  ourEphemeral:   string;    // Our ephemeral public key (for ECDH)
  theirEphemeral: string;    // Their ephemeral public key
  sessionNonce:   string;
}

/**
 * Step 2: Challenge-response identity handshake.
 *
 * A → B:
 *   1. A sends: CID(A), ephemeral_pub_A, requested_scope
 *   2. B responds: challenge_nonce, CID(B), ephemeral_pub_B
 *   3. A signs nonce with private key → sends signature
 *   4. B verifies: CID(A) matches pubkey, signature valid
 *   (Symmetric: B also identifies itself to A)
 *
 * This is mutual verification — both sides prove identity.
 */
export async function performHandshake(
  channel:       TransportChannel,
  localCID:      string,
  remoteRecord:  CIDRecord,
  requestedScope: string,
  crypto:        CryptoProvider,
  nowMs:         number = Date.now(),
): Promise<HandshakeResult | { error: string }> {
  // Generate ephemeral keypair for ECDH
  const ourEphemeral = crypto.generateEphemeralKeypair();

  // Step A→B: Send our identity + ephemeral key + requested scope
  await channel.send({
    type:           'HANDSHAKE_INIT',
    cid:            localCID,
    ephemeralPub:   ourEphemeral.pub,
    requestedScope,
    timestamp:      nowMs,
  });

  // Step B→A: Receive challenge
  const challenge = await channel.receive() as any;
  if (challenge.type !== 'HANDSHAKE_CHALLENGE') {
    return { error: `Expected HANDSHAKE_CHALLENGE, got ${challenge.type}` };
  }

  const nonce          = challenge.nonce as string;
  const theirEphemeral = challenge.ephemeralPub as string;
  const theirCID       = challenge.cid as string;

  // Verify remote CID matches what we looked up
  if (theirCID !== remoteRecord.cid) {
    return { error: `Remote CID mismatch: expected ${remoteRecord.cid}, got ${theirCID}` };
  }

  // Step A→B: Sign the nonce
  const nonceHash = canonicalJsonHashSync({ nonce, localCID, theirCID });
  const signature  = crypto.sign(nonceHash);

  await channel.send({
    type:      'HANDSHAKE_RESPONSE',
    signature,
    cid:       localCID,
  });

  // Step B→A: Receive their verification result + their signature on our nonce
  const verification = await channel.receive() as any;
  if (verification.type !== 'HANDSHAKE_VERIFIED') {
    return { error: `Handshake rejected by remote: ${verification.reason ?? 'unknown'}` };
  }

  // Verify remote's signature on the nonce we'd sent them (symmetric)
  const remoteNonceHash = canonicalJsonHashSync({
    nonce:  verification.nonce,
    localCID: theirCID,
    theirCID: localCID,
  });
  if (!crypto.verify(remoteRecord.pubkey, remoteNonceHash, verification.signature)) {
    return { error: 'Remote signature on challenge is invalid' };
  }

  return {
    verified:       true,
    remotePubkey:   remoteRecord.pubkey,
    ourEphemeral:   ourEphemeral.pub,
    theirEphemeral,
    sessionNonce:   nonce,
  };
}

// ── Step 3: Capability Presentation ──────────────────────────────────────────

export interface CapabilityPresentationResult {
  capId:     string;
  scope:     string;
  action:    CAPAction;
}

/**
 * Step 3: Present a CAP token to the remote node and receive their
 * enforcement decision.
 *
 * The remote node runs enforceCapability() at its boundary. If it
 * rejects the CAP, we get a denial message and the connection ends.
 */
export async function presentCapability(
  channel:         TransportChannel,
  token:           CAPToken,
  localCID:        string,
  targetCID:       string,
  requestedScope:  string,
  requestedAction: CAPAction,
): Promise<CapabilityPresentationResult | { error: string }> {
  await channel.send({
    type:   'CAP_PRESENT',
    token,
    cid:    localCID,
    scope:  requestedScope,
    action: requestedAction,
  });

  const response = await channel.receive() as any;

  if (response.type === 'CAP_ACCEPTED') {
    return {
      capId:  token.id,
      scope:  requestedScope,
      action: requestedAction,
    };
  }

  if (response.type === 'CAP_DENIED') {
    return { error: `CAP denied by remote [${response.code}]: ${response.reason}` };
  }

  return { error: `Unexpected response type: ${response.type}` };
}

/**
 * Server-side: validate an incoming CAP presentation and respond.
 * Called by the remote node's message handler.
 */
export async function handleCapabilityPresentation(
  channel:         TransportChannel,
  message:         any,
  localCID:        string,
  verifySignature: (pubkey: string, msg: string, sig: string) => boolean,
  revocationStore?: RevocationStore,
  nowMs?:          number,
): Promise<{ allowed: true; capId: string } | { allowed: false; reason: string }> {
  const token:    CAPToken   = message.token;
  const reqCID:   string     = message.cid;
  const scope:    string     = message.scope;
  const action:   CAPAction  = message.action;

  const result = enforceCapability(
    token, reqCID, localCID, scope, action,
    verifySignature, revocationStore, nowMs,
  );

  if (result.allowed) {
    await channel.send({ type: 'CAP_ACCEPTED', capId: token.id });
    return { allowed: true, capId: token.id };
  } else {
    await channel.send({ type: 'CAP_DENIED', code: result.code, reason: result.reason });
    return { allowed: false, reason: result.reason };
  }
}

// ── Step 4: Session Establishment ─────────────────────────────────────────────

/**
 * Step 4: Derive a shared session key via ECDH and establish the session.
 *
 * - ECDH over the ephemeral keys exchanged in the handshake
 * - Session key is bound to the CID pair and the session nonce
 * - All subsequent traffic is encrypted with AEAD using this key
 * - A SESSION_ESTABLISHED event is emitted to the DAG
 */
export function establishSession(
  localCID:      string,
  remoteCID:     string,
  handshake:     HandshakeResult,
  capResult:     CapabilityPresentationResult,
  crypto:        CryptoProvider,
  transport:     string,
  ourEphemeralPriv: string,
  nowMs:         number = Date.now(),
): { session: Session; event: OverlayEvent } {
  // Derive shared key: ECDH(ourEphPriv, theirEphPub)
  const rawShared  = crypto.ecdh(ourEphemeralPriv, handshake.theirEphemeral);

  // Bind session key to the CID pair + nonce (prevents key reuse across sessions)
  const sessionKey = canonicalJsonHashSync({
    shared:     rawShared,
    localCID,
    remoteCID,
    nonce:      handshake.sessionNonce,
  });

  const sessionId = canonicalJsonHashSync({ localCID, remoteCID, ts: nowMs, nonce: handshake.sessionNonce });

  const session: Session = {
    sessionId,
    localCID,
    remoteCID,
    transport,
    capId:         capResult.capId,
    sharedKey:     sessionKey,
    establishedAt: nowMs,
    expiresAt:     null,
  };

  const event = evtSessionEstablished(
    localCID, localCID, remoteCID,
    sessionId, transport, capResult.capId,
    null,    // prevHash — caller should chain properly
    nowMs,
  );

  return { session, event };
}

// ── Full Lifecycle ────────────────────────────────────────────────────────────

export interface ConnectParams {
  localCID:        string;
  targetCID:       string;
  requestedScope:  string;
  requestedAction: CAPAction;
  capToken:        CAPToken;
  routingTable:    RoutingTable;
  registry:        CIDRegistry;
  dialer:          TransportDialer;
  crypto:          CryptoProvider;
  revocationStore?: RevocationStore;
  verifySignature: (pubkey: string, msg: string, sig: string) => boolean;
  nowMs?:          number;
}

/**
 * Execute the full four-step connection lifecycle.
 *
 * Returns a live Session on success, or a structured error with the
 * failed step name so the caller can decide how to retry.
 */
export async function connect(params: ConnectParams): Promise<ConnectionResult> {
  const nowMs = params.nowMs ?? Date.now();

  // Step 1: Discovery
  const discovery = await discoverCID(
    params.targetCID, params.routingTable, params.registry,
    params.localCID, { requestedScope: params.requestedScope },
  );
  if ('error' in discovery) {
    return { ok: false, step: 'discovery', reason: discovery.error };
  }

  // Open transport channel
  let channel: TransportChannel;
  try {
    channel = await params.dialer.dial(discovery.endpoint);
  } catch (err: any) {
    return { ok: false, step: 'discovery', reason: `Transport dial failed: ${err.message}` };
  }

  // Step 2: Handshake
  const ephemeral = params.crypto.generateEphemeralKeypair();
  const handshake = await performHandshake(
    channel, params.localCID, discovery.record,
    params.requestedScope, params.crypto, nowMs,
  );
  if ('error' in handshake) {
    await channel.close();
    return { ok: false, step: 'handshake', reason: handshake.error };
  }

  // Step 3: Capability
  const capResult = await presentCapability(
    channel,
    params.capToken,
    params.localCID,
    params.targetCID,
    params.requestedScope,
    params.requestedAction,
  );
  if ('error' in capResult) {
    await channel.close();
    return { ok: false, step: 'capability', reason: capResult.error };
  }

  // Step 4: Session
  const { session, event } = establishSession(
    params.localCID, params.targetCID, handshake, capResult,
    params.crypto, channel.transport, ephemeral.priv, nowMs,
  );

  return { ok: true, session, event };
}
