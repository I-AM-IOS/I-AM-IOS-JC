/**
 * PROTOCOL FREEZE — Consensus-Critical Immutables
 *
 * This module encodes the protocol version and compatibility rules.
 * Changes here require explicit fork decisions, not silent updates.
 *
 * Invariant: Every event and transition must carry a protocol version.
 * A version mismatch signals incompatibility — nodes must diverge explicitly,
 * not silently corrupt.
 */

// ── Consensus-Critical Version ────────────────────────────────────────────────

/**
 * HASH_PROTOCOL_VERSION is consensus-critical.
 * If you change it, you fork the network.
 *
 * Version history:
 * - v1 (current): Canonical hashing, event chaining, transition records
 *
 * To bump to v2:
 * 1. Create a new constant: HASH_PROTOCOL_VERSION_2
 * 2. Add a ProtocolUpgrade event type to track the fork point
 * 3. Implement dual-compat: nodes accept v1 and v2, but fork on mismatch
 * 4. Define migration rules: how S_n(v1) → S_n(v2)
 * 5. Increment HASH_PROTOCOL_VERSION only after all nodes confirm readiness
 *
 * Default behavior on version mismatch: REJECT + emit DivergeEvent
 */
export const HASH_PROTOCOL_VERSION = 1;

// ── Dual-Compat Rules ─────────────────────────────────────────────────────────

export interface ProtocolUpgrade {
  readonly fromVersion:  number;
  readonly toVersion:    number;
  readonly forkHeight:   number;  // Height at which fork occurs
  readonly migrationFn?: (state: any) => any;  // Optional state transformation
}

/**
 * Define all active protocol versions a node will accept.
 * Nodes reject events with versions not in this set.
 * Use this to implement gradual upgrades.
 *
 * Example:
 *   ACCEPTED_VERSIONS = [1, 2]    // Accept v1 and v2, but not v3+
 *   ACCEPTED_VERSIONS = [2]       // Hard fork: v1 nodes are incompatible
 */
export const ACCEPTED_PROTOCOL_VERSIONS: readonly number[] = [1];

/**
 * Dual-compat mode: if true, nodes accept both current and next version.
 * Set to false to enforce a hard fork.
 */
export const DUAL_COMPAT_MODE = false;

// ── Version Validation ────────────────────────────────────────────────────────

export function isAcceptedProtocolVersion(version: number): boolean {
  return ACCEPTED_PROTOCOL_VERSIONS.includes(version);
}

/**
 * Check if an event's protocol version is compatible with this node.
 * Returns a reason string if incompatible, empty string if OK.
 */
export function validateProtocolVersion(eventVersion: number): string {
  if (!isAcceptedProtocolVersion(eventVersion)) {
    const accepted = ACCEPTED_PROTOCOL_VERSIONS.join(', ');
    return `Event protocol=${eventVersion} incompatible (accepted: ${accepted})`;
  }
  return '';  // Compatible
}

/**
 * Fork rule: if protocolVersion mismatch, emit a DivergeRecord.
 * This is first-class: recorded in ledger, not silently dropped.
 */
export interface DivergeRecord {
  readonly timestamp:      number;
  readonly nodeId:         string;
  readonly nodeVersion:    number;
  readonly incomingVersion: number;
  readonly incoming:       { id: string; hash: string };
}

/**
 * Planned upgrades: record when we intend to fork.
 * This allows nodes to coordinate a soft fork before implementation.
 */
export const PLANNED_UPGRADES: ProtocolUpgrade[] = [
  // Example: at block height 10000, if 2/3 consensus, upgrade to v2
  // {
  //   fromVersion: 1,
  //   toVersion: 2,
  //   forkHeight: 10000,
  //   migrationFn: (state) => ({ ...state, version: 2 })
  // }
];

export function lookupUpgrade(from: number, to: number): ProtocolUpgrade | null {
  return PLANNED_UPGRADES.find((u) => u.fromVersion === from && u.toVersion === to) || null;
}
