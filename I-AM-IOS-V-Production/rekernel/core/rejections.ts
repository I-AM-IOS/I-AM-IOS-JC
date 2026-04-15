/**
 * REJECTION RECORDS — First-Class Ledger Entries
 *
 * When an event is rejected, we emit a deterministic RejectionRecord.
 * This keeps the ledger total and auditable: nothing disappears.
 *
 * Instead of:
 *   events → [accepted only] → ledger
 *
 * We have:
 *   events → [accepted + rejected] → ledger
 *   where rejected = RejectionRecord(eventHash, stateHash, reason)
 */

export type RejectionReason =
  | 'ProtocolVersionMismatch'
  | 'InvalidEventStructure'
  | 'HashMismatch'
  | 'IdMismatch'
  | 'ConstraintViolation'
  | 'InsufficientBudget'
  | 'DuplicateEvent'
  | 'OrphanEvent'
  | 'Timeout'
  | 'Other';

/**
 * A rejection record replaces an event that failed verification.
 * It carries:
 *  - The hash of the rejected event (for auditability)
 *  - The state hash at the moment of rejection (immutable proof)
 *  - A deterministic reason code (no opaque strings)
 *  - Timestamp of rejection
 *
 * Rejection records are *not* executed; they are ledger entries.
 * This allows independent verification: given ledger + genesis, recompute every transition.
 */
export interface RejectionRecord {
  readonly type:          'REJECTION';
  readonly id:            string;  // Derived from rejected event hash + reason
  readonly timestamp:     number;
  readonly actor:         string;  // 'system:verifier'
  readonly rejectedHash:  string;  // Hash of the rejected event
  readonly rejectedId:    string;  // Id of the rejected event
  readonly stateHash:     string;  // State before rejection (immutable reference)
  readonly reason:        RejectionReason;
  readonly details?:      string;  // Optional human-readable detail
  readonly hash:          string;  // Self-hash, computed over all fields
  readonly protocolVersion: number;
  readonly prevHash:      string | null;  // Previous ledger entry hash
}

import crypto from 'crypto';
import { HASH_PROTOCOL_VERSION } from './protocol';
import { canonicalJSON, sha256 } from '../hash';

/**
 * Derive the id for a rejection record.
 * Deterministic: same (rejectedHash, reason) → same id.
 */
export function deriveRejectionId(
  rejectedHash: string,
  reason: RejectionReason,
  timestamp: number,
): string {
  const raw = JSON.stringify({ rejectedHash, reason, timestamp });
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Compute the hash of a rejection record.
 * Same structure as event hash.
 */
export function hashRejectionRecord(record: Omit<RejectionRecord, 'hash'>): string {
  return sha256(canonicalJSON({
    type:            record.type,
    id:              record.id,
    timestamp:       record.timestamp,
    actor:           record.actor,
    rejectedHash:    record.rejectedHash,
    rejectedId:      record.rejectedId,
    stateHash:       record.stateHash,
    reason:          record.reason,
    details:         record.details,
    protocolVersion: record.protocolVersion,
    prevHash:        record.prevHash,
  }));
}

/**
 * Create a rejection record.
 * Immutable and frozen.
 */
export function createRejectionRecord(
  rejectedHash: string,
  rejectedId: string,
  stateHash: string,
  reason: RejectionReason,
  prevHash: string | null = null,
  details?: string,
): RejectionRecord {
  const timestamp = Date.now();
  const id = deriveRejectionId(rejectedHash, reason, timestamp);
  
  const baseRecord = {
    type: 'REJECTION' as const,
    id,
    timestamp,
    actor: 'system:verifier',
    rejectedHash,
    rejectedId,
    stateHash,
    reason,
    details,
    protocolVersion: HASH_PROTOCOL_VERSION,
    prevHash,
  };

  const hash = hashRejectionRecord(baseRecord);
  
  return Object.freeze({
    ...baseRecord,
    hash,
  }) as RejectionRecord;
}

/**
 * A ledger entry is either an Event or a RejectionRecord.
 * The type system enforces this union.
 */
export type LedgerEntry = import('../events/event').Event | RejectionRecord;

export function isRejectionRecord(entry: any): entry is RejectionRecord {
  return entry && entry.type === 'REJECTION';
}

export function isEvent(entry: any): entry is import('../events/event').Event {
  return entry && entry.type !== 'REJECTION';
}
