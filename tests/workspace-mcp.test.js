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

test("workspaces over MCP: preview, commit, retry, read back, undo", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-wsmcp-"));
  const a = await storedImage(dir, 1536, 432, "#fff"), b1 = await storedImage(dir, 1152, 1536, "#264"), b2 = await storedImage(dir, 1323, 1871, "#eee");
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "ws-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, name + ": " + r.content?.[0]?.text);
    return r;
  };
  const box = (id, side, x = 0.1) => ({ id, type: "rect", x, y: 0.1, x2: x + 0.1, y2: 0.2, ...(side ? { side } : {}) });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    await call("present_visual", { imageId: a, verify: false, annotations: [box("op1"), box("op2", undefined, 0.4)] });
    await call("present_visual", { imageId: b1, pairImageId: b2, verify: false, annotations: [box("pcb", "left"), box("pdf", "right")] });

    const preview = await call("merge_workspaces", { target: a, source: b1 + "+" + b2 });
    assert.match(preview.content[0].text, /^PREVIEW \(nothing changed yet\)/);
    assert.deepEqual(preview.structuredContent.plan.result, { items: 3, marks: 4, userMarks: 0, layerInstances: 3 });
    const done = await call("merge_workspaces", { target: a, source: b1 + "+" + b2, commit: true, previewId: preview.structuredContent.previewId, idempotencyKey: "k1" });
    assert.match(done.content[0].text, /VERIFIED/);
    const ws = done.structuredContent.workspaceId;
    assert.match(ws, /^ws:[0-9a-f]{16}$/);
    const retry = await call("merge_workspaces", { target: a, source: b1 + "+" + b2, commit: true, previewId: preview.structuredContent.previewId, idempotencyKey: "k1" });
    assert.equal(retry.structuredContent.workspaceId, ws);
    assert.equal(retry.structuredContent.repeated, true);

    const state = await call("get_workspace_state", { workspace: ws });
    assert.equal(state.structuredContent.protocol, "estampes.workspace/1");
    assert.deepEqual(state.structuredContent.items.map((it) => it.asset), [a, b1, b2]);
    assert.deepEqual(state.structuredContent.check.totals, { items: 3, marks: 4, userMarks: 0, layerInstances: 3, links: 0 });
    const api = await (await fetch(base + "/api/v1/workspaces/" + ws.slice(3))).json();
    assert.equal(api.id, ws);

    const edited = await call("edit_workspace", { workspaceId: ws, remove: ["wi-1"], expectedRevision: state.structuredContent.revision });
    assert.equal(edited.structuredContent.items.length, 2);
    const stale = await client.callTool({ name: "edit_workspace", arguments: { workspaceId: ws, name: "x", expectedRevision: 0 } });
    assert.equal(stale.isError, true);
    await call("undo_workspace_change", { workspaceId: ws, undoToken: edited.structuredContent.undoToken });
    assert.equal((await call("get_workspace_state", { workspace: ws })).structuredContent.items.length, 3);
    const legacy = await call("get_workspace_state", { workspace: b1 + "+" + b2 });
    assert.deepEqual(legacy.structuredContent.legacy, { imageId: b1, pairImageId: b2 });
  } finally {
    await client.close().catch(() => {});
    handle.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
