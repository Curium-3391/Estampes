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

test("the user moves and restyles an earlier mark, deletes GPT's, and cannot restyle GPT's", async () => {
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
  assert.throws(() => editCanvas(entry, { marks: [{ id: "g2", color: "red" }], resolveUser }), /its color stays as the AI wrote it/);
  assert.throws(() => editCanvas(entry, { marks: [{ id: "g2", x: 0.62, label: "mine now", size: "l" }], resolveUser }), /its size stays as the AI wrote it/);
  assert.throws(() => editCanvas(entry, { layers: [{ id: "L1", name: "x" }], marks: [{ id: "nope" }], resolveUser }), /marks\[0\] \("nope"\): no such mark/);
  assert.throws(() => editCanvas(entry, { order: ["L1", "L1"], resolveUser }), /repeated/);
  assert.equal(snap(entry), before);
});

test("#69: the user moves, resizes and reshapes GPT's marks; author, claim and ID stay, edits carry before/after geometry", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [box("g", 0.5), { id: "arr", type: "arrow", x: 0.1, y: 0.1, x2: 0.3, y2: 0.3 },
    { id: "pl", type: "polyline", points: [{ x: 0.1, y: 0.6 }, { x: 0.2, y: 0.7 }, { x: 0.3, y: 0.6 }] }], layer: "AI", resolve });
  applyCanvasChanges(entry, { findings: [{ id: "g", note: "晶片", status: "inspected" }], resolve });
  takeUserEdits(entry);
  // Move: same size.
  let [e] = editCanvas(entry, { marks: [{ id: "g", x: 0.55, y: 0.25, x2: 0.65, y2: 0.45, label: undefined }], resolveUser });
  assert.equal(e.kind, "move-mark"); assert.equal(e.change, "move"); assert.equal(e.author, "assistant");
  assert.deepEqual(e.before, { type: "rect", x: 0.5, y: 0.2, x2: 0.6, y2: 0.4 });
  assert.deepEqual(e.after, { type: "rect", x: 0.55, y: 0.25, x2: 0.65, y2: 0.45 });
  // Resize: a corner handle.
  [e] = editCanvas(entry, { marks: [{ id: "g", x: 0.55, y: 0.25, x2: 0.8, y2: 0.5 }], resolveUser });
  assert.equal(e.change, "resize");
  const g = canvasMarks(entry).find((m) => m.id === "g");
  assert.deepEqual([g.author, g.note, g.status, g.layer, g.edited, g.x2, g.y2], ["assistant", "晶片", "inspected", canvasLayers(entry)[0].id, true, 0.8, 0.5]);
  // Reshape: one arrow end; one polyline vertex (bounds follow).
  [e] = editCanvas(entry, { marks: [{ id: "arr", x2: 0.4, y2: 0.2 }], resolveUser });
  assert.equal(e.change, "reshape");
  [e] = editCanvas(entry, { marks: [{ id: "pl", points: [{ x: 0.1, y: 0.6 }, { x: 0.2, y: 0.9 }, { x: 0.3, y: 0.6 }] }], resolveUser });
  assert.equal(e.change, "reshape");
  const pl = canvasMarks(entry).find((m) => m.id === "pl");
  assert.deepEqual([pl.author, pl.y2, pl.points[1].y], ["assistant", 0.9, 0.9]);
  // Undo returns the exact AI mark.
  const { undoCanvasEdit } = await import("../src/canvas-state.js");
  undoCanvasEdit(entry);
  assert.equal(canvasMarks(entry).find((m) => m.id === "pl").y2, 0.7);
  // A lock still blocks it.
  editCanvas(entry, { layers: [{ id: canvasLayers(entry)[0].id, locked: true }], resolveUser });
  assert.throws(() => editCanvas(entry, { marks: [{ id: "g", x: 0.1, y: 0.1, x2: 0.2, y2: 0.2 }], resolveUser }), /LAYER_LOCKED/);
  // When GPT redraws its mark somewhere else, the "edited" flag goes.
  editCanvas(entry, { layers: [{ id: canvasLayers(entry)[0].id, locked: false }], resolveUser });
  applyCanvasChanges(entry, { annotations: [box("g", 0.3)], resolve });
  assert.equal(canvasMarks(entry).find((m) => m.id === "g").edited, undefined);
});

test("finding recency follows changed evidence without changing layer or ink order", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [box("a", .1), box("b", .5)], layer: "走線", resolve });
  applyCanvasChanges(entry, { findings: [{ id: "a", note: "路徑 A" }, { id: "b", note: "路徑 B" }], resolve });
  const before = canvasMarks(entry), first = before.find(m=>m.id==="a").findingUpdatedAt;
  assert.ok(before.find(m=>m.id==="b").findingUpdatedAt > first);
  applyCanvasChanges(entry, { findings: [{ id: "a", note: "路徑 A" }], resolve });
  assert.equal(canvasMarks(entry).find(m=>m.id==="a").findingUpdatedAt, first, "unchanged claims do not jump to the top");
  applyCanvasChanges(entry, { findings: [{ id: "a", note: "路徑 A", evidence: [{ says: "新增觀察", region: [.1,.2,.2,.4] }] }], resolve });
  const after = canvasMarks(entry);
  assert.ok(after.find(m=>m.id==="a").findingUpdatedAt > after.find(m=>m.id==="b").findingUpdatedAt);
  assert.deepEqual(after.map(m=>[m.id,m.layer,m.x]), before.map(m=>[m.id,m.layer,m.x]));
  const { serializeCanvas, restoreCanvas } = await import("../src/storage.js");
  const copy = { imageId: entry.imageId, marks: new Map(), layers: [] };
  restoreCanvas(copy, JSON.parse(JSON.stringify(serializeCanvas(entry))));
  assert.equal(canvasMarks(copy).find(m=>m.id==="a").findingUpdatedAt, after.find(m=>m.id==="a").findingUpdatedAt);
});

test("#70: rotating a box turns it into a quadrilateral; only rect -> closed 4-point polyline is allowed", async () => {
  const entry = await photo();
  storeUserMarks(entry, [{ id: "mine", type: "rect", x: 0.1, y: 0.1, x2: 0.3, y2: 0.2, label: "我的框" }]);
  applyCanvasChanges(entry, { annotations: [{ ...box("ai", 0.5), label: "AI 框", color: "red" }, { id: "arr", type: "arrow", x: 0.1, y: 0.8, x2: 0.3, y2: 0.9 }], resolve });
  const quad = (cx, cy) => [{ x: cx - 0.1, y: cy - 0.02 }, { x: cx + 0.08, y: cy - 0.08 }, { x: cx + 0.1, y: cy + 0.02 }, { x: cx - 0.08, y: cy + 0.08 }];
  const before = snap(entry);
  assert.throws(() => editCanvas(entry, { marks: [{ id: "arr", type: "polyline", closed: true, points: quad(0.2, 0.85) }], resolveUser }), /only a box \(rect\) can become a quadrilateral/);
  assert.throws(() => editCanvas(entry, { marks: [{ id: "ai", type: "polyline", points: quad(0.55, 0.3) }], resolveUser }), /only a box/);
  assert.equal(snap(entry), before);
  const edits = editCanvas(entry, { marks: [{ id: "mine", type: "polyline", closed: true, points: quad(0.2, 0.15) }, { id: "ai", type: "polyline", closed: true, points: quad(0.55, 0.3) }], resolveUser });
  assert.deepEqual(edits.map((e) => [e.kind, e.change]), [["move-mark", "reshape"], ["move-mark", "reshape"]]);
  const byId = Object.fromEntries(canvasMarks(entry).map((m) => [m.id, m]));
  for (const id of ["mine", "ai"]) { assert.equal(byId[id].type, "polyline"); assert.equal(byId[id].closed, true); assert.equal(byId[id].points.length, 4); }
  assert.deepEqual([byId.ai.author, byId.ai.label, byId.ai.color, byId.ai.edited], ["assistant", "AI 框", "red", true]);
  assert.deepEqual([byId.mine.author, byId.mine.label], ["user", "我的框"]);
});
