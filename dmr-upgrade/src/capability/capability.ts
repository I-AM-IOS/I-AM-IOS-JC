/**
 * CAPABILITY TOKEN (CAP)
 *
 * Capabilities are cryptographically signed authorization grants. They
 * determine what a CID-identified actor is allowed to do on a target
 * scope. No network-level enforcement exists — enforcement is strictly
 * at the node boundary (see enforceCapability()).
 *
 * CAP := Sign(issuer_private_key, capability_claim)
 *
 * Integration:
 *   - CAP_ISSUED and CAP_REVOKED are DAG events (see dag-events.ts).
 *   - Connection handshake (connection.ts) calls presentAndVerifyCAP().
 *   - The ingress pipeline checks cap validity before handler dispatch.
 *   - Revocation state flows through the L1 event log as REVOKED entries.
 */

import { canonicalJson, canonicalJsonHashSync } from '../canonical-json';
import { parseCID, isValidCIDString } from '../cid/cid';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CAPAction = 'read' | 'write' | 'execute' | 'delegate' | 'admin';

/**
 * Runtime constraints embedded in every capability claim.
 * All fields are optional; absence means "no constraint on this axis."
 */
export interface CAPConstraints {
  /** Seconds until this CAP expires. */
  ttl?:           number;
  /** If true, the CAP is bound to the device that first used it. */
  deviceBinding?: boolean;
  /** Max calls per minute. */
  rateLimit?:     number;
  /** Unix ms absolute expiry (overrides ttl if present). */
  expiresAt?:     number;
  /** Max delegation depth (0 = non-delegatable). */
  maxDelegation?: number;
}

/**
 * The claim body — what is being authorized. This is what gets signed.
 */
export interface CAPClaim {
  /** The CID of the identity receiving this capability. */
  subjectCID:  string;
  /** The CID of the target service including path. */
  targetCID:   string;
  /** The scope/path within targetCID this claim applies to. */
  scope:       string;
  /** Permitted actions on the scope. */
  actions:     CAPAction[];
  /** Runtime constraints. */
  constraints: CAPConstraints;
  /** Unix ms when this claim was issued. */
  issuedAt:    number;
  /** The CID of the issuer (who is granting this capability). */
  issuerCID:   string;
  /** Monotonic nonce to prevent replay across claim versions. */
  nonce:       string;
}

/**
 * A fully formed Capability Token ready for transport.
 */
export interface CAPToken {
  /** Canonical hash of the claim body. Content-addressable ID. */
  id:        string;
  /** The claim being authorized. */
  claim:     CAPClaim;
  /** Hex signature: Sign(issuer_privkey, id). */
  signature: string;
  /** The issuer's public key (for offline verification). */
  issuerPubkey: string;
  /** If this was delegated, the parent CAP's id. */
  parentId?: string;
}

// ── Revocation ────────────────────────────────────────────────────────────────

/** In-memory revocation record for a single CAP. */
export interface RevocationEntry {
  capId:     string;
  reason:    string;
  revokedAt: number;
  revokedBy: string;  // CID of the revoking party
}

/** Interface for plugging in any revocation backend. */
export interface RevocationStore {
  isRevoked(capId: string): boolean;
  revoke(entry: RevocationEntry): void;
  listRevoked(): RevocationEntry[];
}

/** Simple in-memory revocation store (replace with DAG-backed in production). */
export class InMemoryRevocationStore implements RevocationStore {
  private readonly _map = new Map<string, RevocationEntry>();

  isRevoked(capId: string): boolean {
    return this._map.has(capId);
  }

  revoke(entry: RevocationEntry): void {
    this._map.set(entry.capId, entry);
  }

  listRevoked(): RevocationEntry[] {
    return Array.from(this._map.values());
  }
}

// ── CAP Construction ──────────────────────────────────────────────────────────

/**
 * Compute the canonical ID of a CAP claim.
 * id = SHA-256(canonicalJson(claim))
 */
export function computeCAPId(claim: CAPClaim): string {
  return canonicalJsonHashSync(claim);
}

export interface IssueCAPParams {
  subjectCID:   string;
  targetCID:    string;
  scope:        string;
  actions:      CAPAction[];
  constraints?: CAPConstraints;
  issuerCID:    string;
  issuerPubkey: string;
  parentId?:    string;
  nowMs?:       number;
  /** Produce a hex signature over the CAP id. */
  sign:         (capId: string) => string;
  /** Optional: source of nonce entropy. */
  nonce?:       string;
}

/**
 * Issue a new Capability Token. The claim is canonically serialized,
 * hashed, and signed by the issuer's private key.
 */
export function issueCAP(params: IssueCAPParams): CAPToken {
  const {
    subjectCID,
    targetCID,
    scope,
    actions,
    constraints = {},
    issuerCID,
    issuerPubkey,
    parentId,
    nowMs  = Date.now(),
    sign,
    nonce  = canonicalJsonHashSync({ rand: Math.random(), ts: nowMs }).slice(0, 16),
  } = params;

  const claim: CAPClaim = {
    subjectCID,
    targetCID,
    scope,
    actions,
    constraints,
    issuedAt: nowMs,
    issuerCID,
    nonce,
  };

  const id        = computeCAPId(claim);
  const signature = sign(id);

  return { id, claim, signature, issuerPubkey, ...(parentId ? { parentId } : {}) };
}

// ── CAP Verification ──────────────────────────────────────────────────────────

export type CAPVerifyResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

export interface VerifyCAPOptions {
  /** The CID requesting access. Must match claim.subjectCID. */
  requestingCID: string;
  /** The target CID being accessed. Must match claim.targetCID. */
  targetCID:     string;
  /** The scope being accessed. Must be a prefix-match of claim.scope. */
  requestedScope: string;
  /** The action being performed. Must be in claim.actions. */
  requestedAction: CAPAction;
  /** Current Unix ms. Used for TTL/expiry checks. */
  nowMs?:         number;
  /** If provided, checks against the revocation list. */
  revocationStore?: RevocationStore;
  /** Verify (issuerPubkey, capId, signature) → boolean. */
  verifySignature: (pubkey: string, message: string, signature: string) => boolean;
}

/**
 * Verify a CAPToken against a concrete access request.
 *
 * Checks in order:
 *   V1: id integrity (claim hash matches token.id)
 *   V2: signature valid
 *   V3: subject CID matches
 *   V4: target CID matches
 *   V5: scope match (request must be on or under claim scope)
 *   V6: action permitted
 *   V7: not expired (TTL + expiresAt)
 *   V8: not revoked
 */
export function verifyCAP(
  token: CAPToken,
  opts:  VerifyCAPOptions,
): CAPVerifyResult {
  const nowMs = opts.nowMs ?? Date.now();

  // V1: ID integrity
  const expectedId = computeCAPId(token.claim);
  if (expectedId !== token.id) {
    return { ok: false, code: 'V1', reason: `CAP id mismatch: expected ${expectedId}` };
  }

  // V2: Signature
  if (!opts.verifySignature(token.issuerPubkey, token.id, token.signature)) {
    return { ok: false, code: 'V2', reason: 'Signature verification failed' };
  }

  // V3: Subject CID
  if (token.claim.subjectCID !== opts.requestingCID) {
    return {
      ok:     false,
      code:   'V3',
      reason: `Subject CID ${token.claim.subjectCID} does not match requesting CID ${opts.requestingCID}`,
    };
  }

  // V4: Target CID (root CID comparison, ignoring service path on token)
  if (token.claim.targetCID !== opts.targetCID) {
    return {
      ok:     false,
      code:   'V4',
      reason: `Target CID ${token.claim.targetCID} does not match request target ${opts.targetCID}`,
    };
  }

  // V5: Scope (requested scope must be the same as or nested under claim scope)
  if (!scopeCovers(token.claim.scope, opts.requestedScope)) {
    return {
      ok:     false,
      code:   'V5',
      reason: `Claim scope "${token.claim.scope}" does not cover requested scope "${opts.requestedScope}"`,
    };
  }

  // V6: Action permitted
  if (!token.claim.actions.includes(opts.requestedAction)) {
    return {
      ok:     false,
      code:   'V6',
      reason: `Action "${opts.requestedAction}" not in permitted set [${token.claim.actions.join(', ')}]`,
    };
  }

  // V7: Expiry
  const { constraints } = token.claim;
  if (constraints.expiresAt !== undefined && nowMs > constraints.expiresAt) {
    return { ok: false, code: 'V7', reason: `CAP expired at ${constraints.expiresAt}` };
  }
  if (constraints.ttl !== undefined) {
    const expiresAt = token.claim.issuedAt + constraints.ttl * 1000;
    if (nowMs > expiresAt) {
      return { ok: false, code: 'V7', reason: `CAP TTL (${constraints.ttl}s) exceeded` };
    }
  }

  // V8: Revocation
  if (opts.revocationStore?.isRevoked(token.id)) {
    return { ok: false, code: 'V8', reason: `CAP ${token.id} has been revoked` };
  }

  return { ok: true };
}

// ── Scope Matching ────────────────────────────────────────────────────────────

/**
 * Return true if claimScope covers requestedScope.
 * A claim scope covers a requested scope if the requested scope is
 * the same path or a sub-path of the claim scope.
 *
 * Examples:
 *   scopeCovers("/app", "/app/drone")    → true
 *   scopeCovers("/app/drone", "/app")    → false
 *   scopeCovers("/app", "/app")          → true
 *   scopeCovers("/", "/anything")        → true
 */
export function scopeCovers(claimScope: string, requestedScope: string): boolean {
  if (claimScope === '/' || claimScope === requestedScope) return true;
  const prefix = claimScope.endsWith('/') ? claimScope : claimScope + '/';
  return requestedScope.startsWith(prefix);
}

// ── Delegation ────────────────────────────────────────────────────────────────

export interface DelegateCAPParams {
  parentToken:     CAPToken;
  delegateeCID:    string;
  scope:           string;         // Must be same or narrower than parent
  actions:         CAPAction[];    // Must be subset of parent
  constraints?:    CAPConstraints;
  delegatorCID:    string;
  delegatorPubkey: string;
  nowMs?:          number;
  sign:            (capId: string) => string;
}

/**
 * Delegate a capability to another CID. The delegated scope and actions
 * must be equal to or narrower than the parent CAP.
 *
 * Returns null if the delegation would exceed parent bounds.
 */
export function delegateCAP(params: DelegateCAPParams): CAPToken | null {
  const { parentToken, scope, actions } = params;

  // Scope must be covered by parent
  if (!scopeCovers(parentToken.claim.scope, scope)) return null;

  // Actions must be a subset of parent actions
  const illegalAction = actions.find(a => !parentToken.claim.actions.includes(a));
  if (illegalAction) return null;

  // Max delegation depth check
  const maxDel = parentToken.claim.constraints.maxDelegation;
  if (maxDel !== undefined && maxDel <= 0) return null;

  const delegatedConstraints: CAPConstraints = {
    ...params.constraints,
    maxDelegation: maxDel !== undefined ? maxDel - 1 : undefined,
  };

  return issueCAP({
    subjectCID:   params.delegateeCID,
    targetCID:    parentToken.claim.targetCID,
    scope,
    actions,
    constraints:  delegatedConstraints,
    issuerCID:    params.delegatorCID,
    issuerPubkey: params.delegatorPubkey,
    parentId:     parentToken.id,
    nowMs:        params.nowMs,
    sign:         params.sign,
  });
}

// ── Enforcement ───────────────────────────────────────────────────────────────

export type EnforcementResult =
  | { allowed: true }
  | { allowed: false; reason: string; code: string };

/**
 * Enforcement gate called at node boundary.
 *
 * incoming request →
 *   verify CID →
 *   verify CAP →
 *   verify scope →
 *   allow/deny →
 *   execute handler
 *
 * This is the ONLY enforcement point. There is no network-level enforcement.
 */
export function enforceCapability(
  token:           CAPToken,
  requestingCID:   string,
  targetCID:       string,
  requestedScope:  string,
  requestedAction: CAPAction,
  verifySignature: (pubkey: string, msg: string, sig: string) => boolean,
  revocationStore?: RevocationStore,
  nowMs?:          number,
): EnforcementResult {
  const result = verifyCAP(token, {
    requestingCID,
    targetCID,
    requestedScope,
    requestedAction,
    nowMs,
    revocationStore,
    verifySignature,
  });

  if (result.ok) {
    return { allowed: true };
  }
  return { allowed: false, reason: result.reason, code: result.code };
}
