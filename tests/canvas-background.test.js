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

test("a set copy restored without a background shows its image, not its base's colour", async () => {
  useStorageDir("");
  const base = await createBlankCanvas({ width: 300, height: 200 });
  base.background = { kind: "solid", color: "#203040" };
  const fork = Object.create(base);
  restoreCanvas(fork, { imageId: base.imageId, marks: [] });
  assert.equal(isSolid(fork), false, "the fork's own value shadows the base");
  assert.equal("background" in serializeCanvas(fork), false);
  assert.equal(isSolid(base), true);
});

test("bundles carry a solid background; a different colour is not reused", async () => {
  const { clearImages, registerImage } = await import("../src/image-store.js");
  const { clearWorkspaces, getWorkspace, workspaceItems } = await import("../src/workspace.js");
  const { exportBundle, importBundle } = await import("../src/bundle.js");
  clearImages(); clearWorkspaces(); useStorageDir("");
  const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#eeeeee" } }).png().toBuffer();
  const entry = await registerImage(png, { source: "chat-file", fileName: "any.png" });
  entry.background = { kind: "solid", color: "#203040" };
  // Not empty, so an import compares instead of restoring.
  applySceneOps(entry, [{ op: "object.create", type: "axes-2d", props: { xRange: [-1, 1], yRange: [-1, 1] } }], { author: "user" });
  const { buffer } = await exportBundle(entry.imageId);
  entry.background = { kind: "solid", color: "#ffffff" };
  const other = await importBundle(buffer, { collision: "reuse" });
  assert.equal(other.summary[0].how, "copied");
  assert.equal(other.verified, true, JSON.stringify(other.mismatch));
  const [copy] = (await workspaceItems(await getWorkspace(other.workspace.id))).map((it) => it.entry);
  assert.deepEqual(canvasBackground(copy), { kind: "solid", color: "#203040" }, "the copy keeps the exported colour");
  assert.deepEqual(canvasBackground(entry), { kind: "solid", color: "#ffffff" }, "the local canvas is not overwritten");
  // The same colour on another canvas: identical, so reused.
  const png2 = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#dddddd" } }).png().toBuffer();
  const twin = await registerImage(png2, { source: "chat-file", fileName: "b.png" });
  twin.background = { kind: "solid", color: "#405060" };
  applySceneOps(twin, [{ op: "object.create", type: "axes-2d", props: { xRange: [-1, 1], yRange: [-1, 1] } }], { author: "user" });
  const same = await importBundle((await exportBundle(twin.imageId)).buffer, { collision: "reuse" });
  assert.equal(same.summary[0].how, "reused");
  assert.equal(same.verified, true, JSON.stringify(same.mismatch));
  // A canvas whose only state is its colour is not empty: a different colour is copied, never restored over it.
  const png3 = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#cccccc" } }).png().toBuffer();
  const bare = await registerImage(png3, { source: "chat-file", fileName: "c.png" });
  bare.background = { kind: "solid", color: "#111111" };
  const bareBundle = (await exportBundle(bare.imageId)).buffer;
  bare.background = { kind: "solid", color: "#222222" };
  const bareImport = await importBundle(bareBundle, { collision: "reuse" });
  assert.equal(bareImport.summary[0].how, "copied");
  assert.deepEqual(canvasBackground(bare), { kind: "solid", color: "#222222" }, "the local colour is kept");
});
