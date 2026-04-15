/**
 * crm.js
 * Schema — Genesis/crm: contacts, deals, ContactCreated/DealUpdated/ActivityLogged
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
// schemas/crm.js — Genesis CRM module template
'use strict';

MODULE_SCHEMAS.crm = {
  systemPromptGuide: `Module type: crm
Derived state tracks: contacts (id, name, email, company, stage), interactions (id, contact_id, type, notes, timestamp), deals (id, contact_id, value, stage).
Events: ContactCreated, ContactUpdated, InteractionLogged, DealStageChanged — each with relevant ids, payload fields, previous_hash where applicable, and a deterministic timestamp (u64).
energy   = count(InteractionLogged in last 100 events) / max(1, total_contacts)
decay    = 1 - (events_since_last_interaction / log_length)
priority = (energy * 0.6) + ((1 - decay) * 0.4)
Scheduler selects: ScheduleFollowUp | EscalateDeal | ArchiveContact | Idle`,
  events: {
    ContactCreated: {
      type: "event", ordering_key: "contact_id", enforced: true,
      description: "Emitted when a new CRM contact is added.",
      schema: { type: "object", required: ["contact_id","name","email","timestamp"], properties: {
        contact_id: { type: "u64" }, name: { type: "string" }, email: { type: "string" },
        company: { type: "string" }, stage: { type: "string" }, timestamp: { type: "u64" }
      }}
    },
    ContactUpdated: {
      type: "event", ordering_key: "contact_id", enforced: true,
      description: "Emitted when a contact's fields are modified.",
      schema: { type: "object", required: ["contact_id","changes","previous_hash","timestamp"], properties: {
        contact_id: { type: "u64" }, changes: { type: "object" },
        previous_hash: { type: "array", items: { type: "number" } }, timestamp: { type: "u64" }
      }}
    },
    InteractionLogged: {
      type: "event", ordering_key: "interaction_id", enforced: true,
      description: "Emitted when a sales interaction (call, email, meeting) is recorded.",
      schema: { type: "object", required: ["interaction_id","contact_id","type","notes","timestamp"], properties: {
        interaction_id: { type: "u64" }, contact_id: { type: "u64" },
        type: { type: "string", enum: ["call","email","meeting","note"] },
        notes: { type: "string" }, timestamp: { type: "u64" }
      }}
    },
    DealStageChanged: {
      type: "event", ordering_key: "deal_id", enforced: true,
      description: "Emitted when a deal advances or regresses through the pipeline.",
      schema: { type: "object", required: ["deal_id","contact_id","from_stage","to_stage","previous_hash","timestamp"], properties: {
        deal_id: { type: "u64" }, contact_id: { type: "u64" },
        from_stage: { type: "string" }, to_stage: { type: "string" },
        previous_hash: { type: "array", items: { type: "number" } }, timestamp: { type: "u64" }
      }}
    }
  },
  derived_state: {
    description: "Full deterministic CRM state: contacts, interactions, and deals derived from the event log.",
    structure: { value: "::derived_state", type: "array", enforced: true,
      items: { type: "object", required: ["contact_id","name","stage"],
        properties: { contact_id: { type: "u64" }, name: { type: "string" }, email: { type: "string" },
          stage: { type: "string" }, interactions: { type: "array" }, deals: { type: "array" } }
      }
    }
  },
  emitted_events: {
    description: "Deterministic sequence of CRM events.",
    structure: { value: "::emitted_events", type: "array", enforced: true,
      items: { type: "object", required: ["event_type","args"],
        properties: { event_type: { type: "string", enum: ["ContactCreated","ContactUpdated","InteractionLogged","DealStageChanged"] }, args: { type: "object" } }
      }
    }
  },
  signal_functions: {
    energy:   { description: "Rate of InteractionLogged over sliding window / total contacts.", formula: "count(InteractionLogged, window=100) / max(1, total_contacts)", range: [0,1] },
    decay:    { description: "Staleness of contacts since last interaction, normalized to log length.", formula: "1 - (events_since_last_interaction / log_length)", range: [0,1] },
    priority: { description: "Composite scheduling priority for follow-up actions.", formula: "(energy * 0.6) + ((1 - decay) * 0.4)", range: [0,1] }
  }
};
