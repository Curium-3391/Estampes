// 5B-2b-1: the coordinator applies the derived-binding rules to one canvas.
// Objects are written with the real scene operations; the "module" is a plain
// function, so nothing here depends on a particular producer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applySceneOps } from "../src/scene/scene-ops.js";
import { register, sourceChanged, reconcile, refreshStale, act, bindingsOf, targetInfo, MAX_DERIVED_PER_CANVAS } from "../src/documents/derived-coordinator.js";
import { bindingHash, objectContentHash } from "../src/documents/derived-binding.js";
import { derivedFromCanvas } from "../src/documents/derived-binding.js";

const HASH = "c".repeat(64);
const MOD = { author: "module", module: "com.example.demo.producer", moduleVersion: "1.0.0" };
const newEntry = () => ({ imageId: "img:0123456789abcdef", width: 100, height: 100 });
const range = (n) => ({ xRange: [-n, n], yRange: [-n, n] });
const make = (entry, n = 1) => applySceneOps(entry, [{ op: "object.create", type: "axes-2d", props: range(n) }], MOD).created[0];
const SOURCE = (ref = "ref-1") => ({ module: "com.example.demo.producer", capability: "make", sourceRef: ref, sourceRevision: 1, inputsHash: HASH });
// A producer that rewrites the object the way a module would.
const producer = (entry, n, counter = { calls: 0 }) => async (binding) => {
  counter.calls++;
  applySceneOps(entry, [{ op: "object.update", id: binding.target.id, props: range(n) }], MOD);
  return { sourceRevision: binding.source.sourceRevision + 1 };
};
const userEdit = (entry, id) => applySceneOps(entry, [{ op: "object.update", id, props: range(7) }], { author: "user" });
function staleOne(n = 1) {
  const entry = newEntry(), id = make(entry);
  const b = register(entry, { source: SOURCE(), objectId: id });
  sourceChanged(entry, { module: MOD.module });
  return { entry, id, b };
}

test("registering records a fresh binding in the canvas's short form, readable by the document mapper", () => {
  const entry = newEntry(), id = make(entry);
  const b = register(entry, { source: SOURCE(), objectId: id });
  assert.equal(b.state, "fresh");
  assert.deepEqual(b.target, { id });
  assert.equal(b.lastApplied.contentHash, objectContentHash(entry.objects.get(id)));
  assert.equal(b.lastApplied.objectRevision, entry.objects.get(id).revision);
  assert.ok(derivedFromCanvas(b, { documentId: "doc:00000000-0000-4000-8000-000000000001", sceneId: "scene:00000000-0000-4000-8000-000000000002" }));
  assert.deepEqual(entry.derived, [b]);
});

test("registering refuses an object that is not there, one that is already bound, and too many", () => {
  const entry = newEntry(), id = make(entry);
  assert.throws(() => register(entry, { source: SOURCE(), objectId: "o99" }), { code: "INVALID" });
  register(entry, { source: SOURCE(), objectId: id });
  assert.throws(() => register(entry, { source: SOURCE(), objectId: id }), { code: "INVALID" });
  const many = newEntry();
  for (let i = 0; i < MAX_DERIVED_PER_CANVAS; i++) register(many, { source: SOURCE("r" + i), objectId: make(many) });
  assert.throws(() => register(many, { source: SOURCE("one-more"), objectId: make(many) }), { code: "LIMIT" });
  assert.equal(many.derived.length, MAX_DERIVED_PER_CANVAS);
});

test("text from a module is cleaned and cut before it is stored", () => {
  const entry = newEntry(), id = make(entry);
  const b = register(entry, { source: SOURCE("a\u0000b\u202ec\n" + "x".repeat(500)), objectId: id });
  assert.ok(b.source.sourceRef.length <= 200);
  assert.doesNotMatch(b.source.sourceRef, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
});

test("a source change marks only the matching bindings stale", () => {
  const entry = newEntry();
  const a = register(entry, { source: SOURCE("a"), objectId: make(entry) });
  const b = register(entry, { source: { ...SOURCE("b"), module: "com.example.other.producer" }, objectId: make(entry) });
  assert.deepEqual(sourceChanged(entry, { module: "com.example.demo.producer", sourceRef: "a" }), [a.id]);
  assert.deepEqual(entry.derived.map((x) => x.state), ["stale", "fresh"]);
  assert.deepEqual(sourceChanged(entry, { module: "com.example.demo.producer", sourceRef: "a" }), [], "already stale: nothing changes");
  assert.equal(entry.derived[1].id, b.id);
});

test("refreshing a stale binding whose object is untouched rewrites it and records what was written", async () => {
  const { entry, id } = staleOne();
  const calls = { calls: 0 };
  const out = await refreshStale(entry, { produce: producer(entry, 5, calls) });
  assert.deepEqual([out.refreshed.length, out.paused.length, out.failed.length, out.removed.length, out.remaining], [1, 0, 0, 0, 0]);
  const [b] = bindingsOf(entry), o = entry.objects.get(id);
  assert.equal(b.state, "fresh");
  assert.deepEqual(o.props.xRange, [-5, 5]);
  assert.equal(b.lastApplied.objectRevision, o.revision);
  assert.equal(b.lastApplied.contentHash, objectContentHash(o));
  assert.equal(b.source.sourceRevision, 2);
  // A second refresh has nothing to do.
  assert.equal((await refreshStale(entry, { produce: producer(entry, 9, calls) })).refreshed.length, 0);
  assert.equal(calls.calls, 1);
});

test("an object the user edited is not overwritten: the binding pauses with a reason", async () => {
  const { entry, id } = staleOne();
  userEdit(entry, id);
  assert.equal(targetInfo(entry, bindingsOf(entry)[0]).editedByUser, true);
  const calls = { calls: 0 };
  const out = await refreshStale(entry, { produce: producer(entry, 5, calls) });
  assert.equal(out.paused.length, 1);
  assert.match(out.paused[0].reason, /edited by a person/);
  assert.equal(calls.calls, 0, "the module was not even asked");
  assert.deepEqual(entry.objects.get(id).props.xRange, [-7, 7], "the person's edit is intact");
  assert.equal(bindingsOf(entry)[0].state, "conflict");
  // It stays paused on every later refresh.
  sourceChanged(entry, { module: MOD.module });
  const again = await refreshStale(entry, { produce: producer(entry, 5, calls) });
  assert.deepEqual([again.refreshed.length, again.paused.length, again.failed.length, again.removed.length], [0, 0, 0, 0], "a paused binding is left alone, not re-examined");
  assert.equal(bindingsOf(entry)[0].state, "conflict");
  assert.equal(calls.calls, 0);
});

test("an object changed by any other route since the module wrote it also pauses", async () => {
  const { entry, id } = staleOne();
  applySceneOps(entry, [{ op: "object.update", id, props: range(3) }], MOD);  // the same module, by some other route
  const out = await refreshStale(entry, { produce: producer(entry, 5) });
  assert.equal(out.paused.length, 1);
  assert.match(out.paused[0].reason, /changed after/);
  assert.equal(bindingsOf(entry)[0].state, "conflict");
});

test("an object that is gone is reported as removed, with or without a refresh", async () => {
  const { entry, id } = staleOne();
  applySceneOps(entry, [{ op: "object.delete", id }], { author: "user" });
  const calls = { calls: 0 };
  const out = await refreshStale(entry, { produce: producer(entry, 5, calls) });
  assert.equal(out.removed.length, 1);
  assert.equal(calls.calls, 0);
  assert.equal(bindingsOf(entry)[0].state, "removed");

  const other = newEntry(), oid = make(other);
  register(other, { source: SOURCE(), objectId: oid });
  applySceneOps(other, [{ op: "object.delete", id: oid }], { author: "user" });
  assert.deepEqual(reconcile(other), [bindingsOf(other)[0].id]);
  assert.equal(bindingsOf(other)[0].state, "removed");
  assert.deepEqual(reconcile(other), [], "reconciling again changes nothing");
});

test("a producer that fails leaves the binding in error with a clean reason, and a later refresh can succeed", async () => {
  const { entry, id } = staleOne();
  const out = await refreshStale(entry, { produce: async () => { throw new Error("boom\u0000 " + "x".repeat(600)); } });
  assert.equal(out.failed.length, 1);
  const [b] = bindingsOf(entry);
  assert.equal(b.state, "error");
  assert.ok(b.reason.length <= 300 && !b.reason.includes("\u0000"));
  assert.deepEqual(entry.objects.get(id).props.xRange, [-1, 1]);
  // error -> a plain refresh through the action.
  const r = await act(entry, b.id, "refresh", { expectedBindingHash: bindingHash(withDoc(b)), produce: producer(entry, 4) });
  assert.equal(r.outcome, "refreshed");
  assert.equal(bindingsOf(entry)[0].state, "fresh");
});

test("one call refreshes a bounded number and reports the rest", async () => {
  const entry = newEntry();
  for (let i = 0; i < 25; i++) register(entry, { source: SOURCE("r" + i), objectId: make(entry) });
  sourceChanged(entry, { module: MOD.module });
  const calls = { calls: 0 };
  const first = await refreshStale(entry, { produce: producer(entry, 2, calls) });
  assert.deepEqual([first.refreshed.length, first.remaining], [20, 5]);
  assert.equal(entry.derived.filter((b) => b.state === "stale").length, 5, "none was dropped");
  const second = await refreshStale(entry, { produce: producer(entry, 2, calls) });
  assert.deepEqual([second.refreshed.length, second.remaining], [5, 0]);
  assert.equal(calls.calls, 25);
});

test("the person's choices: overwrite, fork, detach and reattach, each with the hash they read", async () => {
  const hashOf = (entry, id) => bindingHash(withDoc(bindingsOf(entry).find((b) => b.id === id)));
  // overwrite
  let { entry, id } = staleOne(); userEdit(entry, id); await refreshStale(entry, { produce: producer(entry, 5) });
  const bid = bindingsOf(entry)[0].id;
  await assert.rejects(act(entry, bid, "refresh", { expectedBindingHash: hashOf(entry, bid), produce: producer(entry, 5) }), { code: "ILLEGAL_ACTION" });
  await assert.rejects(act(entry, bid, "overwrite", { expectedBindingHash: "0".repeat(64), produce: producer(entry, 5) }), { code: "STALE_BINDING" });
  assert.deepEqual(entry.objects.get(id).props.xRange, [-7, 7], "refused actions change nothing");
  const done = await act(entry, bid, "overwrite", { expectedBindingHash: hashOf(entry, bid), produce: producer(entry, 5) });
  assert.equal(done.outcome, "refreshed");
  assert.deepEqual(entry.objects.get(id).props.xRange, [-5, 5]);
  assert.equal(bindingsOf(entry)[0].state, "fresh");

  // fork keeps the object and removes the binding
  ({ entry, id } = staleOne()); userEdit(entry, id); await refreshStale(entry, { produce: producer(entry, 5) });
  const fid = bindingsOf(entry)[0].id;
  const forked = await act(entry, fid, "fork", { expectedBindingHash: hashOf(entry, fid) });
  assert.deepEqual([forked.outcome, forked.fork, bindingsOf(entry).length], ["forked", true, 0]);
  assert.deepEqual(entry.objects.get(id).props.xRange, [-7, 7]);

  // detach from any state
  ({ entry, id } = staleOne());
  const did = bindingsOf(entry)[0].id;
  assert.equal((await act(entry, did, "detach", { expectedBindingHash: hashOf(entry, did) })).outcome, "detached");
  assert.equal(entry.derived.length, 0);
  assert.ok(entry.objects.has(id));

  // reattach a removed binding to another object
  ({ entry, id } = staleOne());
  applySceneOps(entry, [{ op: "object.delete", id }], { author: "user" });
  await refreshStale(entry, { produce: producer(entry, 5) });
  const rid = bindingsOf(entry)[0].id, other = make(entry, 3);
  await assert.rejects(act(entry, rid, "reattach", { expectedBindingHash: hashOf(entry, rid), target: { id: "o99" } }), { code: "INVALID" });
  const re = await act(entry, rid, "reattach", { expectedBindingHash: hashOf(entry, rid), target: { id: other } });
  assert.equal(re.outcome, "reattached");
  assert.deepEqual([bindingsOf(entry)[0].state, bindingsOf(entry)[0].target.id], ["stale", other]);
  await assert.rejects(act(entry, "bind:00000000-0000-4000-8000-000000000000", "detach", { expectedBindingHash: "0".repeat(64) }), { code: "NOT_FOUND" });
});

test("two different producers use the same rules, and the coordinator names no module or object type", async () => {
  const entry = newEntry();
  const a = register(entry, { source: SOURCE("a"), objectId: make(entry) });
  const b = register(entry, { source: { ...SOURCE("b"), module: "com.example.second.producer", capability: "other_thing" }, objectId: make(entry) });
  sourceChanged(entry, { module: "com.example.second.producer" });
  assert.deepEqual(entry.derived.map((x) => x.state), ["fresh", "stale"]);
  userEdit(entry, b.target.id);
  const out = await refreshStale(entry, { produce: producer(entry, 6) });
  assert.deepEqual([out.paused.length, out.refreshed.length], [1, 0]);
  assert.equal(entry.derived.find((x) => x.id === a.id).state, "fresh");
  const text = readFileSync(new URL("../src/documents/derived-coordinator.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  for (const word of ["org.estampes", "cas-plot", "function-plot", "axes-2d", "notebook", "Graph"]) assert.ok(!text.includes(word), word);
});

// The core's document form of a binding (what the hash is taken over).
function withDoc(b) { return { ...b, target: { documentId: "doc:00000000-0000-4000-8000-000000000000", sceneId: "scene:00000000-0000-4000-8000-000000000000", kind: "object", id: b.target.id } }; }
