// #70 regression: after the turn handle makes a box a closed four-point
// polyline, the user must still be able to drag the whole shape by its body,
// as they could the box. Applies to any closed shape (drawn quadrilaterals,
// loops), not only turned boxes.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { startStack, noBrowser } from "./helpers/widget-host.js";
import { CANVAS_KINDS, makeCanvas } from "./helpers/canvases.js";

const settled = (ui) => ui.frame.locator("#wb-bar:not(:empty)").waitFor();
async function point(ui, x, y) {
  await settled(ui);
  return ui.frame.locator("#surface").evaluate((svg, [x, y]) => {
    const p = svg.createSVGPoint(), vb = svg.getAttribute("viewBox").split(" ").map(Number);
    p.x = x * vb[2]; p.y = y * vb[3]; const q = p.matrixTransform(svg.getScreenCTM()); return { x: q.x, y: q.y };
  }, [x, y]);
}
async function drag(ui, from, to, touch) {
  if (touch) {
    const cdp = await ui.page.context().newCDPSession(ui.page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 1 }] });
    await ui.page.waitForTimeout(120);
    for (let i = 1; i <= 4; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * i / 4, y: from.y + (to.y - from.y) * i / 4, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  } else {
    await ui.page.mouse.move(from.x, from.y); await ui.page.mouse.down(); await ui.page.waitForTimeout(120);
    await ui.page.mouse.move(to.x, to.y, { steps: 5 }); await ui.page.mouse.up();
  }
}
async function dragCanvas(ui, a, b, touch) {
  await ui.page.waitForTimeout(300);
  const from = await point(ui, ...a), to = await point(ui, ...b);
  await drag(ui, from, to, touch);
}
const tap = async (ui, p, touch) => (touch ? ui.page.touchscreen.tap(p.x, p.y) : ui.page.mouse.click(p.x, p.y));
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const centre = (pts) => [pts.reduce((s, p) => s + p.x, 0) / pts.length, pts.reduce((s, p) => s + p.y, 0) / pts.length];

for (const kind of CANVAS_KINDS) for (const touch of [false, true]) test("a turned box can still be dragged by its body: " + (touch ? "mobile touch" : "desktop") + ", " + kind, { skip: noBrowser, timeout: 150000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const ok = async (name, args) => { const r = await s.call(name, args); assert.ok(!r.isError, JSON.stringify(r.content)); return r.structuredContent; };
    const data = (await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ddd" } }).png().toBuffer()).toString("base64");
    const imageId = await makeCanvas(s, kind);
    await ok("present_visual", { imageId, annotations: [
      { id: "box", type: "rect", x: 0.2, y: 0.2, x2: 0.4, y2: 0.4, label: "R70", note: "旋轉後平移" },
      { id: "quad", type: "polyline", closed: true, points: [{ x: 0.6, y: 0.55 }, { x: 0.8, y: 0.6 }, { x: 0.78, y: 0.8 }, { x: 0.62, y: 0.75 }], label: "Q", note: "四邊形" },
    ] });
    const get = async (id) => (await ok("get_visual_state", { imageId })).marks.find((m) => m.id === id);
    const ui = await s.open({ imageId, touch, viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    await ui.frame.locator("#stored-annotations rect, #unified-layers rect").first().waitFor();
    await ui.frame.locator('[data-mode="select"]').click();
    const original = await get("box");
    const keep = (m) => [m.id, m.provenance.author, m.label, m.finding.note, m.layer];

    // 1. A box is dragged from its body before turning.
    await tap(ui, await point(ui, 0.3, 0.3), touch);
    await ui.frame.locator('#selection-outline [data-handle="rot"]').waitFor();
    await dragCanvas(ui, [0.3, 0.3], [0.32, 0.33], touch);
    await ui.frame.locator("#status").filter({ hasText: "已移動標記" }).waitFor();
    let m = await get("box");
    assert.equal(m.type, "rect");
    assert.ok(near(m.geometry.x, 0.22) && near(m.geometry.y, 0.23), JSON.stringify(m.geometry));

    // 2. Turn it; it becomes a closed four-point polyline.
    await ui.page.waitForTimeout(300);
    const rot = await ui.frame.locator('#selection-outline [data-handle="rot"]').boundingBox();
    const from = { x: rot.x + rot.width / 2, y: rot.y + rot.height / 2 };
    await drag(ui, from, { x: from.x + 50, y: from.y + 15 }, touch);
    await ui.frame.locator("#status").filter({ hasText: "已旋轉標記" }).waitFor();
    const turned = await get("box");
    assert.equal(turned.type, "polyline"); assert.equal(turned.geometry.closed, true); assert.equal(turned.geometry.points.length, 4);
    assert.deepEqual(keep(turned), keep(original));

    // Moves every corner by the same amount, keeps the turn, id and text.
    const assertTranslated = (before, after, dx, dy) => {
      assert.equal(after.type, "polyline"); assert.equal(after.geometry.closed, true); assert.equal(after.geometry.points.length, 4);
      after.geometry.points.forEach((p, i) => {
        assert.ok(near(p.x - before.geometry.points[i].x, dx) && near(p.y - before.geometry.points[i].y, dy),
          `corner ${i} moved by (${p.x - before.geometry.points[i].x}, ${p.y - before.geometry.points[i].y}), want (${dx}, ${dy})`);
      });
      const d = (pts, i) => [pts[(i + 1) % 4].x - pts[i].x, pts[(i + 1) % 4].y - pts[i].y];
      for (let i = 0; i < 4; i++) d(after.geometry.points, i).forEach((v, j) => assert.ok(near(v, d(before.geometry.points, i)[j], 0.002), "shape and turn kept"));
      assert.deepEqual(keep(after), keep(original));
    };

    // 3. Immediately drag the turned shape by its body (its centre, away from any edge).
    let [cx, cy] = centre(turned.geometry.points);
    await dragCanvas(ui, [cx, cy], [cx + 0.05, cy + 0.04], touch);
    await ui.frame.locator("#status").filter({ hasText: "已移動標記" }).waitFor();
    let moved = await get("box");
    assertTranslated(turned, moved, 0.05, 0.04);
    assert.equal(moved.provenance.editedByUser, true);

    // 4. Deselect (tap empty canvas), reselect by its body, drag again.
    await tap(ui, await point(ui, 0.05, 0.95), touch);
    await ui.frame.locator("#selection-outline [data-handle]").first().waitFor({ state: "detached" });
    [cx, cy] = centre(moved.geometry.points);
    await tap(ui, await point(ui, cx, cy), touch);
    await ui.frame.locator('#selection-outline [data-handle="rot"]').waitFor();
    await ui.frame.locator("#status").filter({ hasText: "已選取「R70」" }).waitFor();
    let prev = moved;
    await dragCanvas(ui, [cx, cy], [cx - 0.03, cy + 0.02], touch);
    await ui.frame.locator("#status").filter({ hasText: "已移動標記" }).waitFor();
    for (let i = 0; i < 20 && near((moved = await get("box")).geometry.points[0].x, prev.geometry.points[0].x, 0.001); i++) await ui.page.waitForTimeout(150);
    assertTranslated(prev, moved, -0.03, 0.02);

    // 5. One corner still moves on its own.
    prev = moved;
    const v = prev.geometry.points[1];
    await dragCanvas(ui, [v.x, v.y], [v.x + 0.04, v.y - 0.03], touch);
    await ui.frame.locator("#status").filter({ hasText: "已調整標記形狀" }).waitFor();
    moved = await get("box");
    assert.ok(near(moved.geometry.points[1].x, v.x + 0.04) && near(moved.geometry.points[1].y, v.y - 0.03), JSON.stringify(moved.geometry.points));
    for (const i of [0, 2, 3]) assert.deepEqual(moved.geometry.points[i], prev.geometry.points[i], "the other corners stay");
    assert.deepEqual(keep(moved), keep(original));

    // 6. After a reload the stored geometry is the last one, and the body still drags.
    await ui.reload();
    prev = await get("box");
    assert.deepEqual(prev.geometry.points, moved.geometry.points);
    await ui.frame.locator('[data-mode="select"]').click();
    [cx, cy] = centre(prev.geometry.points);
    await tap(ui, await point(ui, cx, cy), touch);
    await ui.frame.locator('#selection-outline [data-handle="rot"]').waitFor();
    await dragCanvas(ui, [cx, cy], [cx + 0.02, cy - 0.03], touch);
    await ui.frame.locator("#status").filter({ hasText: "已移動標記" }).waitFor();
    moved = await get("box");
    assertTranslated(prev, moved, 0.02, -0.03);

    // 7. A quadrilateral that was never a box drags by its body too.
    const q0 = await get("quad");
    [cx, cy] = centre(q0.geometry.points);
    await tap(ui, await point(ui, cx, cy), touch);
    await ui.frame.locator("#status").filter({ hasText: "已選取「Q」" }).waitFor();
    await dragCanvas(ui, [cx, cy], [cx - 0.04, cy - 0.05], touch);
    await ui.frame.locator("#status").filter({ hasText: "已移動標記" }).waitFor();
    const q1 = await get("quad");
    q1.geometry.points.forEach((p, i) => assert.ok(near(p.x - q0.geometry.points[i].x, -0.04) && near(p.y - q0.geometry.points[i].y, -0.05), "quad corner " + i));
    assert.deepEqual([q1.id, q1.label, q1.finding.note], ["quad", "Q", "四邊形"]);

    // The AI reads the moved shape as a quadrilateral.
    const read = (await s.call("present_visual", { imageId })).structuredContent.marks.find((x) => x.id === "box");
    assert.equal(read.shape, "quadrilateral");
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});
