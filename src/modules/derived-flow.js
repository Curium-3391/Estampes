// What the two derived-binding tools do (UVA 5B-2b-2): read the bindings of a
// document, and carry out a choice on them. The rules are the coordinator's
// (src/documents/derived-coordinator.js); this file connects them to the modules
// (a refresh is a call to the refresh capability the module declared) and to the
// saved canvas. It names no module and no object type.
import { reconcile, refreshStale, act, bindingsOf, bindingHashOf } from "../documents/derived-coordinator.js";

// Bounds on what a tool answers: a canvas holds at most 100 bindings, and each row is short.
const REASON_CHARS = 200;
const MAX_ROWS = 50;
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export class DerivedFlowError extends Error {
  constructor(message, code = "invalid") { super(message); this.code = code; }
}

// router: from createRouter; registry: the module registry; canvases: { ensure, save }.
export function createDerivedFlow({ router, registry, canvases, index = null }) {
  const running = new Set();      // canvases with a refresh in progress
  const queue = new Map();        // one change at a time per canvas
  const serial = (key, job) => {
    const next = (queue.get(key) ?? Promise.resolve()).then(job, job);
    queue.set(key, next.catch(() => {}));
    return next;
  };
  const available = (id) => registry.get(id)?.record.state === "enabled";
  const row = (b) => ({ id: b.id, state: b.state, ...(b.reason ? { reason: clean(b.reason, REASON_CHARS) } : {}), object: b.target.id,
    module: b.source.module, capability: b.source.capability, sourceRevision: b.source.sourceRevision, bindingHash: bindingHashOf(b) });

  // Brings the bindings in line with the canvas and the modules. Reading does not save: the next save carries it, and a reopen recomputes it.
  async function open(imageId) {
    const entry = await canvases.ensure(imageId);
    reconcile(entry, { available, interrupted: !running.has(imageId) });
    for (const b of bindingsOf(entry)) if (b.state !== "removed") index?.add(b.source.module, imageId);
    return entry;
  }
  // Bindings that need attention first; at most MAX_ROWS rows, with the count of those left out.
  const rows = (list) => {
    const sorted = [...list].sort((a, b) => (a.state === "fresh") - (b.state === "fresh"));
    return { bindings: sorted.slice(0, MAX_ROWS).map(row), ...(list.length > MAX_ROWS ? { omitted: list.length - MAX_ROWS } : {}) };
  };

  // The module's declared way to recompute one of its objects.
  const producer = (imageId) => async (b) => {
    const mod = registry.get(b.source.module);
    const refresh = mod?.manifest.v2?.derives?.[b.source.capability];
    if (!mod || mod.record.state !== "enabled") throw new DerivedFlowError("the module " + b.source.module + " is not enabled", "unavailable");
    if (!refresh) throw new DerivedFlowError(b.source.module + " no longer declares how to refresh " + b.source.capability, "unavailable");
    const run = await router.execute({ module: b.source.module, capability: refresh, canvas: imageId,
      params: { sourceRef: b.source.sourceRef, object: b.target.id }, internal: { refreshObject: b.target.id } });
    const rev = run.data?.sourceRevision;
    if (!Number.isInteger(rev) || rev < 1) throw new DerivedFlowError(refresh + " did not return data.sourceRevision", "output");
    return { sourceRevision: rev };
  };

  return {
    async list(imageId) {
      return serial(imageId, async () => {
        const entry = await open(imageId);
        const list = bindingsOf(entry);
        const counts = {};
        for (const b of list) counts[b.state] = (counts[b.state] ?? 0) + 1;
        return { canvas: imageId, total: list.length, counts, ...rows(list) };
      });
    },

    // action: refresh-stale (all stale, bounded) or one of refresh, overwrite, fork, detach, reattach on one binding.
    async update({ canvas: imageId, action, binding, expectedBindingHash, target }) {
      return serial(imageId, async () => {
        const entry = await open(imageId);
        running.add(imageId);
        try {
          let result;
          if (action === "refresh-stale") {
            result = await refreshStale(entry, { produce: producer(imageId) });
          } else {
            if (!binding) throw new DerivedFlowError(action + " needs a binding id");
            result = await act(entry, binding, action, { expectedBindingHash, target, produce: producer(imageId) });
          }
          await canvases.save(entry, { tool: "update_derived", author: "assistant", note: action });
          return { canvas: imageId, action, result, total: bindingsOf(entry).length, ...rows(bindingsOf(entry)) };
        } finally { running.delete(imageId); }
      });
    },
  };
}
