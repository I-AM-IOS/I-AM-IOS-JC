/**
 * governance.js
 * Schema — Genesis/governance: proposals, VoteCast/ProposalEnacted/Rejected
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
// schemas/governance.js — Genesis Governance module template
'use strict';

MODULE_SCHEMAS.governance = {
  systemPromptGuide: `Module type: governance
Derived state tracks: proposals (id, title, status, votes_for, votes_against), voters (id, weight, voted_on[]), policies (id, enacted_at, content).
Events: ProposalCreated, VoteCast, ProposalEnacted, ProposalRejected — each with proposal_id or voter_id, relevant payload, previous_hash, and deterministic timestamp (u64).
energy   = count(VoteCast in last 100 events) / max(1, total_proposals)
decay    = 1 - (events_since_last_vote / log_length)
priority = (energy * 0.5) + ((1 - decay) * 0.5)
Scheduler selects: TallyVotes | EnactPolicy | ArchiveProposal | Idle`,
  events: {
    ProposalCreated: {
      type: "event", ordering_key: "proposal_id", enforced: true,
      description: "Emitted when a governance proposal is submitted.",
      schema: { type: "object", required: ["proposal_id","title","content","proposed_by","timestamp"], properties: {
        proposal_id: { type: "u64" }, title: { type: "string" }, content: { type: "string" },
        proposed_by: { type: "u64" }, timestamp: { type: "u64" }
      }}
    },
    VoteCast: {
      type: "event", ordering_key: "vote_id", enforced: true,
      description: "Emitted when a voter casts a vote on a proposal.",
      schema: { type: "object", required: ["vote_id","proposal_id","voter_id","vote","weight","timestamp"], properties: {
        vote_id: { type: "u64" }, proposal_id: { type: "u64" }, voter_id: { type: "u64" },
        vote: { type: "string", enum: ["for","against","abstain"] }, weight: { type: "number" }, timestamp: { type: "u64" }
      }}
    },
    ProposalEnacted: {
      type: "event", ordering_key: "proposal_id", enforced: true,
      description: "Emitted when a proposal reaches quorum and is enacted as policy.",
      schema: { type: "object", required: ["proposal_id","final_hash","enacted_at"], properties: {
        proposal_id: { type: "u64" }, final_hash: { type: "array", items: { type: "number" } }, enacted_at: { type: "u64" }
      }}
    },
    ProposalRejected: {
      type: "event", ordering_key: "proposal_id", enforced: true,
      description: "Emitted when a proposal fails to reach quorum or is vetoed.",
      schema: { type: "object", required: ["proposal_id","reason","previous_hash","timestamp"], properties: {
        proposal_id: { type: "u64" }, reason: { type: "string" },
        previous_hash: { type: "array", items: { type: "number" } }, timestamp: { type: "u64" }
      }}
    }
  },
  derived_state: {
    description: "Full deterministic governance state: proposals, votes, and enacted policies.",
    structure: { value: "::derived_state", type: "array", enforced: true,
      items: { type: "object", required: ["proposal_id","title","status"],
        properties: { proposal_id: { type: "u64" }, title: { type: "string" },
          status: { type: "string", enum: ["open","enacted","rejected"] },
          votes_for: { type: "number" }, votes_against: { type: "number" }, votes_abstain: { type: "number" } }
      }
    }
  },
  emitted_events: {
    description: "Deterministic sequence of governance events.",
    structure: { value: "::emitted_events", type: "array", enforced: true,
      items: { type: "object", required: ["event_type","args"],
        properties: { event_type: { type: "string", enum: ["ProposalCreated","VoteCast","ProposalEnacted","ProposalRejected"] }, args: { type: "object" } }
      }
    }
  },
  signal_functions: {
    energy:   { description: "Rate of VoteCast events over sliding window / total proposals.", formula: "count(VoteCast, window=100) / max(1, total_proposals)", range: [0,1] },
    decay:    { description: "Staleness of open proposals since last vote.", formula: "1 - (events_since_last_vote / log_length)", range: [0,1] },
    priority: { description: "Composite scheduling priority for tally and enactment actions.", formula: "(energy * 0.5) + ((1 - decay) * 0.5)", range: [0,1] }
  }
};
