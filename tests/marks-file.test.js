import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { registerImage } from "../src/image-store.js";
import { applyCanvasChanges, canvasMarks, canvasLayers, storeUserMarks, importMarks } from "../src/canvas-state.js";
import { exportMarksSvg, parseMarksFile } from "../src/marks-file.js";
import { inkReport, renderVerification } from "../src/mark-render.js";
import { resolveCoordinateAnnotation, replayUserAnnotation } from "../src/scene-catalog.js";

async function photo(width = 2000, height = 1000) {
  const bytes = await sharp({ create: { width, height, channels: 3, background: "#203040" } }).png().toBuffer();
  return registerImage(bytes, { source: "test" });
}

test("marks export as a layered SVG and load back onto the canvas", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, {
    annotations: [{ id: "trace", type: "polyline", points: [{ x: .1, y: .1 }, { x: .5, y: .2 }], label: "A <&> B", note: "x ]]> y" }],
    priorUser: [replayUserAnnotation({ id: "user-1", type: "rect", x: .2, y: .2, x2: .4, y2: .5, label: "YOU 1", author: "user" })],
    resolve: resolveCoordinateAnnotation,
  });
  const svg = exportMarksSvg(entry, canvasMarks(entry));
  assert.match(svg, /inkscape:label="使用者"/);
  assert.match(svg, /inkscape:label="GPT"/);
  assert.match(svg, /A &lt;&amp;&gt; B/);
  assert.doesNotMatch(svg, /<script/i);
  // The SVG is a valid image of the right size.
  const meta = await sharp(Buffer.from(svg)).metadata();
  assert.equal(meta.width, 2000);

  const parsed = parseMarksFile(Buffer.from(svg));
  assert.equal(parsed.marks.length, 2);
  assert.equal(parsed.marks.find((m) => m.id === "trace").note, "x ]]> y");

  const fresh = await photo(2000, 1000);
  fresh.marks = new Map();
  const added = importMarks(fresh, parsed.marks, { replayUser: replayUserAnnotation, resolve: resolveCoordinateAnnotation });
  assert.deepEqual(added.sort(), ["trace", "user-1"]);
  const user = canvasMarks(fresh).find((m) => m.id === "user-1");
  assert.equal(user.author, "user");
  assert.equal(user.grounding, "replayed-unverified");
  assert.throws(() => parseMarksFile(Buffer.from("<svg/>")), /Not an Estampes marks file/);
});

test("ink report gives real widths and flags ink that hides its target", async () => {
  const entry = await photo(3000, 3000);
  const [box] = inkReport([resolveCoordinateAnnotation({ id: "b", type: "rect", x: .5, y: .5, x2: .51, y2: .51, size: "thick" })], entry);
  // thick pen: 3 * 1000/640 * 1.8 canvas units = 8.4375 units -> 25.3 px on a 3000 px image.
  assert.equal(box.px, 25.3);
  assert.match(box.warn, /covers much of a 30x30px box/);
  const [fine] = inkReport([resolveCoordinateAnnotation({ id: "f", type: "polyline", points: [{ x: .1, y: .1 }, { x: .2, y: .1 }], size: "fine" })], entry);
  assert.match(fine.warn, /visible only when zoomed/);
  const [ok] = inkReport([resolveCoordinateAnnotation({ id: "o", type: "rect", x: .1, y: .1, x2: .5, y2: .5 })], entry);
  assert.equal(ok.warn, null);
});

test("verification draws ink at its real width", async () => {
  const entry = await photo(1000, 1000);
  const thin = resolveCoordinateAnnotation({ id: "t", type: "polyline", points: [{ x: .3, y: .5 }, { x: .7, y: .5 }], color: "red", size: "fine" });
  const thick = { ...thin, id: "k", size: "thick" };
  const redRows = async (mark) => {
    const out = await renderVerification(entry, [mark], [mark.id]);
    const { data, info } = await sharp(out.data).raw().toBuffer({ resolveWithObject: true });
    const col = Math.round(info.width * 0.8);
    let n = 0;
    for (let y = 0; y < info.height; y++) { const i = (y * info.width + col) * 3; if (data[i] - data[i + 1] > 60) n++; }
    return n;
  };
  const a = await redRows(thin), b = await redRows(thick);
  assert.ok(a > 0 && b > a * 3, `fine=${a} thick=${b}`);
});

test("layers survive export and come back as their own layers", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [{ id: "g", type: "point", x: .2, y: .2 }], layer: "第一輪 <檢查>", resolve: resolveCoordinateAnnotation });
  storeUserMarks(entry, [{ id: "u", type: "point", x: .4, y: .4 }]);
  const svg = exportMarksSvg(entry, canvasMarks(entry), canvasLayers(entry));
  assert.match(svg, /inkscape:label="第一輪 &lt;檢查&gt;"/);
  assert.match(svg, /inkscape:label="你 · 第1次"/);
  assert.doesNotMatch(svg, /inkscape:label="GPT"/);
  const parsed = parseMarksFile(Buffer.from(svg));
  assert.deepEqual(parsed.layers.map(l => l.name), ["第一輪 <檢查>", "你 · 第1次"]);

  // The target canvas already has a layer: imported ones get fresh ids.
  const other = await photo(2000, 1001);
  other.marks = new Map(); other.layers = [];
  applyCanvasChanges(other, { annotations: [{ id: "x", type: "point", x: .5, y: .5 }], resolve: resolveCoordinateAnnotation });
  importMarks(other, parsed.marks, { layers: parsed.layers, replayUser: replayUserAnnotation, resolve: resolveCoordinateAnnotation });
  assert.deepEqual(canvasLayers(other).map(l => [l.id, l.name, l.count]), [["L1", "GPT · 第1次", 1], ["L2", "第一輪 <檢查>", 1], ["L3", "你 · 第1次", 1]]);
});
