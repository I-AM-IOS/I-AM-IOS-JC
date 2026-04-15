// ════════════════════════════════════════════════════════════════════════════
//  kernel-adapter.js
//
//  Wraps kernel.js so all outputs become sovereign-log events.
//  kernel.js itself is untouched — this is the seam layer.
//
//  Before (kernel.js internal flow):
//    callView() → parseFrame() → buildContradictionGraph() → render UI
//
//  After:
//    callView() → parseFrame() → emit(KERNEL_VIEW_RESOLVED)
//    buildContradictionGraph() → emit(KERNEL_ANALYSIS)
//    UI reads deriveState().kernelRuns — never touches kernel internals
// ════════════════════════════════════════════════════════════════════════════

import { emit, EVENT_TYPES, deriveState } from './sovereign-log.js';
import { ALL_VIEWS, VIEWS_A, VIEWS_B, buildContradictionGraph } from './modules/kernel.js';

// ── runKernel ─────────────────────────────────────────────────────────────────
// Drop-in replacement for the inline kernel orchestration in intel.js.
// Returns the seq of the KERNEL_ANALYSIS event (not the result itself —
// callers should read state via deriveState() or subscribe()).
export async function runKernel(concept) {
  const state = deriveState();

  if (!state.kernelModelA || !state.kernelModelB) {
    throw new Error('[kernel-adapter] Assign Model A and Model B before running kernel.');
  }
  if (state.kernelRunning) {
    throw new Error('[kernel-adapter] Kernel already running. Wait for KERNEL_ANALYSIS event.');
  }

  emit({ type: EVENT_TYPES.KERNEL_STARTED, concept });

  // ── Run all 6 views concurrently ────────────────────────────────────────────
  // Each view result is emitted as it lands so the UI can stream partial progress.
  const viewResults = await Promise.all(
    ALL_VIEWS.map(view =>
      _runView(concept, view, view.model === 'A' ? state.kernelModelA : state.kernelModelB)
    )
  );

  // ── Build contradiction graph ────────────────────────────────────────────────
  // This is a pure computation — no storage, no state mutation.
  // The graph lives as data inside the KERNEL_ANALYSIS event, derived on demand.
  const contradictionGraph = buildContradictionGraph(viewResults);

  // ── Cluster unresolved tensions ──────────────────────────────────────────────
  const clusters = _clusterTensions(contradictionGraph);

  // ── Truth hash: hash of intersection of invariants across all views ──────────
  const invariantIntersection = _intersectInvariants(viewResults);
  const truthHash = _fnv32(JSON.stringify(invariantIntersection));

  // ── Single authoritative event — everything downstream derives from this ─────
  const record = emit({
    type:               EVENT_TYPES.KERNEL_ANALYSIS,
    concept,
    views:              viewResults,
    contradictionGraph: _serializeGraph(contradictionGraph),
    clusters,
    truthHash,
  });

  return record.seq;
}

// ── _runView ──────────────────────────────────────────────────────────────────
async function _runView(concept, view, model) {
  try {
    const raw = await _callOllama(concept, view, model);
    const frame = _parseFrame(raw, view, model);

    // Emit partial progress — UI can render incremental results
    emit({
      type:    EVENT_TYPES.KERNEL_VIEW_RESOLVED,
      concept,
      view:    frame,
    });

    return frame;
  } catch (err) {
    emit({
      type:    EVENT_TYPES.KERNEL_ERROR,
      concept,
      viewId:  view.id,
      message: err.message,
    });
    throw err;
  }
}

// ── Ollama call (stateless, same as original callView in kernel.js) ───────────
async function _callOllama(concept, view, model) {
  const r = await fetch('http://localhost:11434/api/chat', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: view.system },
        { role: 'user',   content: `Analyze the following concept:\n\n${concept}` },
      ],
      stream:  false,
      options: { temperature: 0.15, top_p: 0.85, repeat_penalty: 1.1 },
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!r.ok) throw new Error(`Ollama ${r.status} on ${view.id}`);
  const data = await r.json();
  return data.message?.content ?? '';
}

// ── Frame parser (lifted from kernel.js, unchanged) ───────────────────────────
function _parseFrame(raw, view, model) {
  const cleaned = raw.replace(/```json|```/gi, '').trim();
  const start   = cleaned.indexOf('{');
  const end     = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`No JSON in ${view.id} response`);
  const json    = JSON.parse(cleaned.slice(start, end + 1));
  const arr     = v => (Array.isArray(v) ? v : []).map(s => String(s).trim()).filter(Boolean);
  return {
    type:        view.id,
    modelSlot:   view.model,
    modelName:   model,
    claims:      arr(json.claims),
    assumptions: arr(json.assumptions),
    invariants:  arr(json.invariants),
    conflicts:   arr(json.conflicts),
  };
}

// ── Invariant intersection (truth = what all views agree on) ─────────────────
function _intersectInvariants(frames) {
  if (!frames.length) return [];
  const tokenize = s =>
    new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2));
  const jaccard = (a, b) => {
    const ta = tokenize(a), tb = tokenize(b);
    const inter = [...ta].filter(x => tb.has(x)).length;
    return inter / new Set([...ta, ...tb]).size;
  };

  const allInvariants = frames.flatMap(f => f.invariants);
  // Keep only invariants that appear (semantically) in the majority of views
  const threshold = Math.ceil(frames.length * 0.5);
  return allInvariants.filter(inv => {
    const support = allInvariants.filter(other => other !== inv && jaccard(inv, other) > 0.3).length;
    return support >= threshold - 1;
  });
}

// ── Tension clusters (groups of high-degree contradiction nodes) ──────────────
function _clusterTensions(graph) {
  const { edges, topology } = graph;
  if (!edges?.length) return [];

  const highDegree = topology?.hubs ?? [];
  return highDegree.map(hub => ({
    centerId:  hub.id,
    degree:    hub.degree,
    slot:      hub.slot,
    edges:     edges.filter(e => e.source === hub.id || e.target === hub.id)
                    .map(e => ({ type: e.type, strength: e.strength, evidence: e.evidence })),
  }));
}

// ── Serialize graph for log storage (Maps → arrays) ─────────────────────────
function _serializeGraph(graph) {
  return {
    nodes:    [...(graph.nodes?.values() ?? [])],
    edges:    graph.edges ?? [],
    topology: graph.topology ?? {},
  };
}

// ── FNV-32 (local copy — no dep on sovereign-log internals) ──────────────────
function _fnv32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── UI helper — contradiction graph as derived projection ────────────────────
// Call this to get the graph for rendering. Never store the return value.
export function getContradictionGraph(concept) {
  const state = deriveState();
  const runs  = state.kernelRuns.filter(r => r.concept === concept);
  return runs.length ? runs[runs.length - 1].contradictionGraph : null;
}
