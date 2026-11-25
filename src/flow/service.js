// #86 F1-4: what the `get_flow` / `edit_flow` tools (and any other caller) do with a flow: read it with its checks and plan, change it, undo a
// change, run it. It joins the pieces (store, edit operations, static checks, runner) and adds nothing of its own to the contracts: a run is one
// `router.execute` per node, so every node keeps the router's permission and validation checks.
import { applyOps } from "./edit.js";
import { validateFlow } from "./graph.js";
import { plan, runFlow } from "./run.js";
import { FlowError } from "./store.js";

const RESULT_PREVIEW = 2000, BRIEF_PREVIEW = 240;

export function createFlowService({ store, registry, router, now = () => new Date().toISOString() }) {
  const running = new Map();

  // The graph, whether it is well formed, and what a run would do. Node results are shown bounded (the kept result stays whole in the store).
  function present(f, { brief = false } = {}) {
    const cut = brief ? BRIEF_PREVIEW : RESULT_PREVIEW;
    const checked = validateFlow(f.flow, registry);
    const p = checked.ok ? plan(f.flow, registry, f.results) : null;
    const results = {};
    for (const [id, r] of Object.entries(f.results.nodes ?? {})) {
      const data = r.data === undefined ? undefined : JSON.stringify(r.data);
      results[id] = { status: r.status, revision: r.revision, at: r.at, ...(r.code ? { code: r.code, message: r.message } : {}), ...(r.by ? { by: r.by } : {}),
        ...(data === undefined ? {} : data.length <= cut ? { data: r.data } : { dataPreview: data.slice(0, cut), truncated: true }) };
    }
    return { id: f.id, name: f.name, revision: f.revision, updatedAt: f.updatedAt, flow: f.flow, valid: checked.ok, ...(checked.ok ? { order: checked.order } : { errors: checked.errors.slice(0, 20) }),
      ...(p?.ok ? { plan: p.nodes } : {}), results, running: running.has(f.id) };
  }

  return {
    list: () => store.list(),
    get: async (id, opts) => present(await store.read(id), opts),
    create: async ({ name, commandId, by, brief }) => present(await store.create({ name, commandId, by }), { brief }),
    async edit({ id, expectedRevision, commandId, ops, by, brief }) {
      const earlier = await store.applied({ id, commandId, request: ops });
      if (earlier) return { status: "already-applied", ...present(earlier, { brief }) };
      const cur = await store.read(id);
      const flow = applyOps(cur.flow, ops);
      const r = await store.edit({ id, commandId, expectedRevision, flow, request: ops, by });
      return { status: r.status, ...present(r.flow, { brief }) };
    },
    async undo({ id, commandId, undoCommandId, by, brief }) {
      const r = await store.undo({ id, commandId, undoCommandId, by });
      return { status: r.status, ...present(r.flow, { brief }) };
    },
    // Runs what is stale. One run per flow at a time. The results are kept only if the graph did not change meanwhile.
    async run({ id, signal = null, brief = false }) {
      if (running.has(id)) throw new FlowError("this flow is already running", "busy");
      const cur = await store.read(id);
      const checked = validateFlow(cur.flow, registry);
      if (!checked.ok) throw new FlowError("the flow cannot run: " + checked.errors.slice(0, 3).map((e) => e.path + " " + e.message).join("; "), "invalid", { errors: checked.errors.slice(0, 20) });
      running.set(id, true);
      try {
        const out = await runFlow({ flow: cur.flow, router, registry, state: cur.results, signal, now });
        const saved = await store.saveResults({ id, revision: cur.revision, results: out.state });
        const f = await store.read(id);
        return { ok: out.ok, ran: out.ran, reused: out.reused, failed: out.failed, blocked: out.blocked, cancelled: out.cancelled, resultsKept: saved.status === "saved", ...present(f, { brief }) };
      } finally { running.delete(id); }
    },
  };
}
