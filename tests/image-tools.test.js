import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  assertPublicHttpsUrl, downloadImage, registerImage, getImage, clearImages, MAX_DOWNLOAD_BYTES,
} from "../src/image-store.js";
import { regionToPixels, processImage, overlayGrid, cellCenter } from "../src/image-ops.js";

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// 400×200 landscape: dark left half, light right half, black bar near top-left.
async function sampleImage({ orientation } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">
    <rect width="200" height="200" fill="#333"/><rect x="200" width="200" height="200" fill="#ddd"/>
    <rect x="240" y="20" width="100" height="10" fill="#000"/></svg>`;
  let pipeline = sharp(Buffer.from(svg)).jpeg();
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  return pipeline.toBuffer();
}

test("URL guard accepts public https and rejects SSRF targets", async () => {
  await assert.rejects(assertPublicHttpsUrl("http://93.184.216.34/a.png"), /https/);
  await assert.rejects(assertPublicHttpsUrl("https://127.0.0.1/a.png"), /public/);
  await assert.rejects(assertPublicHttpsUrl("https://10.1.2.3/a.png"), /public/);
  await assert.rejects(assertPublicHttpsUrl("https://169.254.169.254/latest"), /public/);
  await assert.rejects(assertPublicHttpsUrl("https://[::1]/a.png"), /public/);
  await assert.rejects(assertPublicHttpsUrl("https://user:pw@93.184.216.34/a.png"), /credentials/);
  assert.equal((await assertPublicHttpsUrl("https://93.184.216.34/a.png")).hostname, "93.184.216.34");
});

test("downloads follow redirects through the guard and enforce the size cap", async () => {
  const seen = [];
  const checkUrl = async (raw) => { seen.push(raw); return new URL(raw); };
  const responses = [
    new Response(null, { status: 302, headers: { location: "/final.png" } }),
    new Response(Buffer.from("ok")),
  ];
  const bytes = await downloadImage("https://example.com/start", { fetchImpl: async () => responses.shift(), checkUrl });
  assert.equal(bytes.toString(), "ok");
  assert.deepEqual(seen, ["https://example.com/start", "https://example.com/final.png"]);
  const huge = new Response(Buffer.alloc(8), { headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) } });
  await assert.rejects(downloadImage("https://example.com/x", { fetchImpl: async () => huge, checkUrl }), /20 MB/);
  await assert.rejects(
    downloadImage("https://example.com/x", { fetchImpl: async () => new Response("no", { status: 404 }), checkUrl }),
    /HTTP 404/
  );
});

test("registerImage applies EXIF orientation, rejects non-images and caches by content", async () => {
  clearImages();
  const rotated = await registerImage(await sampleImage({ orientation: 6 }), { source: "url" });
  assert.equal(rotated.width, 200);
  assert.equal(rotated.height, 400);
  assert.match(rotated.imageId, /^img:[0-9a-f]{16}$/);
  assert.equal(getImage(rotated.imageId), rotated);
  await assert.rejects(registerImage(Buffer.from("not an image"), { source: "url" }), /not a supported image/);
  assert.throws(() => getImage("img:0000000000000000"), /load_image again/);
});

test("regions map to source pixels and back without drifting", () => {
  assert.deepEqual(regionToPixels(undefined, 400, 200), { left: 0, top: 0, width: 400, height: 200 });
  assert.deepEqual(regionToPixels({ x: 0.75, y: 0.5, x2: 0.25, y2: 0 }, 400, 200), { left: 100, top: 0, width: 200, height: 100 });
  assert.deepEqual(regionToPixels({ x: 1, y: 1, x2: 1, y2: 1 }, 400, 200), { left: 399, top: 199, width: 1, height: 1 });
});

test("process_image crops, upscales and reports the covered source region", async () => {
  const entry = await registerImage(await sampleImage(), { source: "url" });
  const whole = await processImage(entry, {});
  assert.equal(whole.width, 400, "whole-image views are never enlarged");
  assert.ok(whole.data.subarray(0, 8).equals(PNG_MAGIC));
  const zoom = await processImage(entry, { region: { x: 0.5, y: 0, x2: 1, y2: 0.25 }, ops: [{ op: "clahe" }, { op: "sharpen" }] });
  assert.deepEqual(zoom.region, { x: 0.5, y: 0, x2: 1, y2: 0.25 });
  assert.equal(zoom.scale, 8);
  assert.equal(zoom.width, 1600);
});

test("threshold and edges produce single-channel binary/edge maps", async () => {
  const entry = await registerImage(await sampleImage(), { source: "url" });
  for (const ops of [[{ op: "threshold", method: "otsu" }], [{ op: "threshold", method: "adaptive" }], [{ op: "edges" }]]) {
    const out = await processImage(entry, { ops });
    assert.equal((await sharp(out.data).metadata()).channels, 1, JSON.stringify(ops));
    const data = await sharp(out.data).extractChannel(0).raw().toBuffer();
    if (ops[0].op === "threshold") assert.ok([...data].every(v => v === 0 || v === 255));
  }
  const otsu = await processImage(entry, { ops: [{ op: "threshold", method: "otsu" }] });
  const data = await sharp(otsu.data).extractChannel(0).raw().toBuffer();
  assert.equal(data[100 * 400 + 50], 0, "dark half becomes black");
  assert.equal(data[100 * 400 + 350], 255, "light half becomes white");
});

test("overlay_grid labels map to correct source coordinates", async () => {
  const entry = await registerImage(await sampleImage(), { source: "url" });
  const region = { x: 0.5, y: 0, x2: 1, y2: 0.5 };
  const grid = await overlayGrid(entry, { region, rows: 4, cols: 4 });
  assert.ok(grid.data.subarray(0, 8).equals(PNG_MAGIC));
  assert.deepEqual(grid.region, region);
  assert.deepEqual(cellCenter("A1", { rows: 4, cols: 4, region }), { x: 0.5625, y: 0.0625 });
  assert.deepEqual(cellCenter("d4", { rows: 4, cols: 4, region }), { x: 0.9375, y: 0.4375 });
  assert.throws(() => cellCenter("E1", { rows: 4, cols: 4, region }), /outside/);
});
