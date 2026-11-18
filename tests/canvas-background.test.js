// UVA Phase 4A-1: a canvas background is data. A solid background is drawn as a
// plain colour (a vector rect in the widget), Graph axes stay vector primitives,
// and every image canvas renders and hashes exactly as before.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { applySceneOps, renderedObjects } from "../src/scene/scene-ops.js";
import { renderCanvas, canvasRevision } from "../src/scene/canvas-render.js";
import { serializeCanvas, restoreCanvas, useStorageDir } from "../src/storage.js";
import { canvasBackground, parseBackground, backgroundPayload, isSolid } from "../src/visual/background.js";

const pixel = async (out, x, y) => {
  const { data, info } = await sharp(out.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

test("background values: absent or unknown means the image; solid needs #rrggbb", () => {
  assert.deepEqual(canvasBackground({}), { kind: "image" });
  assert.deepEqual(canvasBackground({ background: { kind: "solid", color: "red" } }), { kind: "image" });
  assert.deepEqual(canvasBackground({ background: { kind: "weird" } }), { kind: "image" });
  // A non-string colour that coerces to a match is still not a colour.
  assert.deepEqual(canvasBackground({ background: { kind: "solid", color: ["#123456"] } }), { kind: "image" });
  assert.throws(() => parseBackground({ kind: "solid", color: ["#123456"] }), /#rrggbb/);
  assert.deepEqual(canvasBackground({ background: { kind: "solid", color: "#ABCDEF" } }), { kind: "solid", color: "#abcdef" });
  assert.deepEqual(parseBackground(undefined), { kind: "image" });
  assert.deepEqual(parseBackground({ kind: "solid", color: "#FFFFFF" }), { kind: "solid", color: "#ffffff" });
  assert.throws(() => parseBackground({ kind: "solid" }), /#rrggbb/);
  assert.throws(() => parseBackground({ kind: "solid", color: "#fff", url: "x" }), /#rrggbb/);
  assert.throws(() => parseBackground({ kind: "solid", color: "#ffffff", url: "x" }), /only kind and color/);
  assert.throws(() => parseBackground({ kind: "png" }), /"image" or "solid"/);
  assert.equal(backgroundPayload({ width: 10, height: 10 }), null);
  assert.deepEqual(backgroundPayload({ width: 10, height: 20, background: { kind: "solid", color: "#102030" } }),
    { background: { kind: "solid", color: "#102030" }, width: 10, height: 20, full: true });
});

test("a solid background is saved and restored; an image canvas record does not change", async () => {
  useStorageDir("");
  const e = await createBlankCanvas({ width: 300, height: 200 });
  const plain = serializeCanvas(e);
  assert.equal("background" in plain, false, "image canvases keep their record shape");
  e.background = { kind: "solid", color: "#203040" };
  const saved = serializeCanvas(e);
  assert.deepEqual(saved.background, { kind: "solid", color: "#203040" });
  const back = restoreCanvas({ imageId: e.imageId, width: 300, height: 200 }, saved);
  assert.equal(isSolid(back), true);
  assert.deepEqual(canvasBackground(back), { kind: "solid", color: "#203040" });
  // A damaged value restores as the image background.
  const bad = restoreCanvas({ imageId: e.imageId, width: 300, height: 200, background: { kind: "solid", color: "#000000" } },
    { ...saved, background: { kind: "solid", color: "javascript:x" } });
  assert.equal(isSolid(bad), false);
  const coerced = restoreCanvas({ imageId: e.imageId, width: 300, height: 200 }, { ...saved, background: { kind: "solid", color: ["#123456"] } });
  assert.equal(isSolid(coerced), false);
});

test("render: a solid canvas is drawn in its colour; image canvases keep their revision", async () => {
  const e = await createBlankCanvas({ width: 400, height: 300 });
  const before = canvasRevision(e);
  const img = await renderCanvas(e, { maxSide: 400 });
  assert.deepEqual(await pixel(img, 5, 5), [255, 255, 255]);
  assert.equal(img.metadata.sourceKind, "blank");
  assert.equal(img.metadata.included.base, true);
  e.background = { kind: "solid", color: "#336699" };
  assert.notEqual(canvasRevision(e), before, "the background is part of what is drawn");
  const out = await renderCanvas(e, { maxSide: 400 });
  assert.deepEqual(await pixel(out, 5, 5), [0x33, 0x66, 0x99]);
  assert.equal(out.metadata.sourceKind, "solid");
  assert.equal(out.metadata.included.base, false, "no image base is drawn");
  delete e.background;
  assert.equal(canvasRevision(e), before);
});

test("Graph axes, plots and labels are vector primitives, never images", async () => {
  const e = await createBlankCanvas({ width: 400, height: 300 });
  applySceneOps(e, [
    { op: "object.create", type: "axes-2d", props: { xRange: [-3, 3], yRange: [-2, 2], title: "t", xLabel: "x", yLabel: "y" } },
    { op: "object.create", type: "function-plot", props: { frame: "o1", expression: "sin(x)", label: "sin" } },
    { op: "object.create", type: "shape", props: { kind: "dots", space: "frame", frame: "o1", points: [[0, 0], [1, 1]] } },
  ], { author: "user" });
  const kinds = new Set(renderedObjects(e).flatMap((r) => r.primitives.map((p) => p.k)));
  assert.ok(kinds.size > 0);
  assert.equal(kinds.has("image"), false, "kinds: " + [...kinds].join(","));
  for (const k of kinds) assert.ok(["path", "circle", "text"].includes(k), k);
});
