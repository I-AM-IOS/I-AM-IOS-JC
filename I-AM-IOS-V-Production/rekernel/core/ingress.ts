/**
 * INGRESS VERIFICATION — Mandatory Security Boundary
 *
 * No event — local or remote — enters execution without passing:
 *   1. Structural validation (I4)
 *   2. Hash/id consistency (I1, I2)
 *   3. Protocol version match (I3)
 *
 * verifyEvent() is now part of the security boundary.
 * It must be called before every exec() call.
 *
 * Violations are not silently ignored; they emit RejectionRecords.
 */

import { Event } from '../events/event';
import { hashEvent } from '../hash';
import { HASH_PROTOCOL_VERSION, validateProtocolVersion } from './protocol';
import { RejectionReason } from './rejections';

/**
 * Comprehensive event validation.
 * Returns a list of violations (empty = valid).
 *
 * Invariants checked:
 *   I1: event.hash must equal recomputed hashEvent(fields)
 *   I2: event.id must equal deriveId(fields)
 *   I3: event.protocolVersion must be present and accepted
 *   I4: required fields must be present and non-empty
 *
 * Additionally:
 *   I5: timestamp must be reasonable (not far in future/past)
 *   I6: payload must be JSON-serializable
 */
export interface EventValidationResult {
  valid:       boolean;
  violations:  ValidationViolation[];
  reason?:     RejectionReason;
}

export interface ValidationViolation {
  code:        string;
  severity:    'error' | 'warning';
  message:     string;
  field?:      string;
}

/**
 * Validate an event comprehensively.
 * Stops after first error (severity='error'); warnings are collected.
 */
export function verifyEvent(
  event: Event,
  nowMs: number = Date.now(),
  allowedClockSkewMs: number = 5 * 60 * 1000, // 5 min
): EventValidationResult {
  const violations: ValidationViolation[] = [];
  let reason: RejectionReason | undefined;

  // ── I4: Required fields ──────────────────────────────────────────────────

  if (!event.id || typeof event.id !== 'string' || event.id.length === 0) {
    violations.push({
      code: 'I4_ID_MISSING',
      severity: 'error',
      message: 'Event id is missing or empty',
      field: 'id',
    });
    reason = 'InvalidEventStructure';
  }

  if (!event.type || typeof event.type !== 'string' || event.type.length === 0) {
    violations.push({
      code: 'I4_TYPE_MISSING',
      severity: 'error',
      message: 'Event type is missing or empty',
      field: 'type',
    });
    reason = 'InvalidEventStructure';
  }

  if (!event.actor || typeof event.actor !== 'string' || event.actor.length === 0) {
    violations.push({
      code: 'I4_ACTOR_MISSING',
      severity: 'error',
      message: 'Event actor is missing or empty',
      field: 'actor',
    });
    reason = 'InvalidEventStructure';
  }

  if (!event.timestamp || typeof event.timestamp !== 'number' || event.timestamp <= 0) {
    violations.push({
      code: 'I4_TIMESTAMP_INVALID',
      severity: 'error',
      message: 'Event timestamp is missing, zero, or not a number',
      field: 'timestamp',
    });
    reason = 'InvalidEventStructure';
  }

  if (event.payload === undefined) {
    violations.push({
      code: 'I4_PAYLOAD_MISSING',
      severity: 'error',
      message: 'Event payload is undefined',
      field: 'payload',
    });
    reason = 'InvalidEventStructure';
  }

  // ── I3: Protocol version ─────────────────────────────────────────────────

  if (event.protocolVersion === undefined || event.protocolVersion === null) {
    violations.push({
      code: 'I3_VERSION_MISSING',
      severity: 'error',
      message: 'Event protocolVersion is missing',
      field: 'protocolVersion',
    });
    reason = reason || 'ProtocolVersionMismatch';
  } else {
    const versionError = validateProtocolVersion(event.protocolVersion);
    if (versionError) {
      violations.push({
        code: 'I3_VERSION_MISMATCH',
        severity: 'error',
        message: versionError,
        field: 'protocolVersion',
      });
      reason = reason || 'ProtocolVersionMismatch';
    }
  }

  // Early return on errors
  if (violations.some((v) => v.severity === 'error')) {
    return {
      valid: false,
      violations,
      reason: reason || 'InvalidEventStructure',
    };
  }

  // ── I5: Timestamp reasonableness ──────────────────────────────────────

  const clockDiff = Math.abs(nowMs - event.timestamp);
  if (clockDiff > allowedClockSkewMs) {
    violations.push({
      code: 'I5_TIMESTAMP_SKEW',
      severity: 'warning',
      message: `Event timestamp ${event.timestamp} is ${clockDiff}ms off (allowed: ${allowedClockSkewMs}ms)`,
      field: 'timestamp',
    });
  }

  // ── I6: Payload serializability ──────────────────────────────────────

  try {
    JSON.stringify(event.payload);
  } catch (e) {
    violations.push({
      code: 'I6_PAYLOAD_SERIALIZATION',
      severity: 'error',
      message: `Event payload is not JSON-serializable: ${String(e)}`,
      field: 'payload',
    });
    reason = reason || 'InvalidEventStructure';
    return {
      valid: false,
      violations,
      reason,
    };
  }

  // ── I1: Hash integrity ───────────────────────────────────────────────

  if (!event.hash || typeof event.hash !== 'string') {
    violations.push({
      code: 'I1_HASH_MISSING',
      severity: 'error',
      message: 'Event hash is missing or not a string',
      field: 'hash',
    });
    reason = reason || 'HashMismatch';
  } else {
    const expectedHash = hashEvent({
      id:        event.id,
      type:      event.type,
      actor:     event.actor,
      timestamp: event.timestamp,
      payload:   event.payload,
      prevHash:  event.prevHash || null,
    });

    if (event.hash !== expectedHash) {
      violations.push({
        code: 'I1_HASH_MISMATCH',
        severity: 'error',
        message: `Hash mismatch: stored=${event.hash.slice(0, 12)}… expected=${expectedHash.slice(0, 12)}…`,
        field: 'hash',
      });
      reason = reason || 'HashMismatch';
    }
  }

  // ── I2: Id derivation ────────────────────────────────────────────────

  if (!event.id || typeof event.id !== 'string') {
    // Already caught by I4
  } else {
    // Derive id is expensive; only do if hash passed
    const { deriveId } = require('../events/event');
    const expectedId = deriveId(
      event.type,
      event.actor,
      event.timestamp,
      event.payload,
      event.prevHash || null,
    );

    if (event.id !== expectedId) {
      violations.push({
        code: 'I2_ID_MISMATCH',
        severity: 'error',
        message: `Id mismatch: stored=${event.id.slice(0, 12)}… expected=${expectedId.slice(0, 12)}…`,
        field: 'id',
      });
      reason = reason || 'IdMismatch';
    }
  }

  // ── Final verdict ────────────────────────────────────────────────────

  const hasErrors = violations.some((v) => v.severity === 'error');

  return {
    valid: !hasErrors,
    violations,
    reason: hasErrors ? (reason || 'InvalidEventStructure') : undefined,
  };
}

/**
 * Batch verification: validate all events before execution.
 * Short-circuits on first error.
 */
export function verifyEventBatch(
  events: readonly Event[],
  nowMs?: number,
): { valid: boolean; firstError?: EventValidationResult } {
  for (const event of events) {
    const result = verifyEvent(event, nowMs);
    if (!result.valid) {
      return { valid: false, firstError: result };
    }
  }
  return { valid: true };
}

/**
 * Helper: format violations for logging.
 */
export function formatValidationResult(result: EventValidationResult): string {
  if (result.valid) return 'VALID';

  const lines = [
    `INVALID (reason: ${result.reason})`,
    ...result.violations.map((v) => {
      const field = v.field ? ` [${v.field}]` : '';
      return `  ${v.severity.toUpperCase()}${field}: ${v.code} — ${v.message}`;
    }),
  ];

  return lines.join('\n');
}
