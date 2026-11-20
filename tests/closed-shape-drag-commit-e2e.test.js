// #70: dragging a closed shape by its body must commit: after release the shape
// stays where it was dropped, through re-renders, a reload and server sync.
// Covers the paths a real host takes: a drawn-but-unsent shape (local state),
// a sent user shape, and a re-read of the canvas between pointer events.
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
  await drag(ui, await point(ui, ...a), await point(ui, ...b), touch);
}
const tap = async (ui, p, touch) => (touch ? ui.page.touchscreen.tap(p.x, p.y) : ui.page.mouse.click(p.x, p.y));
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const centre = (pts) => [pts.reduce((s, p) => s + p.x, 0) / pts.length, pts.reduce((s, p) => s + p.y, 0) / pts.length];
// The polyline the widget currently draws, in canvas units (0..1).
const drawn = (ui) => ui.frame.locator("#surface").evaluate((svg) => {
  const vb = svg.getAttribute("viewBox").split(" ").map(Number);
  return [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d")).filter((d) => d && /Z$/.test(d)).map((d) =>
    d.replace(/Z$/, "").slice(1).split("L").map((s) => s.trim().split(/\s+/).map(Number)).map(([x, y]) => ({ x: x / vb[2], y: y / vb[3] })));
});

for (const kind of CANVAS_KINDS) for (const touch of [false, true]) test("a closed shape stays where it is dropped: " + (touch ? "mobile touch" : "desktop") + ", " + kind, { skip: noBrowser, timeout: 150000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const ok = async (name, args) => { const r = await s.call(name, args); assert.ok(!r.isError, JSON.stringify(r.content)); return r.structuredContent; };
    const data = (await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ddd" } }).png().toBuffer()).toString("base64");
    const imageId = await makeCanvas(s, kind);
    const ui = await s.open({ imageId, touch, viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    await settled(ui);
    const get = async (id) => (await ok("get_visual_state", { imageId })).marks.find((m) => m.id === id);
    const status = () => ui.frame.locator("#status").innerText();

    // A: draw a quadrilateral and drag it BEFORE sending (local, unsent state).
    await ui.frame.locator('[data-mode="quad"]').click();
    await dragCanvas(ui, [0.3, 0.3], [0.5, 0.5], touch);
    await ui.frame.locator("#status").filter({ hasText: "已新增標註" }).waitFor();
    await ui.frame.locator('[data-mode="select"]').click();
    await tap(ui, await point(ui, 0.4, 0.4), touch);
    await ui.frame.locator('#selection-outline [data-handle="rot"]').waitFor();
    const before = (await drawn(ui)).at(-1);
    await dragCanvas(ui, [0.4, 0.4], [0.5, 0.45], touch);
    await ui.page.waitForTimeout(500);
    const after = (await drawn(ui)).at(-1);
    console.log("unsent:", await status(), JSON.stringify(before[0]), JSON.stringify(after[0]));
    after.forEach((p, i) => assert.ok(near(p.x - before[i].x, 0.1) && near(p.y - before[i].y, 0.05), "unsent corner " + i + " " + JSON.stringify([before[i], p])));

    // B: send it, then drag again (server-held, user's own shape).
    await ui.frame.locator("#send").click();
    let quad;
    for (let i = 0; i < 40 && !quad; i++) { quad = (await ok("get_visual_state", { imageId })).marks.find((m) => m.type === "polyline"); if (!quad) await ui.page.waitForTimeout(150); }
    assert.ok(quad);
    let [cx, cy] = centre(quad.geometry.points);
    // Sending scrolls the page; bring the canvas back before tapping (a Graph
    // has its axes editor below the canvas, so the page is longer).
    await ui.frame.locator("#surface").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await tap(ui, await point(ui, cx, cy), touch);
    await ui.frame.locator('#selection-outline [data-handle="rot"]').waitFor();
    await dragCanvas(ui, [cx, cy], [cx + 0.1, cy + 0.1], touch);
    await ui.page.waitForTimeout(800);
    console.log("sent:", await status());
    const moved = await get(quad.id);
    moved.geometry.points.forEach((p, i) => assert.ok(near(p.x - quad.geometry.points[i].x, 0.1) && near(p.y - quad.geometry.points[i].y, 0.1), "sent corner " + i));
    // What the widget draws is the same, and survives a reload.
    const shown = (await drawn(ui)).at(-1);
    shown.forEach((p, i) => assert.ok(near(p.x, moved.geometry.points[i].x, 0.002) && near(p.y, moved.geometry.points[i].y, 0.002), "drawn corner " + i));
    await ui.reload();
    assert.deepEqual((await get(quad.id)).geometry.points, moved.geometry.points);
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});

// An AI-made quadrilateral is held by the server: its drag goes through
// edit_visual_canvas. Dropping it commits; if the browser or host cancels the
// gesture instead (pointercancel), the mark goes back and the status says why.
test("an AI-made quadrilateral: drop commits, a cancelled drag says why", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const ok = async (name, args) => { const r = await s.call(name, args); assert.ok(!r.isError, JSON.stringify(r.content)); return r.structuredContent; };
    const data = (await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ddd" } }).png().toBuffer()).toString("base64");
    const imageId = (await ok("upload_visual_image", { total: data.length, offset: 0, data })).imageId;
    await ok("present_visual", { imageId, annotations: [{ id: "q", type: "polyline", closed: true, color: "cyan", size: "thin", points: [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.42 }, { x: 0.58, y: 0.6 }, { x: 0.42, y: 0.58 }], label: "Q", note: "AI 四邊形" }] });
    const get = async () => (await ok("get_visual_state", { imageId })).marks.find((m) => m.id === "q");
    const ui = await s.open({ imageId, globals: true });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    await settled(ui);
    await ui.frame.locator('[data-mode="select"]').click();
    await tap(ui, await point(ui, 0.5, 0.5), false);
    await ui.frame.locator("#status").filter({ hasText: "已選取「Q」" }).waitFor();
    const start = await get();
    // Drop: moved, persisted, and the drawn shape matches after a re-render and a reload.
    await dragCanvas(ui, [0.5, 0.5], [0.6, 0.6], false);
    await ui.frame.locator("#status").filter({ hasText: "已移動標記" }).waitFor();
    const moved = await get();
    moved.geometry.points.forEach((p, i) => assert.ok(near(p.x - start.geometry.points[i].x, 0.1) && near(p.y - start.geometry.points[i].y, 0.1)));
    assert.deepEqual([moved.id, moved.label, moved.finding.note, moved.provenance.author], ["q", "Q", "AI 四邊形", "assistant"]);
    // Tapping the status line shows a diagnostics block that says what was sent and what the server answered, for a live bug report.
    await ui.frame.locator("#status").click();
    const diagText = await ui.frame.locator("#diag-text").innerText();
    assert.match(diagText, /最近修改: q acknowledged/); assert.match(diagText, /送出座標 \(0\.\d+,0\.\d+\)/); assert.match(diagText, /伺服器回傳 \(0\.\d+,0\.\d+\)/); assert.match(diagText, /來源: host result/);
    await ui.page.waitForTimeout(2500); // a poll must not bring the old place back
    assert.match(await ui.frame.locator("#diag-text").innerText(), /輪詢: [1-9]\d* 次.*正常.*已套用 [1-9]/s);
    assert.deepEqual((await get()).geometry.points, moved.geometry.points);
    await ui.reload();
    assert.deepEqual((await get()).geometry.points, moved.geometry.points);
    // Cancel: the host takes the gesture away mid-drag.
    await ui.frame.locator('[data-mode="select"]').click();
    const [cx, cy] = centre(moved.geometry.points);
    await tap(ui, await point(ui, cx, cy), false);
    await ui.frame.locator("#status").filter({ hasText: "已選取「Q」" }).waitFor();
    await ui.page.waitForTimeout(300);
    const a = await point(ui, cx, cy), b = await point(ui, cx - 0.1, cy - 0.1);
    await ui.page.mouse.move(a.x, a.y); await ui.page.mouse.down(); await ui.page.waitForTimeout(100);
    await ui.page.mouse.move(b.x, b.y, { steps: 5 });
    await ui.frame.locator("#surface").evaluate((svg) => { const h = svg.querySelector("[data-hit], #hit") ?? [...svg.querySelectorAll("rect")].at(-1); h.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true })); });
    await ui.frame.locator("#status").filter({ hasText: "已還原" }).waitFor();
    await ui.page.mouse.up();
    await ui.page.waitForTimeout(500);
    assert.deepEqual((await get()).geometry.points, moved.geometry.points, "a cancelled drag changes nothing");
  } finally { await s.close(); }
});

// A refresh in the host rebuilds the widget from the OLD tool result (the AI's mark at its first place).
// After the user moved it, the poll must bring the moved place back, and the diagnostics must say where marks came from.
test("a widget rebuilt from the old tool result shows the moved AI quadrilateral", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const ok = async (name, args) => { const r = await s.call(name, args); assert.ok(!r.isError, JSON.stringify(r.content)); return r; };
    const data = (await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ddd" } }).png().toBuffer()).toString("base64");
    const imageId = (await ok("upload_visual_image", { total: data.length, offset: 0, data })).structuredContent.imageId;
    const first = await ok("present_visual", { imageId, annotations: [{ id: "q", type: "polyline", closed: true, points: [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.42 }, { x: 0.58, y: 0.6 }, { x: 0.42, y: 0.58 }], label: "Q" }] });
    const ui = await s.open({ imageId, globals: true, result: async () => first });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    await settled(ui);
    await ok("edit_visual_canvas", { imageId, marks: [{ id: "q", type: "polyline", closed: true, points: [{ x: 0.7, y: 0.7 }, { x: 0.9, y: 0.72 }, { x: 0.88, y: 0.9 }, { x: 0.72, y: 0.88 }] }] });
    await ui.reload(); // the old result again
    await settled(ui);
    let corner;
    for (let i = 0; i < 30 && !(corner && near(corner.x, 0.7, 0.002)); i++) { await ui.page.waitForTimeout(200); corner = (await drawn(ui)).at(-1)?.[0]; }
    assert.ok(corner && near(corner.x, 0.7, 0.002) && near(corner.y, 0.7, 0.002), "the moved place, not the first one: " + JSON.stringify(corner));
    await ui.frame.locator("#status").click();
    assert.match(await ui.frame.locator("#diag-text").innerText(), /已套用 [1-9]/);
  } finally { await s.close(); }
});

// A poll answer that was fetched before the user's last edit finished must not draw the mark at its
// previous place while that edit is still on its way to the server (the "springs back, then returns" flicker).
test("a poll snapshot older than an edit in flight does not move the mark back", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const ok = async (name, args) => { const r = await s.call(name, args); assert.ok(!r.isError, JSON.stringify(r.content)); return r.structuredContent; };
    const data = (await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ddd" } }).png().toBuffer()).toString("base64");
    const imageId = (await ok("upload_visual_image", { total: data.length, offset: 0, data })).imageId;
    await ok("present_visual", { imageId, annotations: [{ id: "q", type: "polyline", closed: true, color: "cyan", size: "thin", points: [{ x: 0.3, y: 0.3 }, { x: 0.5, y: 0.32 }, { x: 0.48, y: 0.5 }, { x: 0.32, y: 0.48 }], label: "Q" }] });
    const ui = await s.open({ imageId, globals: true });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    await settled(ui);
    await ui.frame.locator('[data-mode="select"]').click();
    await tap(ui, await point(ui, 0.4, 0.4), false);
    await ui.frame.locator("#status").filter({ hasText: "已選取「Q」" }).waitFor();
    // Polls are held back until told otherwise, so none picks the first edit's revision up early.
    await ui.page.evaluate(() => { const orig = window.hostCall; window.blockPoll = true; window.hostCall = async (p) => (p.name === "documents_get_changes" && window.blockPoll ? { content: [], structuredContent: { kind: "estampes.documents_changes", documents: [] } } : orig(p)); });
    // First move: acknowledged by the server, but no poll has picked that revision up yet.
    await dragCanvas(ui, [0.4, 0.4], [0.5, 0.4], false);
    await ui.frame.locator("#status").filter({ hasText: "已移動標記" }).waitFor();
    // Second move: its answer is held back, as on a slow link.
    await ui.page.evaluate(() => { const orig = window.hostCall; window.heldEdit = new Promise((r) => { window.releaseEdit = r; }); window.hostCall = async (p) => { if (p.name === "edit_visual_canvas") await window.heldEdit; return orig(p); }; });
    await dragCanvas(ui, [0.5, 0.4], [0.6, 0.5], false);
    await ui.page.waitForTimeout(300);
    const second = (await drawn(ui)).at(-1)[0];
    assert.ok(near(second.x, 0.5, 0.01) && near(second.y, 0.4, 0.01), "the mark follows the second drop: " + JSON.stringify(second));
    // A poll that answers now describes the state after the FIRST edit.
    await ui.page.evaluate(() => { window.blockPoll = false; });
    await ui.frame.locator("body").evaluate(() => window.estampesSurface.pollNow());
    await ui.page.waitForTimeout(300);
    const during = (await drawn(ui)).at(-1)[0];
    assert.ok(near(during.x, second.x, 0.002) && near(during.y, second.y, 0.002), "no flicker back while the edit is in flight: " + JSON.stringify([second, during]));
    await ui.page.evaluate(() => window.releaseEdit());
    await ui.frame.locator("#status").filter({ hasText: "已移動標記" }).waitFor();
    await ui.page.waitForTimeout(800);
    const end = (await drawn(ui)).at(-1)[0], server = (await ok("get_visual_state", { imageId })).marks.find((m) => m.id === "q").geometry.points[0];
    assert.ok(near(end.x, server.x, 0.002) && near(end.y, server.y, 0.002), "the final place is the server's: " + JSON.stringify([end, server]));
    assert.ok(near(end.x, second.x, 0.002) && near(end.y, second.y, 0.002));
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});
