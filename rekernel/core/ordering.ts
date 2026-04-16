/**
 * EVENT ORDERING — Deterministic Total Order
 *
 * Without total ordering, the same events can be applied in different orders,
 * leading to different final states. This breaks multi-node convergence.
 *
 * Solution: Define a canonical ordering rule over all events in a batch.
 * 
 * Primary: hash order (deterministic, stable)
 * Secondary: timestamp (causal context, for tie-breaks)
 * Tertiary: id (final disambiguation)
 *
 * This ensures that any two nodes with the same event set apply them
 * in the same order and reach the same state.
 */

import { Event } from '../events/event';

/**
 * Canonical event ordering.
 * 
 * Rule: sort by (hash.localeCompare(other.hash)) — lexicographic order.
 * This is deterministic, stable, and requires no centralized authority.
 * 
 * Secondary tie-break: if hash is equal (should never happen), use timestamp,
 * then id.
 */
export function compareEvents(a: Event, b: Event): number {
  const hashCmp = a.hash.localeCompare(b.hash);
  if (hashCmp !== 0) return hashCmp;

  // Hash tie (should not occur in practice)
  const tsCmp = a.timestamp - b.timestamp;
  if (tsCmp !== 0) return tsCmp;

  return a.id.localeCompare(b.id);
}

/**
 * Sort events into canonical order.
 * Returns a new array; does not mutate input.
 */
export function sortEvents(events: readonly Event[]): Event[] {
  return [...events].sort(compareEvents);
}

/**
 * Deduplication: remove duplicate events (same hash).
 * If duplicates exist, keep only the first (by sort order).
 */
export function deduplicateEvents(events: readonly Event[]): Event[] {
  const seen = new Set<string>();
  const result: Event[] = [];

  for (const event of sortEvents(events)) {
    if (!seen.has(event.hash)) {
      seen.add(event.hash);
      result.push(event);
    }
  }

  return result;
}

/**
 * Apply total ordering and deduplication together.
 * This is the standard preprocessing step before executing a batch.
 * 
 * Example:
 *   const ordered = canonicalizeEventBatch(incomingEvents);
 *   let state = genesis;
 *   for (const event of ordered) {
 *     state = exec(state, event);
 *   }
 */
export function canonicalizeEventBatch(events: readonly Event[]): Event[] {
  return deduplicateEvents(events);
}

/**
 * Verify that two event batches would produce the same result.
 * They must be identical *after* canonicalization.
 */
export function isBatchEquivalent(
  batch1: readonly Event[],
  batch2: readonly Event[]
): boolean {
  const c1 = canonicalizeEventBatch(batch1);
  const c2 = canonicalizeEventBatch(batch2);

  if (c1.length !== c2.length) return false;

  for (let i = 0; i < c1.length; i++) {
    if (c1[i].hash !== c2[i].hash) return false;
  }

  return true;
}

/**
 * Event merge: combine ledgers from multiple nodes, returning canonical order.
 * Used in consensus to merge partial views.
 */
export function mergeAndOrderLedgers(ledgers: Event[][]): Event[] {
  const allEvents: Event[] = [];

  for (const ledger of ledgers) {
    allEvents.push(...ledger);
  }

  return canonicalizeEventBatch(allEvents);
}

/**
 * Detect ordering conflict: if two nodes have the same events but different order,
 * they're diverging. (This should not happen if nodes use canonicalOrder everywhere.)
 */
export function detectOrderingConflict(ledger1: Event[], ledger2: Event[]): boolean {
  const set1 = new Set(ledger1.map((e) => e.hash));
  const set2 = new Set(ledger2.map((e) => e.hash));

  // Same event set?
  if (set1.size !== set2.size) return false;
  for (const hash of set1) {
    if (!set2.has(hash)) return false;
  }

  // Same events, different order?
  for (let i = 0; i < ledger1.length; i++) {
    if (ledger1[i].hash !== ledger2[i].hash) return true;
  }

  return false;
}
