import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { registerImage, clearImages } from "../src/image-store.js";
import { applyCanvasChanges, applyPairChanges, storeUserMarks, editCanvas, canvasMarks, importMarks } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation as resolve, replayUserAnnotation } from "../src/scene-catalog.js";
import { canvasDocument, VISUAL_PROTOCOL } from "../src/protocol.js";
import { parseMarksFile } from "../src/marks-file.js";

beforeEach(() => clearImages());
const image = async (w, h, colour) => registerImage(await sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer(), { source: "url" });
const box = (id, x, side) => ({ id, type: "rect", x, y: 0.2, x2: x + 0.1, y2: 0.4, ...(side ? { side } : {}) });

test("one image: layers, marks with provenance, style and findings, nothing host-specific", async () => {
  const entry = await image(400, 300, "#246");
  applyCanvasChanges(entry, { annotations: [{ ...box("g", 0.1), color: "red", note: "讀到的字" , status: "inspected" },
    { id: "path", type: "polyline", points: [{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.7 }, { x: 0.9, y: 0.9 }], smooth: true }], layer: "第一輪", resolve });
  storeUserMarks(entry, [{ id: "user-1", type: "point", x: 0.5, y: 0.5, label: "YOU 1" }]);
  editCanvas(entry, { layers: [{ id: "L1", locked: true, opacity: 0.5 }], marks: [{ id: "user-1", x: 0.6 }], resolveUser: replayUserAnnotation });
  const doc = canvasDocument(entry);
  assert.equal(doc.protocol, VISUAL_PROTOCOL);
  assert.equal(doc.coordinateSystem, "normalized-top-left");
  assert.deepEqual(doc.images, [{ id: entry.imageId, role: "single", width: 400, height: 300, source: "url", original: { format: "png", width: 400, height: 300 } }]);
  assert.deepEqual(doc.layers.map((l) => [l.id, l.order, l.locked, l.opacity]), [["L1", 0, true, 0.5], ["L2", 1, undefined, undefined]]);
  const [g, path, user] = doc.marks;
  assert.deepEqual(g, { id: "g", image: entry.imageId, type: "rect", geometry: { x: 0.1, y: 0.2, x2: 0.2, y2: 0.4 }, layer: "L1",
    style: { color: "red" }, finding: { note: "讀到的字", status: "inspected" }, provenance: { author: "assistant", grounding: "unverified" } });
  assert.deepEqual(path.geometry.bbox, [0.1, 0.7, 0.9, 0.9]);
  assert.equal(path.geometry.smooth, true);
  assert.deepEqual(user.provenance, { author: "user", grounding: "user-pointer", editedByUser: true });
  assert.deepEqual(doc.links, []);
  assert.doesNotMatch(JSON.stringify(doc), /openai|chatgpt|_meta/i);
});

test("a pair: links point from one image's mark to the other's, with review", async () => {
  const left = await image(800, 600, "#fff"), right = await image(600, 800, "#0a0");
  applyPairChanges(left, right, { annotations: [box("a", 0.1, "left"), box("b", 0.5, "right")],
    links: [{ id: "k", left: "a", right: "b", label: "同一個", confidence: "low" }], resolve });
  const doc = canvasDocument(left, right);
  assert.deepEqual(doc.images.map((i) => i.role), ["left", "right"]);
  assert.deepEqual(doc.marks.map((m) => [m.id, m.image]), [["a", left.imageId], ["b", right.imageId]]);
  assert.deepEqual(doc.links, [{ id: "k", from: { image: left.imageId, mark: "a" }, to: { image: right.imageId, mark: "b" },
    label: "同一個", confidence: "low", author: "assistant" }]);
});

test("a protocol document attached as a marks file restores the matching image's marks", async () => {
  const left = await image(800, 600, "#fff"), right = await image(600, 800, "#0a0");
  applyPairChanges(left, right, { annotations: [box("a", 0.1, "left"), { id: "p", type: "polyline", side: "right", points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.4 }] }], resolve });
  const bytes = Buffer.from(JSON.stringify(canvasDocument(left, right)));
  const parsed = parseMarksFile(bytes, { width: 600, height: 800 });
  assert.equal(parsed.imageId, right.imageId);
  clearImages();
  const fresh = await image(600, 800, "#0a1");
  importMarks(fresh, parsed.marks, { layers: parsed.layers, replayUser: replayUserAnnotation, resolve });
  assert.deepEqual(canvasMarks(fresh).map((m) => [m.id, m.type, m.points?.length]), [["p", "polyline", 2]]);
  assert.throws(() => parseMarksFile(Buffer.from(JSON.stringify({ protocol: VISUAL_PROTOCOL, images: [] })), {}), /Not an estampes.visual\/1 document|no images/);
});
