// #69: the AI's marks are shared: the user can drag them and resize or
// reshape them with handles, on desktop and touch. Author, note and ID stay.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { startStack, noBrowser } from "./helpers/widget-host.js";

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
// Both ends measured at once, after the layout below the canvas settles
// (the selection panel and status line change height as you select).
async function dragCanvas(ui, a, b, touch) {
  await ui.page.waitForTimeout(300);
  const from = await point(ui, ...a), to = await point(ui, ...b);
  await drag(ui, from, to, touch);
}
const tap = async (ui, p, touch) => (touch ? ui.page.touchscreen.tap(p.x, p.y) : ui.page.mouse.click(p.x, p.y));
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

for (const touch of [false, true]) test("drag, resize and reshape the AI's marks: " + (touch ? "mobile touch" : "desktop"), { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const ok = async (name, args) => { const r = await s.call(name, args); assert.ok(!r.isError, JSON.stringify(r.content)); return r.structuredContent; };
    const data = (await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ddd" } }).png().toBuffer()).toString("base64");
    const imageId = (await ok("upload_visual_image", { total: data.length, offset: 0, data })).imageId;
    await ok("present_visual", { imageId, annotations: [
      { id: "box", type: "rect", x: 0.2, y: 0.2, x2: 0.4, y2: 0.4, label: "晶片", note: "AI 的說明" },
      { id: "arr", type: "arrow", x: 0.6, y: 0.7, x2: 0.8, y2: 0.8 },
    ] });
    const ui = await s.open({ imageId, touch, viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    await ui.frame.locator("#stored-annotations rect, #unified-layers rect").first().waitFor();
    await ui.frame.locator('[data-mode="select"]').click();
    const box = () => ok("get_visual_state", { imageId }).then((st) => st.marks.find((m) => m.id === "box"));

    // Move: grab the box's edge line and drag it.
    await tap(ui, await point(ui, 0.2, 0.3), touch);
    await ui.frame.locator("#selection-outline [data-handle]").first().waitFor();
    assert.equal(await ui.frame.locator("#selection-outline [data-handle]").count(), 8, "a box has corner and side handles");
    await dragCanvas(ui, [0.25, 0.2], [0.30, 0.25], touch);
    await ui.frame.locator("#status").filter({ hasText: "已移動標記" }).waitFor();
    let m = await box();
    assert.ok(near(m.geometry.x, 0.25) && near(m.geometry.x2, 0.45), JSON.stringify(m.geometry));
    assert.ok(near(m.geometry.x2 - m.geometry.x, 0.2, 0.005), "a move keeps the size");

    // Resize: the bottom-right corner handle.
    const g = m.geometry;
    await dragCanvas(ui, [g.x2, g.y2], [0.6, 0.55], touch);
    await ui.frame.locator("#status").filter({ hasText: "已調整標記大小" }).waitFor();
    m = await box();
    assert.ok(near(m.geometry.x2, 0.6) && near(m.geometry.y2, 0.55), JSON.stringify(m.geometry));
    assert.ok(near(m.geometry.x, g.x, 0.002) && near(m.geometry.y, g.y, 0.002), "the opposite corner stays");
    assert.equal(m.id, "box"); assert.equal(m.provenance.author, "assistant"); assert.equal(m.provenance.editedByUser, true);
    assert.equal(m.finding.note, "AI 的說明");
    await ui.shot("annotation-handles-resized-" + (touch ? "mobile" : "desktop"));

    // Reshape: an arrow's end.
    await tap(ui, await point(ui, 0.7, 0.75), touch);
    await ui.frame.locator("#selection-outline [data-handle]").nth(1).waitFor();
    assert.equal(await ui.frame.locator("#selection-outline [data-handle]").count(), 2);
    await dragCanvas(ui, [0.8, 0.8], [0.9, 0.6], touch);
    await ui.frame.locator("#status").filter({ hasText: "已調整標記形狀" }).waitFor();
    const st = await ok("get_visual_state", { imageId }), arr = st.marks.find((x) => x.id === "arr");
    assert.ok(near(arr.geometry.x2, 0.9) && near(arr.geometry.y2, 0.6), JSON.stringify(arr.geometry));
    assert.ok(near(arr.geometry.x, 0.6, 0.002), "the other end stays");

    // The AI is told what changed, with geometry.
    const r = await s.call("present_visual", { imageId });
    const text = r.content.map((c) => c.text ?? "").join(" ");
    assert.match(text, /moved YOUR mark box/); assert.match(text, /resized YOUR mark box/); assert.match(text, /reshaped YOUR mark arr/);

    // Reload keeps the edited geometry.
    await ui.reload();
    m = await box();
    assert.ok(near(m.geometry.x2, 0.6));
  } finally { await s.close(); }
});
