import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { registerImage } from "../src/image-store.js";
import { applyCanvasChanges, canvasMarks, storeUserMarks, fromFrame } from "../src/canvas-state.js";
import { renderVerification, marksRegion } from "../src/mark-render.js";
import { resolveCoordinateAnnotation } from "../src/scene-catalog.js";

const photo = async () => registerImage(await sharp({ create: { width: 400, height: 300, channels: 3, background: "#264" } })
  .png().toBuffer(), { source: "url" });
const resolve = resolveCoordinateAnnotation;

test("crop coordinates convert back to the full image", () => {
  const frame = { region: { x: 0.5, y: 0.2, x2: 0.7, y2: 0.6 }, width: 800, height: 1600 };
  const m = fromFrame({ id: "t", type: "polyline", points: [{ x: 0, y: 0 }, { x: 400, y: 1600 }] }, frame);
  assert.deepEqual(m.points.map(p => [+p.x.toFixed(6), +p.y.toFixed(6)]), [[0.5, 0.2], [0.6, 0.6]]);
  const n = fromFrame({ id: "r", type: "rect", x: 0.5, y: 0.5, x2: 1, y2: 1 }, { region: frame.region });
  assert.deepEqual([n.x, n.y, n.x2, n.y2].map(v => +v.toFixed(6)), [0.6, 0.4, 0.7, 0.6]);
});

test("marks persist with stable ids: add, edit, comment, remove", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [{ id: "chip", type: "rect", x: 0.1, y: 0.1, x2: 0.3, y2: 0.3, note: "first" }], resolve });
  storeUserMarks(entry, [{ id: "user-ab-1", type: "point", x: 0.5, y: 0.5, label: "YOU 1", role: "focus" }]);
  // Editing by id keeps the old note; findings comment on the user's mark.
  const changed = applyCanvasChanges(entry, {
    annotations: [{ id: "chip", type: "rect", x: 0.12, y: 0.1, x2: 0.3, y2: 0.3 }],
    findings: [{ id: "user-ab-1", note: "CXD2500AQ", status: "inspected" }], resolve,
  });
  assert.deepEqual(changed, ["chip", "user-ab-1"]);
  const [chip, user] = canvasMarks(entry);
  assert.equal(chip.x, 0.12);
  assert.equal(chip.note, "first");
  assert.equal(user.author, "user");
  assert.equal(user.role, undefined, "submission role is not stored");
  assert.equal(user.note, "CXD2500AQ");
  assert.throws(() => applyCanvasChanges(entry, { annotations: [{ id: "user-ab-1", type: "point", x: 0, y: 0 }], resolve }), /drawn by the user/);
  assert.throws(() => applyCanvasChanges(entry, { findings: [{ id: "nope", note: "x" }], resolve }), /No mark nope/);
  applyCanvasChanges(entry, { remove: ["chip"], resolve });
  assert.deepEqual(canvasMarks(entry).map(m => m.id), ["user-ab-1"]);
  applyCanvasChanges(entry, { reset: true, resolve });
  assert.equal(canvasMarks(entry).length, 0);
  assert.throws(() => applyCanvasChanges(entry, { annotations: [{ id: "far", type: "point", x: 2, y: 0.5 }], resolve }), /Invalid/);
});

test("verification image shows the crop with and without the marks", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [
    { id: "a", type: "rect", x: 0.4, y: 0.4, x2: 0.5, y2: 0.6, color: "red" },
    { id: "b", type: "polyline", points: [{ x: 0.45, y: 0.5 }, { x: 0.6, y: 0.55 }], pen: "highlighter" },
  ], resolve });
  const v = await renderVerification(entry, canvasMarks(entry), ["a"]);
  assert.equal(v.mimeType, "image/jpeg");
  assert.deepEqual(v.numbers, [{ n: 1, id: "a", label: undefined }]);
  assert.ok(v.region.x <= 0.4 && v.region.x2 >= 0.5 && v.region.y <= 0.4 && v.region.y2 >= 0.6);
  const meta = await sharp(v.data).metadata();
  assert.equal(v.layout, "side-by-side");
  assert.ok(meta.width > meta.height, "two panels side by side");
  // Left panel is untouched photo; the right panel has the red outline.
  const { data, info } = await sharp(v.data).raw().toBuffer({ resolveWithObject: true });
  const half = (info.width - 8) / 2, rowY = Math.round(info.height / 2);
  let redLeft = 0, redRight = 0;
  for (let x = 0; x < info.width; x++) {
    const i = (rowY * info.width + x) * info.channels;
    if (data[i] - data[i + 1] > 60) x < half ? redLeft++ : redRight++;
  }
  assert.equal(redLeft, 0);
  assert.ok(redRight > 0);
  assert.deepEqual(marksRegion([{ x: 0.5, y: 0.5 }]), { x: 0.46, y: 0.46, x2: 0.54, y2: 0.54 });
});
