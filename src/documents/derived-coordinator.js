// UVA Phase 5B-2b: the coordinator that applies the `derived` binding rules to
// one canvas. It reads and writes `entry.derived` (the canvas's list of
// bindings) and looks at `entry.objects` (what is on the canvas now); it never
// runs a module. The thing that actually recomputes an object is handed in as
// `produce`, so any module that can write an object can be a producer and this
// file stays free of module names and object types.
//
// Nothing here saves the canvas. A caller changes `entry.derived`, then saves
// the canvas the usual way; every function either finishes its change to
// `entry.derived` or leaves it as it was.
import { randomUUID } from "node:crypto";
import { DerivedBindingError, DerivedBindingSchema, bindingHash, applyAction, evaluateRefresh, objectContentHash, reduce } from "./derived-binding.js";

export const MAX_DERIVED_PER_CANVAS = 100;
// Bindings refreshed in one call. The rest are reported in `remaining`, not dropped.
export const REFRESH_BUDGET = 20;

const LIVE = ["fresh", "stale", "recomputing", "conflict", "error"];

export const bindingsOf = (entry) => (Array.isArray(entry.derived) ? entry.derived : []);
const objectOf = (entry, id) => (entry.objects instanceof Map ? entry.objects.get(id) : undefined);
const clean = (s, n = 200) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

// What a refresh needs to know about the object a binding names.
export function targetInfo(entry, binding) {
  const o = objectOf(entry, binding.target.id);
  // The flag is sticky (it records that a person ever edited the object), so it only counts as an edit made after the module's last write.
  return o ? { revision: o.revision, contentHash: objectContentHash(o), editedByUser: o.provenance?.editedByUser === true && o.revision !== binding.lastApplied.objectRevision } : null;
}

function replace(entry, next) {
  entry.derived = bindingsOf(entry).map((b) => (b.id === next.id ? next : b));
  return next;
}

// A module made object `objectId` from `source`. Records the binding as fresh.
export function register(entry, { source, objectId, sourceRevision = source.sourceRevision }) {
  const o = objectOf(entry, objectId);
  if (!o) throw new DerivedBindingError("INVALID", "The object " + objectId + " is not on this canvas");
  if (bindingsOf(entry).some((b) => b.target.id === objectId && LIVE.includes(b.state))) throw new DerivedBindingError("INVALID", "The object " + objectId + " already has a binding");
  if (bindingsOf(entry).length >= MAX_DERIVED_PER_CANVAS) throw new DerivedBindingError("LIMIT", "A canvas holds at most " + MAX_DERIVED_PER_CANVAS + " derived bindings");
  const binding = DerivedBindingSchema.parse({
    id: "bind:" + randomUUID(), kind: "derived", version: 1,
    source: { ...source, sourceRef: clean(source.sourceRef), sourceRevision },
    target: { documentId: "doc:00000000-0000-4000-8000-000000000000", sceneId: "scene:00000000-0000-4000-8000-000000000000", kind: "object", id: objectId },
    lastApplied: { objectRevision: o.revision, contentHash: objectContentHash(o), sourceRevision },
    policy: "pause-on-user-edit", state: "fresh",
  });
  // A canvas names its objects by id only; the placeholders above only satisfy the document schema.
  const local = { ...binding, target: { id: objectId } };
  entry.derived = [...bindingsOf(entry), local];
  return local;
}

// The source of some bindings changed (same module, and the same sourceRef when one is given).
export function sourceChanged(entry, { module, sourceRef }) {
  const touched = [];
  entry.derived = bindingsOf(entry).map((b) => {
    if (b.source.module !== module || (sourceRef !== undefined && b.source.sourceRef !== sourceRef)) return b;
    const next = reduce(withDoc(b), "sourceChanged");
    if (next.state !== b.state) touched.push(b.id);
    return stripDoc(next);
  });
  return touched;
}

// Brings the list in line with the canvas and with the modules:
//  - a binding whose object is gone becomes `removed`;
//  - one whose module is not available becomes `unavailable` (and comes back as
//    `stale` once the module is available again), when `available(moduleId)` is given;
//  - one left `recomputing` by a refresh that never finished (a restart, a kill) becomes
//    `error`, unless `interrupted` is false because a refresh may still be running.
export function reconcile(entry, { available, interrupted = true } = {}) {
  const changed = [];
  entry.derived = bindingsOf(entry).map((b) => {
    const gone = !objectOf(entry, b.target.id);
    let next = null;
    if ((LIVE.includes(b.state) || b.state === "unavailable") && gone) next = reduce(withDoc(b), "targetRemoved", { reason: "the object no longer exists" });
    else if (b.state === "unavailable") { if (available?.(b.source.module)) next = reduce(withDoc(b), "moduleAvailable"); }
    else if (LIVE.includes(b.state) && available && !available(b.source.module)) next = reduce(withDoc(b), "moduleUnavailable", { reason: "the module is not available" });
    else if (b.state === "recomputing" && interrupted) next = reduce(withDoc(b), "refreshFailed", { reason: "the refresh was interrupted" });
    if (!next) return b;
    changed.push(b.id);
    return stripDoc(next);
  });
  return changed;
}

// The core's functions take the document form of a binding (a full object reference); the canvas keeps the short one.
const PLACE = { documentId: "doc:00000000-0000-4000-8000-000000000000", sceneId: "scene:00000000-0000-4000-8000-000000000000", kind: "object" };
const withDoc = (b) => ({ ...b, target: { ...PLACE, id: b.target.id } });
const stripDoc = (b) => ({ ...b, target: { id: b.target.id } });

// Recomputes one binding's object. `produce(binding)` writes the object and
// returns { sourceRevision, sourceRef?, inputsHash? }; when it throws, the
// binding is left in `error` and the object as the module left it.
async function recompute(entry, binding, produce, { force }) {
  let current = withDoc(binding);
  if (!force) {
    const verdict = evaluateRefresh(current, targetInfo(entry, binding));
    if (!verdict.proceed) {
      current = reduce(current, verdict.event, { reason: verdict.reason });
      replace(entry, stripDoc(current));
      return { outcome: verdict.event === "refreshPaused" ? "paused" : "removed", binding: stripDoc(current), reason: verdict.reason };
    }
  }
  if (current.state === "conflict") current = { ...current, state: "stale" };  // a person chose to overwrite
  current = reduce(current, "refreshStarted");
  replace(entry, stripDoc(current));
  let made;
  try { made = await produce(stripDoc(current)); }
  catch (e) {
    current = reduce(current, "refreshFailed", { reason: clean(e?.message ?? e, 300) });
    replace(entry, stripDoc(current));
    return { outcome: "failed", binding: stripDoc(current), reason: current.reason };
  }
  const o = objectOf(entry, binding.target.id);
  if (!o) {
    current = reduce(current, "targetRemoved", { reason: "the object was removed while it was being updated" });
    replace(entry, stripDoc(current));
    return { outcome: "removed", binding: stripDoc(current), reason: current.reason };
  }
  const sourceRevision = made?.sourceRevision ?? current.lastApplied.sourceRevision;
  current = reduce(current, "refreshSucceeded", {
    lastApplied: { objectRevision: o.revision, contentHash: objectContentHash(o), sourceRevision },
    sourceRevision, ...(made?.sourceRef !== undefined ? { sourceRef: clean(made.sourceRef) } : {}), ...(made?.inputsHash !== undefined ? { inputsHash: made.inputsHash } : {}),
  });
  replace(entry, stripDoc(current));
  return { outcome: "refreshed", binding: stripDoc(current) };
}

// Refreshes the stale bindings, a bounded number per call.
export async function refreshStale(entry, { produce, budget = REFRESH_BUDGET }) {
  const out = { refreshed: [], paused: [], failed: [], removed: [], remaining: 0 };
  const todo = bindingsOf(entry).filter((b) => b.state === "stale");
  for (const b of todo.slice(0, budget)) {
    const fresh = bindingsOf(entry).find((x) => x.id === b.id);
    if (!fresh || fresh.state !== "stale") continue;
    const r = await recompute(entry, fresh, produce, { force: false });
    ({ refreshed: out.refreshed, paused: out.paused, failed: out.failed, removed: out.removed })[r.outcome].push({ id: b.id, ...(r.reason ? { reason: r.reason } : {}) });
  }
  out.remaining = Math.max(0, todo.length - budget);
  return out;
}

// What a person asked for. `expectedBindingHash` is the hash of the binding they read.
export async function act(entry, bindingId, action, { expectedBindingHash, produce, target } = {}) {
  const binding = bindingsOf(entry).find((b) => b.id === bindingId);
  if (!binding) throw new DerivedBindingError("NOT_FOUND", "No such binding on this canvas");
  const full = withDoc(binding);
  if (action === "reattach" && target && !objectOf(entry, target.id ?? target)) throw new DerivedBindingError("INVALID", "The object to attach to is not on this canvas");
  const result = applyAction(full, action, { expectedBindingHash, ...(action === "reattach" ? { target: { ...PLACE, id: target?.id ?? target } } : {}) });
  if (result.remove) {
    entry.derived = bindingsOf(entry).filter((b) => b.id !== bindingId);
    return { outcome: result.fork ? "forked" : "detached", binding: null, fork: result.fork === true, source: binding.source };
  }
  if (action === "reattach") { replace(entry, stripDoc(result.binding)); return { outcome: "reattached", binding: stripDoc(result.binding) }; }
  if (typeof produce !== "function") throw new DerivedBindingError("INVALID", action + " needs a way to recompute the object");
  // applyAction only checked that the action is allowed here; recompute does the work from the binding as it was.
  return recompute(entry, binding, produce, { force: action === "overwrite" });
}

// The hash a person must quote to act on a binding.
export const bindingHashOf = (binding) => bindingHash(withDoc(binding));
export { bindingHash };
