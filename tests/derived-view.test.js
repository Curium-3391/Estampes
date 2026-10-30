import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { registerImage, clearImages, imageIdOf } from "../src/image-store.js";
import { processImage, regionTile } from "../src/image-ops.js";
import { renderView, rememberView, frameFromView } from "../src/image/view.js";
import {
  apply, invert, rotate, chain, translate, scale, fitTransform, reprojectionErrors, mapMark, condition,
} from "../src/image/transform.js";
import { fromFrame } from "../src/canvas-state.js";
import { useStorageDir, intakeImage, ensureImage, flushStorage, saveDerived } from "../src/storage.js";

beforeEach(() => { clearImages(); useStorageDir(""); });

// 6000x3000 grey board with a 10x10 black square at source (3000,1500),
// stored rotated: EXIF orientation 6 makes it 3000x6000 when oriented.
async function bigImage({ orientation } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="3000"><rect width="6000" height="3000" fill="#ddd"/>` +
    `<rect x="3000" y="1500" width="10" height="10" fill="#000"/></svg>`;
  let p = sharp(Buffer.from(svg)).png();
  if (orientation) p = sharp(Buffer.from(svg)).jpeg({ quality: 95 }).withMetadata({ orientation });
  return p.toBuffer();
}

test("transform matrices: quarter turns are exact, singular matrices have no inverse", () => {
  for (const deg of [90, 180, 270, 37.5]) {
    const m = chain(translate(-50, -20), rotate(deg), translate(400, 300));
    const inv = invert(m);
    for (const [x, y] of [[0, 0], [123.25, 45.5], [999, 3]]) {
      const p = apply(m, x, y), q = apply(inv, p.x, p.y);
      assert.ok(Math.hypot(q.x - x, q.y - y) < 1e-9, deg + "° round trip");
    }
  }
  assert.deepEqual(rotate(90), [0, -1, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(invert([1, 2, 3, 2, 4, 6, 0, 0, 1]), null);
  assert.equal(invert([1, 0, 0, 0, 1e-20, 0, 0, 0, 1]), null);
  assert.ok(condition(scale(2)) < 10);
});

test("fitTransform recovers similarity, affine and homography and reports residuals", () => {
  const H = [1.2, 0.1, 30, -0.05, 0.9, 12, 0.0004, -0.0002, 1];
  const from = [[0, 0], [400, 0], [400, 300], [0, 300], [200, 150], [50, 260]].map(([x, y]) => ({ x, y }));
  const to = from.map((p) => apply(H, p.x, p.y));
  const fit = fitTransform(from, to, "homography");
  assert.ok(Math.max(...reprojectionErrors(fit, from, to)) < 1e-6);
  const A = chain(rotate(20), scale(1.5), translate(5, -7));
  const toA = from.map((p) => apply(A, p.x, p.y));
  assert.ok(Math.max(...reprojectionErrors(fitTransform(from, toA, "affine"), from, toA)) < 1e-6);
  assert.ok(Math.max(...reprojectionErrors(fitTransform(from, toA, "similarity"), from, toA)) < 1e-6);
  // Too few or collinear points: no transform rather than a made-up one.
  assert.equal(fitTransform(from.slice(0, 3), to.slice(0, 3), "homography"), null);
  const line = [0, 1, 2, 3].map((i) => ({ x: i, y: 2 * i }));
  assert.equal(fitTransform(line, line, "homography"), null);
});

test("preview sampling returns exactly the old process_image pixels", async () => {
  const entry = await registerImage(await bigImage(), { source: "url" });
  const region = { x: 0.45, y: 0.45, x2: 0.55, y2: 0.55 };
  for (const ops of [[], [{ op: "clahe" }, { op: "sharpen" }], [{ op: "grayscale" }, { op: "threshold", method: "otsu" }]]) {
    const old = await processImage(entry, { region, ops });
    const now = await renderView(entry, { region, ops });
    assert.equal(Buffer.compare(old.data, now.data), 0);
    assert.deepEqual([now.width, now.height, now.scale, now.region], [old.width, old.height, old.scale, old.region]);
  }
});

test("native sampling cuts real source pixels beyond the working copy, EXIF applied", async () => {
  const entry = await registerImage(await bigImage({ orientation: 6 }), { source: "url" });
  assert.equal(entry.width, 2048); // working copy of the 3000x6000 oriented image
  assert.deepEqual([entry.sourceInfo.width, entry.sourceInfo.height, entry.sourceInfo.orientation], [3000, 6000, 6]);
  assert.match(entry.sourceAssetId, /^sha256:[0-9a-f]{64}$/);
  // The square at stored (3000,1500) is at oriented (3000-1500-10, 3000) = (1490, 3000).
  const region = { x: 1480 / 3000, y: 2990 / 6000, x2: 1520 / 3000, y2: 3030 / 6000 };
  const native = await renderView(entry, { region, sampling: { mode: "native" }, output: { format: "png" } });
  assert.deepEqual([native.width, native.height], [40, 40]);
  assert.equal(native.record.analysis.space, "source");
  assert.equal(native.record.evidence.interpolated, false);
  assert.equal(native.record.evidence.lossyDelivery, false);
  assert.equal(native.record.evidence.sourcePixelsPerOutputPixel, 1);
  const { data } = await sharp(native.data).greyscale().raw().toBuffer({ resolveWithObject: true });
  // Dark square from (10,10) to (20,20) of the crop: exact source pixels.
  assert.ok(data[15 * 40 + 15] < 60 && data[5 * 40 + 5] > 180);
  // Pixel (15,15) of the output maps back to the square in normalized coords.
  const back = apply(native.record.coordinateMapping.derivedToNormalized, 15, 15);
  assert.ok(Math.abs(back.x * 3000 - 1495) < 1e-6 && Math.abs(back.y * 6000 - 3005) < 1e-6);
  // The working copy holds the same square in fewer pixels.
  const working = await renderView(entry, { region, sampling: { mode: "working" } });
  assert.ok(working.width < 40);
  assert.ok(working.record.analysis.scale < 1);
  // Upscale only after processing, flagged as interpolation.
  const big = await renderView(entry, { region, sampling: { mode: "native", allowUpscale: true }, output: { maxLongSide: 320 } });
  assert.equal(big.width, 320);
  assert.equal(big.record.evidence.interpolated, true);
  assert.match(big.record.evidence.warnings.join(" "), /no new detail/);
});

test("derived view ids are deterministic and recipes rebuild the same pixels", async () => {
  const entry = await registerImage(await bigImage(), { source: "url" });
  const spec = { region: { x: 0.4, y: 0.4, x2: 0.6, y2: 0.6 }, ops: [{ op: "clahe" }], sampling: { mode: "working" } };
  const a = await renderView(entry, spec), b = await renderView(entry, spec);
  assert.equal(a.record.derivedViewId, b.record.derivedViewId);
  assert.equal(Buffer.compare(a.data, b.data), 0);
  const c = await renderView(entry, { ...spec, ops: [{ op: "clahe", tile: 64 }] });
  assert.notEqual(c.record.derivedViewId, a.record.derivedViewId);
  const again = await renderView(entry, a.record.recipe);
  assert.equal(again.record.derivedViewId, a.record.derivedViewId);
  assert.equal(a.record.sourceAssetId, entry.sourceAssetId);
  assert.ok(a.record.evidence.enhanced);
});

test("coordinates read off a derived view map back exactly, rects under rotation become polygons", async () => {
  const entry = await registerImage(await bigImage(), { source: "url" });
  const out = await renderView(entry, { region: { x: 0.5, y: 0.25, x2: 0.75, y2: 0.75 }, sampling: { mode: "native" } });
  const frame = frameFromView(out.record);
  const mark = fromFrame({ id: "a", type: "rect", x: 0, y: 0, x2: out.width, y2: out.height }, frame);
  assert.deepEqual([mark.x, mark.y, mark.x2, mark.y2].map((v) => Math.round(v * 1e6) / 1e6), [0.5, 0.25, 0.75, 0.75]);
  const half = fromFrame({ id: "p", type: "point", x: 0.5, y: 0.5 }, frameFromView(out.record, "normalized"));
  assert.ok(Math.abs(half.x - 0.625) < 1e-9 && Math.abs(half.y - 0.5) < 1e-9);
  const turned = mapMark({ id: "r", type: "rect", x: 0, y: 0, x2: 1, y2: 1 }, rotate(30));
  assert.equal(turned.type, "polyline");
  assert.equal(turned.closed, true);
  assert.equal(turned.points.length, 4);
});

test("zoom tiles come from the source file when it is larger than the working copy", async () => {
  const entry = await registerImage(await bigImage(), { source: "url" });
  const tile = await regionTile(entry, { x: 0.49, y: 0.49, x2: 0.52, y2: 0.52 }, 1600);
  assert.equal(tile.native, true);
  assert.deepEqual([tile.width, tile.height], [180, 90]);
});

test("derived view recipes are stored with the image and survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "estampes-derived-"));
  useStorageDir(dir);
  const entry = await intakeImage(await bigImage(), { source: "url" });
  const out = await renderView(entry, { region: { x: 0.1, y: 0.1, x2: 0.3, y2: 0.3 }, ops: [{ op: "edges" }], sampling: { mode: "native" } });
  rememberView(entry, out.record);
  await saveDerived(entry);
  await flushStorage();
  const saved = JSON.parse(readFileSync(join(dir, "images", entry.imageId.slice(4), "derived.json"), "utf8"));
  assert.equal(saved.views[0].derivedViewId, out.record.derivedViewId);
  const meta = JSON.parse(readFileSync(join(dir, "images", entry.imageId.slice(4), "meta.json"), "utf8"));
  assert.equal(meta.sourceAssetId, entry.sourceAssetId);
  clearImages();
  const back = await ensureImage(entry.imageId);
  assert.ok(back.derivedViews.has(out.record.derivedViewId));
  const again = await renderView(back, back.derivedViews.get(out.record.derivedViewId).recipe);
  assert.equal(again.record.derivedViewId, out.record.derivedViewId);
  assert.equal(Buffer.compare(again.data, out.data), 0);
});

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

test("MCP: native process_image, marking through derivedViewId, inspect_image and get_derived_view", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "estampes-derived-mcp-"));
  const bytes = await bigImage();
  const imageId = imageIdOf(bytes);
  mkdirSync(join(dir, "images", imageId.slice(4)), { recursive: true });
  writeFileSync(join(dir, "images", imageId.slice(4), "source"), bytes);
  const port = await freePort();
  const start = () => spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_ACCESS_KEY: "", ESTAMPES_ALLOW_OPEN: "1" }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const connect = async () => {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    const client = new Client({ name: "derived-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    return client;
  };
  let handle = start(), client;
  try {
    client = await connect();
    const info = await client.callTool({ name: "inspect_image", arguments: { imageId } });
    assert.equal(info.structuredContent.source.width, 6000);
    assert.equal(info.structuredContent.working.width, 4096);
    assert.equal(info.structuredContent.nativeDetailAvailable, true);
    const region = { x: 2990 / 6000, y: 1490 / 3000, x2: 3030 / 6000, y2: 1530 / 3000 };
    const out = await client.callTool({ name: "process_image", arguments: { imageId, region, sampling: { mode: "native" }, output: { format: "png" } } });
    assert.equal(out.isError, undefined);
    const { derivedViewId, output, derivedView } = out.structuredContent;
    assert.match(derivedViewId, /^dv:[0-9a-f]{16}$/);
    assert.deepEqual([output.width, output.height], [40, 40]);
    assert.equal(derivedView.analysis.space, "source");
    assert.match(out.content[0].text, /coordinateFrame \{derivedViewId/);
    // The square's centre (15,15) in that crop becomes (3005,1505) source px.
    const shown = await client.callTool({ name: "present_visual", arguments: { imageId, verify: false,
      annotations: [{ id: "dot", type: "point", x: 15, y: 15 }], coordinateFrame: { derivedViewId } } });
    assert.equal(shown.isError, undefined, shown.content?.[0]?.text);
    const dot = shown.structuredContent.marks.find((m) => m.id === "dot");
    assert.deepEqual(dot.box, [Math.round(3005 / 6000 * 1000) / 1000, Math.round(1505 / 3000 * 1000) / 1000]);
    const bad = await client.callTool({ name: "present_visual", arguments: { imageId, annotations: [{ id: "x", type: "point", x: 1, y: 1 }], coordinateFrame: { derivedViewId: "dv:0000000000000000" } } });
    assert.equal(bad.isError, true);
    await client.close();
    handle.kill();
    await sleep(300);
    // After a restart the recipe still renders the same view.
    handle = start();
    client = await connect();
    const again = await client.callTool({ name: "get_derived_view", arguments: { imageId, derivedViewId } });
    assert.equal(again.isError, undefined, again.content?.[0]?.text);
    assert.equal(again.structuredContent.reproduced, true);
    assert.equal(again.content[1].data, out.content[1].data);
    const smaller = await client.callTool({ name: "get_derived_view", arguments: { imageId, derivedViewId, output: { format: "jpeg", maxLongSide: 64 } } });
    assert.notEqual(smaller.structuredContent.derivedViewId, derivedViewId);
    assert.equal(smaller.structuredContent.derivedView.delivery.lossy, true);
  } finally { await client?.close().catch(() => {}); handle.kill(); }
});
