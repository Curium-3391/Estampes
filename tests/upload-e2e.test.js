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

for (const profile of [
  { name: "desktop notifications", globals: false, viewport: { width: 1280, height: 900 }, size: [800,1200] },
  { name: "mobile globals", globals: true, viewport: { width: 390, height: 844 }, size: [3072,4096] },
]) test("uploaded photo survives replay of the original empty host result: " + profile.name, { skip: noBrowser, timeout: 90000 }, async () => {
  const stack = await startStack({ cas: false });
  try {
    const initial = await stack.call("present_visual", { upload: true });
    const ui = await stack.open({ result: async () => initial, globals: profile.globals, viewport: profile.viewport });
    await ui.frame.locator("#upload-big").waitFor();
    await ui.page.waitForFunction(()=>window.hostLog.includes("ui/notifications/initialized"));
    await ui.page.evaluate(() => {
      const original=window.hostCall;
      window.uploadedResults=[];
      window.hostCall=async params=>{
        const result=await original(params);
        if(params.name==="upload_visual_image"&&result.structuredContent?.uploaded)window.uploadedResults.push(result);
        return result;
      };
    });
    const photo = await noisyJpeg(...profile.size);
    await ui.frame.locator("#upload-file").setInputFiles({ name: "portrait.jpg", mimeType: "image/jpeg", buffer: photo });
    await ui.frame.locator("#status").filter({ hasText: "已上傳" }).waitFor({ timeout: 60000 });
    assert.equal(await ui.frame.locator("#surface").isVisible(), true);
    await ui.page.waitForFunction(() => {
      const href=document.querySelector("#w").contentDocument.querySelector("#scene image")?.getAttribute("href");
      return href?.length>150_000;
    }, null, { timeout: 30000 });
    const href = await ui.frame.locator("#scene image").getAttribute("href");
    assert.ok(href?.startsWith("data:image/"));

    // A host can replay its original output after model-context or layout
    // updates. Test both delivery channels with fresh objects, as JSON bridges do.
    await ui.page.evaluate(({ structuredContent, _meta }) => {
      const frame = document.querySelector("#w");
      frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent, _meta } }, "*");
    }, initial);
    await ui.page.waitForTimeout(100);
    assert.equal(await ui.frame.locator("#surface").isVisible(), true, "notification replay must not hide the uploaded photo");
    await ui.page.evaluate(({ structuredContent, _meta }) => {
      const win = document.querySelector("#w").contentWindow;
      win.openai = { ...win.openai, toolOutput: structuredContent, toolResponseMetadata: _meta };
      win.dispatchEvent(new Event("openai:set_globals"));
    }, initial);
    await ui.page.waitForTimeout(100);
    assert.equal(await ui.frame.locator("#surface").isVisible(), true, "globals replay must not hide the uploaded photo");
    assert.equal((await ui.frame.locator("#scene image").getAttribute("href"))===href, true, "replay retains the full uploaded pixels");

    // A second upload applies locally even though the host's original output
    // has not changed. A failed third upload must leave this canvas intact.
    const second=await noisyJpeg(640,480);
    await ui.frame.locator("#upload-file").setInputFiles({name:"second.jpg",mimeType:"image/jpeg",buffer:second});
    await ui.page.waitForFunction(()=>window.uploadedResults.length===2);
    await ui.frame.locator("#status").filter({hasText:"已上傳"}).waitFor();
    await ui.page.evaluate(({structuredContent,_meta})=>{
      document.querySelector("#w").contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{structuredContent,_meta}},"*");
    },initial);
    await ui.page.waitForTimeout(100);
    assert.equal(await ui.frame.locator("#surface").isVisible(),true);
    assert.equal(await ui.frame.locator("#scene image").getAttribute("height"),"750","second upload updates the image aspect ratio");

    // Real new host data must still apply, including metadata-only changes.
    await ui.page.evaluate(()=>{
      const win=document.querySelector("#w").contentWindow;
      const result=window.uploadedResults.at(-1);
      window.nextHostResult={...result,_meta:{...result._meta,"estampes/annotations":[{id:"host-point",type:"point",x:.5,y:.5,author:"assistant",color:"green"}]}};
      win.openai={...win.openai,toolOutput:window.nextHostResult.structuredContent,toolResponseMetadata:window.nextHostResult._meta};
      win.dispatchEvent(new Event("openai:set_globals"));
    });
    await ui.frame.locator('#unified-layers circle[fill="#3DDC84"]').waitFor();
    await ui.page.evaluate(()=>{
      const result=window.nextHostResult;
      result._meta={...result._meta,"estampes/annotations":[{...result._meta["estampes/annotations"][0],color:"red"}]};
      document.querySelector("#w").contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:result},"*");
    });
    await ui.frame.locator('#unified-layers circle[fill="#F2545B"]').waitFor();
    await ui.frame.locator("#upload-file").setInputFiles({name:"broken.jpg",mimeType:"image/jpeg",buffer:Buffer.from("not an image")});
    await ui.frame.locator("#status").filter({hasText:"上傳失敗"}).waitFor();
    assert.equal(await ui.frame.locator("#surface").isVisible(),true,"failed upload keeps the existing image visible");
    assert.equal(await ui.frame.locator("#scene image").getAttribute("height"),"750");
    assert.deepEqual(ui.errors, []);
  } finally { await stack.close(); }
});
