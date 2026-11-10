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

test("dryRun reports refusals and changes without saving, over MCP (#72, #74)", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-dry-"));
  const id = await storedImage(dir, 800, 600, "#fff");
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "dry-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  const call = (args) => client.callTool({ name: "present_visual", arguments: { imageId: id, verify: false, ...args } });
  const mark = { id: "m1", type: "point", x: 0.3, y: 0.3, note: "first" };
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    // Nothing is saved by a dry run.
    const dry = await call({ annotations: [mark], dryRun: true });
    assert.notEqual(dry.isError, true, dry.content?.[0]?.text);
    assert.match(dry.content[0].text, /DRY RUN: nothing was saved/);
    assert.match(dry.content[0].text, /would change: .*"marks":\["m1"\]/);
    assert.equal(dry.structuredContent.marks.length, 0);
    const first = await call({ annotations: [mark] });
    assert.equal(first.structuredContent.marks.length, 1);
    // A dry-run reset/remove must not save or write history either.
    const dryReset = await call({ reset: true, dryRun: true });
    assert.equal(dryReset.structuredContent.marks.length, 1);
    const dryRemove = await call({ remove: ["m1"], dryRun: true });
    assert.equal(dryRemove.structuredContent.marks.length, 1);
    // A stale ifMatch is refused in a dry run exactly as in a real call, tagged [CONFLICT].
    const stale = await call({ annotations: [{ ...mark, note: "x", ifMatch: "0123456789ab" }], dryRun: true });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /\[CONFLICT\]/);
    // The state still has the first note, and a dry-run edit changed nothing.
    const dry2 = await call({ annotations: [{ ...mark, note: "second" }], dryRun: true });
    assert.equal(dry2.structuredContent.marks.length, 1);
    const state = JSON.parse((await client.callTool({ name: "get_visual_state", arguments: { imageId: id } })).content[0].text.replace(/^[^{]*/, ""));
    assert.equal(state.marks[0].finding.note, "first");
    // dryRun does not apply to workspaces.
    const bad = await client.callTool({ name: "present_visual", arguments: { workspaceId: "ws:0123456789abcdef", dryRun: true } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /dryRun works on one image/);
  } finally {
    await client.close().catch(() => {});
    handle.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
