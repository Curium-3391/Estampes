// Browser test: an empty upload canvas, a photo picked in the widget, sent
// in slices, shown first as a preview and then at full display size, and
// reported to the model through ui/update-model-context.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { startStack, noBrowser } from "./helpers/widget-host.js";

async function noisyJpeg(w, h) {
  const raw = Buffer.alloc(w * h * 3);
  let x = 3;
  for (let i = 0; i < raw.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; raw[i] = ((i % 3) * 70 + (x >> 16) % 90) & 255; }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

test("pick a photo in the canvas: upload in slices, preview then full image, model told", { skip: noBrowser, timeout: 90000 }, async () => {
  const stack = await startStack({ cas: false });
  try {
    const { page, frame, errors } = await stack.open({ result: () => stack.call("present_visual", { upload: true }) });
    await page.evaluate(() => {
      window.sent = [];
      addEventListener("message", (e) => { if (e.data?.jsonrpc === "2.0" && e.data.method) window.sent.push({ method: e.data.method, params: e.data.params }); });
    });
    await frame.locator("#status").filter({ hasText: "選擇圖片／拍照" }).waitFor({ timeout: 15000 });
    assert.ok(await frame.locator("#upload-big").isVisible());
    assert.ok(!(await frame.locator("#surface").isVisible()), "no demo picture behind an upload canvas");

    const photo = await noisyJpeg(3000, 2000);
    await frame.locator("#upload-file").setInputFiles({ name: "board.jpg", mimeType: "image/jpeg", buffer: photo });
    await frame.locator("#status").filter({ hasText: "已上傳" }).waitFor({ timeout: 60000 });
    assert.ok(await frame.locator("#surface").isVisible());

    const sent = await page.evaluate(() => window.sent);
    const uploads = sent.filter((m) => m.method === "tools/call" && m.params?.name === "upload_visual_image");
    assert.ok(uploads.length >= 2, "sent in slices: " + uploads.length);
    const told = sent.find((m) => m.method === "ui/update-model-context");
    assert.ok(told, "model context updated");
    const imageId = /img:[0-9a-f]{16}/.exec(told.params.content[0].text)[0];
    assert.match(told.params.content[0].text, /3000×2000/);

    // The preview is replaced by the full 1400 px display image.
    await page.waitForFunction(() => {
      const img = document.querySelector("#w").contentDocument.querySelector("#scene image");
      return img && img.getAttribute("href").length > 150_000; // the preview is under 80,000
    }, null, { timeout: 30000 });
    assert.ok((await page.evaluate(() => window.sent)).some((m) => m.params?.name === "load_visual_pixels"));

    const state = await stack.call("get_visual_state", { imageId });
    assert.ok(!state.isError, state.content?.[0]?.text);
    assert.deepEqual(errors, []);
  } finally { await stack.close(); }
});
