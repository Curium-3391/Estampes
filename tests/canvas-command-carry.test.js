// A command id must stay recorded with its edit when a later save of the same canvas
// is the one that makes the edit durable (the first save failed). Review of the lost-ACK PR.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { useCanvasStore, saveCanvas } from "../src/storage.js";
import { commandRecords, judgeCommand } from "../src/visual/commands.js";

after(() => useCanvasStore(null));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const mark = (id) => ({ id, type: "point", x: 0.5, y: 0.5, author: "assistant" });
const tick = () => new Promise((r) => setImmediate(r));

test("a later save that carries a failed save's edit also carries its command record", async () => {
  const writes = [], reads = [];
  useCanvasStore({
    write: (_key, record) => { const d = deferred(); writes.push({ d, record }); return d.promise; },
    read: () => { const d = deferred(); reads.push(d); return d.promise; },
  });
  const entry = { imageId: "img:00000000000000b1", width: 10, height: 10, marks: new Map(), layers: [] };
  entry.marks.set("m1", mark("m1"));
  const first = saveCanvas(entry, { tool: "edit_visual_canvas", commandId: "cmd-carry-001", argsHash: "h1" });
  writes[0].d.reject(new Error("disk full"));
  await tick();
  assert.equal(reads.length, 1, "the rollback is reading the stored canvas");
  // An edit without a command id (another tool) saves while that read is under way and carries the first edit.
  entry.marks.set("m2", mark("m2"));
  const second = saveCanvas(entry, { tool: "other" });
  reads[0].resolve({ canvas: { imageId: entry.imageId, marks: [], layers: [], links: {} } });
  writes[1].d.resolve();
  await second; await first;
  const log = [writes[1].record.line];
  assert.equal(judgeCommand([log], "cmd-carry-001", "h1").state, "applied", "the record is durable with the edit");
  assert.equal(commandRecords(log).length, 1);

  // Later saves do not keep carrying it once it is durable.
  entry.marks.set("m3", mark("m3"));
  const third = saveCanvas(entry, { tool: "other" });
  writes[2].d.resolve(); await third;
  assert.equal(writes[2].record.line.carried, undefined);
});

test("when the carrying save fails too, nothing stays outstanding", async () => {
  const writes = [];
  useCanvasStore({
    write: (_key, record) => { const d = deferred(); writes.push({ d, record }); return d.promise; },
    read: async () => ({ canvas: { imageId: "img:00000000000000b2", marks: [], layers: [], links: {} } }),
  });
  const entry = { imageId: "img:00000000000000b2", width: 10, height: 10, marks: new Map(), layers: [] };
  entry.marks.set("m1", mark("m1"));
  const first = saveCanvas(entry, { tool: "edit_visual_canvas", commandId: "cmd-carry-002", argsHash: "h2" });
  writes[0].d.reject(new Error("disk full"));
  await assert.rejects(first, /disk full/);
  // The edit was rolled back, so a new save must not claim the command was applied.
  entry.marks.set("m2", mark("m2"));
  const next = saveCanvas(entry, { tool: "other" });
  writes[1].d.resolve(); await next;
  assert.equal(writes[1].record.line.carried, undefined);
});
