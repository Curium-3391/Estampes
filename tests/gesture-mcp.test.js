import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
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

async function storedImage(dir, w, h) {
  const bytes = await sharp({ create: { width: w, height: h, channels: 3, background: "#fff" } }).png().toBuffer();
  const id = imageIdOf(bytes), folder = join(dir, "images", id.slice(4));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "source"), bytes);
  await writeFile(join(folder, "meta.json"), JSON.stringify({ imageId: id, source: "test" }));
  return { id, folder };
}

test("gesture groups over MCP: candidate, user verdict stored, strokes untouched", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-gesture-"));
  const { id, folder } = await storedImage(dir, 800, 400);
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_UVA_MIRROR_IDLE_SEC: "3600" }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "gesture-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  // A shaft to the left and a V head at its tip, as two freehand strokes.
  const shaft = { id: "user-t-1", type: "polyline", label: "YOU 1", points: [{ x: 0.6, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.4, y: 0.5 }],
    x: 0.4, y: 0.5, x2: 0.6, y2: 0.5, strokeOrder: 1, relativeStartMs: 0, relativeEndMs: 500, pointerType: "pen" };
  const head = { id: "user-t-2", type: "polyline", label: "YOU 2", points: [{ x: 0.43, y: 0.44 }, { x: 0.4005, y: 0.5 }, { x: 0.43, y: 0.56 }],
    x: 0.4005, y: 0.44, x2: 0.43, y2: 0.56, strokeOrder: 2, relativeStartMs: 700, relativeEndMs: 900, pointerType: "pen" };
  const validate = (extra = {}) => client.callTool({ name: "validate_visual_annotations",
    arguments: { imageId: id, annotations: [shaft, head], note: "我覺得水是這樣流的", ...extra } });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.find((t) => t.name === "review_gesture_group")?._meta?.ui?.visibility, ["app"]);

    const first = await validate();
    assert.notEqual(first.isError, true, first.content?.[0]?.text);
    const event = first.structuredContent.event;
    assert.equal(event.interaction.intent, "free-annotate");
    assert.equal(event.annotations.length, 2, "both strokes kept");
    assert.deepEqual(event.annotations[0].stroke, { order: 1, relativeStartMs: 0, relativeEndMs: 500, pointerType: "pen" });
    const [g] = event.gestureGroups;
    assert.equal(g.proposedMeaning, "direction-arrow");
    assert.equal(g.arrow.direction.heading, "left");
    assert.equal(g.confirmation, "unconfirmed");
    assert.match(first.structuredContent.chatMessage, /YOU 1 \+ YOU 2 → 可能是一支方向箭頭（往左/);

    const review = await client.callTool({ name: "review_gesture_group", arguments: { imageId: id, memberIds: g.memberIds, verdict: "user-rejected" } });
    assert.notEqual(review.isError, true, review.content?.[0]?.text);
    assert.equal(review.structuredContent.gestureGroups[0].confirmation, "user-rejected");

    const again = await validate();
    assert.equal(again.structuredContent.event.gestureGroups[0].confirmation, "user-rejected", "the stored verdict is used");
    const widget = await validate({ gestureDecisions: [{ memberIds: g.memberIds, verdict: "user-confirmed" }] });
    assert.equal(widget.structuredContent.event.gestureGroups[0].confirmation, "user-confirmed", "the widget's newer verdict wins");

    const loaded = await client.callTool({ name: "load_visual_canvas", arguments: { imageId: id, part: "canvas" } });
    assert.equal(loaded.structuredContent.gestureGroups[0].confirmation, "user-rejected");
    const state = await client.callTool({ name: "get_visual_state", arguments: { imageId: id } });
    const doc = JSON.parse(state.content[0].text.slice(state.content[0].text.indexOf("{")));
    assert.equal(doc.gestureGroups[0].image, id);
    assert.equal(doc.marks.find((m) => m.id === "user-t-1").stroke.pointerType, "pen");
    assert.equal(doc.marks.find((m) => m.id === "user-t-1").geometry.points.length, 3, "strokes untouched");
    await sleep(300);
    // The durable record the save was acknowledged with (the UVA store's pending copy).
    // (Where the host cannot run the UVA store, the server keeps the older canvas file.)
    const pending = await readFile(join(dir, "uva-pending", id.slice(4) + ".json"), "utf8").then((t) => JSON.parse(t).canvas, () => null);
    const saved = pending ?? await readFile(join(folder, "canvas.json"), "utf8").then((t) => JSON.parse(t), () => null);
    // Once the store has committed it the file is gone; the verdict was read back through MCP above.
    if (saved) assert.equal(saved.gestureDecisions[0].verdict, "user-rejected");
  } finally {
    await client.close().catch(() => {});
    handle.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
