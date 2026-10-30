import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerImage, clearImages, imageIdOf } from "../src/image-store.js";
import { renderView } from "../src/image/view.js";
import { estimateSkew } from "../src/image/geometry.js";
import { registerPair, compareView } from "../src/image/register.js";
import { measureQuality } from "../src/image/quality.js";
import { calibrate, measure } from "../src/image/measure.js";
import { applyExtraOp } from "../src/image/ops-extra.js";
import { apply, rotate, chain, translate } from "../src/image/transform.js";
import { fromFrame } from "../src/canvas-state.js";
import { frameFromView } from "../src/image/view.js";

beforeEach(() => clearImages());

const lines = (w = 800, h = 600) => {
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fff"/>`;
  for (let y = 60; y < h - 40; y += 40) svg += `<rect x="80" y="${y}" width="${w - 160}" height="12" fill="#000"/>`;
  return svg + "</svg>";
};
const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();

function scene(seed = 1) {
  let s = seed; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#8a8"/>`;
  for (let i = 0; i < 300; i++) {
    const c = `rgb(${Math.floor(r() * 255)},${Math.floor(r() * 255)},${Math.floor(r() * 255)})`;
    svg += r() < 0.5 ? `<rect x="${r() * 1150}" y="${r() * 860}" width="${10 + r() * 50}" height="${10 + r() * 40}" fill="${c}" transform="rotate(${r() * 90} 600 450)"/>`
      : `<circle cx="${r() * 1200}" cy="${r() * 900}" r="${4 + r() * 25}" fill="${c}"/>`;
  }
  return svg + "</svg>";
}

test("deskew finds the tilt of ruled lines and refuses a blank page", async () => {
  for (const deg of [4, -6]) {
    const tilted = await sharp(await png(lines())).rotate(deg, { background: "#fff" }).flatten({ background: "#fff" }).raw().toBuffer({ resolveWithObject: true });
    const est = await estimateSkew({ data: tilted.data, width: tilted.info.width, height: tilted.info.height, channels: tilted.info.channels });
    assert.ok(Math.abs(est.angle - deg) < 0.6, "estimated " + est.angle + " for " + deg);
  }
  const blank = await registerImage(await png(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#fff"/></svg>`), { source: "url" });
  const out = await renderView(blank, { sampling: { mode: "working" }, geometry: [{ op: "deskew" }] });
  assert.match(out.record.evidence.warnings.join(" "), /left unrotated/);
});

test("rotation by 90 degrees maps marks back exactly; any angle reports invalid corners", async () => {
  const entry = await registerImage(await png(lines(400, 200)), { source: "url" });
  const turned = await renderView(entry, { sampling: { mode: "working" }, geometry: [{ op: "rotate", degrees: 90 }], output: { format: "png" } });
  assert.deepEqual([turned.width, turned.height], [200, 400]);
  const m = turned.record.coordinateMapping.derivedToNormalized;
  // Derived (0,0) is the old bottom-left; derived (w,0) the old top-left.
  assert.deepEqual([apply(m, 0, 0).x, apply(m, 0, 0).y].map((v) => Math.round(v * 1e6) / 1e6), [0, 1]);
  assert.deepEqual([apply(m, 200, 0).x, apply(m, 200, 0).y].map((v) => Math.round(v * 1e6) / 1e6), [0, 0]);
  assert.equal(turned.record.validity.validFraction, 1);
  const rect = fromFrame({ id: "r", type: "rect", x: 0, y: 0, x2: 100, y2: 200 }, frameFromView(turned.record));
  assert.equal(rect.type, "rect"); // a quarter turn keeps rectangles axis-aligned
  assert.deepEqual([rect.x, rect.y, rect.x2, rect.y2].map((v) => Math.round(v * 1e6) / 1e6), [0, 1, 0.5, 0.5]);
});

test("perspective rectification recovers a flat surface and inverts to the image", async () => {
  // A 600x400 target painted into a quadrilateral inside a 1000x800 photo.
  const corners = [{ x: 0.2, y: 0.15 }, { x: 0.85, y: 0.25 }, { x: 0.8, y: 0.85 }, { x: 0.15, y: 0.7 }];
  const src = await png(scene(3));
  const entry = await registerImage(src, { source: "url" });
  const out = await renderView(entry, { sampling: { mode: "working" }, geometry: [{ op: "perspective", corners }], output: { format: "png" } });
  const m = out.record.coordinateMapping.derivedToNormalized;
  const tl = apply(m, 0, 0), br = apply(m, out.width, out.height);
  assert.ok(Math.hypot(tl.x - 0.2, tl.y - 0.15) < 1e-6 && Math.hypot(br.x - 0.8, br.y - 0.85) < 1e-6);
  assert.equal(out.record.validity.validFraction, 1);
  assert.match(out.record.evidence.warnings.join(" "), /flat surface/);
  // Degenerate corners fail loudly.
  await assert.rejects(renderView(entry, { geometry: [{ op: "perspective", corners: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.9 }, { x: 0.3, y: 0.3 }] }] }), /degenerate/);
});

test("extra operators behave: levels stretch, gamma lifts, white balance neutralizes, channel isolates", async () => {
  const grey = (v) => ({ data: Buffer.alloc(100 * 100 * 3, v), width: 100, height: 100, channels: 3 });
  const a = await applyExtraOp(grey(60), { op: "gamma", gamma: 2 });
  assert.ok(a.data[0] > 60);
  const dim = { data: Buffer.from(Array.from({ length: 100 * 100 * 3 }, (_, i) => 80 + (i % 7))), width: 100, height: 100, channels: 3 };
  const l = await applyExtraOp(dim, { op: "levels", low: 1, high: 99 });
  assert.ok(Math.max(...l.data) > 240 && Math.min(...l.data) < 15);
  const warm = { data: Buffer.alloc(30 * 30 * 3), width: 30, height: 30, channels: 3 };
  for (let i = 0; i < warm.data.length; i += 3) { warm.data[i] = 200; warm.data[i + 1] = 150; warm.data[i + 2] = 100; }
  const wb = await applyExtraOp(warm, { op: "white_balance" });
  assert.ok(Math.abs(wb.data[0] - wb.data[2]) <= 1);
  const red = await applyExtraOp(warm, { op: "channel", channel: "red" });
  assert.equal(red.channels, 1); assert.equal(red.data[0], 200);
  const canny = await applyExtraOp({ data: Buffer.from(Array.from({ length: 40 * 40 }, (_, i) => (i % 40 < 20 ? 0 : 255))), width: 40, height: 40, channels: 1 }, { op: "canny", sigma: 0 });
  const edgeCols = new Set(); canny.data.forEach((v, i) => { if (v) edgeCols.add(i % 40); });
  assert.ok(edgeCols.size <= 3 && [...edgeCols].every((c) => c >= 18 && c <= 21));
  const morph = await applyExtraOp({ data: Buffer.from(Array.from({ length: 20 * 20 }, (_, i) => (i === 210 ? 255 : 0))), width: 20, height: 20, channels: 1 }, { op: "morphology", operation: "open", radius: 1 });
  assert.equal(Math.max(...morph.data), 0); // a single bright pixel is removed by opening
});

test("auto registration recovers a rotated, scaled copy; mirror needs the flag; unrelated images fail", async () => {
  const A = await png(scene(1));
  const B = await sharp(A).rotate(12, { background: "#000" }).resize({ width: 1000 }).png().toBuffer();
  const a = await registerImage(A, { source: "url" }), b = await registerImage(B, { source: "url" });
  const reg = await registerPair(a, b, { method: "auto" });
  assert.equal(reg.status, "ok", JSON.stringify(reg.reasons));
  assert.ok(reg.quality.inliers >= 40 && reg.quality.medianErrorPx < 2.5);
  // Centre of A is the centre of B (rotation about the middle).
  const c = apply(reg.normalizedAtoB, 0.5, 0.5);
  assert.ok(Math.hypot(c.x - 0.5, c.y - 0.5) < 0.01);
  assert.equal(registerPair.length >= 0, true);
  const again = await registerPair(a, b, { method: "auto" });
  assert.equal(again.registrationId, reg.registrationId);
  assert.deepEqual(again.normalizedAtoB, reg.normalizedAtoB);

  const flipped = await registerImage(await sharp(B).flop().png().toBuffer(), { source: "url" });
  assert.equal((await registerPair(a, flipped, { method: "auto" })).status, "failed");
  const mirrored = await registerPair(a, flipped, { method: "auto", mirror: true });
  assert.equal(mirrored.status, "ok");

  const other = await registerImage(await png(scene(99)), { source: "url" });
  const bad = await registerPair(a, other, { method: "auto" });
  assert.equal(bad.status, "failed");
  assert.ok(bad.reasons.length > 0);

  const diff = await compareView(a, b, reg, { mode: "difference" });
  assert.ok(diff.metrics.ssim > 0.85, "ssim " + diff.metrics.ssim);
});

test("landmark registration fits exactly and reports residuals; too few points fail", async () => {
  const a = await registerImage(await png(scene(1)), { source: "url" }), b = await registerImage(await png(scene(1)), { source: "url" }).catch(() => null);
  void b;
  const other = await registerImage(await sharp(await png(scene(1))).resize({ width: 600 }).png().toBuffer(), { source: "url" });
  const pts = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]].map(([x, y]) => ({ a: { x, y }, b: { x, y } }));
  const reg = await registerPair(a, other, { method: "landmarks", landmarks: pts, model: "homography" });
  assert.equal(reg.status, "ok");
  assert.ok(reg.quality.medianErrorPx < 1e-3);
  assert.equal(reg.landmarkResiduals.length, 4);
  const few = await registerPair(a, other, { method: "landmarks", landmarks: pts.slice(0, 2), model: "affine" });
  assert.equal(few.status, "failed");
});

test("quality metrics tell sharp from blurred, clean from noisy, and flag clipping and casts", async () => {
  const sharpImg = await sharp(await png(lines())).raw().toBuffer({ resolveWithObject: true });
  const blurImg = await sharp(await png(lines())).blur(4).raw().toBuffer({ resolveWithObject: true });
  const mk = (r) => ({ data: r.data, width: r.info.width, height: r.info.height, channels: r.info.channels });
  const s = await measureQuality(mk(sharpImg)), bl = await measureQuality(mk(blurImg));
  assert.ok(s.metrics.sharpness.laplacianVariance > 5 * bl.metrics.sharpness.laplacianVariance);
  assert.ok(bl.advice.some((t) => /blurred/.test(t)));
  const noisy = Buffer.alloc(200 * 200 * 3); let seed = 5;
  for (let i = 0; i < noisy.length; i++) { seed = (seed * 16807) % 2147483647; noisy[i] = 128 + ((seed % 41) - 20); }
  const n = await measureQuality({ data: noisy, width: 200, height: 200, channels: 3 });
  assert.ok(n.metrics.noise.sigma > 8);
  const cast = Buffer.alloc(100 * 100 * 3); for (let i = 0; i < cast.length; i += 3) { cast[i] = 255; cast[i + 1] = 120; cast[i + 2] = 80; }
  const c = await measureQuality({ data: cast, width: 100, height: 100, channels: 3 });
  assert.ok(c.metrics.clipping.red.highlights > 0.9);
  assert.ok(c.advice.some((t) => /colour cast/.test(t)) && c.advice.some((t) => /clipped highlights/.test(t)));
});

test("measurements carry uncertainty and never invent units", () => {
  const unscaled = measure("distance", [{ x: 0, y: 0 }, { x: 300, y: 400 }], { calibration: null, sigmaPx: 1 });
  assert.deepEqual([unscaled.value, unscaled.unit], [500, "px"]);
  const cal = calibrate({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], length: 25.4, unit: "mm", sigmaPx: 0.5 });
  const d = measure("distance", [{ x: 0, y: 0 }, { x: 200, y: 0 }], { calibration: cal, sigmaPx: 0.5 });
  assert.equal(d.unit, "mm"); assert.ok(Math.abs(d.value - 50.8) < 1e-9); assert.ok(d.uncertainty > 0 && d.uncertainty < 1);
  const area = measure("area", [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], { calibration: cal, sigmaPx: 0.5 });
  assert.equal(area.unit, "mm²"); assert.ok(Math.abs(area.value - 645.16) < 0.01);
  const ang = measure("angle", [{ x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }], { calibration: null, sigmaPx: 0.5 });
  assert.ok(Math.abs(ang.value - 90) < 1e-9);
  assert.throws(() => measure("angle", [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }], { sigmaPx: 1 }), /differ/);
  assert.throws(() => calibrate({ points: [{ x: 1, y: 1 }, { x: 1, y: 1 }], length: 1, unit: "mm", sigmaPx: 1 }), /different/);
});

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

test("MCP: assess, rectify, calibrate in the rectified view, measure, register and compare", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "estampes-geo-mcp-"));
  const A = await png(scene(1));
  const B = await sharp(A).rotate(10, { background: "#000" }).resize({ width: 900 }).png().toBuffer();
  const ids = [];
  for (const bytes of [A, B]) {
    const id = imageIdOf(bytes); ids.push(id);
    mkdirSync(join(dir, "images", id.slice(4)), { recursive: true });
    writeFileSync(join(dir, "images", id.slice(4), "source"), bytes);
  }
  const [idA, idB] = ids;
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_ACCESS_KEY: "", ESTAMPES_ALLOW_OPEN: "1" }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "geo-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const q = await client.callTool({ name: "assess_image", arguments: { imageId: idA, clippingMap: true } });
    assert.equal(q.isError, undefined, q.content?.[0]?.text);
    assert.ok(q.structuredContent.metrics.sharpness.laplacianVariance > 0);
    assert.equal(q.content[1].type, "image");

    const corners = [{ x: 0.2, y: 0.15 }, { x: 0.85, y: 0.25 }, { x: 0.8, y: 0.85 }, { x: 0.15, y: 0.7 }];
    const view = await client.callTool({ name: "process_image", arguments: { imageId: idA, geometry: [{ op: "perspective", corners, width: 600, height: 400 }], ops: [{ op: "levels" }], sampling: { mode: "working" }, output: { format: "png" } } });
    assert.equal(view.isError, undefined, view.content?.[0]?.text);
    const dv = view.structuredContent.derivedViewId;
    assert.deepEqual([view.structuredContent.output.width, view.structuredContent.output.height], [600, 400]);

    const unscaled = await client.callTool({ name: "measure_image", arguments: { imageId: idA, derivedViewId: dv, units: "pixels", kind: "distance", points: [{ x: 0, y: 0 }, { x: 300, y: 0 }] } });
    assert.equal(unscaled.structuredContent.unit, "px");
    assert.equal(unscaled.structuredContent.calibrated, false);
    const cal = await client.callTool({ name: "calibrate_scale", arguments: { imageId: idA, derivedViewId: dv, units: "pixels", points: [{ x: 0, y: 0 }, { x: 600, y: 0 }], length: 150, unit: "mm" } });
    assert.equal(cal.isError, undefined, cal.content?.[0]?.text);
    const m = await client.callTool({ name: "measure_image", arguments: { imageId: idA, derivedViewId: dv, units: "pixels", kind: "distance", points: [{ x: 0, y: 0 }, { x: 300, y: 0 }] } });
    assert.equal(m.structuredContent.unit, "mm");
    assert.ok(Math.abs(m.structuredContent.value - 75) < 1e-6);
    // The measured points come back in normalized image coordinates.
    assert.ok(Math.abs(m.structuredContent.points[0].x - 0.2) < 1e-4);

    const reg = await client.callTool({ name: "register_images", arguments: { imageId: idA, otherImageId: idB, mapPoints: [{ x: 0.5, y: 0.5 }] } });
    assert.equal(reg.structuredContent.status, "ok", JSON.stringify(reg.structuredContent.reasons));
    assert.ok(Math.abs(reg.structuredContent.mappedPoints[0].to.x - 0.5) < 0.02);
    const cmp = await client.callTool({ name: "compare_images", arguments: { registrationId: reg.structuredContent.registrationId, mode: "difference" } });
    assert.equal(cmp.isError, undefined, cmp.content?.[0]?.text);
    assert.ok(cmp.structuredContent.metrics.ssim > 0.8);
    const same = await client.callTool({ name: "register_images", arguments: { imageId: idA, otherImageId: idA } });
    assert.match(same.content[0].text, /two different/);
    const noReg = await client.callTool({ name: "compare_images", arguments: { registrationId: "reg:0123456789abcdef" } });
    assert.equal(noReg.isError, true);
  } finally { await client.close().catch(() => {}); handle.kill(); }
});
