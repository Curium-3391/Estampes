import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { unzipFiles } from "../src/zip.js";
import { imageIdOf } from "../src/image-store.js";

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}
async function storedImage(dir, w, h, colour) {
  const bytes = await sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();
  const id = imageIdOf(bytes), folder = join(dir, "images", id.slice(4));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "source"), bytes);
  await writeFile(join(folder, "meta.json"), JSON.stringify({ imageId: id, source: "test" }));
  return id;
}

test("export_workspace_bundle over MCP: signed link downloads a bundle that imports back", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-bundlemcp-"));
  const a = await storedImage(dir, 800, 600, "#fff"), b = await storedImage(dir, 600, 800, "#264");
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_ACCESS_KEY: "k".repeat(24) }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "bundle-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp?key=" + "k".repeat(24))));
    await client.callTool({ name: "present_visual", arguments: { imageId: a, verify: false, annotations: [{ id: "m1", type: "rect", x: 0.1, y: 0.1, x2: 0.3, y2: 0.3 }] } });
    const made = await client.callTool({ name: "create_workspace", arguments: { canvases: [a, b] } });
    assert.notEqual(made.isError, true, made.content?.[0]?.text);
    const ws = made.structuredContent.workspaceId;
    const exp = await client.callTool({ name: "export_workspace_bundle", arguments: { workspace: ws } });
    assert.notEqual(exp.isError, true, exp.content?.[0]?.text);
    const link = new URL(exp.structuredContent.downloadUrl);
    assert.match(link.search, /sig=/);
    const bad = await fetch(base + link.pathname + "?sig=nope");
    assert.equal(bad.status, 403);
    const res = await fetch(base + link.pathname + link.search);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, exp.structuredContent.bytes);
    const files = unzipFiles(buf);
    assert.ok(files.has("manifest.json") && files.has("workspace.json"));
    assert.equal(JSON.stringify(Object.fromEntries([...files].filter(([n]) => n.endsWith(".json")).map(([n, d]) => [n, d.toString()]))).includes("kkkkkkkk"), false, "no access key inside");
    assert.equal(exp.structuredContent.manifest.workspace.marks, 1);
  } finally {
    await client.close().catch(() => {});
    handle.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
