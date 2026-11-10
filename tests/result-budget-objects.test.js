// Image layers (add_image_layer) keep their PNG inline in the canvas. Tool
// results must still fit the host size cap: the widget gets small previews
// and fetches the full pixels itself, and model-facing documents omit them.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const LIMIT = 145000;

async function start(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "estampes-budget-"));
  const port = await freePort();
  const proc = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), stdio: "ignore", env: { ...process.env, PORT: String(port),
    ESTAMPES_STORAGE_DIR: dir, ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0", ESTAMPES_RATE_LIMIT_PER_MIN: "0", ESTAMPES_MAX_RESULT_CHARS: String(LIMIT), ...env } });
  for (let i = 0; i < 300; i++) { try { if ((await fetch("http://127.0.0.1:" + port + "/")).ok) break; } catch {} await sleep(100); }
  const client = new Client({ name: "budget", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp")));
  t.after(async () => { await client.close().catch(() => {}); proc.kill(); await rm(dir, { recursive: true, force: true }); });
  return (name, args) => client.callTool({ name, arguments: args });
}

// A photo-like image: noise does not compress, like a real photograph.
async function photo(call, seed) {
  const w = 1600, h = 1200, raw = Buffer.alloc(w * h * 3);
  let x = seed;
  for (let i = 0; i < raw.length; i++) { x = (x * 1103515245 + 12345) >>> 0; raw[i] = (x >>> 16) & 255; }
  const data = (await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 80 }).toBuffer()).toString("base64");
  let r, offset = 0, uploadId;
  while (offset < data.length) {
    const part = data.slice(offset, offset + 380000);
    r = await call("upload_visual_image", { ...(uploadId ? { uploadId } : {}), total: data.length, offset, data: part, fileName: "p.jpg" });
    assert.ok(!r.isError, JSON.stringify(r.content));
    uploadId = r.structuredContent?.uploadId ?? uploadId; offset += part.length;
  }
  return r.structuredContent.imageId;
}

const size = (r) => JSON.stringify(r).length;
const ok = (r, name) => { assert.ok(!r.isError, name + ": " + JSON.stringify(r.content).slice(0, 300)); assert.ok(size(r) <= LIMIT, name + " " + size(r)); return r; };

test("canvases with image layers stay inside the host result limit", { timeout: 180000 }, async (t) => {
  const call = await start(t);
  const a = await photo(call, 1), b = await photo(call, 2);
  ok(await call("present_visual", { imageId: a, annotations: [{ id: "m1", type: "point", x: .5, y: .5, label: "p" }] }), "present_visual");
  const layered = ok(await call("add_image_layer", { imageId: a, sourceImageId: b, region: { x: .1, y: .1, x2: .6, y2: .6 } }), "add_image_layer");
  const images = layered.structuredContent.objects.filter((o) => o.type === "image");
  assert.equal(images.length, 2);
  for (const o of images) {
    const p = o.primitives.find((q) => q.k === "image");
    assert.equal(p.full, false, "a preview stands in for the full PNG");
    // The widget completes it from load_visual_pixels.
    let data = "", offset = 0, done = false;
    while (!done) {
      const r = await call("load_visual_pixels", { imageId: a, object: o.id, offset });
      assert.ok(!r.isError, JSON.stringify(r.content));
      assert.equal(r.structuredContent.mimeType, "image/png");
      data += r.structuredContent.data; offset += r.structuredContent.data.length; done = r.structuredContent.done;
    }
    const meta = await sharp(Buffer.from(data, "base64")).metadata();
    assert.equal(meta.format, "png");
    assert.equal(meta.width, 1600);
  }
  const state = ok(await call("get_visual_state", { imageId: a }), "get_visual_state");
  assert.ok(!/data:image\/png;base64,iVBOR[A-Za-z0-9+/=]{4000}/.test(JSON.stringify(state)), "no inline layer PNG in the document");
  assert.equal(state.structuredContent.objects.filter((o) => o.type === "image").length, 2, "image layers are still listed");
  ok(await call("present_visual", { imageId: a, annotations: [{ id: "m2", type: "point", x: .2, y: .2, label: "q" }] }), "present_visual after layer");

  const ws = ok(await call("create_workspace", { canvases: [a, b] }), "create_workspace").structuredContent.workspaceId;
  ok(await call("get_workspace_state", { workspace: ws }), "get_workspace_state");
  ok(await call("present_visual", { workspaceId: ws, verify: false, annotations: [{ id: "w1", type: "point", x: .3, y: .3, label: "w", item: "wi-1" }] }), "present_visual workspace");
});
