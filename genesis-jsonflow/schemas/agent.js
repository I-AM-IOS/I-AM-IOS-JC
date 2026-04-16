/**
 * agent.js
 * Schema — Genesis/agent: AI runs, ToolInvoked/EnrichmentCompleted/AgentRunFinished
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
// schemas/agent.js — Genesis AI Agent module template
'use strict';

MODULE_SCHEMAS.agent = {
  systemPromptGuide: `Module type: agent
Derived state tracks: agent runs (run_id, status, inputs, outputs), enrichment tasks (task_id, run_id, source, result), tool invocations (tool_id, run_id, tool_name, args, result).
Events: AgentRunStarted, EnrichmentCompleted, ToolInvoked, AgentRunFinished — each with run_id, relevant payload, previous_hash, and deterministic timestamp (u64).
energy   = count(ToolInvoked in last 100 events) / max(1, total_runs)
decay    = 1 - (events_since_last_tool_invocation / log_length)
priority = (energy * 0.7) + ((1 - decay) * 0.3)
Scheduler selects: InvokeNextTool | RetryFailed | FinalizeRun | Idle`,
  events: {
    AgentRunStarted: {
      type: "event", ordering_key: "run_id", enforced: true,
      description: "Emitted when an AI agent run is initiated with a set of inputs.",
      schema: { type: "object", required: ["run_id","inputs","timestamp"], properties: {
        run_id: { type: "u64" }, inputs: { type: "object" }, timestamp: { type: "u64" }
      }}
    },
    ToolInvoked: {
      type: "event", ordering_key: "tool_id", enforced: true,
      description: "Emitted when the agent calls an external tool or sub-process.",
      schema: { type: "object", required: ["tool_id","run_id","tool_name","args","timestamp"], properties: {
        tool_id: { type: "u64" }, run_id: { type: "u64" }, tool_name: { type: "string" },
        args: { type: "object" }, timestamp: { type: "u64" }
      }}
    },
    EnrichmentCompleted: {
      type: "event", ordering_key: "task_id", enforced: true,
      description: "Emitted when an enrichment task returns a result.",
      schema: { type: "object", required: ["task_id","run_id","source","result","previous_hash","timestamp"], properties: {
        task_id: { type: "u64" }, run_id: { type: "u64" }, source: { type: "string" },
        result: { type: "object" }, previous_hash: { type: "array", items: { type: "number" } }, timestamp: { type: "u64" }
      }}
    },
    AgentRunFinished: {
      type: "event", ordering_key: "run_id", enforced: true,
      description: "Emitted when the agent run completes with final outputs.",
      schema: { type: "object", required: ["run_id","outputs","final_hash","timestamp"], properties: {
        run_id: { type: "u64" }, outputs: { type: "object" },
        final_hash: { type: "array", items: { type: "number" } }, timestamp: { type: "u64" }
      }}
    }
  },
  derived_state: {
    description: "Full deterministic AI agent state: runs, tools, and enrichments derived from the event log.",
    structure: { value: "::derived_state", type: "array", enforced: true,
      items: { type: "object", required: ["run_id","status","inputs"],
        properties: { run_id: { type: "u64" }, status: { type: "string", enum: ["running","completed","failed"] },
          inputs: { type: "object" }, outputs: { type: "object" }, tools: { type: "array" }, enrichments: { type: "array" } }
      }
    }
  },
  emitted_events: {
    description: "Deterministic sequence of AI agent events.",
    structure: { value: "::emitted_events", type: "array", enforced: true,
      items: { type: "object", required: ["event_type","args"],
        properties: { event_type: { type: "string", enum: ["AgentRunStarted","ToolInvoked","EnrichmentCompleted","AgentRunFinished"] }, args: { type: "object" } }
      }
    }
  },
  signal_functions: {
    energy:   { description: "Rate of ToolInvoked events over sliding window / total runs.", formula: "count(ToolInvoked, window=100) / max(1, total_runs)", range: [0,1] },
    decay:    { description: "Staleness of runs since last tool invocation.", formula: "1 - (events_since_last_tool_invocation / log_length)", range: [0,1] },
    priority: { description: "Composite scheduling priority for next tool invocation.", formula: "(energy * 0.7) + ((1 - decay) * 0.3)", range: [0,1] }
  }
};
