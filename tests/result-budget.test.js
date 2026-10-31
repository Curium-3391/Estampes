// Hosts cap tool-result size (claude.ai at about 150,000 characters for a
// whole result). Real photos must still reach the canvas: a preview inline,
// the full display image in slices, and uploads from the canvas itself.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const HOST_CAP = 150_000;

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

// Noise compresses badly, so this is a worst case for a photo.
async function noisyJpeg(w, h, seed) {
  const raw = Buffer.alloc(w * h * 3);
  let x = seed;
  for (let i = 0; i < raw.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; raw[i] = ((i % 3) * 70 + (x >> 16) % 90) & 255; }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

async function upload(client, bytes, fileName, size = 240_000) {
  const data = bytes.toString("base64");
  let uploadId, result;
  for (let offset = 0; offset < data.length; offset += size) {
    result = await client.callTool({ name: "upload_visual_image", arguments: { ...(uploadId ? { uploadId } : {}), fileName, total: data.length, offset, data: data.slice(offset, offset + size) } });
    assert.ok(!result.isError, result.content?.[0]?.text);
    uploadId = result.structuredContent.uploadId ?? uploadId;
  }
  return result;
}

async function pixels(client, args) {
  let offset = 0, parts = [], r;
  do {
    const res = await client.callTool({ name: "load_visual_pixels", arguments: { ...args, offset } });
    assert.ok(!res.isError, res.content?.[0]?.text);
    assert.ok(JSON.stringify(res).length < HOST_CAP);
    r = res.structuredContent;
    parts.push(r.data); offset += r.data.length;
  } while (!r.done);
  return Buffer.from(parts.join(""), "base64");
}

test("canvas results stay under host size caps; uploads and slices carry the rest", { timeout: 60000 }, async () => {
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_ACCESS_KEY: "", ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_STORAGE_DIR: "" }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "budget-test", version: "0" });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const { tools } = await client.listTools();
    for (const name of ["upload_visual_image", "load_visual_pixels"]) {
      assert.deepEqual(tools.find((t) => t.name === name)?._meta?.ui?.visibility, ["app"], name + " is app-only");
    }

    // An empty canvas for the user's own picture.
    const empty = await client.callTool({ name: "present_visual", arguments: { upload: true } });
    assert.equal(empty.structuredContent.awaitingUpload, true);
    const both = await client.callTool({ name: "present_visual", arguments: { upload: true, scene: "shapes" } });
    assert.equal(both.isError, true);

    // Slices must arrive in order.
    const photo = await noisyJpeg(3000, 2000, 7);
    const data = photo.toString("base64");
    const first = await client.callTool({ name: "upload_visual_image", arguments: { total: data.length, offset: 0, data: data.slice(0, 1000) } });
    const skip = await client.callTool({ name: "upload_visual_image", arguments: { uploadId: first.structuredContent.uploadId, total: data.length, offset: 5000, data: data.slice(5000, 6000) } });
    assert.equal(skip.isError, true);
    assert.match(skip.content[0].text, /expected offset 1000/);

    const done = await upload(client, photo, "board.jpg");
    const imageId = done.structuredContent.imageId;
    assert.match(imageId, /^img:[0-9a-f]{16}$/);
    assert.equal(done.structuredContent.width, 3000);
    assert.ok(JSON.stringify(done).length < HOST_CAP, "upload result " + JSON.stringify(done).length);
    assert.equal(done._meta["estampes/image"].preview, true);

    const shown = await client.callTool({ name: "present_visual", arguments: { imageId, annotations: [{ id: "a", type: "rect", x: 0.1, y: 0.1, x2: 0.3, y2: 0.3 }],
      views: [{ label: "增強", ops: [{ op: "clahe" }] }, { label: "放大", region: { x: 0, y: 0, x2: 0.5, y2: 0.5 } }] } });
    assert.ok(!shown.isError, shown.content?.[0]?.text);
    assert.ok(JSON.stringify(shown).length < HOST_CAP, "present_visual " + JSON.stringify(shown).length);
    const preview = shown._meta["estampes/image"];
    assert.equal(preview.preview, true);
    assert.ok(preview.width < 1400);
    const deferred = shown._meta["estampes/views"].filter((v) => v.deferred);
    assert.ok(deferred.length >= 1);

    const full = await pixels(client, { imageId });
    const meta = await sharp(full).metadata();
    assert.equal(Math.max(meta.width, meta.height), 1400);
    const view = await pixels(client, { imageId, view: deferred[0].index });
    assert.ok((await sharp(view).metadata()).width > 0);

    const reload = await client.callTool({ name: "load_visual_canvas", arguments: { imageId } });
    assert.ok(JSON.stringify(reload).length < HOST_CAP, "load_visual_canvas " + JSON.stringify(reload).length);

    const other = (await upload(client, await noisyJpeg(2400, 1800, 11), "schematic.jpg")).structuredContent.imageId;
    const pair = await client.callTool({ name: "present_visual", arguments: { imageId, pairImageId: other } });
    assert.ok(!pair.isError, pair.content?.[0]?.text);
    assert.ok(JSON.stringify(pair).length < HOST_CAP, "paired " + JSON.stringify(pair).length);
    const pairReload = await client.callTool({ name: "load_visual_canvas", arguments: { imageId, pairImageId: other } });
    assert.ok(JSON.stringify(pairReload).length < HOST_CAP, "paired reload " + JSON.stringify(pairReload).length);

    const tile = await client.callTool({ name: "load_visual_region", arguments: { imageId, region: { x: 0, y: 0, x2: 1, y2: 1 }, maxSide: 2048 } });
    assert.ok(!tile.isError, tile.content?.[0]?.text);
    assert.ok(JSON.stringify(tile).length < HOST_CAP, "tile " + JSON.stringify(tile).length);
  } finally { await client.close().catch(() => {}); handle.kill(); }
});
