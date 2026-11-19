// A layer's stored default name follows the viewer's language in the layer
// list (RFC docs/rfc/i18n Phase 4); the stored name does not change.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { startStack, noBrowser } from "./helpers/widget-host.js";

test("the layer list shows the AI's default layer name in the viewer's language", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const data = (await sharp({ create: { width: 400, height: 300, channels: 3, background: "#ddd" } }).png().toBuffer()).toString("base64");
    const imageId = (await s.call("upload_visual_image", { total: data.length, offset: 0, data })).structuredContent.imageId;
    const drawn = await s.call("present_visual", { imageId, annotations: [{ id: "box", type: "rect", x: 0.2, y: 0.2, x2: 0.4, y2: 0.4 }] });
    assert.ok(!drawn.isError, JSON.stringify(drawn.content));
    const stored = () => s.call("get_visual_state", { imageId }).then((r) => r.structuredContent.layers.map((l) => l.name));
    assert.deepEqual(await stored(), ["AI · 第1次"], "the server writes the name in its own language");
    const ui = await s.open({ imageId });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    const row = ui.frame.locator("#layers .layer-evidence-button");
    await ui.frame.locator("#layer-manager summary").click();
    await row.filter({ hasText: "AI · 第1次" }).first().waitFor();
    const host = (locale) => ui.page.evaluate((locale) => document.getElementById("w").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { locale } }, "*"), locale);
    await host("en-US");
    await row.filter({ hasText: "AI · #1" }).first().waitFor();
    await host("zh-TW");
    await row.filter({ hasText: "AI · 第1次" }).first().waitFor();
    assert.deepEqual(await stored(), ["AI · 第1次"], "showing it in another language never rewrites it");
  } finally { await s.close(); }
});
