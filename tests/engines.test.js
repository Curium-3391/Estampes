import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { registerImage, clearImages } from "../src/image-store.js";
import { runEngine, listEngines, registerEngine, labelComponents } from "../src/image/engines.js";

beforeEach(() => clearImages());
const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();
const board = () => png(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#fff"/>
<rect x="50" y="60" width="80" height="40" fill="#000"/><rect x="300" y="200" width="30" height="30" fill="#000"/>
<line x1="40" y1="300" x2="560" y2="320" stroke="#000" stroke-width="3"/>
<circle cx="450" cy="120" r="35" fill="none" stroke="#000" stroke-width="4"/></svg>`);

test("engine list reports availability and optional engines degrade to a result, not a crash", async () => {
  const engines = await listEngines();
  assert.deepEqual(engines.filter((e) => e.builtin).map((e) => e.id).sort(), ["blobs", "circles", "components", "lines", "ocr", "regions"]);
  assert.equal(engines.find((e) => e.id === "components").ok, true);
  const entry = await registerImage(await board(), { source: "url" });
  const ocr = await runEngine(entry, "ocr", {});
  if (!engines.find((e) => e.id === "ocr").ok) {
    assert.equal(ocr.status, "unavailable");
    assert.match(ocr.reasons[0], /not installed/);
    assert.deepEqual(ocr.detections, []);
  }
  await assert.rejects(runEngine(entry, "nope", {}), /Unknown engine/);
});

test("components return boxes in normalized source coordinates with version and provenance", async () => {
  const entry = await registerImage(await board(), { source: "url" });
  const res = await runEngine(entry, "components", {});
  assert.equal(res.status, "ok");
  assert.equal(res.engineVersion, "1");
  assert.equal(res.sourceAssetId, entry.sourceAssetId);
  const box = res.detections.find((d) => d.attributes.widthPx === 80);
  assert.deepEqual([box.x * 600, box.y * 400, box.x2 * 600, box.y2 * 400].map((v) => Math.round(v)), [50, 60, 130, 100]);
  assert.equal(box.mark.type, "rect");
  assert.match(box.id, /^components-\d+$/);
  // A sub-region reports coordinates of the full image, not of the crop.
  const sub = await runEngine(entry, "components", { region: { x: 0.45, y: 0.45, x2: 0.6, y2: 0.65 } });
  const sq = sub.detections.find((d) => d.attributes.widthPx === 30);
  assert.ok(Math.abs(sq.x - 0.5) < 0.003 && Math.abs(sq.y - 0.5) < 0.003);
  // Polarity flips what counts as foreground.
  const light = await runEngine(entry, "components", { params: { polarity: "light", minArea: 5000 } });
  assert.equal(light.detections.length, 1);
});

test("blobs find point sources with sub-pixel centroids", async () => {
  const bg = sharp(Buffer.alloc(300 * 300 * 3, 20), { raw: { width: 300, height: 300, channels: 3 } });
  const img = await bg.composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><circle cx="100" cy="80" r="3" fill="#fff"/><circle cx="220.5" cy="200.5" r="2" fill="#ccc"/></svg>`) }]).blur(1).png().toBuffer();
  const entry = await registerImage(img, { source: "url" });
  const res = await runEngine(entry, "blobs", {});
  assert.equal(res.detections.length, 2);
  const [a, b] = res.detections;
  assert.ok(Math.abs(a.x * 300 - 100) < 0.5 && Math.abs(a.y * 300 - 80) < 0.5);
  assert.ok(Math.abs(b.x * 300 - 220.5) < 0.5 && Math.abs(b.y * 300 - 200.5) < 0.5);
  assert.ok(a.attributes.fwhmPx > 1 && a.attributes.snr > 5);
});

test("lines and circles find strokes and rings, and do not call a square a circle", async () => {
  const entry = await registerImage(await board(), { source: "url" });
  const lines = await runEngine(entry, "lines", {});
  const long = lines.detections.filter((d) => d.attributes.lengthPx > 400);
  assert.ok(long.length >= 1 && long.length <= 2); // two edges of one stroke
  assert.ok(Math.abs(long[0].attributes.angleDeg % 180 - 2.2) < 1.5 || Math.abs(long[0].attributes.angleDeg - 182.2) < 1.5);
  assert.equal(long[0].mark.type, "polyline");
  const circles = await runEngine(entry, "circles", {});
  assert.equal(circles.detections.length, 1);
  const c = circles.detections[0];
  assert.ok(Math.abs(c.x * 600 - 450) < 3 && Math.abs(c.y * 400 - 120) < 3 && Math.abs(c.radiusPx - 35) <= 3);
});

test("custom engines register once, run purely and failures keep one shape", async () => {
  registerEngine({ id: "t-fail", version: "9", kind: "detect", description: "x", async run() { throw new Error("boom"); } });
  const entry = await registerImage(await board(), { source: "url" });
  const res = await runEngine(entry, "t-fail", {});
  assert.deepEqual([res.status, res.engineVersion, res.reasons, res.detections], ["failed", "9", ["boom"], []]);
  assert.throws(() => registerEngine({ id: "t-fail", version: "1", kind: "detect", description: "x", run() {} }), /already registered/);
  const { comps } = labelComponents(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 1]), 3, 3, {});
  assert.equal(comps.length, 2);
});

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { imageIdOf } from "../src/image-store.js";

test("MCP: detect_features lists engines, runs one and refuses a missing image", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "estampes-eng-"));
  const bytes = await board(), id = imageIdOf(bytes);
  mkdirSync(join(dir, "images", id.slice(4)), { recursive: true });
  writeFileSync(join(dir, "images", id.slice(4), "source"), bytes);
  const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const port = s.address().port; await new Promise((r) => s.close(r));
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_ACCESS_KEY: "", ESTAMPES_ALLOW_OPEN: "1" }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "eng-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const list = await client.callTool({ name: "detect_features", arguments: {} });
    assert.deepEqual(list.structuredContent.engines.map((e) => e.id), ["components", "blobs", "lines", "circles", "regions", "ocr"]);
    const run = await client.callTool({ name: "detect_features", arguments: { imageId: id, engine: "components", params: { minArea: 100 } } });
    assert.equal(run.isError, undefined, run.content?.[0]?.text);
    assert.equal(run.structuredContent.status, "ok");
    assert.ok(run.structuredContent.detections.length >= 3);
    assert.match(run.content[0].text, /Candidates only/);
    const bad = await client.callTool({ name: "detect_features", arguments: { engine: "lines" } });
    assert.equal(bad.isError, true);
  } finally { await client.close().catch(() => {}); handle.kill(); }
});
