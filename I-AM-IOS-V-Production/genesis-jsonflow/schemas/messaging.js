/**
 * messaging.js
 * Schema — Genesis/messaging: conversations, MessageSent/Edited/Deleted
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
// schemas/messaging.js — Genesis Messaging module template
'use strict';

MODULE_SCHEMAS.messaging = {
  systemPromptGuide: `Module type: messaging
Derived state tracks: conversations (id, participants, created_at, last_activity), messages (id, conversation_id, sender_id, body, status, sent_at, edited_at?).
Events: ConversationCreated, MessageSent, MessageEdited, MessageDeleted — each with conversation_id or message_id, sender_id, relevant payload fields, previous_hash where applicable, and a deterministic timestamp (u64).
energy   = count(MessageSent in last 100 events) / max(1, total_messages)
decay    = 1 - (events_since_last_message_in_conversation / log_length)
priority = (energy * 0.5) + ((1 - decay) * 0.5)
Scheduler selects: SendNotification | CleanupDeletedMessages | RetryQueuedSend | ArchiveConversation | Idle`,
  events: {
    ConversationCreated: {
      type: "event", ordering_key: "conversation_id", enforced: true,
      description: "Emitted when a new conversation is opened between participants.",
      schema: { type: "object", required: ["conversation_id","participants","created_by","timestamp"], properties: {
        conversation_id: { type: "u64" },
        participants:    { type: "array", items: { type: "u64" }, description: "Ordered list of participant user_ids." },
        created_by:      { type: "u64" },
        timestamp:       { type: "u64" }
      }}
    },
    MessageSent: {
      type: "event", ordering_key: "message_id", enforced: true,
      description: "Emitted when a participant sends a message into a conversation.",
      schema: { type: "object", required: ["message_id","conversation_id","sender_id","body","timestamp"], properties: {
        message_id:      { type: "u64" },
        conversation_id: { type: "u64" },
        sender_id:       { type: "u64" },
        body:            { type: "string" },
        status:          { type: "string", enum: ["sent","delivered","read"], description: "Initial delivery status." },
        timestamp:       { type: "u64" }
      }}
    },
    MessageEdited: {
      type: "event", ordering_key: "message_id", enforced: true,
      description: "Emitted when a sender edits the body of a previously sent message.",
      schema: { type: "object", required: ["message_id","conversation_id","sender_id","new_body","previous_hash","timestamp"], properties: {
        message_id:      { type: "u64" },
        conversation_id: { type: "u64" },
        sender_id:       { type: "u64" },
        new_body:        { type: "string" },
        previous_hash:   { type: "array", items: { type: "number" } },
        timestamp:       { type: "u64" }
      }}
    },
    MessageDeleted: {
      type: "event", ordering_key: "message_id", enforced: true,
      description: "Emitted when a message is permanently removed from a conversation.",
      schema: { type: "object", required: ["message_id","conversation_id","deleted_by","previous_hash","timestamp"], properties: {
        message_id:      { type: "u64" },
        conversation_id: { type: "u64" },
        deleted_by:      { type: "u64" },
        previous_hash:   { type: "array", items: { type: "number" } },
        timestamp:       { type: "u64" }
      }}
    }
  },
  derived_state: {
    description: "Full deterministic state of all conversations and messages.",
    structure: { value: "::derived_state", type: "array", enforced: true,
      items: { type: "object", required: ["conversation_id","participants"],
        properties: { conversation_id: { type: "u64" }, participants: { type: "array" }, messages: { type: "array" } }
      }
    }
  },
  emitted_events: {
    description: "Deterministic sequence of messaging events.",
    structure: { value: "::emitted_events", type: "array", enforced: true,
      items: { type: "object", required: ["event_type","args"],
        properties: { event_type: { type: "string", enum: ["ConversationCreated","MessageSent","MessageEdited","MessageDeleted"] }, args: { type: "object" } }
      }
    }
  },
  signal_functions: {
    energy:   { description: "Rate of MessageSent events over sliding window / total messages.", formula: "count(MessageSent, window=100) / max(1, total_messages)", range: [0,1] },
    decay:    { description: "Staleness of conversations since last message.", formula: "1 - (events_since_last_message_in_conversation / log_length)", range: [0,1] },
    priority: { description: "Composite scheduling priority for messaging actions.", formula: "(energy * 0.5) + ((1 - decay) * 0.5)", range: [0,1] }
  }
};
