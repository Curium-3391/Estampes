// The eraser (UVA Phase 4, whole-mark erasing): touching a mark or dragging
// across marks deletes each whole mark; a mark in a locked layer stays; a
// sent delete can be undone. On an image and on a Graph.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noBrowser } from "./helpers/widget-host.js";
import { CANVAS_KINDS, makeCanvas } from "./helpers/canvases.js";

const settled = (ui) => ui.frame.locator("#wb-bar:not(:empty)").waitFor();
async function point(ui, x, y) {
  await settled(ui);
  return ui.frame.locator("#surface").evaluate((svg, [x, y]) => {
    const p = svg.createSVGPoint(), vb = svg.getAttribute("viewBox").split(" ").map(Number);
    p.x = vb[0] + x * vb[2]; p.y = vb[1] + y * vb[3]; const q = p.matrixTransform(svg.getScreenCTM()); return { x: q.x, y: q.y };
  }, [x, y]);
}

for (const kind of CANVAS_KINDS) test("the eraser deletes whole marks by touch or drag, spares a locked layer, and a delete can be undone: " + kind, { skip: noBrowser, timeout: 180000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const ok = async (name, args) => { const r = await s.call(name, args); assert.ok(!r.isError, name + ": " + JSON.stringify(r.content)); return r.structuredContent; };
    const ids = async () => (await ok("get_visual_state", { imageId })).marks.map((m) => m.id).sort();
    const imageId = await makeCanvas(s, kind);
    // A first layer that gets locked, then a second layer with marks to erase.
    await ok("present_visual", { imageId, annotations: [{ id: "keep", type: "rect", x: 0.6, y: 0.1, x2: 0.8, y2: 0.2, label: "keep" }] });
    const keepLayer = (await ok("get_visual_state", { imageId })).marks.find((m) => m.id === "keep").layer;
    await ok("edit_visual_canvas", { imageId, layers: [{ id: keepLayer, locked: true }] });
    await ok("present_visual", { imageId, annotations: [
      { id: "a", type: "rect", x: 0.1, y: 0.3, x2: 0.25, y2: 0.4, label: "a" },
      { id: "b", type: "rect", x: 0.4, y: 0.3, x2: 0.55, y2: 0.4, label: "b" },
      { id: "c", type: "arrow", x: 0.1, y: 0.7, x2: 0.3, y2: 0.8, label: "c" },
      { id: "d", type: "rect", x: 0.6, y: 0.6, x2: 0.8, y2: 0.7, label: "d" },
    ] });
    assert.deepEqual(await ids(), ["a", "b", "c", "d", "keep"]);
    const ui = await s.open({ imageId, viewport: { width: 1280, height: 900 } });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    await ui.frame.locator("#stored-annotations rect, #unified-layers rect").first().waitFor();
    const eraser = ui.frame.locator('[data-mode="erase"]');
    await eraser.click();
    assert.equal(await eraser.getAttribute("aria-pressed"), "true");

    // One touch on the edge of "d": only that mark goes.
    let at = await point(ui, 0.6, 0.65);
    await ui.page.mouse.click(at.x, at.y);
    for (let i = 0; i < 40 && (await ids()).includes("d"); i++) await ui.page.waitForTimeout(150);
    assert.deepEqual(await ids(), ["a", "b", "c", "keep"], "one mark erased, whole");

    // One drag across the edges of "a" and "b" (a fast sweep with few samples): both go.
    const from = await point(ui, 0.1, 0.35), to = await point(ui, 0.55, 0.35);
    await ui.page.mouse.move(from.x, from.y); await ui.page.mouse.down();
    await ui.page.mouse.move(to.x, to.y, { steps: 2 }); await ui.page.mouse.up();
    for (let i = 0; i < 40 && ((await ids()).includes("a") || (await ids()).includes("b")); i++) await ui.page.waitForTimeout(150);
    assert.deepEqual(await ids(), ["c", "keep"], "a drag erased both marks it crossed");

    // The locked layer's mark stays, and the person is told why.
    at = await point(ui, 0.6, 0.15);
    await ui.page.mouse.click(at.x, at.y);
    await ui.frame.locator("#status").filter({ hasText: /locked|鎖定/ }).waitFor();
    assert.deepEqual(await ids(), ["c", "keep"], "a locked mark is not erased");

    // Undo the last erase (b, then a were sent deletes): the mark comes back.
    await ui.frame.locator("#undo").click();
    for (let i = 0; i < 40 && (await ids()).length === 2; i++) await ui.page.waitForTimeout(150);
    assert.equal((await ids()).length, 3, "undo brought a mark back: " + JSON.stringify(await ids()));
  } finally { await s.close(); }
});
