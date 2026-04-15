/**
 * CID REGISTRY
 *
 * Distributed CID registry backed by:
 *   1. Local in-memory cache (fast path)
 *   2. Local DAG (persistent, replayed from event log)
 *   3. DHT + gossip (network resolution, peer discovery)
 *
 * The registry is intentionally NOT centralized. Every node maintains
 * its own view derived from the overlay event log. Convergence is
 * guaranteed by the L3 consensus layer.
 *
 * Integration:
 *   - On CID_CREATED / CID_ROTATED events: store() is called by
 *     the overlay state machine (applyOverlayEvent)
 *   - On CID_REVOKED: revoke() marks the CID as invalid
 *   - Connection lifecycle (connection.ts) calls resolve()
 *   - QuorumBridge gossip layer calls announce() to spread new CIDs
 */

import { canonicalJsonHashSync } from '../canonical-json';
import {
  CIDRecord, verifyCIDRecord, parseCID,
} from '../cid/cid';
import { EndpointDescriptor } from '../endpoint/endpoint';
import { CIDRegistry }        from '../connection/connection';

// ── DHT Interface ─────────────────────────────────────────────────────────────

/**
 * Pluggable DHT backend. In production: Kademlia over QUIC.
 * In tests: in-memory map.
 */
export interface DHTBackend {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlMs?: number): Promise<void>;
  findProviders(key: string): Promise<string[]>;  // returns peer CIDs
}

// ── Gossip Interface ──────────────────────────────────────────────────────────

export interface GossipInterface {
  broadcast(topic: string, payload: object): void;
  subscribe(topic: string, handler: (payload: object) => void): void;
}

// ── Registry Config ───────────────────────────────────────────────────────────

export interface RegistryConfig {
  /** How long to cache a resolved CIDRecord (ms). Default: 60s. */
  cacheTtlMs?:  number;
  /** Max number of CIDRecords to cache. Default: 10_000. */
  maxCacheSize?: number;
  /** Signature verification function. Required for untrusted records. */
  verifySignature: (pubkey: string, hash: string, sig: string) => boolean;
}

// ── Cache Entry ───────────────────────────────────────────────────────────────

interface CacheEntry {
  record:     CIDRecord;
  cachedAt:   number;
  expiresAt:  number;
}

// ── Registry Implementation ───────────────────────────────────────────────────

export class DistributedCIDRegistry implements CIDRegistry {
  private readonly _cache   = new Map<string, CacheEntry>();
  private readonly _revoked = new Set<string>();
  private readonly _cacheTtlMs:   number;
  private readonly _maxCacheSize: number;
  private readonly _dht:    DHTBackend | null;
  private readonly _gossip: GossipInterface | null;
  private readonly _verify: (pubkey: string, hash: string, sig: string) => boolean;

  constructor(
    config:  RegistryConfig,
    dht?:    DHTBackend,
    gossip?: GossipInterface,
  ) {
    this._cacheTtlMs   = config.cacheTtlMs   ?? 60_000;
    this._maxCacheSize = config.maxCacheSize  ?? 10_000;
    this._verify       = config.verifySignature;
    this._dht          = dht    ?? null;
    this._gossip       = gossip ?? null;

    if (this._gossip) {
      this._gossip.subscribe('cid.announce', (payload) => {
        const record = (payload as any).record as CIDRecord;
        this._storeLocal(record);
      });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Resolve a CID to its current CIDRecord.
   * Checks: local cache → local DAG → DHT
   */
  async resolve(cid: string): Promise<CIDRecord | null> {
    if (this._revoked.has(cid)) return null;

    // 1. Cache hit
    const cached = this._cache.get(cid);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.record;
    }

    // 2. DHT lookup
    if (this._dht) {
      const raw = await this._dht.get(`cid:${cid}`);
      if (raw) {
        try {
          const record = JSON.parse(raw) as CIDRecord;
          const valid  = verifyCIDRecord(record, this._verify);
          if (valid.ok) {
            this._storeLocal(record);
            return record;
          }
        } catch { /* malformed record from DHT — ignore */ }
      }
    }

    return null;
  }

  /**
   * Store a CIDRecord locally and optionally propagate via gossip/DHT.
   * Called when we learn about a new or updated CID.
   */
  async store(record: CIDRecord): Promise<void> {
    // Verify before storing
    const valid = verifyCIDRecord(record, this._verify);
    if (!valid.ok) {
      throw new Error(`Cannot store invalid CIDRecord: ${valid.reason}`);
    }

    this._storeLocal(record);

    // Propagate to DHT
    if (this._dht) {
      await this._dht.put(
        `cid:${record.cid}`,
        JSON.stringify(record),
        this._cacheTtlMs * 10,   // DHT TTL longer than cache
      );
    }

    // Gossip to peers
    if (this._gossip) {
      this._gossip.broadcast('cid.announce', { record });
    }
  }

  /** Mark a CID as revoked. Removes from cache and prevents future resolution. */
  revoke(cid: string): void {
    this._revoked.add(cid);
    this._cache.delete(cid);
  }

  /** Return all CIDRecords currently in cache. */
  cachedRecords(): CIDRecord[] {
    const now = Date.now();
    return Array.from(this._cache.values())
      .filter(e => e.expiresAt > now)
      .map(e => e.record);
  }

  /** Announce our own CIDRecord to the network. */
  announce(record: CIDRecord): void {
    if (this._gossip) {
      this._gossip.broadcast('cid.announce', { record });
    }
  }

  /** Look up endpoint hints for a CID from DHT providers. */
  async findEndpoints(cid: string): Promise<EndpointDescriptor[]> {
    if (!this._dht) return [];

    const providers = await this._dht.findProviders(`cid:${cid}`);
    const endpoints: EndpointDescriptor[] = providers
      .map(raw => {
        try { return JSON.parse(raw) as EndpointDescriptor; }
        catch { return null; }
      })
      .filter((e): e is EndpointDescriptor => e !== null);

    return endpoints;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _storeLocal(record: CIDRecord): void {
    if (this._revoked.has(record.cid)) return;

    // Evict oldest if over capacity
    if (this._cache.size >= this._maxCacheSize) {
      const oldest = Array.from(this._cache.entries())
        .sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
      if (oldest) this._cache.delete(oldest[0]);
    }

    const now = Date.now();
    this._cache.set(record.cid, {
      record,
      cachedAt:  now,
      expiresAt: now + this._cacheTtlMs,
    });
  }
}

// ── In-Memory Registry (for tests) ───────────────────────────────────────────

/** Simple in-memory CIDRegistry for unit tests. No DHT, no gossip. */
export class InMemoryCIDRegistry implements CIDRegistry {
  private readonly _store = new Map<string, CIDRecord>();

  async resolve(cid: string): Promise<CIDRecord | null> {
    return this._store.get(cid) ?? null;
  }

  async store(record: CIDRecord): Promise<void> {
    this._store.set(record.cid, record);
  }

  /** Convenience: store without async. */
  set(record: CIDRecord): void {
    this._store.set(record.cid, record);
  }

  all(): CIDRecord[] {
    return Array.from(this._store.values());
  }
}
