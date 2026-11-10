import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { registerImage, clearImages, entrySharp } from "../src/image-store.js";
import { applyCanvasChanges, canvasMarks, canvasLayers, storeUserMarks, editCanvas } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation, replayUserAnnotation, MARK_COLORS, MARK_SIZES, MARK_PENS } from "../src/scene-catalog.js";
import { markSvg } from "../src/mark-render.js";
import { renderCanvas } from "../src/scene/canvas-render.js";
import { buildRenderPlan, planItems, INK_COLORS, RENDER_PLAN_VERSION } from "../src/visual/render-plan.js";
import { itemSvg, planSvg } from "../src/visual/render-svg.js";

beforeEach(() => clearImages());
const resolve = resolveCoordinateAnnotation;
const photo = async () => registerImage(await sharp({ create: { width: 640, height: 360, channels: 3, background: "#264" } })
  .composite([{ input: await sharp({ create: { width: 200, height: 120, channels: 3, background: "#c84" } }).png().toBuffer(), left: 220, top: 90 }]).png().toBuffer(), { source: "url" });

const sample = () => [
  { id: "p", type: "point", x: 0.2, y: 0.3, label: "P<1>", color: "red" },
  { id: "ph", type: "point", x: 0.25, y: 0.35, pen: "highlighter", size: "thick" },
  { id: "r", type: "rect", x: 0.4, y: 0.3, x2: 0.6, y2: 0.6, size: "thin" },
  { id: "rh", type: "rect", x: 0.42, y: 0.32, x2: 0.62, y2: 0.62, pen: "highlighter", color: "cyan" },
  { id: "a", type: "arrow", x: 0.1, y: 0.8, x2: 0.5, y2: 0.7, color: "green", size: "medium" },
  { id: "l", type: "polyline", points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.2 }, { x: 0.5, y: 0.1 }, { x: 0.7, y: 0.25 }], smooth: true, color: "magenta" },
  { id: "c", type: "polyline", points: [{ x: 0.7, y: 0.6 }, { x: 0.9, y: 0.6 }, { x: 0.9, y: 0.9 }, { x: 0.7, y: 0.9 }], closed: true, pen: "highlighter", color: "yellow" },
  { id: "s", type: "polyline", points: [{ x: 0.05, y: 0.5 }, { x: 0.3, y: 0.55 }], size: "fine", color: "white" },
];

test("the table of ink colours is the one the widget and mark-render use", () => {
  assert.deepEqual(Object.keys(INK_COLORS).sort(), [...MARK_COLORS].sort());
  assert.equal(RENDER_PLAN_VERSION, 1);
});

test("structure: itemSvg equals markSvg for every type, colour, size, pen and author", () => {
  const map = (x, y) => [x * 640, y * 360], toPx = 0.64, checked = new Set();
  for (const base of sample()) for (const color of [undefined, ...MARK_COLORS]) for (const size of [undefined, ...MARK_SIZES]) for (const pen of [undefined, ...MARK_PENS]) for (const author of ["assistant", "user"]) {
    const raw = { ...base, author, ...(color ? { color } : {}), ...(size ? { size } : {}), ...(pen ? { pen } : {}) };
    const mark = base.type === "polyline" ? resolveCoordinateAnnotation({ ...raw, ...(base.smooth ? { smooth: true } : {}) }) : resolve(raw);
    const m = { ...mark, author };
    const [item] = planItems(buildRenderPlan({ marks: [m], layers: [] }));
    assert.equal(itemSvg(item, map, toPx), markSvg(m, map, toPx), JSON.stringify(raw));
    checked.add(base.id);
  }
  assert.equal(checked.size, sample().length);
});

test("structure: planSvg equals the canvas renderer's stacking: layers, opacity, user group, labels", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: sample().slice(0, 4), resolve, layer: "first" });
  applyCanvasChanges(entry, { annotations: sample().slice(4), resolve, layer: "second" });
  storeUserMarks(entry, [{ id: "user-1", type: "rect", x: 0.1, y: 0.1, x2: 0.2, y2: 0.2, label: "YOU 1", role: "focus" }, { id: "user-2", type: "point", x: 0.8, y: 0.2, label: "YOU 2", role: "focus" }]);
  const second = canvasLayers(entry).find((l) => l.name === "second");
  editCanvas(entry, { layers: [{ id: second.id, opacity: 0.5 }] });

  const marks = canvasMarks(entry), layers = canvasLayers(entry);
  const plan = buildRenderPlan({ marks, layers });
  assert.deepEqual(plan.layers.map((l) => l.layer), [null, ...layers.map((l) => l.id)]);
  assert.equal(plan.layers.find((l) => l.layer === second.id).opacity, 0.5);
  assert.equal(planItems(plan).length, marks.length);
  assert.ok(plan.layers.every((l) => l.user.every((i) => marks.find((m) => m.id === i.id).author === "user")));

  const labels = Object.fromEntries(marks.filter((m) => m.label).map((m) => [m.id, m.label]));
  const body = planSvg(plan, { width: entry.width, height: entry.height, labels });
  // The reference, written the way scene/canvas-render.js builds it.
  const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]);
  const known = new Set(layers.map((l) => l.id));
  const mark = (m) => markSvg(m, (x, y) => [x * entry.width, y * entry.height], entry.width / 1000) +
    (m.label ? `<text x="${m.x * entry.width + 6}" y="${m.y * entry.height - 8}" font-size="${15 * entry.width / 640}" fill="#17212A">${xml(m.label)}</text>` : "");
  const legacy = [null, ...layers.map((l) => l.id)].map((id) => {
    const own = marks.filter((m) => (id === null ? !known.has(m.layer) : m.layer === id));
    return `<g opacity="${layers.find((l) => l.id === id)?.opacity ?? 1}">` + own.filter((m) => m.author !== "user").map(mark).join("") +
      `<g opacity="0.55">${own.filter((m) => m.author === "user").map(mark).join("")}</g></g>`;
  }).join("");
  assert.equal(body, legacy);
  assert.ok(body.includes("P&lt;1&gt;"), "label text is escaped");

  // Hidden layers are left out of the plan.
  const hidden = buildRenderPlan({ marks, layers, hidden: [second.id] });
  assert.ok(planItems(hidden).length < marks.length && planItems(hidden).every((i) => marks.find((m) => m.id === i.id).layer !== second.id));
});

test("pixels (sampled): the plan drawn over the photo matches renderCanvas", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: sample(), resolve });
  storeUserMarks(entry, [{ id: "user-1", type: "polyline", x: 0.3, y: 0.8, x2: 0.6, y2: 0.9, points: [{ x: 0.3, y: 0.8 }, { x: 0.6, y: 0.9 }], label: "YOU 1", role: "focus" }]);
  const marks = canvasMarks(entry), layers = canvasLayers(entry), maxSide = 800;
  const legacy = await renderCanvas(entry, { maxSide });
  const { width, height } = legacy;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${entry.width} ${entry.height}" preserveAspectRatio="none">` +
    planSvg(buildRenderPlan({ marks, layers }), { width: entry.width, height: entry.height }) + "</svg>";
  const shadow = await entrySharp(entry).resize(width, height).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  const raw = async (png) => (await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true }));
  const [a, b] = [await raw(legacy.data), await raw(shadow)];
  assert.deepEqual([a.info.width, a.info.height], [b.info.width, b.info.height]);
  // Every 7th pixel in both directions.
  let sampled = 0, differing = 0;
  for (let y = 0; y < height; y += 7) for (let x = 0; x < width; x += 7) {
    const i = (y * width + x) * 4; sampled++;
    if ([0, 1, 2, 3].some((c) => Math.abs(a.data[i + c] - b.data[i + c]) > 2)) differing++;
  }
  assert.ok(sampled > 5000);
  assert.equal(differing, 0, differing + " of " + sampled + " sampled pixels differ");
});

test("no free text or markup reaches the SVG; bad plans fail instead of drawing", () => {
  const map = (x, y) => [x * 100, y * 100];
  const evil = { id: '"/><script>', type: "point", ink: '"/><script>alert(1)</script>', highlighter: false, stroke: 3, total: 3, dot: 16, at: { x: 0.1, y: 0.1 }, x: 0.1, y: 0.1 };
  // Colours come from the table when a plan is built from marks.
  const built = planItems(buildRenderPlan({ marks: [{ id: "m", type: "point", x: 0.1, y: 0.1, color: "<script>" }], layers: [] }))[0];
  assert.equal(built.ink, INK_COLORS.gold);
  assert.ok(!itemSvg(built, map, 1).includes("<script"));
  assert.throws(() => buildRenderPlan({ marks: [{ id: "m", type: "blob", x: 0, y: 0 }], layers: [] }), /Cannot draw mark of type/);
  assert.throws(() => buildRenderPlan({ marks: [{ id: "m", type: "point", x: NaN, y: 0 }], layers: [] }), /cannot be drawn/);
  assert.throws(() => itemSvg({ ...evil, ink: "#fff", stroke: NaN }, map, 1), /Non-finite/);
  assert.throws(() => planSvg({ version: 2, layers: [] }, { width: 1, height: 1 }), /Unsupported render plan version/);
});

test("server budget: planning and writing 2000 marks stays well under a second", () => {
  const marks = Array.from({ length: 2000 }, (_, i) => ({ id: "m" + i, type: i % 2 ? "rect" : "polyline", author: "assistant", layer: "L1",
    x: 0.1, y: 0.1, x2: 0.3, y2: 0.3, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }, { x: 0.3, y: 0.2 }], smooth: true }));
  const t0 = performance.now();
  const svg = planSvg(buildRenderPlan({ marks, layers: [{ id: "L1" }] }), { width: 1600, height: 900 });
  const ms = performance.now() - t0;
  console.log("render plan, 2000 marks: " + ms.toFixed(1) + " ms, " + svg.length + " bytes");
  assert.ok(ms < 1000, ms + " ms");
});
