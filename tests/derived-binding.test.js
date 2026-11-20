// UVA Phase 5B-1: the generic `derived` binding (src/documents/derived-binding.js).
// The module knows no producer: these tests use a CAS-looking reference and a
// made-up one side by side, and walk the full state x event and state x action
// tables, because a binding record outlives the build that wrote it.
import test from "node:test";
import assert from "node:assert/strict";
import { populated, id, HASH } from "./fixtures/uva-pr1a.mjs";
import { VisualDocumentSchema, parseVisualDocument } from "../src/documents/schema.js";
import { validateDocumentReferences } from "../src/documents/integrity.js";
import { DerivedBindingSchema, DERIVED_STATES, DERIVED_ACTIONS, DERIVED_EVENTS, reduce, applyAction, bindingHash, evaluateRefresh, objectContentHash, DerivedBindingError } from "../src/documents/derived-binding.js";

const H2 = "b".repeat(64);
const binding = (state = "fresh", over = {}) => {
  const d = populated(), s = d.scenes[0];
  return { id: id("bind"), kind: "derived", version: 1,
    source: { module: "org.example.producer", capability: "make_plot", sourceRef: "item:42", sourceRevision: 3, inputsHash: HASH },
    target: { documentId: d.id, sceneId: s.id, kind: "object", id: "o1" },
    lastApplied: { objectRevision: 1, contentHash: H2, sourceRevision: 3 }, policy: "pause-on-user-edit", state, ...over };
};
const docWith = (b) => { const d = populated(); d.bindings = [b]; b.target = { documentId: d.id, sceneId: d.defaultSceneId, kind: "object", id: "o1" }; return d; };
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof DerivedBindingError && e.code === code, code);

test("schema: accepts any producer; the source reference is opaque", () => {
  for (const sourceRef of ["item:42", "nb:0123456789ab#cell:0123456789ab", "x".repeat(200), "语 ref"]) {
    const b = binding("fresh"); b.source.sourceRef = sourceRef;
    assert.ok(DerivedBindingSchema.safeParse(b).success, sourceRef.slice(0, 20));
  }
  for (const state of DERIVED_STATES) assert.ok(DerivedBindingSchema.safeParse(binding(state)).success, state);
});

test("schema: closed, bounded, no control characters", () => {
  const bad = [
    (b) => { b.extra = 1; }, (b) => { b.version = 2; }, (b) => { b.kind = "cas-plot"; }, (b) => { b.policy = "overwrite"; }, (b) => { b.state = "done"; },
    (b) => { b.source.module = "Not A Module"; }, (b) => { b.source.capability = "Bad-Cap"; }, (b) => { b.source.sourceRef = ""; }, (b) => { b.source.sourceRef = "x".repeat(201); },
    (b) => { b.source.sourceRef = "a\u0000b"; }, (b) => { b.reason = "x".repeat(301); }, (b) => { b.reason = "a\u0007b"; }, (b) => { b.source.inputsHash = "abc"; },
    (b) => { b.lastApplied.objectRevision = 0; }, (b) => { b.lastApplied.extra = 1; }, (b) => { b.source.extra = 1; }, (b) => { delete b.target; }, (b) => { b.id = "bind:short"; },
  ];
  bad.forEach((mutate, i) => { const b = binding(); mutate(b); assert.equal(DerivedBindingSchema.safeParse(b).success, false, "case " + i); });
});

test("document: a derived binding parses, a live one needs its target, a removed one may dangle, an unknown kind is refused", () => {
  const live = docWith(binding("fresh"));
  assert.deepEqual(parseVisualDocument(live).bindings[0].state, "fresh");
  const missing = docWith(binding("fresh")); missing.bindings[0].target.id = "o999";
  assert.throws(() => validateDocumentReferences([missing]), (e) => e.code === "UNRESOLVED_REFERENCE");
  for (const state of ["removed", "unavailable", "unresolved"]) {
    const d = docWith(binding(state)); d.bindings[0].target.id = "o999";
    validateDocumentReferences([d]);
  }
  const anyType = docWith(binding("fresh"));
  assert.ok(anyType.scenes[0].objects.every((o) => o.type !== "cas-never"), "the core does not look at the object's type");
  validateDocumentReferences([anyType]);
  const future = docWith(binding("fresh")); future.bindings[0].kind = "derived/2";
  assert.equal(VisualDocumentSchema.safeParse(future).success, false, "a kind this build does not know is refused, not guessed");
  const old = docWith(binding("fresh")); old.bindings[0].kind = "cas-plot";
  assert.equal(VisualDocumentSchema.safeParse(old).success, false, "cas-plot was never written and is gone");
});

// ---- state x event: written out by hand, not derived from the code ----
const EVENT_TABLE = {
  //                   fresh        stale        recomputing  conflict     removed      unavailable  unresolved   error
  sourceChanged:       ["stale",     "stale",     "recomputing", "conflict",  "removed",    "unavailable", "unresolved", "error"],
  refreshStarted:      ["recomputing", "recomputing", null,      null,        null,         null,        null,        "recomputing"],
  refreshSucceeded:    [null,        null,        "fresh",      null,        null,         null,        null,        null],
  refreshFailed:       [null,        null,        "error",      null,        null,         null,        null,        null],
  refreshPaused:       ["conflict",  "conflict",  "conflict",   null,        null,         null,        null,        "conflict"],
  targetRemoved:       ["removed",   "removed",   "removed",    "removed",   null,         "removed",   "removed",   "removed"],
  referenceUnresolved: ["unresolved", "unresolved", "unresolved", "unresolved", null,       "unresolved", null,       "unresolved"],
  moduleUnavailable:   ["unavailable", "unavailable", "unavailable", "unavailable", null,   null,        null,        "unavailable"],
  moduleAvailable:     [null,        null,        null,         null,        null,         "stale",     null,        null],
};
test("state machine: every event in every state, exactly as the table says", () => {
  assert.deepEqual(Object.keys(EVENT_TABLE).sort(), [...DERIVED_EVENTS].sort(), "the table covers every event");
  let cells = 0;
  for (const [event, row] of Object.entries(EVENT_TABLE)) {
    DERIVED_STATES.forEach((state, i) => {
      cells++;
      const before = binding(state); const snapshot = structuredClone(before);
      const extra = event === "refreshSucceeded" ? { lastApplied: { objectRevision: 2, contentHash: H2, sourceRevision: 4 } } : {};
      if (row[i] === null) throwsCode(() => reduce(before, event, extra), "ILLEGAL_TRANSITION");
      else assert.equal(reduce(before, event, extra).state, row[i], event + " from " + state);
      assert.deepEqual(before, snapshot, "the input binding is never mutated");
    });
  }
  assert.equal(cells, DERIVED_EVENTS.length * DERIVED_STATES.length);
  throwsCode(() => reduce(binding(), "explode"), "UNKNOWN_EVENT");
  throwsCode(() => reduce(binding("recomputing"), "refreshSucceeded"), "INVALID");
});

test("events carry their data: success records what was applied, a reason is bounded and cleared on the next change", () => {
  const ok = reduce(binding("recomputing"), "refreshSucceeded", { lastApplied: { objectRevision: 5, contentHash: H2, sourceRevision: 9 }, sourceRevision: 9, sourceRef: "item:43" });
  assert.deepEqual([ok.state, ok.lastApplied.objectRevision, ok.source.sourceRevision, ok.source.sourceRef], ["fresh", 5, 9, "item:43"]);
  assert.ok(DerivedBindingSchema.safeParse(ok).success);
  const err = reduce(binding("recomputing"), "refreshFailed", { reason: "x".repeat(900) });
  assert.equal(err.reason.length, 300);
  assert.equal(reduce(err, "refreshStarted").reason, undefined);
});

// ---- state x action ----
const ACTION_TABLE = {
  //          fresh          stale          recomputing  conflict       removed        unavailable    unresolved     error
  refresh:   ["recomputing", "recomputing", null,        null,          null,          null,          null,          "recomputing"],
  overwrite: [null,          null,          null,        "recomputing", null,          null,          null,          null],
  fork:      [null,          "remove+fork", null,        "remove+fork", null,          null,          null,          "remove+fork"],
  reattach:  [null,          null,          null,        null,          "stale",       null,          "stale",       null],
  detach:    ["remove",      "remove",      "remove",    "remove",      "remove",      "remove",      "remove",      "remove"],
};
test("actions: every action in every state, exactly as the table says; conflict refuses refresh", () => {
  assert.deepEqual(Object.keys(ACTION_TABLE).sort(), [...DERIVED_ACTIONS].sort());
  let cells = 0;
  const target = { documentId: populated().id, sceneId: populated().defaultSceneId, kind: "object", id: "o1" };
  for (const [action, row] of Object.entries(ACTION_TABLE)) {
    DERIVED_STATES.forEach((state, i) => {
      cells++;
      const before = binding(state); const snapshot = structuredClone(before);
      const run = () => applyAction(before, action, { expectedBindingHash: bindingHash(before), target });
      const want = row[i];
      if (want === null) throwsCode(run, "ILLEGAL_ACTION");
      else if (want === "remove") assert.deepEqual(run(), { remove: true }, action + " from " + state);
      else if (want === "remove+fork") assert.deepEqual(run(), { remove: true, fork: true }, action + " from " + state);
      else assert.equal(run().binding.state, want, action + " from " + state);
      assert.deepEqual(before, snapshot, "the input binding is never mutated");
    });
  }
  assert.equal(cells, DERIVED_ACTIONS.length * DERIVED_STATES.length);
  const paused = binding("conflict");
  assert.throws(() => applyAction(paused, "refresh", { expectedBindingHash: bindingHash(paused) }), /resolve it with overwrite, fork or detach/);
});

test("actions: expectedBindingHash is required and must match; unknown actions and a bare reattach are refused", () => {
  const b = binding("conflict");
  throwsCode(() => applyAction(b, "overwrite", {}), "STALE_BINDING");
  throwsCode(() => applyAction(b, "overwrite", { expectedBindingHash: "0".repeat(64) }), "STALE_BINDING");
  const changed = { ...b, reason: "edited" };
  throwsCode(() => applyAction(b, "overwrite", { expectedBindingHash: bindingHash(changed) }), "STALE_BINDING");
  throwsCode(() => applyAction(b, "teleport", { expectedBindingHash: bindingHash(b) }), "UNKNOWN_ACTION");
  const gone = binding("removed");
  throwsCode(() => applyAction(gone, "reattach", { expectedBindingHash: bindingHash(gone) }), "INVALID");
  const target = { documentId: populated().id, sceneId: populated().defaultSceneId, kind: "object", id: "o1" };
  const back = applyAction(gone, "reattach", { expectedBindingHash: bindingHash(gone), target }).binding;
  assert.deepEqual([back.state, back.target.id], ["stale", "o1"]);
  assert.ok(DerivedBindingSchema.safeParse(back).success);
});

test("pause on user edit (OD-05): a refresh may overwrite only what the module itself last wrote", () => {
  const b = binding("stale");
  const clean = { revision: 1, contentHash: H2, editedByUser: false };
  assert.deepEqual(evaluateRefresh(b, clean), { proceed: true });
  const edited = evaluateRefresh(b, { ...clean, editedByUser: true });
  assert.deepEqual([edited.proceed, edited.event], [false, "refreshPaused"]);
  assert.match(edited.reason, /edited by a person/);
  assert.equal(evaluateRefresh(b, { ...clean, revision: 2 }).event, "refreshPaused", "another change to the object counts too");
  assert.equal(evaluateRefresh(b, { ...clean, contentHash: "c".repeat(64) }).event, "refreshPaused");
  assert.deepEqual(evaluateRefresh(b, null), { proceed: false, event: "targetRemoved", reason: "the object no longer exists" });
  assert.equal(reduce(b, evaluateRefresh(b, { ...clean, editedByUser: true }).event, { reason: edited.reason }).state, "conflict");
  assert.equal(objectContentHash({ type: "a", props: { x: 1 } }), objectContentHash({ type: "a", props: { x: 1 }, layerId: "elsewhere" }), "moving an object between layers is not an edit");
  assert.notEqual(objectContentHash({ type: "a", props: { x: 1 } }), objectContentHash({ type: "a", props: { x: 2 } }));
});

test("the core file names no module and no object type", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/documents/derived-binding.js", import.meta.url), "utf8");
  for (const word of ["org.estampes", "cas-plot", "function-plot", "axes-2d", "notebook", "Graph"]) {
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.equal(code.includes(word), false, word + " must not appear in the generic binding code");
  }
});
