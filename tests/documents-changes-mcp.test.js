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

test("documents_get_changes: unchanged, snapshot after an edit, gap after a restart-like epoch, missing", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-poll-"));
  const { id } = await storedImage(dir, 800, 400);
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_UVA_MIRROR_IDLE_SEC: "3600" }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "poll-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  const poll = async (documents) => {
    const r = await client.callTool({ name: "documents_get_changes", arguments: { documents } });
    assert.notEqual(r.isError, true, r.content?.[0]?.text);
    return r.structuredContent;
  };
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.find((t) => t.name === "documents_get_changes")?._meta?.ui?.visibility, ["app"]);

    const first = (await poll([{ documentId: id }])).documents[0];
    assert.equal(first.status, "snapshot");
    assert.equal(first.revision.counter, 1);
    assert.equal(first.snapshot.width, 800);

    const same = (await poll([{ documentId: id, sinceRevision: first.revision }])).documents[0];
    assert.equal(same.status, "unchanged");
    assert.equal(same.snapshot, undefined, "no payload when nothing changed");

    const mark = { id: "user-p-1", type: "rect", label: "YOU 1", x: 0.1, y: 0.1, x2: 0.3, y2: 0.3 };
    const v = await client.callTool({ name: "validate_visual_annotations", arguments: { imageId: id, annotations: [mark], note: "x" } });
    assert.notEqual(v.isError, true, v.content?.[0]?.text);
    const after = (await poll([{ documentId: id, sinceRevision: first.revision }])).documents[0];
    assert.equal(after.status, "snapshot", "the next revision comes as a snapshot");
    assert.equal(after.revision.counter, 2);
    assert.ok(after.snapshot.annotations.some((m) => m.id === "user-p-1"));

    const stale = (await poll([{ documentId: id, sinceRevision: { ...first.revision, epoch: "old-process" } }])).documents[0];
    assert.equal(stale.status, "gap", "a revision from another epoch is a gap");
    assert.ok(stale.snapshot);

    const two = (await poll([{ documentId: id, sinceRevision: after.revision }, { documentId: "img:" + "0".repeat(16) }])).documents;
    assert.equal(two[0].status, "unchanged");
    assert.equal(two[1].status, "missing");

    const tooMany = await client.callTool({ name: "documents_get_changes", arguments: { documents: Array.from({ length: 13 }, () => ({ documentId: id })) } }).catch((e) => ({ isError: true, e }));
    assert.equal(tooMany.isError, true, "more than 12 documents is refused");
  } finally {
    await client.close().catch(() => {});
    handle.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("documents_get_changes: a gesture verdict alone changes the revision", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-poll-g-"));
  const { id } = await storedImage(dir, 800, 400);
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_UVA_MIRROR_IDLE_SEC: "3600" }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "poll-test-g", version: "0" }, { versionNegotiation: { mode: "auto" } });
  const shaft = { id: "user-t-1", type: "polyline", label: "YOU 1", points: [{ x: 0.6, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.4, y: 0.5 }],
    x: 0.4, y: 0.5, x2: 0.6, y2: 0.5, strokeOrder: 1, relativeStartMs: 0, relativeEndMs: 500, pointerType: "pen" };
  const head = { id: "user-t-2", type: "polyline", label: "YOU 2", points: [{ x: 0.43, y: 0.44 }, { x: 0.4005, y: 0.5 }, { x: 0.43, y: 0.56 }],
    x: 0.4005, y: 0.44, x2: 0.43, y2: 0.56, strokeOrder: 2, relativeStartMs: 700, relativeEndMs: 900, pointerType: "pen" };
  const poll = async (since) => (await client.callTool({ name: "documents_get_changes", arguments: { documents: [{ documentId: id, ...(since ? { sinceRevision: since } : {}) }] } })).structuredContent.documents[0];
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const v = await client.callTool({ name: "validate_visual_annotations", arguments: { imageId: id, annotations: [shaft, head], note: "x" } });
    const [g] = v.structuredContent.event.gestureGroups;
    const before = await poll();
    assert.equal((await poll(before.revision)).status, "unchanged");
    await client.callTool({ name: "review_gesture_group", arguments: { imageId: id, memberIds: g.memberIds, verdict: "user-rejected" } });
    const after = await poll(before.revision);
    assert.equal(after.status, "snapshot", "the verdict moves the revision although the strokes did not change");
    assert.equal(after.snapshot.gestureGroups[0].confirmation, "user-rejected");
  } finally {
    await client.close().catch(() => {});
    handle.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
