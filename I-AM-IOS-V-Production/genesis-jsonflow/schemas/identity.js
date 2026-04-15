/**
 * identity.js
 * Schema — Genesis/identity: DIDs, key rotation, IdentityCreated/Updated/Deleted
 *
 * Copyright (c) 2026 Sovereign OS Contributors
 *
 * This file is part of Sovereign Net OS / DDC Infrastructure.
 * Licensed under the Sovereign OS Community License (LICENSE-COMMUNITY).
 * Commercial use requires a separate Commercial License (LICENSE-COMMERCIAL).
 *
 * Core invariant: VM_stateₙ = deriveState(eventLog[0…n])
 *
 * Retain this notice in all copies and derivative works.
 */
// schemas/identity.js — Genesis Identity module template
'use strict';

MODULE_SCHEMAS.identity = {
  systemPromptGuide: `Module type: identity
Derived state tracks: user_id (u64), public_key (byte array), address (byte array).
Events: IdentityCreated, IdentityUpdated, IdentityDeleted — each with user_id, relevant key/address fields, previous_hash where applicable, and a deterministic timestamp (u64).
energy  = count(IdentityCreated in last 100 events) / max(1, total_identities)
decay   = 1 - (events_since_last_update / log_length)
priority = (energy * 0.6) + ((1 - decay) * 0.4)
Scheduler selects: CreateIdentity | UpdateIdentity | DeleteIdentity | Idle`,
  events: {
    IdentityCreated: {
      type: "event", ordering_key: "user_id", enforced: true,
      description: "Emitted when a new user identity is registered.",
      schema: { type: "object", required: ["user_id","public_key","address","timestamp"], properties: {
        user_id:    { type: "u64" }, public_key: { type: "array", items: { type: "number" } },
        address:    { type: "array", items: { type: "number" } }, timestamp: { type: "u64" }
      }}
    },
    IdentityUpdated: {
      type: "event", ordering_key: "user_id", enforced: true,
      description: "Emitted when an identity rotates its public key or address.",
      schema: { type: "object", required: ["user_id","new_public_key","new_address","previous_hash","timestamp"], properties: {
        user_id:        { type: "u64" }, new_public_key: { type: "array", items: { type: "number" } },
        new_address:    { type: "array", items: { type: "number" } },
        previous_hash:  { type: "array", items: { type: "number" } }, timestamp: { type: "u64" }
      }}
    },
    IdentityDeleted: {
      type: "event", ordering_key: "user_id", enforced: true,
      description: "Emitted when a user identity is permanently removed.",
      schema: { type: "object", required: ["user_id","final_hash","timestamp"], properties: {
        user_id: { type: "u64" }, final_hash: { type: "array", items: { type: "number" } }, timestamp: { type: "u64" }
      }}
    }
  },
  derived_state: {
    description: "Full deterministic state of all user identities derived from the event log.",
    structure: { value: "::derived_state", type: "array", enforced: true,
      items: { type: "object", required: ["user_id","public_key","address"],
        properties: { user_id: { type: "u64" }, public_key: { type: "array", items: { type: "number" } }, address: { type: "array", items: { type: "number" } } }
      }
    }
  },
  emitted_events: {
    description: "Deterministic sequence of IdentityCreated, IdentityUpdated, IdentityDeleted events.",
    structure: { value: "::emitted_events", type: "array", enforced: true,
      items: { type: "object", required: ["event_type","args"],
        properties: { event_type: { type: "string", enum: ["IdentityCreated","IdentityUpdated","IdentityDeleted"] }, args: { type: "object" } }
      }
    }
  },
  signal_functions: {
    energy:   { description: "Rate of IdentityCreated events over sliding window / total identities.", formula: "count(IdentityCreated, window=100) / max(1, total_identities)", range: [0,1] },
    decay:    { description: "Staleness of identities since last IdentityUpdated, normalized to log length.", formula: "1 - (events_since_last_update / log_length)", range: [0,1] },
    priority: { description: "Composite scheduling priority from energy and inverse decay.", formula: "(energy * 0.6) + ((1 - decay) * 0.4)", range: [0,1] }
  }
};
