import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentStore } from "../src/surface/document-store.js";

const rev = (counter, hash = "h" + counter, epoch = "e1") => ({ epoch, counter, hash });

test("hydrate applies newer, ignores older and duplicate, flags a same-counter conflict", () => {
  const store = createDocumentStore();
  const seen = [];
  store.subscribe("d", (v) => seen.push(v));
  assert.equal(store.hydrate("d", rev(2), { n: 2 }), "applied");
  assert.equal(store.hydrate("d", rev(1), { n: 1 }), "ignored", "older");
  assert.equal(store.hydrate("d", rev(2), { n: 2 }), "ignored", "same revision, same hash");
  assert.equal(store.hydrate("d", rev(2, "other"), { n: "x" }), "conflict");
  assert.deepEqual(store.get("d").snapshot, { n: 2 }, "never last-writer-wins");
  assert.equal(seen.at(-1).conflict, true);
  assert.equal(store.hydrate("d", rev(3), { n: 3 }), "applied");
  assert.equal(store.get("d").error, null, "a newer revision clears the conflict");
});

test("a new epoch is authoritative even with a lower counter", () => {
  const store = createDocumentStore();
  store.subscribe("d", () => {});
  store.hydrate("d", rev(9), { n: 9 });
  assert.equal(store.hydrate("d", rev(1, "h1", "e2"), { n: 1 }), "applied");
  assert.deepEqual(store.get("d").snapshot, { n: 1 });
});

test("viewers on one document share one subscription entry; the last release drops it", () => {
  const store = createDocumentStore();
  const a = [], b = [];
  const offA = store.subscribe("d", (v) => a.push(v)), offB = store.subscribe("d", (v) => b.push(v));
  store.hydrate("d", rev(1), { n: 1 });
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  assert.deepEqual(store.ids(), ["d"]);
  offA(); store.hydrate("d", rev(2), { n: 2 });
  assert.equal(a.length, 1, "released viewer is not called"); assert.equal(b.length, 2);
  offB();
  assert.equal(store.get("d"), null);
  assert.deepEqual(store.ids(), []);
});

test("reconcile sends the known revision, applies snapshots and gaps, skips unchanged", async () => {
  const calls = [];
  const answers = { d: { status: "snapshot", revision: rev(2), snapshot: { n: 2 } } };
  const store = createDocumentStore({ fetchChanges: async (list) => { calls.push(list); return { documents: list.map((q) => ({ documentId: q.documentId, ...answers[q.documentId] })) }; } });
  const seen = [];
  store.subscribe("d", (v) => seen.push(v));
  store.hydrate("d", rev(1), { n: 1 });
  let r = await store.reconcile();
  assert.deepEqual(calls[0], [{ documentId: "d", sinceRevision: rev(1) }]);
  assert.equal(r.applied, 1);
  answers.d = { status: "unchanged", revision: rev(2) };
  r = await store.reconcile();
  assert.equal(r.ignored, 1); assert.equal(seen.length, 2, "unchanged does not notify");
  answers.d = { status: "gap", revision: rev(7), snapshot: { n: 7 } };
  await store.reconcile();
  assert.equal(seen.at(-1).gap, true);
  assert.deepEqual(store.get("d").snapshot, { n: 7 });
});

test("reconcile batches 12 per call and survives a release mid-flight", async () => {
  const sizes = [];
  let store;
  store = createDocumentStore({ fetchChanges: async (list) => { sizes.push(list.length); return { documents: list.map((q) => ({ documentId: q.documentId, status: "snapshot", revision: rev(1), snapshot: {} })) }; } });
  const offs = Array.from({ length: 25 }, (_, i) => store.subscribe("d" + i, () => {}));
  await store.reconcile();
  assert.deepEqual(sizes, [12, 12, 1]);
  let release;
  store = createDocumentStore({ fetchChanges: async (list) => { release(); return { documents: list.map((q) => ({ documentId: q.documentId, status: "snapshot", revision: rev(1), snapshot: {} })) }; } });
  release = store.subscribe("x", () => {});
  const r = await store.reconcile();
  assert.equal(r.applied, 0, "an answer for a released document is dropped");
  offs.forEach((f) => f());
});

test("offline keeps the last snapshot, marks it stale, and recovers; missing is reported", async () => {
  let fail = true;
  const store = createDocumentStore({ fetchChanges: async (list) => { if (fail) throw new Error("offline"); return { documents: list.map((q) => q.documentId === "gone" ? { documentId: "gone", status: "missing", error: "no such image" } : { documentId: q.documentId, status: "snapshot", revision: rev(2), snapshot: { n: 2 } }) }; } });
  store.subscribe("d", () => {}); store.subscribe("gone", () => {});
  store.hydrate("d", rev(1), { n: 1 });
  let r = await store.reconcile();
  assert.equal(r.failed, true);
  assert.equal(store.get("d").stale, true);
  assert.deepEqual(store.get("d").snapshot, { n: 1 }, "last snapshot kept");
  fail = false;
  r = await store.reconcile();
  assert.equal(store.get("d").stale, false);
  assert.equal(store.get("gone").missing, true);
  assert.equal(r.missing, 1);
});

test("an unchanged answer with a newer counter keeps the snapshot and blocks a late middle revision", () => {
  const store = createDocumentStore();
  store.subscribe("d", () => {});
  store.hydrate("d", rev(1, "A"), { n: "A" });
  store.hydrate("d", rev(3, "A"), null); // content went A, B, A: "unchanged" at counter 3
  assert.equal(store.get("d").revision.counter, 3);
  assert.equal(store.hydrate("d", rev(2, "B"), { n: "B" }), "ignored", "the delayed snapshot of revision 2 is older");
  assert.deepEqual(store.get("d").snapshot, { n: "A" });
});

test("a delayed answer from a replaced epoch is ignored", () => {
  const store = createDocumentStore();
  store.subscribe("d", () => {});
  store.hydrate("d", rev(9, "h9", "e1"), { n: "old" });
  assert.equal(store.hydrate("d", rev(1, "x", "e2"), { n: "new" }), "applied");
  assert.equal(store.hydrate("d", rev(10, "h10", "e1"), { n: "late-old" }), "ignored");
  assert.deepEqual(store.get("d").snapshot, { n: "new" });
});

test("an unchanged answer after an outage clears stale and the error and tells subscribers", async () => {
  let fail = true, counter = 1;
  const store = createDocumentStore({ fetchChanges: async (list) => { if (fail) throw new Error("offline"); return { documents: list.map((q) => ({ documentId: q.documentId, status: "unchanged", revision: rev(counter, "h1") })) }; } });
  const seen = [];
  store.subscribe("d", (v) => seen.push(v));
  store.hydrate("d", rev(1, "h1"), { n: 1 });
  await store.reconcile();
  assert.equal(store.get("d").stale, true);
  fail = false;
  await store.reconcile();
  assert.equal(store.get("d").stale, false); assert.equal(store.get("d").error, null);
  assert.equal(seen.at(-1).stale, false, "same counter: subscribers are told");
  fail = true; await store.reconcile(); fail = false; counter = 3;
  await store.reconcile();
  assert.equal(seen.at(-1).stale, false, "higher same-hash counter: subscribers are told too");
  assert.equal(store.get("d").revision.counter, 3);
});
