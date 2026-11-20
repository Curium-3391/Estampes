// UVA Phase 4B-1: the shared annotation tools on a Graph document (gph:).
// Move, resize, reshape, rotate, text, labels, polling and two viewers run on
// both canvas kinds in their own tests (helpers/canvases.js). This file covers
// what is left: freehand with the highlighter, undo/redo, the camera (zoom
// and pan change nothing stored), layer visibility and opacity, a server
// restart, and the Graph-specific parts of the page.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noBrowser } from "./helpers/widget-host.js";
import { makeCanvas } from "./helpers/canvases.js";

const settled = (ui) => ui.frame.locator("#wb-bar:not(:empty)").waitFor();
async function point(ui, x, y) {
  await settled(ui);
  return ui.frame.locator("#surface").evaluate((svg, [x, y]) => {
    const p = svg.createSVGPoint(), vb = svg.getAttribute("viewBox").split(" ").map(Number);
    p.x = vb[0] + x * 1000; p.y = vb[1] + y * 750; const q = p.matrixTransform(svg.getScreenCTM()); return { x: q.x, y: q.y };
  }, [x, y]);
}
async function stroke(ui, pts) {
  await ui.page.waitForTimeout(300);
  const [first, ...rest] = await Promise.all(pts.map((p) => point(ui, ...p)));
  await ui.page.mouse.move(first.x, first.y); await ui.page.mouse.down();
  for (const q of rest) await ui.page.mouse.move(q.x, q.y, { steps: 4 });
  await ui.page.mouse.up();
}

test("a Graph takes the shared tools: highlighter, undo/redo, camera, layers, restart", { skip: noBrowser, timeout: 180000 }, async () => {
  let s = await startStack({ cas: false });
  try {
    const ok = async (name, args) => { const r = await s.call(name, args); assert.ok(!r.isError, name + ": " + JSON.stringify(r.content)); return r.structuredContent; };
    const imageId = await makeCanvas(s, "graph", { width: 1000, height: 750 });
    const ui = await s.open({ imageId });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    await settled(ui);

    // The page names it a Graph and offers no image-layer controls (add_image_layer refuses a Graph).
    assert.match(await ui.frame.locator("#caption").innerText(), /^函數圖 gph:/);
    assert.equal(await ui.frame.locator("#objects button", { hasText: "加入圖片／畫布圖層" }).count(), 0);
    assert.equal(await ui.frame.locator('#objects .obj[data-object]').count() > 0, true, "the axes are editable objects");

    // Freehand with the highlighter, in red.
    await ui.frame.locator('[data-mode="polyline"]').click();
    await ui.frame.locator('[data-pen="highlighter"]').click();
    await ui.frame.locator('[data-color="red"]').click();
    await stroke(ui, [[0.2, 0.3], [0.3, 0.35], [0.4, 0.3], [0.5, 0.4]]);
    await ui.frame.locator("#status").filter({ hasText: "已新增標註" }).waitFor();
    const drawnCount = () => ui.frame.locator("#fresh-annotations path, #fresh-annotations polyline").count();
    const withStroke = await drawnCount();
    assert.ok(withStroke > 0, "the stroke is drawn");

    // Undo and redo before sending.
    await ui.frame.locator("#undo").click();
    await ui.page.waitForTimeout(200);
    assert.ok((await drawnCount()) < withStroke, "undo removes the stroke");
    await ui.frame.locator("#redo").click();
    await ui.page.waitForTimeout(200);
    assert.equal(await drawnCount(), withStroke, "redo brings it back");

    // Send it: the Graph stores a highlighter polyline in red.
    await ui.frame.locator("#send").click();
    let mark;
    for (let i = 0; i < 40 && !mark; i++) { mark = (await ok("get_visual_state", { imageId })).marks.find((m) => m.type === "polyline"); if (!mark) await ui.page.waitForTimeout(150); }
    assert.ok(mark, "the stroke reached the Graph");
    assert.equal(mark.style?.pen ?? mark.pen, "highlighter", JSON.stringify(mark));
    assert.equal(mark.style?.color ?? mark.color, "red");
    const stored = await ok("get_visual_state", { imageId });

    // The camera: zoom in, pan, fit. Nothing stored changes.
    await ui.frame.locator("#zoom-in").click();
    await ui.frame.locator("#zoom-in").click();
    assert.notEqual(await ui.frame.locator("#zoom-level").innerText(), "100%");
    await ui.frame.locator('[data-mode="pan"]').click();
    await stroke(ui, [[0.5, 0.5], [0.4, 0.45]]);
    await ui.frame.locator("#zoom-fit").click();
    const after = await ok("get_visual_state", { imageId });
    assert.deepEqual(after.marks, stored.marks, "zoom and pan move no mark");
    assert.deepEqual(after.objects, stored.objects, "zoom and pan change no axes");

    // Layers: hide the person's layer, then set its opacity.
    const layers = (await ok("get_visual_layers", { imageId })).layers;
    const mine = layers.find((l) => l.id === mark.layer || l.id === mark.layerId) ?? layers.find((l) => l.author === "user");
    assert.ok(mine, JSON.stringify(layers));
    await ui.frame.locator("#layer-manager summary").click();
    const row = ui.frame.locator('#layer-manager .row[data-layer="' + mine.id + '"]');
    await row.locator("input[data-act=opacity]").fill("40");
    await row.locator("input[data-act=opacity]").dispatchEvent("change");
    await ui.frame.locator("#status").filter({ hasText: "已調整透明度" }).waitFor();
    await row.locator("input[data-act=toggle]").uncheck();
    await ui.frame.locator("#status").filter({ hasText: "已調整圖層顯示" }).waitFor();
    let st = (await ok("get_visual_layers", { imageId })).layers.find((l) => l.id === mine.id);
    assert.equal(st.opacity, 0.4); assert.equal(st.visible, false);
    assert.deepEqual(ui.errors, []);
    await ui.shot("graph-editing");

    // Restart: the mark and the layer settings come back.
    const dir = s.dir;
    await s.close();
    s = await startStack({ cas: false, env: { ESTAMPES_STORAGE_DIR: dir } });
    const back = await s.call("get_visual_state", { imageId });
    assert.ok(!back.isError, JSON.stringify(back.content));
    assert.deepEqual(back.structuredContent.marks.find((m) => m.id === mark.id)?.geometry, mark.geometry);
    st = (await s.call("get_visual_layers", { imageId })).structuredContent.layers.find((l) => l.id === mine.id);
    assert.equal(st.opacity, 0.4); assert.equal(st.visible, false);
  } finally { await s.close(); }
});
