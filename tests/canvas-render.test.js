import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { applySceneOps } from "../src/scene/scene-ops.js";
import { storeUserMarks, editCanvas } from "../src/canvas-state.js";
import { renderCanvas, canvasReadRequest } from "../src/scene/canvas-render.js";
import { renderView } from "../src/image/view.js";

const pixels = async (out) => sharp(out.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const at = ({ data, info }, x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
const white = (p) => p.every((v) => v === 255);
const line = { id: "user-1", type: "polyline", author: "user", color: "blue", size: "thick", x: .2, y: .5, x2: .8, y2: .5,
  points: [{ x: .2, y: .5 }, { x: .8, y: .5 }] };

test("canvas pixels include saved handwriting in full and cropped views; source stays blank", async () => {
  const e = await createBlankCanvas({ width: 400, height: 400 });
  storeUserMarks(e, [line]);
  const request = canvasReadRequest(e);
  const full = await renderCanvas(e, { ...request, maxSide: 400 });
  const crop = await renderCanvas(e, { ...request, maxSide: 200, region: { x: .25, y: .25, x2: .75, y2: .75 } });
  assert.ok(!white(at(await pixels(full), 200, 200)));
  assert.ok(!white(at(await pixels(crop), 100, 100)));
  assert.ok(white(at(await pixels(crop), 100, 30)));
  assert.deepEqual(crop.metadata.included.marks, [line.id]);
  assert.deepEqual(crop.metadata.mapping.pixelToCanvasNormalized, [.0025, 0, .25, 0, .0025, .25, 0, 0, 1]);
  const raw = await renderView(e, { region: crop.metadata.region });
  assert.ok((await pixels(raw)).data.every((v) => v === 255));
});

test("public Graph pixels update; hidden layers and scratch are excluded, locked layers remain visible", async () => {
  const e = await createBlankCanvas({ width: 400, height: 400 });
  applySceneOps(e, [
    { op: "object.create", type: "axes-2d", props: { xRange: [-3, 3], yRange: [-2, 2] } },
    { op: "object.create", type: "function-plot", props: { frame: "o1", expression: "sin(x)" } },
  ], { author: "user" });
  const old = canvasReadRequest(e);
  const before = await renderCanvas(e);
  applySceneOps(e, [{ op: "object.update", id: "o2", props: { expression: "sin(2*x)" } }], { author: "user" });
  await assert.rejects(renderCanvas(e, old), (err) => err.code === "STALE_CANVAS");
  assert.notDeepEqual((await renderCanvas(e)).data, before.data);
  const layer = e.objects.get("o1").layer;
  editCanvas(e, { layers: [{ id: layer, locked: true }] });
  assert.deepEqual((await renderCanvas(e)).metadata.included.objects, ["o1", "o2"]);
  applySceneOps(e, [{ op: "object.create", type: "shape", visibility: "scratch", props: { kind: "point", x: .5, y: .5 } }], { author: "user" }, { layer: "scratch" });
  const hidden = await renderCanvas(e, { hiddenLayers: [layer], maxSide: 400 });
  assert.deepEqual(hidden.metadata.included.objects, []);
  assert.ok((await pixels(hidden)).data.every((v) => v === 255));
});

test("revision checks cover marks, layer opacity and view visibility; render takes a consistent snapshot", async () => {
  const e = await createBlankCanvas({ width: 400, height: 400 });
  const blank = canvasReadRequest(e);
  const layer = storeUserMarks(e, [line]);
  await assert.rejects(renderCanvas(e, blank), (err) => err.code === "STALE_CANVAS");
  const beforeFade = canvasReadRequest(e);
  const solid = await pixels(await renderCanvas(e, { maxSide: 400 }));
  editCanvas(e, { layers: [{ id: layer.id, opacity: .2 }] });
  await assert.rejects(renderCanvas(e, beforeFade), (err) => err.code === "STALE_CANVAS");
  const faded = await pixels(await renderCanvas(e, { maxSide: 400 }));
  assert.ok(at(faded, 200, 200)[0] > at(solid, 200, 200)[0]);
  const current = canvasReadRequest(e);
  await assert.rejects(renderCanvas(e, { ...current, hiddenLayers: [layer.id] }), (err) => err.code === "STALE_CANVAS");
  const pending = renderCanvas(e, { ...current, maxSide: 400 });
  e.marks.clear();
  const snapshot = await pending;
  assert.equal(snapshot.metadata.revision, current.expectedRevision);
  assert.deepEqual(snapshot.metadata.included.marks, [line.id]);
  assert.ok(!white(at(await pixels(snapshot), 200, 200)));
});

test("mixed canvas draws marks over public objects and supports lossless WebP", async () => {
  const e = await createBlankCanvas({ width: 400, height: 400 });
  applySceneOps(e, [{ op: "object.create", type: "shape", props: { kind: "polyline", points: [[.2,.5],[.8,.5]], style: { color: "red", width: 10 } } }], { author: "user" });
  const before = await pixels(await renderCanvas(e, { maxSide: 400 }));
  storeUserMarks(e, [line]);
  const after = await pixels(await renderCanvas(e, { maxSide: 400, format: "webp" }));
  assert.ok(at(after, 200, 200)[2] > at(before, 200, 200)[2]);
  assert.deepEqual(at(after, 10, 10), [255,255,255]);
});
