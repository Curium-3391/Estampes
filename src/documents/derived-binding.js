// UVA Phase 5B-1: the `derived` binding, the generic record that says "this
// object in a document was made by a module capability from a source that can
// change, and may be refreshed from it". It replaces the CAS-only `cas-plot`
// kind (which nothing ever wrote) so that any module can be a producer.
//
// This file is pure: it knows no module names and no object types. The state
// machine, the pause-on-user-edit rule (OD-05) and the expectedBindingHash
// check live here, in the core, so every producer gets them the same way. A
// module only supplies an opaque `sourceRef`, which the core stores and never
// parses.
import { z } from "zod";
import { BindingIdSchema } from "./identity.js";
import { ObjectRefSchema } from "./references.js";
import { RevisionSchema, ContentHashSchema, hashJson } from "./validation.js";

export const DERIVED_VERSION = 1;
export const DERIVED_STATES = Object.freeze(["fresh", "stale", "recomputing", "conflict", "removed", "unavailable", "unresolved", "error"]);
// What the person (or the model on their behalf) can ask for. The set is closed: an unknown action is refused.
export const DERIVED_ACTIONS = Object.freeze(["refresh", "detach", "overwrite", "fork", "reattach"]);
// What the system reports about a binding.
export const DERIVED_EVENTS = Object.freeze(["sourceChanged", "refreshStarted", "refreshSucceeded", "refreshFailed", "refreshPaused", "targetRemoved", "referenceUnresolved", "moduleUnavailable", "moduleAvailable"]);

const MODULE_ID = /^[a-z][a-z0-9-]{0,30}(\.[a-z0-9][a-z0-9-]{0,30}){2,5}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9_]{0,47}$/;
const NO_CONTROL = (s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
const Text = (max) => z.string().max(max).refine(NO_CONTROL, "control characters are not allowed");

export const DerivedBindingSchema = z.object({
  id: BindingIdSchema, kind: z.literal("derived"), version: z.literal(DERIVED_VERSION),
  // The producer. `sourceRef` belongs to the module; the core keeps it as text and never reads inside it.
  source: z.object({ module: z.string().regex(MODULE_ID), capability: z.string().regex(CAPABILITY_ID), sourceRef: Text(200).min(1),
    sourceRevision: RevisionSchema, inputsHash: ContentHashSchema }).strict(),
  target: ObjectRefSchema,
  // What the module last wrote, so a later edit by anyone else can be told apart from it.
  lastApplied: z.object({ objectRevision: RevisionSchema, contentHash: ContentHashSchema, sourceRevision: RevisionSchema }).strict(),
  policy: z.literal("pause-on-user-edit"),
  state: z.enum(DERIVED_STATES), reason: Text(300).optional(),
}).strict();

export class DerivedBindingError extends Error {
  constructor(code, message) { super(message); this.name = "DerivedBindingError"; this.code = code; }
}

// ---- state machine ------------------------------------------------------

// Events: [from states] -> to. An event from any other state is an illegal transition.
const ANY_LIVE = ["fresh", "stale", "recomputing", "conflict", "error"];
const EVENTS = {
  sourceChanged: { from: ["fresh"], to: "stale", keep: DERIVED_STATES.filter((s) => s !== "fresh") },
  refreshStarted: { from: ["fresh", "stale", "error"], to: "recomputing" },
  refreshSucceeded: { from: ["recomputing"], to: "fresh" },
  refreshFailed: { from: ["recomputing"], to: "error" },
  refreshPaused: { from: ["fresh", "stale", "recomputing", "error"], to: "conflict" },
  targetRemoved: { from: [...ANY_LIVE, "unavailable", "unresolved"], to: "removed" },
  referenceUnresolved: { from: [...ANY_LIVE, "unavailable"], to: "unresolved" },
  moduleUnavailable: { from: ANY_LIVE, to: "unavailable" },
  moduleAvailable: { from: ["unavailable"], to: "stale" },
};

// Returns a new binding. `keep` lists states in which the event is a no-op (the binding is already "at least that stale").
export function reduce(binding, event, { reason, lastApplied, sourceRef, sourceRevision, inputsHash } = {}) {
  const rule = EVENTS[event];
  if (!rule) throw new DerivedBindingError("UNKNOWN_EVENT", "Unknown derived binding event " + JSON.stringify(event));
  if (rule.keep?.includes(binding.state)) return structuredClone(binding);
  if (!rule.from.includes(binding.state)) throw new DerivedBindingError("ILLEGAL_TRANSITION", event + " is not allowed while the binding is " + binding.state);
  const next = structuredClone(binding);
  next.state = rule.to;
  if (reason !== undefined) next.reason = String(reason).slice(0, 300); else delete next.reason;
  if (event === "refreshSucceeded") {
    if (!lastApplied) throw new DerivedBindingError("INVALID", "refreshSucceeded needs what was applied");
    next.lastApplied = structuredClone(lastApplied);
    if (sourceRef !== undefined) next.source.sourceRef = sourceRef;
    if (sourceRevision !== undefined) next.source.sourceRevision = sourceRevision;
    if (inputsHash !== undefined) next.source.inputsHash = inputsHash;
  }
  return next;
}

// What the person may do in each state. A cell that is absent is refused.
// `conflict` is the pause: refresh is refused there, and only an explicit
// resolution (overwrite, fork, detach) moves on.
const ACTIONS = {
  refresh: { fresh: "recomputing", stale: "recomputing", error: "recomputing" },
  overwrite: { conflict: "recomputing" },
  fork: { conflict: REMOVE(), stale: REMOVE(), error: REMOVE() },
  reattach: { removed: "stale", unresolved: "stale" },
  detach: Object.fromEntries(DERIVED_STATES.map((s) => [s, REMOVE()])),
};
function REMOVE() { return { remove: true }; }

// Applies a user action. The result is either a new binding (`binding`) or, for
// detach and fork, the order to delete it (`remove`). `fork` also says the
// caller must create a new binding for a new object (`fork: true`); the
// original object is left exactly as it is.
export function applyAction(binding, action, { expectedBindingHash, target } = {}) {
  if (!DERIVED_ACTIONS.includes(action)) throw new DerivedBindingError("UNKNOWN_ACTION", "Unknown derived binding action " + JSON.stringify(action));
  if (expectedBindingHash === undefined || expectedBindingHash !== bindingHash(binding)) {
    throw new DerivedBindingError("STALE_BINDING", "The binding changed since it was read; read it again");
  }
  const cell = ACTIONS[action][binding.state];
  if (cell === undefined) {
    const hint = binding.state === "conflict" ? "; the object was edited, resolve it with overwrite, fork or detach" : "";
    throw new DerivedBindingError("ILLEGAL_ACTION", action + " is not allowed while the binding is " + binding.state + hint);
  }
  if (action === "reattach") {
    if (!target) throw new DerivedBindingError("INVALID", "reattach needs the object to attach to");
    const next = structuredClone(binding);
    next.target = ObjectRefSchema.parse(target); next.state = "stale"; delete next.reason;
    return { binding: next };
  }
  if (cell.remove) return { remove: true, ...(action === "fork" ? { fork: true } : {}) };
  const next = structuredClone(binding);
  next.state = cell; delete next.reason;
  return { binding: next };
}

// ---- conflict detection (OD-05) -------------------------------------------

// The hash of what the module writes into an object, so an unrelated change such as moving the object between layers is not an edit.
export const objectContentHash = (object) => hashJson({ type: object.type, props: object.props });

export const bindingHash = (binding) => hashJson(binding);

// Decides whether a refresh may overwrite the target. `target` is
// { revision, contentHash, editedByUser } or null when the object is gone.
export function evaluateRefresh(binding, target) {
  if (!target) return { proceed: false, event: "targetRemoved", reason: "the object no longer exists" };
  const edited = target.editedByUser === true;
  const moved = target.revision !== binding.lastApplied.objectRevision || target.contentHash !== binding.lastApplied.contentHash;
  if (edited || moved) {
    return { proceed: false, event: "refreshPaused", reason: edited ? "the object was edited by a person after it was last updated from its source" : "the object changed after it was last updated from its source" };
  }
  return { proceed: true };
}

// ---- canvas-local form -------------------------------------------------------

// A canvas record names its own objects by id only; the document form adds the
// document and scene the object lives in. These two functions are the whole
// difference, so a binding round-trips through the canvas unchanged.
export function derivedFromCanvas(local, { documentId, sceneId }) {
  if (!local || typeof local !== "object" || Array.isArray(local) || !local.target || typeof local.target !== "object") return null;
  const candidate = { ...local, target: { documentId, sceneId, kind: "object", id: local.target.id } };
  const parsed = DerivedBindingSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function derivedToCanvas(binding) {
  const { target, ...rest } = structuredClone(binding);
  return { ...rest, target: { id: target.id } };
}
