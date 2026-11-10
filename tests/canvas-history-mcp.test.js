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
import { readFileSync } from "node:fs";

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

test("undo and redo of the user's sent edits over MCP: single image, pair, conflicts, GPT is told", { timeout: 40000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-hist-"));
  const a = await storedImage(dir, 800, 600, "#264"), b = await storedImage(dir, 600, 800, "#eee");
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "hist-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, name + ": " + r.content?.[0]?.text);
    return r;
  };
  const mine = (id, x) => ({ id, type: "rect", x, y: 0.1, x2: x + 0.2, y2: 0.3, label: "YOU " + id.slice(-1) });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const tools = await client.listTools();
    const schema = tools.tools.find((t) => t.name === "edit_visual_canvas").inputSchema;
    assert.ok(schema.properties.history, "edit_visual_canvas advertises history");

    await call("validate_visual_annotations", { imageId: a, annotations: [mine("user-1", 0.1), mine("user-2", 0.5)] });
    const find = (r, id) => r.structuredContent.annotations.find((m) => m.id === id);

    let r = await call("edit_visual_canvas", { imageId: a, marks: [{ id: "user-1", x: 0.3, y: 0.1, x2: 0.5, y2: 0.3 }] });
    assert.deepEqual(r.structuredContent.history.left, { canUndo: true, canRedo: false, undoNext: ["move"] });
    r = await call("edit_visual_canvas", { imageId: a, remove: [{ id: "user-2" }] });
    assert.equal(find(r, "user-2"), undefined);

    r = await call("edit_visual_canvas", { imageId: a, history: { action: "undo" } });
    assert.ok(find(r, "user-2"), "the deleted mark is back");
    assert.equal(r.structuredContent.edits[0].kind, "undo-edit");
    r = await call("edit_visual_canvas", { imageId: a, history: { action: "undo" } });
    assert.equal(find(r, "user-1").x, 0.1, "moved mark is back in place");
    assert.equal(r.structuredContent.history.left.canUndo, false);
    r = await call("edit_visual_canvas", { imageId: a, history: { action: "redo" } });
    assert.equal(find(r, "user-1").x, 0.3);

    r = await call("edit_visual_canvas", { imageId: a, history: { action: "redo" } });
    assert.equal(find(r, "user-2"), undefined, "redo re-applies the delete");
    assert.equal(r.structuredContent.history.left.canRedo, false);

    // Nothing to redo / combined with other edits / unknown side: clear errors.
    const none = await client.callTool({ name: "edit_visual_canvas", arguments: { imageId: a, history: { action: "redo" } } });
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /Nothing to redo/);
    const mixed = await client.callTool({ name: "edit_visual_canvas", arguments: { imageId: a, remove: [{ id: "user-1" }], history: { action: "undo" } } });
    assert.match(mixed.content[0].text, /cannot be combined/);
    const side = await client.callTool({ name: "edit_visual_canvas", arguments: { imageId: a, history: { action: "undo", side: "right" } } });
    assert.match(side.content[0].text, /needs pairImageId/);

    // GPT hears about it on its next call.
    const next = await call("present_visual", { imageId: a, verify: false });
    assert.match(next.content[0].text, /undid their last change|redid their change/);

    // Pair view: each side has its own history.
    await call("validate_visual_annotations", { imageId: a, pairImageId: b, annotations: [{ ...mine("user-3", 0.1), side: "right" }] });
    r = await call("edit_visual_canvas", { imageId: a, pairImageId: b, marks: [{ id: "user-3", side: "right", x: 0.4, y: 0.1, x2: 0.6, y2: 0.3 }] });
    assert.equal(r.structuredContent.history.right.canUndo, true);
    r = await call("edit_visual_canvas", { imageId: a, pairImageId: b, history: { action: "undo", side: "right" } });
    assert.equal(r.structuredContent.edits[0].side, "right");
    assert.equal(find(r, "user-3").x, 0.1);
  } finally {
    await client.close().catch(() => {});
    handle.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the canvas buttons fall back to server undo/redo for sent edits", () => {
  const html = readFileSync(new URL("../public/visual-surface.html", import.meta.url), "utf8");
  assert.match(html, /function undo\(\)\{if\(!past\.length\)\{serverStep\("undo"\)/);
  assert.match(html, /function redo\(\)\{if\(!future\.length\)\{serverStep\("redo"\)/);
  assert.match(html, /undoBtn\.disabled=!past\.length&&!canServerStep\("undo"\)/);
  assert.match(html, /history:\{action,/);
  assert.match(html, /"undo-edit":e=>/);
});
