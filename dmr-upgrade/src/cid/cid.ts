/**
 * CID — Canonical Identity Descriptor
 *
 * The CID is the cryptographic identity anchor for every node, service,
 * and actor in the overlay. It is derived from a public key, meaning
 * identity cannot be spoofed without possessing the private key.
 *
 * Format:   cid:iam:<key_id>//<service_path>
 * Example:  cid:iam:7f3a9c.../app/drone/control
 *
 * Integration:
 *   - All events flowing through L1 carry a `cid` actor field.
 *   - CID_CREATED and CID_ROTATED are DAG events (see dag-events.ts).
 *   - The ingress I7 check (verifyActorSignature) uses CID pubkeys.
 *   - Routing decisions (overlay-routing.ts) traverse the CID graph.
 */

import { canonicalJson, canonicalJsonHashSync } from '../canonical-json';

// ── Constants ─────────────────────────────────────────────────────────────────

export const CID_SCHEME   = 'cid:iam:';
export const CID_VERSION  = 1;
export const KEY_TYPES    = ['ed25519', 'secp256k1'] as const;

export type KeyType = typeof KEY_TYPES[number];

// ── Core Types ────────────────────────────────────────────────────────────────

/**
 * A fully resolved CID object. This is the canonical identity record
 * stored in the CID registry and gossiped across the overlay.
 */
export interface CIDRecord {
  /** Globally unique identifier derived from pubkey hash. */
  cid:           string;
  /** Algorithm prefix + base58/hex encoded public key. */
  pubkey:        string;
  /** Key algorithm. Defaults to ed25519. */
  keyType:       KeyType;
  /** Optional metadata hash (IPFS CID or local DAG root). */
  metadataHash:  string | null;
  /** Active reachable endpoints for this CID. */
  endpoints:     EndpointHint[];
  /** Monotonic counter. Incremented on key rotation. */
  epoch:         number;
  /** Unix ms when this record was created. */
  createdAt:     number;
  /** Unix ms when this record was last updated. */
  updatedAt:     number;
  /** SHA-256(canonical fields) — integrity over this record. */
  recordHash:    string;
  /** Signature over recordHash using CID private key. */
  signature:     string;
}

/** Lightweight endpoint hint embedded in a CIDRecord. */
export interface EndpointHint {
  transport: 'quic' | 'webrtc' | 'relay' | 'tcp';
  address:   string;   // e.g. "192.0.2.1:443" or relay node CID
}

/**
 * Parsed CID — the structural components of a CID string.
 */
export interface ParsedCID {
  keyId:       string;         // hex prefix of pubkey hash
  servicePath: string | null;  // optional path after "//"
  raw:         string;         // original string
}

// ── CID Construction ──────────────────────────────────────────────────────────

/**
 * Derive the key_id component from a raw public key.
 * key_id = first 32 hex chars of SHA-256(pubkey bytes).
 * This is stable across epochs as long as the key doesn't rotate.
 */
export function deriveKeyId(pubkeyHex: string): string {
  const hash = canonicalJsonHashSync({ pubkey: pubkeyHex });
  return hash.slice(0, 32);
}

/**
 * Build a CID string from its components.
 *
 * @param keyId       - 32-char hex key identifier
 * @param servicePath - optional path e.g. "app/drone/control"
 */
export function buildCIDString(keyId: string, servicePath?: string): string {
  const base = `${CID_SCHEME}${keyId}`;
  return servicePath ? `${base}//${servicePath}` : base;
}

/**
 * Parse a CID string into its structural components.
 * Returns null if the string is not a valid CID.
 */
export function parseCID(cid: string): ParsedCID | null {
  if (!cid.startsWith(CID_SCHEME)) return null;
  const rest = cid.slice(CID_SCHEME.length);
  const slashIdx = rest.indexOf('//');
  if (slashIdx === -1) {
    return { keyId: rest, servicePath: null, raw: cid };
  }
  return {
    keyId:       rest.slice(0, slashIdx),
    servicePath: rest.slice(slashIdx + 2) || null,
    raw:         cid,
  };
}

/**
 * Return true if the string is a syntactically valid CID.
 */
export function isValidCIDString(cid: string): boolean {
  return parseCID(cid) !== null;
}

// ── Record Hashing ────────────────────────────────────────────────────────────

/**
 * Fields that are included in the recordHash. Excludes recordHash and
 * signature themselves to avoid circularity.
 */
function hashableFields(r: Omit<CIDRecord, 'recordHash' | 'signature'>): object {
  return {
    cid:          r.cid,
    pubkey:       r.pubkey,
    keyType:      r.keyType,
    metadataHash: r.metadataHash,
    endpoints:    r.endpoints,
    epoch:        r.epoch,
    createdAt:    r.createdAt,
    updatedAt:    r.updatedAt,
  };
}

/**
 * Compute the canonical record hash. Called both on creation and
 * on verification. The hash is deterministic across all nodes.
 */
export function computeRecordHash(
  record: Omit<CIDRecord, 'recordHash' | 'signature'>
): string {
  return canonicalJsonHashSync(hashableFields(record));
}

// ── Record Creation ───────────────────────────────────────────────────────────

export interface CreateCIDParams {
  pubkey:        string;
  keyType?:      KeyType;
  endpoints?:    EndpointHint[];
  metadataHash?: string;
  servicePath?:  string;
  nowMs?:        number;
  /** Called to produce the Ed25519/secp256k1 signature over recordHash. */
  sign:          (recordHash: string) => string;
}

/**
 * Create a new CIDRecord. Computes the key_id, builds the CID string,
 * hashes the canonical fields, and calls sign() for the signature.
 */
export function createCIDRecord(params: CreateCIDParams): CIDRecord {
  const {
    pubkey,
    keyType     = 'ed25519',
    endpoints   = [],
    metadataHash = null,
    servicePath,
    nowMs       = Date.now(),
    sign,
  } = params;

  const keyId = deriveKeyId(pubkey);
  const cid   = buildCIDString(keyId, servicePath);

  const partial: Omit<CIDRecord, 'recordHash' | 'signature'> = {
    cid,
    pubkey,
    keyType,
    metadataHash,
    endpoints,
    epoch:     1,
    createdAt: nowMs,
    updatedAt: nowMs,
  };

  const recordHash = computeRecordHash(partial);
  const signature  = sign(recordHash);

  return { ...partial, recordHash, signature };
}

// ── Record Verification ───────────────────────────────────────────────────────

export type CIDVerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify a CIDRecord's structural and cryptographic integrity.
 *
 * @param record         - The record to verify
 * @param verifySignature - Called with (pubkey, recordHash, signature);
 *                          return true if valid.
 */
export function verifyCIDRecord(
  record: CIDRecord,
  verifySignature: (pubkey: string, hash: string, sig: string) => boolean,
): CIDVerifyResult {
  // 1. CID string is valid
  if (!isValidCIDString(record.cid)) {
    return { ok: false, reason: 'Invalid CID string format' };
  }

  // 2. Key type is known
  if (!KEY_TYPES.includes(record.keyType)) {
    return { ok: false, reason: `Unknown key type: ${record.keyType}` };
  }

  // 3. Epoch is positive integer
  if (!Number.isInteger(record.epoch) || record.epoch < 1) {
    return { ok: false, reason: 'Epoch must be a positive integer' };
  }

  // 4. The key_id embedded in the CID matches the pubkey
  const parsed = parseCID(record.cid)!;
  const expectedKeyId = deriveKeyId(record.pubkey);
  if (parsed.keyId !== expectedKeyId) {
    return {
      ok:     false,
      reason: `CID key_id ${parsed.keyId} does not match pubkey-derived key_id ${expectedKeyId}`,
    };
  }

  // 5. Record hash is correct
  const expectedHash = computeRecordHash(record);
  if (expectedHash !== record.recordHash) {
    return { ok: false, reason: 'Record hash mismatch — possible tampering' };
  }

  // 6. Signature is valid
  if (!verifySignature(record.pubkey, record.recordHash, record.signature)) {
    return { ok: false, reason: 'Signature verification failed' };
  }

  return { ok: true };
}

// ── Epoch Rotation ────────────────────────────────────────────────────────────

/**
 * Rotate the CID to a new key. Produces a new CIDRecord with incremented
 * epoch. The CID string (and key_id) changes because the pubkey changes.
 *
 * The old record should be kept in the DAG as a CID_ROTATED event so
 * peers can verify the rotation chain.
 */
export function rotateCIDKey(
  oldRecord:   CIDRecord,
  newPubkey:   string,
  newKeyType:  KeyType,
  sign:        (recordHash: string) => string,
  nowMs:       number = Date.now(),
): CIDRecord {
  const newKeyId = deriveKeyId(newPubkey);
  const parsed   = parseCID(oldRecord.cid)!;
  const newCID   = buildCIDString(newKeyId, parsed.servicePath ?? undefined);

  const partial: Omit<CIDRecord, 'recordHash' | 'signature'> = {
    cid:          newCID,
    pubkey:       newPubkey,
    keyType:      newKeyType,
    metadataHash: oldRecord.metadataHash,
    endpoints:    oldRecord.endpoints,
    epoch:        oldRecord.epoch + 1,
    createdAt:    oldRecord.createdAt,
    updatedAt:    nowMs,
  };

  const recordHash = computeRecordHash(partial);
  const signature  = sign(recordHash);
  return { ...partial, recordHash, signature };
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Extract the root CID (without service path) from a full CID string.
 * "cid:iam:abc123//app/drone" → "cid:iam:abc123"
 */
export function rootCID(cid: string): string {
  const parsed = parseCID(cid);
  if (!parsed) return cid;
  return `${CID_SCHEME}${parsed.keyId}`;
}

/**
 * Attach a service path to a root CID.
 * ("cid:iam:abc123", "app/sensor") → "cid:iam:abc123//app/sensor"
 */
export function withServicePath(cid: string, servicePath: string): string {
  const parsed = parseCID(cid);
  if (!parsed) throw new Error(`Invalid CID: ${cid}`);
  return buildCIDString(parsed.keyId, servicePath);
}
