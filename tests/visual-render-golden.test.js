// The renderers now draw from the RenderPlan. This fixture was captured from
// the previous hand-written drawing code (before the switch); the output must
// stay byte-for-byte what it was.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { registerImage } from "../src/image-store.js";
import { applyCanvasChanges, canvasMarks, canvasLayers, storeUserMarks, editCanvas } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation as resolve, MARK_COLORS, MARK_SIZES, MARK_PENS } from "../src/scene-catalog.js";
import { markSvg } from "../src/mark-render.js";
import { buildRenderPlan } from "../src/visual/render-plan.js";
import { planSvg } from "../src/visual/render-svg.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/render-golden.json", import.meta.url)));
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

test("markSvg equals the captured output for every colour/size/pen/author", () => {
  const map = (x, y) => [x * 640, y * 360];
  let n = 0;
  for (const base of sample()) for (const color of [undefined, ...MARK_COLORS]) for (const size of [undefined, ...MARK_SIZES])
    for (const pen of [undefined, ...MARK_PENS]) for (const author of ["assistant", "user"]) {
      const raw = { ...base, ...(color ? { color } : {}), ...(size ? { size } : {}), ...(pen ? { pen } : {}) };
      const key = [base.id, color, size, pen, author].join("|");
      assert.equal(markSvg({ ...resolve(raw), author }, map, 0.64), golden.perMark[key], key); n++;
    }
  assert.equal(n, Object.keys(golden.perMark).length);
});

test("the canvas body (layers, opacity, user group, labels, hidden layer) equals the captured output", async () => {
  const entry = await registerImage(await sharp({ create: { width: 640, height: 360, channels: 3, background: "#264" } }).png().toBuffer(), { source: "url" });
  applyCanvasChanges(entry, { annotations: sample().slice(0, 4), resolve, layer: "first" });
  applyCanvasChanges(entry, { annotations: sample().slice(4), resolve, layer: "second" });
  storeUserMarks(entry, [{ id: "user-1", type: "rect", x: 0.1, y: 0.1, x2: 0.2, y2: 0.2, label: "YOU 1", role: "focus" }, { id: "user-2", type: "point", x: 0.8, y: 0.2, label: "YOU 2", role: "focus" }]);
  const second = canvasLayers(entry).find((l) => l.name === "second");
  editCanvas(entry, { layers: [{ id: second.id, opacity: 0.5 }] });
  const body = (hidden, labels) => {
    const marks = canvasMarks(entry).filter((m) => !hidden.includes(m.layer));
    const plan = buildRenderPlan({ marks, layers: canvasLayers(entry) });
    const names = labels === "all" ? Object.fromEntries(marks.filter((m) => m.label).map((m) => [m.id, m.label])) : {};
    return planSvg(plan, { width: entry.width, height: entry.height, toPx: entry.width / 1000, labels: names });
  };
  assert.equal(body([], "none"), golden.canvas.plain);
  assert.equal(body([], "all"), golden.canvas.labels);
  assert.equal(body([second.id], "none"), golden.canvas.hidden);
});

test("a mark id like constructor or __proto__ draws no label text unless one is given", () => {
  const marks = ["constructor", "toString", "__proto__", "hasOwnProperty"].map((id, i) => ({ id, type: "point", x: 0.1 * (i + 1), y: 0.5, author: "assistant" }));
  const plan = buildRenderPlan({ marks, layers: [] });
  assert.ok(!planSvg(plan, { width: 640, height: 360 }).includes("<text"));
  assert.ok(!planSvg(plan, { width: 640, height: 360, labels: {} }).includes("<text"));
  assert.ok(planSvg(plan, { width: 640, height: 360, labels: Object.fromEntries([["constructor", "A<b>"]]) }).includes("A&lt;b&gt;"));
});
