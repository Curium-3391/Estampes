import test from "node:test";
import assert from "node:assert/strict";
import { createRevisionTracker, classifyChange } from "../src/visual/document-revisions.js";

test("counter grows only when the content hash changes", () => {
  const t = createRevisionTracker({ epoch: "e1" });
  const a = t.observe("img:a", "cv:1");
  assert.deepEqual(a, { epoch: "e1", counter: 1, hash: "cv:1" });
  assert.equal(t.observe("img:a", "cv:1").counter, 1, "same hash, same revision");
  assert.equal(t.observe("img:a", "cv:2").counter, 2);
  assert.equal(t.observe("img:a", "cv:1").counter, 3, "going back to an old hash is still newer");
  assert.equal(t.observe("img:b", "cv:9").counter, 1, "documents count separately");
});

test("classifyChange: unchanged, next snapshot, gap, other epoch", () => {
  const cur = { epoch: "e1", counter: 5, hash: "cv:5" };
  assert.equal(classifyChange(undefined, cur), "snapshot");
  assert.equal(classifyChange({ epoch: "e1", counter: 5, hash: "cv:5" }, cur), "unchanged");
  assert.equal(classifyChange({ epoch: "e1", counter: 4, hash: "cv:4" }, cur), "snapshot");
  assert.equal(classifyChange({ epoch: "e1", counter: 2, hash: "cv:2" }, cur), "gap");
  assert.equal(classifyChange({ epoch: "e0", counter: 9, hash: "cv:x" }, cur), "gap", "server restarted");
  assert.equal(classifyChange({ epoch: "e0", counter: 9, hash: "cv:5" }, cur), "gap", "same content after a restart still moves the client to the new epoch");
});

test("the tracker forgets the oldest documents past its limit", () => {
  const t = createRevisionTracker({ epoch: "e", limit: 2 });
  t.observe("a", "1"); t.observe("b", "1"); t.observe("c", "1");
  assert.ok(t.observe("a", "1").counter > 1, "a was forgotten but never restarts at a counter it had");
});

test("a forgotten document returns above every counter a client could hold", () => {
  const t = createRevisionTracker({ epoch: "e", limit: 1 });
  t.observe("A", "h1"); const held = t.observe("A", "h2");
  t.observe("B", "h1");
  const back = t.observe("A", "h3");
  assert.ok(back.counter > held.counter);
  assert.equal(classifyChange(held, back), "snapshot");
});
