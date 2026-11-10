// Browser test: every kind of content is a layer you can fade and reorder.
// A base image, an image laid over it, a Graph curve and marks share one
// list; opacity and order are saved on the server. (Fake host, not live ChatGPT.)
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noBrowser } from "./helpers/widget-host.js";

test("layers in a browser: base image + overlay image + Graph curve, fade and reorder", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    await s.enable(["org.estampes.graph"]);
    const mk = async (expression) => {
      const r = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression }, newCanvas: {} });
      return (JSON.stringify(r.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    };
    const a = await mk("x^2"), b = await mk("sin(x)");
    const composed = await s.call("add_image_layer", { imageId: a, sourceImageId: b, region: { x: 0.2, y: 0.2, x2: 0.8, y2: 0.8 } });
    assert.ok(!composed.isError, JSON.stringify(composed.content));
    const kinds = composed.structuredContent.objects.map((o) => o.type);
    assert.ok(kinds.filter((t) => t === "image").length >= 2, "base and overlay are both image layers: " + kinds);
    assert.ok(kinds.includes("function-plot"), "curves are layers too");

    const ui = await s.open({ imageId: a });
    await ui.frame.locator("#layer-manager summary").click({ timeout: 20000 });
    const rows = ui.frame.locator("#layer-manager .row");
    await rows.first().waitFor({ timeout: 20000 });
    const n = await rows.count();
    assert.ok(n >= 3, "layers listed: " + n);
    // Image layers arrive as previews; the widget swaps in the full PNG.
    let hrefs = [];
    for (let i = 0; i < 60; i++) {
      hrefs = await ui.frame.locator("#scene-objects image, #unified-layers image").evaluateAll((els) => els.map((e) => e.getAttribute("href").slice(0, 30)));
      if (hrefs.length >= 2 && hrefs.every((h) => h.startsWith("data:image/png"))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(hrefs.length >= 2 && hrefs.every((h) => h.startsWith("data:image/png")), "full layer pixels loaded: " + hrefs);
    await ui.shot("layers-1-before");

    // Fade the top layer to 50% with its slider; the server remembers it.
    const top = rows.first();
    const id = await top.getAttribute("data-layer");
    const slider = top.locator("input[data-act=opacity]");
    await slider.fill("50");
    await slider.dispatchEvent("change");
    let saved;
    for (let i = 0; i < 40 && !saved; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const st = (await s.call("present_visual", { imageId: a })).structuredContent;
      saved = st.layers.find((l) => l.opacity === 0.5);
    }
    assert.ok(saved, "opacity 50% saved for " + id);
    assert.ok(await ui.frame.locator('#scene-objects g[opacity="0.5"], #unified-layers g[opacity="0.5"]').count() >= 1, "the drawing is actually faded");
    await ui.shot("layers-2-faded");

    // Move it down one level; the order is saved.
    const before = (await s.call("present_visual", { imageId: a })).structuredContent.layers.map((l) => l.id);
    await rows.first().locator("button[data-act=down]").click();
    let after;
    for (let i = 0; i < 40 && !after; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const order = (await s.call("present_visual", { imageId: a })).structuredContent.layers.map((l) => l.id);
      if (order.join() !== before.join()) after = order;
    }
    assert.ok(after, "the new order was saved");
    await ui.shot("layers-3-reordered");
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});
