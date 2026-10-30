import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { registerImage, clearImages } from "../src/image-store.js";
import { applyCanvasChanges, canvasMarks, canvasLayers, storeUserMarks, editCanvas, takeUserEdits } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation as resolve, replayUserAnnotation } from "../src/scene-catalog.js";
import { exportMarksSvg } from "../src/marks-file.js";

beforeEach(() => clearImages());
const photo = async () => registerImage(await sharp({ create: { width: 400, height: 300, channels: 3, background: "#468" } }).png().toBuffer(), { source: "test" });
const box = (id, x) => ({ id, type: "rect", x, y: 0.2, x2: x + 0.1, y2: 0.4 });
const resolveUser = (m) => replayUserAnnotation(m);
const snap = (entry) => JSON.stringify([canvasMarks(entry), entry.layers, entry.userEdits ?? []]);

test("the user renames, reorders, fades and locks layers; GPT reads the edits once", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [box("a", 0.1)], layer: "第一輪", resolve });
  storeUserMarks(entry, [{ id: "user-1", type: "point", x: 0.5, y: 0.5, label: "YOU 1" }]);
  applyCanvasChanges(entry, { annotations: [box("b", 0.6)], layer: "第二輪", resolve });
  const [gpt1, mine, gpt2] = canvasLayers(entry).map((l) => l.id);
  const edits = editCanvas(entry, { layers: [{ id: gpt1, name: "  外框  ", opacity: 0.42 }, { id: mine, locked: true }], order: [gpt2, gpt1], resolveUser });
  assert.deepEqual(edits.map((e) => e.kind), ["rename-layer", "lock-layer", "reorder-layers"]);
  assert.deepEqual(canvasLayers(entry).map((l) => [l.id, l.name, l.opacity, l.locked]),
    [[gpt2, "第二輪", undefined, undefined], [gpt1, "外框", 0.4, undefined], [mine, "你 · 第1次", undefined, true]]);
  assert.equal(takeUserEdits(entry).length, 3);
  assert.equal(takeUserEdits(entry).length, 0);
  assert.match(exportMarksSvg(entry, canvasMarks(entry), canvasLayers(entry)), /inkscape:label="外框" opacity="0.4"/);
});

test("a locked layer stops GPT and the user changing its marks, but reset keeps it and notes still attach", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [box("a", 0.1)], layer: "保留", resolve });
  applyCanvasChanges(entry, { annotations: [box("b", 0.5)], resolve });
  const keep = canvasLayers(entry)[0].id;
  editCanvas(entry, { layers: [{ id: keep, locked: true }], resolveUser });
  const before = snap(entry);
  assert.throws(() => applyCanvasChanges(entry, { annotations: [box("a", 0.2)], resolve }), /annotations\[0\] \(mark "a"\): mark is in layer L1 "保留", which the user locked/);
  assert.throws(() => applyCanvasChanges(entry, { remove: ["a"], resolve }), /remove\[0\].*locked/);
  assert.throws(() => applyCanvasChanges(entry, { annotations: [box("c", 0.7)], layer: "保留", resolve }), /layer L1 is locked/);
  assert.throws(() => editCanvas(entry, { remove: ["a"], resolveUser }), /its layer is locked/);
  assert.equal(snap(entry), before);
  applyCanvasChanges(entry, { findings: [{ id: "a", note: "還是可以加註" }], resolve });
  applyCanvasChanges(entry, { reset: true, resolve });
  assert.deepEqual(canvasMarks(entry).map((m) => [m.id, m.note]), [["a", "還是可以加註"]]);
  assert.deepEqual(entry.layers.map((l) => l.id), [keep]);
});

test("the user moves and restyles an earlier mark, deletes GPT's, and cannot move GPT's", async () => {
  const entry = await photo();
  storeUserMarks(entry, [{ id: "user-1", type: "rect", x: 0.1, y: 0.1, x2: 0.2, y2: 0.2, label: "YOU 1" }]);
  applyCanvasChanges(entry, { annotations: [box("g", 0.5)], findings: [{ id: "user-1", note: "電阻" }], resolve });
  const edits = editCanvas(entry, { marks: [{ id: "user-1", x: 0.3, y: 0.3, x2: 0.45, y2: 0.4, color: "red" }], remove: ["g"], resolveUser });
  assert.deepEqual(edits.map((e) => e.kind), ["remove-mark", "move-mark"]);
  const [moved] = canvasMarks(entry);
  assert.deepEqual([moved.x, moved.x2, moved.color, moved.author, moved.grounding, moved.edited, moved.note], [0.3, 0.45, "red", "user", "user-pointer", true, "電阻"]);
  editCanvas(entry, { marks: [{ id: "user-1", label: "電阻 R1" }], resolveUser });
  assert.equal(entry.userEdits.at(-1).kind, "restyle-mark");
  applyCanvasChanges(entry, { annotations: [box("g2", 0.6)], resolve });
  const before = snap(entry);
  assert.throws(() => editCanvas(entry, { marks: [{ id: "g2", x: 0 }], resolveUser }), /only your own marks/);
  assert.throws(() => editCanvas(entry, { layers: [{ id: "L1", name: "x" }], marks: [{ id: "nope" }], resolveUser }), /marks\[0\] \("nope"\): no such mark/);
  assert.throws(() => editCanvas(entry, { order: ["L1", "L1"], resolveUser }), /repeated/);
  assert.equal(snap(entry), before);
});
