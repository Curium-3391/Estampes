// #86 F1-3: running a Flow. One `router.execute` per node, in dependency order, so every node keeps the router's checks (the module is enabled, its
// permissions, input validation, the declared outputSchema, audit). The runner keeps nothing itself: it is given the flow and the per-node results
// of earlier runs (`state`) and returns the new state, so whoever stores a flow decides where that lives.
//
// A node's result is kept with the hash of exactly what it was computed from (module version, capability, literal and fed inputs). A node is fresh
// when that hash still matches what its inputs are now, so a run only recomputes what changed, and a node whose new result is identical to its old
// one does not make the nodes after it recompute (early cutoff). A node that fails leaves the nodes that need it blocked, not wrong.
import { createHash } from "node:crypto";
import { validateFlow } from "./graph.js";

const stable = (v) => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}" : JSON.stringify(v ?? null);
const sha = (v) => createHash("sha256").update(stable(v)).digest("hex");
const short = (e) => String(e?.message ?? e).slice(0, 300);

export const emptyState = () => ({ nodes: {} });

// A kept result is good for these inputs when it has data and was computed from exactly them. A node that was blocked or failed keeps its last good
// data and its hash, so going back to inputs it already has an answer for needs no run.
const holds = (kept, hash) => kept?.data !== undefined && kept.inputsHash === hash;
const lastGood = (kept) => (kept?.data !== undefined ? { data: kept.data, revision: kept.revision, inputsHash: kept.inputsHash, at: kept.at } : {});

// What a node would be computed from now, or the reason it cannot be computed yet.
function inputsOf(flow, node, results) {
  const inputs = { ...(node.params ?? {}) };
  for (const e of flow.edges) {
    if (e.to.node !== node.id) continue;
    const up = results[e.from.node];
    if (!up || up.status !== "fresh") return { blockedBy: e.from.node };
    inputs[e.to.port] = up.data[e.from.port];
  }
  return { inputs };
}
const hashOf = (registry, node, inputs) => sha({ module: node.module, version: registry.get(node.module)?.manifest.version ?? null, capability: node.capability, inputs });

// What a run would do, without running anything: per node `fresh` (its result still matches its inputs), `stale` (it would be recomputed),
// or `blocked` (an upstream node has no good result). Reading it costs nothing and runs no module.
export function plan(flow, registry, state = emptyState()) {
  const checked = validateFlow(flow, registry);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const view = {}, out = {};
  for (const id of checked.order) {
    const node = flow.nodes.find((n) => n.id === id), got = inputsOf(flow, node, view);
    if (got.blockedBy) {
      // Behind a node that has no good result: blocked if that node failed or is itself blocked, otherwise just waiting for it to be recomputed.
      const up = state.nodes[got.blockedBy], broken = out[got.blockedBy].status === "blocked" || (out[got.blockedBy].status === "stale" && !out[got.blockedBy].pending && up?.status === "error");
      out[id] = broken ? { status: "blocked", by: got.blockedBy } : { status: "stale", pending: got.blockedBy };
      view[id] = { status: "stale" }; continue;
    }
    const kept = state.nodes[id];
    const same = holds(kept, hashOf(registry, node, got.inputs));
    out[id] = { status: same ? "fresh" : "stale" };
    view[id] = same ? kept : { status: "stale" };
  }
  return { ok: true, order: checked.order, nodes: out };
}

// Runs what is stale. `signal` (an AbortSignal) is checked between nodes: a cancelled run keeps every result it has already produced and
// reports the rest as `cancelled`. Returns { ok, state, ran, reused, failed, blocked, cancelled } (node ids).
export async function runFlow({ flow, router, registry, state = emptyState(), signal = null, now = () => new Date().toISOString() }) {
  const checked = validateFlow(flow, registry);
  if (!checked.ok) return { ok: false, errors: checked.errors, state };
  const next = { nodes: {} };
  for (const id of checked.order) if (state.nodes[id]) next.nodes[id] = state.nodes[id];
  const report = { ran: [], reused: [], failed: [], blocked: [], cancelled: [] };
  for (const [i, id] of checked.order.entries()) {
    if (signal?.aborted) { report.cancelled.push(...checked.order.slice(i)); break; }
    const node = flow.nodes.find((n) => n.id === id), got = inputsOf(flow, node, next.nodes);
    if (got.blockedBy) { next.nodes[id] = { status: "blocked", by: got.blockedBy, ...lastGood(next.nodes[id]) }; report.blocked.push(id); continue; }
    const inputsHash = hashOf(registry, node, got.inputs), kept = next.nodes[id];
    if (holds(kept, inputsHash)) { next.nodes[id] = { status: "fresh", ...lastGood(kept) }; report.reused.push(id); continue; }
    try {
      const run = await router.execute({ module: node.module, capability: node.capability, params: got.inputs });
      const data = run.data ?? {};
      const same = kept?.data !== undefined && stable(kept.data) === stable(data);
      // An identical result keeps its revision: what depends on it sees no change.
      next.nodes[id] = { status: "fresh", revision: same ? kept.revision : (kept?.revision ?? 0) + 1, inputsHash, data, at: same ? kept.at : now() };
      report.ran.push(id);
    } catch (error) {
      next.nodes[id] = { status: "error", code: error?.code ?? "run", message: short(error), ...lastGood(kept) };
      report.failed.push(id);
    }
  }
  return { ok: report.failed.length === 0 && report.cancelled.length === 0, state: next, ...report };
}
