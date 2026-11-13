// A failed save must not roll a canvas back over a newer save issued while
// the rollback was reading the stored state (review of A03): that newer save
// carries this change too, so the failed call reports its outcome.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { useCanvasStore, saveCanvas, restoreCanvas } from "../src/storage.js";
import { canvasMarks } from "../src/canvas-state.js";

after(() => useCanvasStore(null));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const mark = (id) => ({ id, type: "point", x: 0.5, y: 0.5, author: "assistant" });

test("a save issued during the rollback read wins; the canvas is not restored over it", async () => {
  const writes = [], reads = [];
  useCanvasStore({
    write: () => { const d = deferred(); writes.push(d); return d.promise; },
    read: () => { const d = deferred(); reads.push(d); return d.promise; },
  });
  const entry = { imageId: "img:00000000000000ab", width: 10, height: 10, marks: new Map(), layers: [] };
  entry.marks.set("m1", mark("m1"));
  const first = saveCanvas(entry, { tool: "t" });
  writes[0].reject(new Error("disk full"));
  await new Promise((r) => setImmediate(r));
  assert.equal(reads.length, 1, "the rollback is reading the stored canvas");
  // A newer edit and its save, while that read is under way.
  entry.marks.set("m2", mark("m2"));
  const second = saveCanvas(entry, { tool: "t" });
  // The store still holds the state from before both edits.
  reads[0].resolve({ canvas: { imageId: entry.imageId, marks: [], layers: [], links: {} } });
  writes[1].resolve();
  await second;
  await first; // answered with the newer save's outcome
  assert.deepEqual(canvasMarks(entry).map((m) => m.id).sort(), ["m1", "m2"], "nothing rolled back over the newer save");
});

test("without a newer save, the failed change is rolled back to the stored state", async () => {
  const writes = [];
  useCanvasStore({
    write: () => { const d = deferred(); writes.push(d); return d.promise; },
    read: async () => ({ canvas: { imageId: "img:00000000000000ac", marks: [mark("kept")], layers: [], links: {} } }),
  });
  const entry = restoreCanvas({ imageId: "img:00000000000000ac", width: 10, height: 10 }, { imageId: "img:00000000000000ac", marks: [mark("kept")], layers: [] });
  entry.marks.set("failed", mark("failed"));
  const save = saveCanvas(entry, { tool: "t" });
  writes[0].reject(new Error("disk full"));
  await assert.rejects(save, /disk full/);
  assert.deepEqual(canvasMarks(entry).map((m) => m.id), ["kept"]);
});
