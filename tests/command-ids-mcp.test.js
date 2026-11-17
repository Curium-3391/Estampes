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
import { commandHash, judgeCommand, createCommandGate } from "../src/visual/commands.js";

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

async function start(dir, env = {}) {
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_UVA_MIRROR_IDLE_SEC: "3600", ...env }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
  const client = new Client({ name: "cmd-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const stop = async () => { await client.close().catch(() => {}); handle.kill("SIGTERM"); await new Promise((r) => handle.once("exit", r)); };
  // A second session: two widgets (or a retry on a new connection) can reach the server at the same time.
  const other = new Client({ name: "cmd-test-2", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await other.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  const callOther = async (name, args) => other.callTool({ name, arguments: args });
  return { call, callOther, stop: async () => { await other.close().catch(() => {}); await stop(); }, list: () => client.listTools() };
}

test("the command gate lets one holder in at a time, in arrival order", async () => {
  const gate = createCommandGate(), order = [];
  let inside = 0, overlap = false;
  const job = async (name, ms) => {
    const release = await gate();
    try { inside++; overlap ||= inside > 1; order.push("start " + name); await sleep(ms); order.push("end " + name); }
    finally { inside--; release(); }
  };
  await Promise.all([job("a", 30), job("b", 1), job("c", 1)]);
  assert.equal(overlap, false);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  // A holder that throws still lets the next one in.
  const failing = gate().then((release) => { release(); throw new Error("x"); }).catch(() => {});
  await failing;
  const release = await gate(); release();
});

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

async function storedImage(dir) {
  const bytes = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#fff" } }).png().toBuffer();
  const id = imageIdOf(bytes), folder = join(dir, "images", id.slice(4));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "source"), bytes);
  await writeFile(join(folder, "meta.json"), JSON.stringify({ imageId: id, source: "test" }));
  return id;
}
const withMark = (s, id) => s.call("present_visual", { imageId: id, annotations: [{ id: "ai-1", type: "rect", x: 0.2, y: 0.2, x2: 0.4, y2: 0.4, label: "A" }], findings: [{ id: "ai-1", note: "n", status: "inspected" }] });
const markX = (r) => r.structuredContent.annotations.find((m) => m.id === "ai-1").x;

test("two calls with one command id at the same time apply it once", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-cmd-"));
  const id = await storedImage(dir);
  const s = await start(dir);
  try {
    assert.notEqual((await withMark(s, id)).isError, true);
    for (const v of [0.3, 0.1]) assert.notEqual((await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "ai-1", x: v }] })).isError, true);
    // Two retries of one undo arrive together (the first answer was slow, the widget asked again).
    const both = await Promise.all([s.call, s.callOther, s.call, s.callOther, s.call, s.callOther].map((call) => call("edit_visual_canvas", { imageId: id, history: { action: "undo" }, commandId: "cmd-undo-race" })));
    assert.ok(both.every((r) => r.isError !== true), JSON.stringify(both.map((r) => r.content?.[0]?.text)));
    assert.equal(both.filter((r) => r.structuredContent.replayed).length, both.length - 1, "one applied, the rest replayed");
    const state = await s.call("edit_visual_canvas", { imageId: id, marks: [], commandId: "cmd-noop-race" });
    assert.equal(markX(state), 0.3, "undone once, not twice");
    // Different payloads under one id, at the same time: one wins, the other is refused.
    const clash = await Promise.all([[0.5, s.call], [0.6, s.callOther]].map(([v, call]) => call("edit_visual_canvas", { imageId: id, marks: [{ id: "ai-1", x: v }], commandId: "cmd-clash-race" })));
    assert.equal(clash.filter((r) => r.isError).length, 1);
  } finally { await s.stop(); }
});

test("without the UVA store the ids are kept in memory: retries in one run still apply once", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-cmd-"));
  const id = await storedImage(dir);
  const s = await start(dir, { ESTAMPES_CANVAS_STORE: "legacy" });
  try {
    assert.notEqual((await withMark(s, id)).isError, true);
    for (const v of [0.3, 0.1]) assert.notEqual((await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "ai-1", x: v }] })).isError, true);
    const undo = () => s.call("edit_visual_canvas", { imageId: id, history: { action: "undo" }, commandId: "cmd-legacy-undo" });
    assert.equal(markX(await undo()), 0.3);
    const again = await undo();
    assert.equal(again.structuredContent.replayed, true);
    assert.equal(markX(again), 0.3);
    const got = (await s.call("commands_get_status", { documentId: id, commandIds: ["cmd-legacy-undo", "cmd-other-one"] })).structuredContent.commands;
    assert.deepEqual(got.map((c) => c.status), ["applied", "unknown"]);
  } finally { await s.stop(); }
});

test("a command that edits several workspace items is applied once across items, and its status reads applied", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-cmd-ws-"));
  const ids = [];
  for (const color of ["#fff", "#ccc"]) {
    const bytes = await sharp({ create: { width: 400, height: 300, channels: 3, background: color } }).png().toBuffer();
    const id = imageIdOf(bytes), folder = join(dir, "images", id.slice(4));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "source"), bytes);
    await writeFile(join(folder, "meta.json"), JSON.stringify({ imageId: id, source: "test" }));
    ids.push(id);
  }
  const s = await start(dir);
  try {
    const ok = (r) => { assert.notEqual(r.isError, true, r.content?.[0]?.text); return r; };
    const ws = ok(await s.call("create_workspace", { canvases: ids })).structuredContent.workspaceId;
    ok(await s.call("present_visual", { workspaceId: ws, verify: false, annotations: [{ id: "w1", type: "point", x: 0.2, y: 0.2, label: "a", item: "wi-1" }, { id: "w2", type: "point", x: 0.2, y: 0.2, label: "b", item: "wi-2" }] }));
    const move = () => s.call("edit_visual_canvas", { imageId: ids[0], workspaceId: ws, commandId: "cmd-ws-move-1", marks: [{ id: "w1", x: 0.6, item: "wi-1" }, { id: "w2", x: 0.7, item: "wi-2" }] });
    const first = ok(await move());
    assert.equal(first.structuredContent.replayed, undefined);
    const again = ok(await move());
    assert.equal(again.structuredContent.replayed, true);
    assert.deepEqual(again.structuredContent.edits, []);
    const st = (await s.call("commands_get_status", { documentId: ws, commandIds: ["cmd-ws-move-1"] })).structuredContent.commands;
    assert.equal(st[0].status, "applied");
  } finally { await s.stop(); }
});
