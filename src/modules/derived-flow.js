// What the two derived-binding tools do (UVA 5B-2b-2): read the bindings of a
// document, and carry out a choice on them. The rules are the coordinator's
// (src/documents/derived-coordinator.js); this file connects them to the modules
// (a refresh is a call to the refresh capability the module declared) and to the
// saved canvas. It names no module and no object type.
import { randomBytes } from "node:crypto";
import { reconcile, refreshStale, act, bindingsOf, bindingHashOf, targetInfo } from "../documents/derived-coordinator.js";

// Bounds on what a tool answers: a canvas holds at most 100 bindings, and each row is short.
const REASON_CHARS = 200;
const MAX_ROWS = 50;
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

// A preview must come before an overwrite (UVA 5B-3): a one-time token, kept in
// memory only (a restart means previewing again), tied to the binding as it was
// read and to the object's revision. It proves a preview was made for this state;
// it does not prove who asked for the overwrite.
const PREVIEW_TTL_MS = 10 * 60 * 1000, MAX_PREVIEWS = 200, OPS_CHARS = 3000, PROPS_CHARS = 1500;

export class DerivedFlowError extends Error {
  constructor(message, code = "invalid") { super(message); this.code = code; }
}

// router: from createRouter; registry: the module registry; canvases: { ensure, save }.
// state: the previews, running refreshes and queues. One server may build this flow
// again for every connection, so the host keeps the state and hands the same one in.
export const newDerivedState = () => ({ previews: new Map(), running: new Set(), queue: new Map(), adopted: new Set() });
export function createDerivedFlow({ router, registry, canvases, index = null, state = newDerivedState() }) {
  const { running, queue } = state;   // running: canvases with a refresh in progress; queue: one change at a time per canvas
  const serial = (key, job) => {
    const next = (queue.get(key) ?? Promise.resolve()).then(job, job);
    queue.set(key, next.catch(() => {}));
    return next;
  };
  const { previews } = state;         // token -> { canvas, binding, hash, revision, until }
  const issue = (t) => {
    const now = Date.now();
    for (const [k, v] of previews) if (v.until < now) previews.delete(k);
    while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value);
    const token = randomBytes(16).toString("hex");
    previews.set(token, { ...t, until: now + PREVIEW_TTL_MS });
    return token;
  };
  const consume = (token, want) => {
    const t = token ? previews.get(token) : null;
    previews.delete(token);
    if (!t || t.until < Date.now() || t.canvas !== want.canvas || t.binding !== want.binding || t.hash !== want.hash || t.revision !== want.revision) {
      throw new DerivedFlowError("overwrite needs a fresh preview of this binding as it is now: run preview, show it to the person, then overwrite with its previewToken", "preview-required");
    }
  };
  const available = (id) => registry.get(id)?.record.state === "enabled";
  const row = (b) => ({ id: b.id, state: b.state, ...(b.reason ? { reason: clean(b.reason, REASON_CHARS) } : {}), object: b.target.id,
    module: b.source.module, capability: b.source.capability, sourceRevision: b.source.sourceRevision, bindingHash: bindingHashOf(b) });

  // Brings the bindings in line with the canvas and the modules. Reading does not save: the next save carries it, and a reopen recomputes it.
  // Objects a module made before bindings existed: the first time a document is opened here, each enabled module that declares an
  // adopt capability is asked which of its objects on the document should be bound (5B-4). It is idempotent, so a repeat or a crash
  // in the middle costs nothing; a failure leaves the document as it is and is tried again next time.
  async function adopt(imageId) {
    for (const mod of registry.list?.() ?? []) {
      const adoptions = mod?.manifest?.v2?.adopt;
      if (!adoptions || mod.record?.state !== "enabled") continue;
      for (const [producer, capability] of Object.entries(adoptions)) {
        const key = imageId + "|" + mod.manifest.id + "|" + mod.manifest.version + "|" + producer;
        if (state.adopted.has(key)) continue;
        try {
          await router.execute({ module: mod.manifest.id, capability, canvas: imageId, params: { canvas: imageId }, internal: { adopt: producer } });
          state.adopted.add(key);
        } catch { /* tried again the next time the document is opened */ }
      }
    }
  }
  async function open(imageId) {
    await adopt(imageId);
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
  const call = (imageId, b, internal) => {
    const mod = registry.get(b.source.module);
    const refresh = mod?.manifest.v2?.derives?.[b.source.capability];
    if (!mod || mod.record.state !== "enabled") throw new DerivedFlowError("the module " + b.source.module + " is not enabled", "unavailable");
    if (!refresh) throw new DerivedFlowError(b.source.module + " no longer declares how to refresh " + b.source.capability, "unavailable");
    return router.execute({ module: b.source.module, capability: refresh, canvas: imageId, params: { sourceRef: b.source.sourceRef, object: b.target.id }, internal: { refreshObject: b.target.id, ...internal } });
  };
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
    async update({ canvas: imageId, action, binding, expectedBindingHash, target, previewToken }) {
      return serial(imageId, async () => {
        const entry = await open(imageId);
        running.add(imageId);
        try {
          let result;
          if (action === "preview") {
            if (!binding) throw new DerivedFlowError("preview needs a binding id");
            const b = bindingsOf(entry).find((x) => x.id === binding);
            if (!b) throw new DerivedFlowError("No such binding on this canvas", "not-found");
            if (!["stale", "conflict", "error"].includes(b.state)) throw new DerivedFlowError("there is nothing to preview for a " + b.state + " binding");
            const run = await call(imageId, b, { dryRun: true });
            const info = targetInfo(entry, b);
            const obj = entry.objects?.get?.(b.target.id);
            const previewToken = issue({ canvas: imageId, binding: b.id, hash: bindingHashOf(b), revision: obj?.revision });
            result = { outcome: "preview", previewToken, expiresInSeconds: PREVIEW_TTL_MS / 1000, wouldWrite: clean(JSON.stringify(run.preview?.operations ?? []), OPS_CHARS),
              current: clean(JSON.stringify(obj?.props ?? {}), PROPS_CHARS), editedByPerson: info?.editedByUser === true,
              note: "nothing was changed in the document; the module may have recomputed its own source. overwrite replaces the object with what the module writes when you run it" };
            return { canvas: imageId, action, result, total: bindingsOf(entry).length, ...rows(bindingsOf(entry)) };
          }
          if (action === "overwrite") {
            const b = bindingsOf(entry).find((x) => x.id === binding);
            if (b) consume(previewToken, { canvas: imageId, binding: b.id, hash: bindingHashOf(b), revision: entry.objects?.get?.(b.target.id)?.revision });
          }
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
