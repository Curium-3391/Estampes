// #81: the AI checking or iterating on the canvas does not reopen the user's
// canvas. A background result shows a one-line note; explicit presentation
// (present_visual) still opens the shared editable surface.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { startStack, noBrowser } from "./helpers/widget-host.js";
import { inBackground } from "../src/modules/mcp-tools.js";

test("inBackground flags the widget and tells the model, but leaves errors alone", () => {
  const r = inBackground({ content: [{ type: "text", text: "done" }], structuredContent: { kind: "estampes.visual_surface" }, _meta: { a: 1 } });
  assert.equal(r._meta["estampes/presentation"], "background");
  assert.equal(r._meta.a, 1);
  assert.equal(r.content[0].text, "done");
  assert.match(r.content.at(-1).text, /canvas was not reopened.*present_visual/);
  const err = { isError: true, content: [{ type: "text", text: "x" }] };
  assert.equal(inBackground(err), err);
});

test("execute_module present:false runs Graph in the background; the default still presents", { timeout: 60000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const prepared = await s.call("prepare_module_change", { action: "enable", module: "org.estampes.graph" });
    const plan = prepared.structuredContent.plan;
    const committed = await s.call("store_commit_plan", { planId: plan.planId, consent: prepared._meta["estampes/consent"].consent });
    assert.equal(committed.structuredContent.result.state, "enabled");
    const quiet = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "sin(x)" }, present: false });
    assert.ok(!quiet.isError, JSON.stringify(quiet.content));
    assert.equal(quiet._meta["estampes/presentation"], "background");
    assert.ok(quiet.content.some((c) => c.type === "image"), "the AI still gets its preview pixels");
    const canvas = quiet.structuredContent.imageId;
    const loud = await s.call("execute_module", { module: "org.estampes.graph", capability: "update_plot", canvas, params: { object: "o2", expression: "sin(2x)" } });
    assert.ok(!loud.isError, JSON.stringify(loud.content));
    assert.equal(loud._meta["estampes/presentation"], undefined);
    // A stale revision is still a clear error, in the background too.
    const stale = await s.call("execute_module", { module: "org.estampes.graph", capability: "update_plot", canvas, expectedRevision: 0, params: { object: "o2", expression: "x" }, present: false });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /revision/i);
  } finally { await s.close(); }
});

test("a background result shows a note, not the canvas, until the user opens it", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const data = (await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ddd" } }).png().toBuffer()).toString("base64");
    const imageId = (await s.call("upload_visual_image", { total: data.length, offset: 0, data })).structuredContent.imageId;
    await s.call("present_visual", { imageId, annotations: [{ id: "a", type: "rect", x: 0.2, y: 0.2, x2: 0.4, y2: 0.4 }] });
    const ui = await s.open({ imageId, result: async () => inBackground(await s.call("present_visual", { imageId })) });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    const note = ui.frame.locator(".background-note");
    await note.waitFor();
    assert.match(await note.textContent(), /背景/);
    assert.equal(await ui.frame.locator("#surface").isVisible(), false, "the canvas is not reopened");
    await ui.shot("background-note");
    await ui.frame.getByRole("button", { name: "顯示畫布" }).click();
    await ui.frame.locator("#surface").waitFor();
    await ui.frame.locator("#stored-annotations rect, #unified-layers rect").first().waitFor();
    assert.equal(await note.count(), 0);
    // Explicit presentation opens the editable canvas directly.
    const ui2 = await s.open({ imageId });
    await ui2.frame.locator("#surface").waitFor();
    assert.equal(await ui2.frame.locator(".background-note").count(), 0);
  } finally { await s.close(); }
});
