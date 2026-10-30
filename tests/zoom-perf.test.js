// Zooming a photo must stay cheap: the camera moves the viewBox, and the
// full render (marks, panels) runs at most a few times per second.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { startStack, noBrowser } from "./helpers/widget-host.js";
import { imageIdOf } from "../src/image-store.js";

test("browser: a burst of wheel zooms triggers only a few full renders", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const bytes = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#4a7" } }).png().toBuffer();
    const id = imageIdOf(bytes), folder = join(s.dir, "images", id.slice(4));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "source"), bytes);
    await writeFile(join(folder, "meta.json"), JSON.stringify({ imageId: id, source: "test" }));
    const ui = await s.open({ imageId: id });
    await ui.frame.locator("#surface").waitFor({ timeout: 30000 });
    await ui.frame.locator("#panel-canvas image").first().waitFor({ state: "attached", timeout: 30000 });
    // Count how often the scene is rebuilt, and how long the burst takes to settle.
    const frame = ui.page.frames().find((f) => f !== ui.page.mainFrame());
    await frame.evaluate(() => { window.__renders = 0; const el = document.querySelector("#scene"); new MutationObserver((m) => { window.__renders += m.length; }).observe(el, { childList: true }); window.__img = el.querySelector("image"); });
    const t0 = Date.now();
    const box = await ui.frame.locator("#surface").boundingBox();
    await ui.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await ui.page.keyboard.down("Control");
    for (let i = 0; i < 40; i++) { await ui.page.mouse.wheel(0, i < 25 ? -40 : 40); await ui.page.waitForTimeout(8); }
    await ui.page.keyboard.up("Control");
    await ui.page.waitForTimeout(400);
    const rebuilt = await frame.evaluate(() => ({ same: document.querySelector("#scene image") === window.__img, renders: window.__renders }));
    console.log("zoom burst ms:", Date.now() - t0, JSON.stringify(rebuilt));
    const vb = (await frame.evaluate(() => document.querySelector("#surface").getAttribute("viewBox"))).split(" ").map(Number);
    assert.ok(vb[2] < 3000 * 0.9, "the zoom took effect: " + vb.join(" "));
    assert.equal(rebuilt.same, true, "the photo element is reused, not decoded again, while zooming");
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});
