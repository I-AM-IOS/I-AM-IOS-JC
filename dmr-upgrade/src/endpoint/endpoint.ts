/**
 * ENDPOINT DESCRIPTOR (EPD)
 *
 * Represents how a CID is reachable at a transport level.
 * EPDs are gossiped through the overlay and stored in the CID registry.
 * They are separate from CIDRecords so endpoints can be updated without
 * rotating the identity key.
 *
 * Transport priority (when multiple EPDs available):
 *   1. QUIC (lowest latency, UDP-based, built-in crypto)
 *   2. WebRTC (browser-native, NAT-traversal via STUN/TURN)
 *   3. TCP   (universal fallback)
 *   4. Relay (multi-hop fallback; highest latency, use only if needed)
 */

import { canonicalJsonHashSync } from '../canonical-json';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Transport = 'quic' | 'webrtc' | 'tcp' | 'relay';
export type NATType   = 'open' | 'cone' | 'symmetric' | 'unknown';

/** Scores for transport preference. Higher = more preferred. */
const TRANSPORT_SCORE: Record<Transport, number> = {
  quic:   4,
  webrtc: 3,
  tcp:    2,
  relay:  1,
};

/**
 * A fully described endpoint for a CID.
 */
export interface EndpointDescriptor {
  /** The CID this endpoint belongs to. */
  cid:         string;
  /** Transport mechanism. */
  transport:   Transport;
  /**
   * Address. Semantics depend on transport:
   *   quic/tcp:  "ip:port"
   *   webrtc:    offer_id or signaling channel id
   *   relay:     relay node CID
   */
  address:     string;
  /** NAT classification. Relevant for WebRTC hole-punching. */
  natType:     NATType;
  /** Last measured round-trip latency in milliseconds. */
  latencyMs:   number;
  /** Composite reliability score [0, 1]. */
  trustScore:  number;
  /** Unix ms when this EPD was observed/updated. */
  observedAt:  number;
  /** Canonical hash of this EPD (for dedup and gossip). */
  epHash:      string;
}

// ── Construction ──────────────────────────────────────────────────────────────

export interface CreateEPDParams {
  cid:        string;
  transport:  Transport;
  address:    string;
  natType?:   NATType;
  latencyMs?: number;
  trustScore?: number;
  nowMs?:     number;
}

/**
 * Create an EndpointDescriptor with a canonical hash.
 */
export function createEPD(params: CreateEPDParams): EndpointDescriptor {
  const {
    cid,
    transport,
    address,
    natType    = 'unknown',
    latencyMs  = 0,
    trustScore = 0.5,
    nowMs      = Date.now(),
  } = params;

  const epd: Omit<EndpointDescriptor, 'epHash'> = {
    cid, transport, address, natType,
    latencyMs, trustScore, observedAt: nowMs,
  };

  const epHash = canonicalJsonHashSync(epd);
  return { ...epd, epHash };
}

// ── Selection ─────────────────────────────────────────────────────────────────

export interface EPDScore {
  epd:   EndpointDescriptor;
  score: number;
}

/**
 * Score an endpoint for selection preference.
 *
 * score =
 *   transport_preference * 40
 *   + trust_score       * 35
 *   - latency_penalty   * 25
 *
 * Result is in [0, 100].
 */
export function scoreEPD(epd: EndpointDescriptor, maxLatencyMs = 1000): number {
  const transportPref = (TRANSPORT_SCORE[epd.transport] / 4) * 40;
  const trustPref     = epd.trustScore * 35;
  const latencyRatio  = Math.min(epd.latencyMs / maxLatencyMs, 1);
  const latencyPenalty = latencyRatio * 25;
  return transportPref + trustPref - latencyPenalty;
}

/**
 * Select the best endpoint from a list.
 * Returns null if the list is empty.
 */
export function selectBestEPD(
  epds: EndpointDescriptor[],
  maxLatencyMs?: number,
): EndpointDescriptor | null {
  if (epds.length === 0) return null;
  return epds.reduce((best, candidate) => {
    return scoreEPD(candidate, maxLatencyMs) > scoreEPD(best, maxLatencyMs)
      ? candidate
      : best;
  });
}

/**
 * Rank a list of EPDs by score, descending.
 */
export function rankEPDs(
  epds: EndpointDescriptor[],
  maxLatencyMs?: number,
): EPDScore[] {
  return epds
    .map(epd => ({ epd, score: scoreEPD(epd, maxLatencyMs) }))
    .sort((a, b) => b.score - a.score);
}

// ── Deduplication ─────────────────────────────────────────────────────────────

/**
 * Deduplicate EPDs by (cid, transport, address) — keep highest trustScore.
 */
export function deduplicateEPDs(epds: EndpointDescriptor[]): EndpointDescriptor[] {
  const best = new Map<string, EndpointDescriptor>();
  for (const epd of epds) {
    const key = `${epd.cid}|${epd.transport}|${epd.address}`;
    const existing = best.get(key);
    if (!existing || epd.trustScore > existing.trustScore) {
      best.set(key, epd);
    }
  }
  return Array.from(best.values());
}

// ── Trust Score Update ────────────────────────────────────────────────────────

/**
 * Update the trust score on an EPD after an observed interaction.
 * Uses exponential moving average with alpha=0.2.
 *
 * @param success  - Whether the interaction succeeded
 * @param latencyMs - Observed latency (only used on success)
 */
export function updateEPDTrust(
  epd: EndpointDescriptor,
  success: boolean,
  latencyMs?: number,
  nowMs: number = Date.now(),
): EndpointDescriptor {
  const alpha      = 0.2;
  const observation = success ? 1.0 : 0.0;
  const newTrust    = alpha * observation + (1 - alpha) * epd.trustScore;
  const newLatency  = (success && latencyMs !== undefined)
    ? alpha * latencyMs + (1 - alpha) * epd.latencyMs
    : epd.latencyMs;

  const updated: Omit<EndpointDescriptor, 'epHash'> = {
    ...epd,
    trustScore:  Math.max(0, Math.min(1, newTrust)),
    latencyMs:   Math.max(0, newLatency),
    observedAt:  nowMs,
  };

  return { ...updated, epHash: canonicalJsonHashSync(updated) };
}

// ── Relay Resolution ──────────────────────────────────────────────────────────

/**
 * When direct connection fails, build a relay path through known intermediaries.
 * Returns an ordered list of relay EPDs forming the hop path.
 */
export function buildRelayPath(
  targetCID:   string,
  knownRelays: EndpointDescriptor[],
  maxHops:     number = 3,
): EndpointDescriptor[] {
  const relays = knownRelays
    .filter(e => e.transport === 'relay')
    .sort((a, b) => b.trustScore - a.trustScore)
    .slice(0, maxHops);

  return relays.map(relay => ({
    ...relay,
    cid:     targetCID,
    address: relay.cid,   // relay node CID as the address
  }));
}
