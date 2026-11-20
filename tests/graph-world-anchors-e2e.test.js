// UVA Phase 4B-3 in the page: the selection bar of a Graph mark offers
// 固定在座標 (follow the axes) / 固定在畫面 (stay on the page, the default);
// a mark fixed to the axes whose place leaves the axes range is not drawn and
// is listed under 超出座標範圍. An image canvas has no such choice.
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
const markText = (ui) => ui.frame.locator("#stored-annotations text, #unified-layers text").evaluateAll((els) => els.map((e) => e.textContent ?? ""));

test("a Graph mark can be fixed to the axes from the selection bar; outside the range it is listed, not drawn", { skip: noBrowser, timeout: 180000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const ok = async (name, args) => { const r = await s.call(name, args); assert.ok(!r.isError, name + ": " + JSON.stringify(r.content)); return r.structuredContent; };
    const imageId = await makeCanvas(s, "graph", { width: 1000, height: 750 });
    await ok("present_visual", { imageId, annotations: [
      { id: "p", type: "rect", x: 0.2, y: 0.2, x2: 0.4, y2: 0.4, label: "頁面框" },
      { id: "w", type: "rect", x: 2, y: 2, x2: 6, y2: 6, label: "資料框", anchor: { space: "world" } },
    ] });
    let ui = await s.open({ imageId });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    await ui.frame.locator("#stored-annotations rect, #unified-layers rect").first().waitFor();
    await ui.frame.locator('[data-mode="select"]').click();

    // Select the page mark: the choice shows 固定在畫面 pressed.
    const at = await point(ui, 0.2, 0.3);
    await ui.page.mouse.click(at.x, at.y);
    const toAxes = ui.frame.locator('#selection button[data-act="anchor"][data-space="world"]');
    await toAxes.waitFor();
    assert.equal(await toAxes.innerText(), "固定在座標");
    assert.equal(await toAxes.getAttribute("aria-pressed"), "false");
    assert.equal(await ui.frame.locator('#selection button[data-space="document"]').getAttribute("aria-pressed"), "true");
    await toAxes.click();
    await ui.frame.locator("#status").filter({ hasText: "已固定在座標" }).waitFor();
    const p = (await ok("get_visual_state", { imageId })).marks.find((m) => m.id === "p");
    assert.equal(p.anchor?.space, "world", JSON.stringify(p));
    assert.deepEqual([p.geometry.x, p.geometry.y, p.geometry.x2, p.geometry.y2], [0.2, 0.2, 0.4, 0.4], "fixing it did not move it");
    assert.equal(await toAxes.getAttribute("aria-pressed"), "true");
    assert.equal(await ui.frame.locator("#anchor-notice").isHidden(), true);

    // Axes x 0..10: the data box is still inside, the former page box (x about -7..-3) is not.
    await ok("execute_module", { module: "org.estampes.graph", capability: "set_axes", canvas: imageId, params: { xRange: [0, 10], yRange: [-10, 10] }, present: false });
    const st = await ok("get_visual_state", { imageId });
    assert.equal(st.marks.find((m) => m.id === "p").anchor.status, "outside");
    assert.equal(st.marks.find((m) => m.id === "w").anchor.status, "ok");
    ui = await s.open({ imageId });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    const notice = ui.frame.locator("#anchor-notice");
    await notice.filter({ hasText: "超出座標範圍" }).waitFor();
    assert.match(await notice.innerText(), /頁面框/);
    const drawn = await markText(ui);
    assert.ok(drawn.some((x) => x.includes("資料框")), "the data box is drawn: " + JSON.stringify(drawn));
    assert.ok(!drawn.some((x) => x.includes("頁面框")), "the outside box is not drawn: " + JSON.stringify(drawn));
  } finally { await s.close(); }
});

test("an image canvas offers no axes choice", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const imageId = await makeCanvas(s, "image");
    const r = await s.call("present_visual", { imageId, annotations: [{ id: "p", type: "rect", x: 0.2, y: 0.2, x2: 0.4, y2: 0.4 }] });
    assert.ok(!r.isError);
    const ui = await s.open({ imageId });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    await ui.frame.locator("#stored-annotations rect, #unified-layers rect").first().waitFor();
    await ui.frame.locator('[data-mode="select"]').click();
    const at = await point(ui, 0.2, 0.3);
    await ui.page.mouse.click(at.x, at.y);
    await ui.frame.locator('#selection button[data-act="deselect"]').waitFor();
    assert.equal(await ui.frame.locator('#selection button[data-act="anchor"]').count(), 0);
  } finally { await s.close(); }
});
