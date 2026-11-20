// UVA Phase 4B-5: the model and the person see the same Graph marks. The
// model draws one mark fixed to the axes and one pinned to a curve, the person
// drags one in the widget, the model changes the axes and the formula, and
// get_visual_state, render_canvas and the widget all put both marks at the
// same place (fake host).
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { startStack, noBrowser } from "./helpers/widget-host.js";
import { makeCanvas } from "./helpers/canvases.js";
import { frameOf } from "../src/scene/objects.js";

const W = 1000, H = 750, GRAPH = "org.estampes.graph";
const settled = (ui) => ui.frame.locator("#wb-bar:not(:empty)").waitFor();
async function point(ui, x, y) {
  await settled(ui);
  return ui.frame.locator("#surface").evaluate((svg, [x, y]) => {
    const p = svg.createSVGPoint(), vb = svg.getAttribute("viewBox").split(" ").map(Number);
    p.x = vb[0] + x * 1000; p.y = vb[1] + y * 750; const q = p.matrixTransform(svg.getScreenCTM()); return { x: q.x, y: q.y };
  }, [x, y]);
}
async function drag(ui, a, b) {
  await ui.page.waitForTimeout(300);
  const from = await point(ui, ...a), to = await point(ui, ...b);
  await ui.page.mouse.move(from.x, from.y); await ui.page.mouse.down(); await ui.page.waitForTimeout(120);
  await ui.page.mouse.move(to.x, to.y, { steps: 5 }); await ui.page.mouse.up();
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const box = (g) => [Math.min(g.x, g.x2), Math.min(g.y, g.y2), Math.max(g.x, g.x2), Math.max(g.y, g.y2)];
// The rectangles the widget draws, normalized to the canvas.
const drawnRects = (ui) => ui.frame.locator("#stored-annotations rect, #unified-layers rect").evaluateAll((els, [w, h]) =>
  els.map((e) => ["x", "y", "width", "height"].map((k) => Number(e.getAttribute(k)))).filter((v) => v.every(Number.isFinite))
    .map(([x, y, rw, rh]) => [x / w, y / h, (x + rw) / w, (y + rh) / h]), [W, H]);
const drawnAt = (rects, b, tol = 0.006) => rects.some((r) => r.every((v, i) => near(v, b[i], tol)));
// render_canvas: a pixel of the mark's colour on each edge of its box.
async function renderedAt(png, b, isColour) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => { const i = (Math.round(y * (info.height - 1)) * info.width + Math.round(x * (info.width - 1))) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
  const around = (x, y) => { for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) if (isColour(at(x + dx / info.width, y + dy / info.height))) return true; return false; };
  const [x, y, x2, y2] = b, mx = (x + x2) / 2, my = (y + y2) / 2;
  return [[mx, y], [mx, y2], [x, my], [x2, my]].every(([px, py]) => around(px, py));
}
// Outline colours as drawn (about 229,118,240 and 238,93,101), well apart from the grid, axes and the blue curve.
const magenta = ([r, g, b]) => r > 190 && b > 190 && g < 160;
const red = ([r, g, b]) => r > 200 && g < 140 && b < 140;

test("model and person see Graph anchors in the same place: drag in the widget, then new axes and a new formula", { skip: noBrowser, timeout: 240000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const ok = async (name, args) => { const r = await s.call(name, args); assert.ok(!r.isError, name + ": " + JSON.stringify(r.content)); return r; };
    const state = async () => (await ok("get_visual_state", { imageId })).structuredContent;
    const imageId = await makeCanvas(s, "graph", { width: W, height: H });
    await ok("execute_module", { module: GRAPH, capability: "plot_function", canvas: imageId, params: { expression: "x", color: "blue" }, present: false });
    // 1. The model draws a box fixed to the axes and a box pinned to y = x at x = -6.
    await ok("present_visual", { imageId, annotations: [
      { id: "w", type: "rect", x: 2, y: 2, x2: 4, y2: 4, label: "data", color: "magenta", anchor: { space: "world" } },
      { id: "f", type: "rect", x: -6, y: 0, x2: -4, y2: -2, label: "curve", color: "red", anchor: { space: "function-x" } },
    ] });
    let st = await state();
    const axes = () => st.objects.find((o) => o.type === "axes-2d"), plot = st.objects.find((o) => o.type === "function-plot");
    let f = frameOf(axes()), w = st.marks.find((m) => m.id === "w");
    assert.deepEqual(st.marks.find((m) => m.id === "f").anchor.x, -6);

    // 2. The person drags the data box right by 0.05 of the canvas.
    let ui = await s.open({ imageId, viewport: { width: 1280, height: 900 } });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    await ui.frame.locator("#stored-annotations rect, #unified-layers rect").first().waitFor();
    await ui.frame.locator('[data-mode="select"]').click();
    // A point on the top edge away from the handles (corners and side midpoints resize).
    const [wx, wy, wx2] = box(w.geometry);
    const edge = [wx + (wx2 - wx) / 4, wy];
    const at = await point(ui, ...edge);
    await ui.page.mouse.click(at.x, at.y);
    await ui.frame.locator("#selection-outline [data-handle]").first().waitFor();
    await drag(ui, edge, [edge[0] + 0.05, edge[1]]);
    await ui.frame.locator("#status").filter({ hasText: "已移動標記" }).waitFor();

    // 3. The model reads where the person put it, in axis units too.
    st = await state();
    w = st.marks.find((m) => m.id === "w");
    const dx = 0.05 / (f.region.x2 - f.region.x) * 20;
    assert.equal(w.anchor.status, "ok");
    assert.ok(near(w.anchor.world.x, 2 + dx, 0.15) && near(w.anchor.world.x2, 4 + dx, 0.15) && near(w.anchor.world.y, 2, 0.15), JSON.stringify(w.anchor));
    assert.ok(drawnAt(await drawnRects(ui), box(w.geometry)), "the widget draws it where get_visual_state says");

    // 4. The model zooms the axes and changes the formula.
    await ok("execute_module", { module: GRAPH, capability: "set_axes", canvas: imageId, params: { xRange: [-8, 8], yRange: [-8, 8] }, present: false });
    await ok("execute_module", { module: GRAPH, capability: "update_plot", canvas: imageId, params: { object: plot.id, expression: "x/2" }, present: false });
    st = await state();
    f = frameOf(axes());
    w = st.marks.find((m) => m.id === "w");
    const fm = st.marks.find((m) => m.id === "f");
    const [ax, ay] = f.toCanvas(w.anchor.world.x, w.anchor.world.y), [bx, by] = f.toCanvas(w.anchor.world.x2, w.anchor.world.y2);
    const expectW = box({ x: ax, y: ay, x2: bx, y2: by });
    assert.ok(box(w.geometry).every((v, i) => near(v, expectW[i], 1e-6)), "the data box follows the new range: " + JSON.stringify(w.geometry));
    // f keeps its shape (2 by 2 in the old units, kept on the canvas) with its first corner on y = x/2 at x = -6.
    const [cx, cy] = f.toCanvas(-6, -3);
    assert.equal(fm.anchor.status, "ok");
    assert.ok(near(fm.geometry.x, cx, 1e-6) && near(fm.geometry.y, cy, 1e-6), "the curve box follows the formula: " + JSON.stringify(fm.geometry));

    // render_canvas draws both where get_visual_state says.
    const render = await ok("render_canvas", { imageId });
    const png = Buffer.from(render.content.find((c) => c.type === "image").data, "base64");
    assert.deepEqual([...render.structuredContent.included.marks].sort(), ["f", "w"]);
    assert.ok(await renderedAt(png, box(w.geometry), magenta), "render_canvas draws the data box where the state says");
    assert.ok(await renderedAt(png, box(fm.geometry), red), "render_canvas draws the curve box where the state says");

    // And the person sees the same when the canvas is opened again.
    ui = await s.open({ imageId, viewport: { width: 1280, height: 900 } });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    await ui.frame.locator("#stored-annotations rect, #unified-layers rect").first().waitFor();
    const rects = await drawnRects(ui);
    assert.ok(drawnAt(rects, box(w.geometry)), "widget: data box " + JSON.stringify({ rects, w: box(w.geometry) }));
    assert.ok(drawnAt(rects, box(fm.geometry)), "widget: curve box " + JSON.stringify({ rects, f: box(fm.geometry) }));
  } finally { await s.close(); }
});
