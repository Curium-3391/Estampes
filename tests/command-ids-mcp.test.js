// Lost-ACK handling (UVA Phase 3): a command id makes the widget's edit apply at most once,
// and commands_get_status says whether it did. Real server, no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { imageIdOf } from "../src/image-store.js";
import { commandHash, judgeCommand } from "../src/visual/commands.js";

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

async function start(dir) {
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_UVA_MIRROR_IDLE_SEC: "3600" }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
  const client = new Client({ name: "cmd-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const stop = async () => { await client.close().catch(() => {}); handle.kill("SIGTERM"); await new Promise((r) => handle.once("exit", r)); };
  return { call, stop, list: () => client.listTools() };
}

test("judgeCommand: none, applied, mismatch; the hash ignores key order", () => {
  const h = commandHash({ a: 1, b: [{ x: 1, y: 2 }] });
  assert.equal(h, commandHash({ b: [{ y: 2, x: 1 }], a: 1 }));
  assert.notEqual(h, commandHash({ a: 2, b: [{ x: 1, y: 2 }] }));
  assert.equal(judgeCommand([[{ at: "t" }]], "cmd-aaaaaaaa", h).state, "none");
  assert.equal(judgeCommand([[{ commandId: "cmd-aaaaaaaa", argsHash: h, at: "t", tool: "x" }]], "cmd-aaaaaaaa", h).state, "applied");
  assert.equal(judgeCommand([[], [{ commandId: "cmd-aaaaaaaa", argsHash: "other" }]], "cmd-aaaaaaaa", h).state, "mismatch");
});

test("a command id applies once, is looked up by status, and survives a restart", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-cmd-"));
  const bytes = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#fff" } }).png().toBuffer();
  const id = imageIdOf(bytes), folder = join(dir, "images", id.slice(4));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "source"), bytes);
  await writeFile(join(folder, "meta.json"), JSON.stringify({ imageId: id, source: "test" }));
  let s = await start(dir);
  try {
    const shown = await s.call("present_visual", { imageId: id, annotations: [{ id: "ai-1", type: "rect", x: 0.2, y: 0.2, x2: 0.4, y2: 0.4, label: "A" }], findings: [{ id: "ai-1", note: "n", status: "inspected" }] });
    assert.notEqual(shown.isError, true);
    const x = async (r) => { assert.notEqual(r.isError, true, r.content?.[0]?.text); return r.structuredContent.annotations.find((m) => m.id === "ai-1").x; };
    const move = (value, commandId) => s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "ai-1", x: value }], ...(commandId ? { commandId } : {}) });
    const undo = (commandId) => s.call("edit_visual_canvas", { imageId: id, history: { action: "undo" }, ...(commandId ? { commandId } : {}) });

    assert.equal(await x(await move(0.3, "cmd-move-03")), 0.3);
    assert.equal(await x(await move(0.1, "cmd-move-01")), 0.1);
    const first = await undo("cmd-undo-one");
    assert.equal(await x(first), 0.3, "undo went back one step");
    assert.equal(first.structuredContent.replayed, undefined);

    // The ACK was lost and the widget sends the undo again: it must not undo a second time.
    const again = await undo("cmd-undo-one");
    assert.equal(again.structuredContent.replayed, true);
    assert.deepEqual(again.structuredContent.edits, []);
    assert.equal(await x(again), 0.3, "applied once");

    // The same id for different edits is refused, not applied.
    const clash = await move(0.9, "cmd-undo-one");
    assert.equal(clash.isError, true);
    assert.match(clash.content[0].text, /already used/);

    // Without an id, nothing changes: a second undo is a second undo.
    assert.equal(await x(await undo()), 0.2);

    const status = async () => (await s.call("commands_get_status", { documentId: id, commandIds: ["cmd-move-03", "cmd-undo-one", "cmd-never-sent"] })).structuredContent.commands;
    const got = await status();
    assert.deepEqual(got.map((c) => c.status), ["applied", "applied", "unknown"]);
    assert.equal(got[1].tool, "edit_visual_canvas");

    // A restart: the record is on disk, so the lookup and the replay still work.
    await s.stop();
    s = await start(dir);
    assert.deepEqual((await status()).map((c) => c.status), ["applied", "applied", "unknown"]);
    const afterRestart = await undo("cmd-undo-one");
    assert.equal(afterRestart.structuredContent.replayed, true);
    assert.equal(await x(afterRestart), 0.2, "the replay changed nothing");
  } finally { await s.stop(); }
});

test("commands_get_status is app-only and checks its input", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-cmd-"));
  const s = await start(dir);
  try {
    assert.deepEqual((await s.list()).tools.find((t) => t.name === "commands_get_status")?._meta?.ui?.visibility, ["app"]);
    const bad = await s.call("commands_get_status", { documentId: "img:0000000000000000", commandIds: ["x"] }).catch((e) => ({ isError: true, thrown: String(e) }));
    assert.equal(bad.isError, true);
  } finally { await s.stop(); }
});
