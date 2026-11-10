// The canvas store is the default: a server with storage and no UVA settings
// commits to "<storage>-uva"; ESTAMPES_CANVAS_STORE=legacy turns it off.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

async function freePort() { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
async function start(storage, env = {}) {
  const port = await freePort(), clean = { ...process.env };
  for (const k of Object.keys(clean)) if (/^ESTAMPES_(UVA|CANVAS_STORE|TEST_CANVAS_STORE)/.test(k)) delete clean[k];
  const proc = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), stdio: "ignore", env: { ...clean, NODE_OPTIONS: "", PORT: String(port),
    ESTAMPES_STORAGE_DIR: storage, ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0", ESTAMPES_RATE_LIMIT_PER_MIN: "0", ESTAMPES_UVA_MIRROR_IDLE_SEC: "0", ...env } });
  const exited = new Promise((r) => proc.once("exit", r));
  for (let i = 0; i < 300; i++) { try { if ((await fetch("http://127.0.0.1:" + port + "/")).ok) break; } catch {} await sleep(100); }
  const client = new Client({ name: "uva-default", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp")));
  return { client, async stop() { await client.close().catch(() => {}); proc.kill("SIGTERM"); await exited; } };
}

test("with storage and no UVA settings, canvases are committed to the default UVA folder; legacy opts out", { skip: process.platform !== "linux" && "the UVA lease needs Linux", timeout: 120000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uva-default-")), storage = join(root, "data");
  t.after(() => rm(root, { recursive: true, force: true }));
  let s = await start(storage);
  try {
    const tools = (await s.client.listTools()).tools.map((x) => x.name);
    assert.ok(tools.includes("uva_store"), "the store's read-only view is offered");
    assert.ok(!tools.includes("experimental_workspace"), "the Beta editor stays off by default");
    const data = (await sharp({ create: { width: 64, height: 40, channels: 3, background: "#224466" } }).png().toBuffer()).toString("base64");
    const imageId = (await s.client.callTool({ name: "upload_visual_image", arguments: { total: data.length, offset: 0, data, fileName: "d.png" } })).structuredContent.imageId;
    await s.client.callTool({ name: "present_visual", arguments: { imageId, annotations: [{ id: "a", type: "point", x: .5, y: .5, label: "p" }] } });
    const status = async () => (await s.client.callTool({ name: "uva_store", arguments: { action: "status" } })).structuredContent.diagnostics;
    const end = Date.now() + 30000;
    while (!((await status()).mirror.canvasStore?.committed > 0)) { assert.ok(Date.now() < end, JSON.stringify(await status())); await sleep(200); }
    assert.equal((await status()).mirror.mode, "canvas-store");
    assert.ok((await stat(storage + "-uva")).isDirectory(), "the store lives beside the storage folder, not inside it");
    const list = (await s.client.callTool({ name: "uva_store", arguments: { action: "list" } })).structuredContent.workspaces;
    assert.equal(list.length, 1);
    const refused = await s.client.callTool({ name: "uva_store", arguments: { action: "prepare" } });
    assert.equal(refused.isError, true, "the view never edits");
  } finally { await s.stop(); }

  s = await start(storage, { ESTAMPES_CANVAS_STORE: "legacy" });
  try {
    assert.ok(!(await s.client.listTools()).tools.some((x) => x.name === "uva_store"), "legacy: no UVA store");
    assert.deepEqual((await readdir(join(storage, "uva-pending"))).filter((n) => n.endsWith(".json")), []);
  } finally { await s.stop(); }
});
