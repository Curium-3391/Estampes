// ESTAMPES_CANVAS_STORE=uva: real server processes over real storage folders,
// restarted and killed between steps. Canvases, their copies and the images
// themselves live only in the UVA store; no canvas, set or image file is written.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// A failing assertion must not leave a server running (the test would hang).
const running = new Set();
test.after(() => { for (const p of running) p.kill("SIGKILL"); });
async function freePort() { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
async function start(storage, beta, { mode = "uva", idle = "0", env = {} } = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), stdio: "ignore", env: { ...process.env, PORT: String(port),
    ESTAMPES_STORAGE_DIR: storage, ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0", ESTAMPES_RATE_LIMIT_PER_MIN: "0",
    ESTAMPES_UVA_BETA_DIR: beta, ESTAMPES_UVA_BETA_PROFILE: "linux-process-crash-test",
    ESTAMPES_CANVAS_STORE: mode, ESTAMPES_UVA_MIRROR_IDLE_SEC: idle, ...env } });
  for (let i = 0; i < 300; i++) { try { if ((await fetch("http://127.0.0.1:" + port + "/")).ok) break; } catch {} await sleep(100); }
  const client = new Client({ name: "canvas-store", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp")));
  const raw = (name, args) => client.callTool({ name, arguments: args });
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, name + ": " + JSON.stringify(r.content)); return r; };
  running.add(proc);
  const exited = new Promise((r) => proc.once("exit", () => { running.delete(proc); r(); }));
  return {
    call, raw,
    get: async (path) => (await fetch("http://127.0.0.1:" + port + path)).json(),
    async stop() { await client.close().catch(() => {}); proc.kill("SIGTERM"); await exited; },
    async kill() { await client.close().catch(() => {}); proc.kill("SIGKILL"); await exited; },
    diagnostics: async () => (await call("uva_store", { action: "status" })).structuredContent.diagnostics,
    documents: async () => (await call("uva_store", { action: "list" })).structuredContent.workspaces,
    labels: async (imageId) => (await call("get_visual_state", { imageId })).structuredContent.marks.map((m) => m.label ?? m.id).sort(),
  };
}
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error("timed out waiting"); await sleep(100); }
}
async function folders(t) {
  const storage = await mkdtemp(join(tmpdir(), "canvas-store-legacy-")), beta = await mkdtemp(join(tmpdir(), "canvas-store-uva-"));
  t.after(() => Promise.all([rm(storage, { recursive: true, force: true }), rm(beta, { recursive: true, force: true })]));
  return { storage, beta };
}
async function upload(server, color) {
  const data = (await sharp({ create: { width: 320, height: 200, channels: 3, background: color } }).png().toBuffer()).toString("base64");
  return (await server.call("upload_visual_image", { total: data.length, offset: 0, data, fileName: "c.png" })).structuredContent.imageId;
}
const pendingFiles = async (storage) => (await readdir(join(storage, "uva-pending")).catch(() => [])).filter((n) => n.endsWith(".json"));
const canvasJson = (storage, imageId) => join(storage, "images", imageId.slice(4), "canvas.json");
// What the server wrote under images/ (the legacy store's folder).
const imageFiles = async (storage) => (await readdir(join(storage, "images"), { recursive: true }).catch(() => [])).sort();
const pendingPath = (storage, key) => join(storage, "uva-pending", key.slice(4).replace("#", "-") + ".json");
const committed = (server, storage) => until(async () => !(await pendingFiles(storage)).length && (await server.diagnostics()).mirror.canvasStore?.committed > 0);

const state = async (s, imageId) => (await s.call("get_visual_state", { imageId })).structuredContent;
const pixels = async (s, imageId) => (await s.call("render_canvas", { imageId, maxSide: 256 })).content.find((c) => c.type === "image").data;
const openDoc = async (s, title) => {
  const doc = (await s.documents()).find((d) => d.title === title);
  return doc && (await s.call("uva_store", { action: "open", documentId: doc.id })).structuredContent.document;
};

test("a canvas is committed to its UVA document, writes no file of its own, and comes back after a restart", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta);
  const imageId = await upload(s, "#336699");
  await s.call("present_visual", { imageId, layer: "第一輪", annotations: [{ id: "a1", type: "rect", x: .1, y: .2, x2: .4, y2: .5, label: "first" }, { id: "a2", type: "point", x: .7, y: .7, label: "second" }] });
  await committed(s, storage);
  assert.deepEqual(await imageFiles(storage), [], "no canvas, history or image file");
  const open = await openDoc(s, "Canvas " + imageId);
  assert.equal(open.extensions["estampes.beta:mirror"].authority, "uva");
  assert.deepEqual(open.scenes[0].annotations.map((a) => a.label).sort(), ["first", "second"]);
  assert.equal((await s.diagnostics()).mirror.lastResidualBytes, 0);
  const before = await pixels(s, imageId);
  await s.stop();

  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["first", "second"]);
  assert.equal(await pixels(s, imageId), before, "the image bytes come back from the store");
  assert.equal((await s.diagnostics()).mirror.canvasStore.read.uva, 1, JSON.stringify((await s.diagnostics()).mirror.canvasStore));
  // Further edits keep updating the same document.
  await s.call("present_visual", { imageId, annotations: [{ id: "a3", type: "point", x: .2, y: .8, label: "third" }] });
  await committed(s, storage);
  assert.equal((await s.documents()).length, 1);
  await s.stop();
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["first", "second", "third"]);
  assert.deepEqual(await imageFiles(storage), []);
  await s.stop();
});

test("an edit killed before its commit is recovered from the pending copy and then committed", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta, { idle: "3600" });
  const imageId = await upload(s, "#993366");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "rect", x: .1, y: .1, x2: .3, y2: .3, label: "unsaved?" }] });
  assert.equal((await pendingFiles(storage)).length, 1);
  assert.equal((await s.documents()).length, 0, "the commit waits for the idle time");
  await s.kill();
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["unsaved?"]);
  await committed(s, storage);
  assert.equal((await s.documents()).length, 1);
  await s.stop();
});

test("a canvas saved by the legacy store moves into UVA once and no longer needs its files", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta, { mode: "legacy" });
  const imageId = await upload(s, "#669933");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .5, y: .5, label: "old canvas" }] });
  const before = await pixels(s, imageId);
  await s.stop();
  assert.ok((await imageFiles(storage)).length > 0, "the legacy store wrote its files");

  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["old canvas"]);
  await committed(s, storage);
  await s.stop();
  // The legacy files are left alone; the store no longer reads them.
  const legacy = await readFile(canvasJson(storage, imageId), "utf8");
  await rm(join(storage, "images"), { recursive: true });
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["old canvas"]);
  assert.equal(await pixels(s, imageId), before);
  await s.call("present_visual", { imageId, annotations: [{ id: "a2", type: "point", x: .2, y: .2, label: "new" }] });
  await committed(s, storage);
  await s.stop();
  // A legacy file put back later does not replace the store's record.
  await mkdir(join(storage, "images", imageId.slice(4)), { recursive: true });
  await writeFile(canvasJson(storage, imageId), legacy);
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["new", "old canvas"]);
  await s.stop();
});

test("image layers are committed as verified assets and come back byte for byte", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta);
  const imageId = await upload(s, "#336633"), other = await upload(s, "#aa2244");
  // Promotes the base image to an image object and copies another canvas in as a second one.
  await s.call("add_image_layer", { imageId, sourceImageId: other, region: { x: .1, y: .1, x2: .5, y2: .6 } });
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .5, y: .5, label: "kept" }] });
  await committed(s, storage);
  const open = await openDoc(s, "Canvas " + imageId);
  const scene = open.scenes[0];
  assert.equal(scene.background.kind, "transparent");
  const images = scene.objects.filter((o) => o.type === "image");
  assert.equal(images.length, 2);
  // The document holds references, not the PNG text.
  for (const o of images) assert.match(o.props.asset.assetId, /^asset:sha256:[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(open).includes("data:image/png"));
  assert.ok(Buffer.byteLength(JSON.stringify(open)) < 64 * 1024);
  const r = await s.call("uva_store", { action: "render", documentId: (await s.documents()).find((d) => d.title === "Canvas " + imageId).id });
  assert.ok(r.content.find((c) => c.type === "image")?.data.length > 100);
  // The export carries every image the document references.
  const exported = (await s.call("uva_store", { action: "export", documentId: (await s.documents()).find((d) => d.title === "Canvas " + imageId).id })).structuredContent;
  const zip = await readFile(join(beta, "exports", exported.exportId + ".zip"));
  for (const o of images) assert.ok(zip.includes(Buffer.from("assets/" + o.props.asset.assetId.slice(13))), o.props.asset.assetId);
  const before = await pixels(s, imageId);
  await s.stop();

  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["kept"]);
  assert.equal(await pixels(s, imageId), before);
  // Moving an image layer is an object edit; it commits and survives a restart.
  const moved = images.find((o) => o.props.region?.x === .1) ?? images[1];
  await s.call("edit_scene_object", { imageId, id: moved.id, props: { region: { x: .2, y: .2, x2: .6, y2: .7 } } });
  await committed(s, storage);
  const movedPixels = await pixels(s, imageId);
  assert.notEqual(movedPixels, before);
  await s.stop();
  s = await start(storage, beta);
  assert.equal(await pixels(s, imageId), movedPixels);
  const again = (await openDoc(s, "Canvas " + imageId)).scenes[0].objects.find((o) => o.id === moved.id);
  assert.deepEqual(again.props.asset, moved.props.asset, "the same verified asset");
  await s.stop();
});

test("links to another canvas and their reviews are committed as relation bindings", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta);
  const left = await upload(s, "#336633"), right = await upload(s, "#663333");
  await s.call("present_visual", { imageId: left, pairImageId: right, annotations: [{ id: "a1", type: "point", x: .5, y: .5, label: "left" }, { id: "b1", side: "right", type: "point", x: .4, y: .4, label: "right" }],
    links: [{ id: "k1", left: "a1", right: "b1", label: "same", confidence: "low" }] });
  // The user's verdict is part of the link record.
  await s.call("review_visual_link", { imageId: left, pairImageId: right, linkId: "k1", review: "confirmed" });
  await until(async () => { if ((await pendingFiles(storage)).length) return false; const im = (await s.diagnostics()).mirror.canvasStore.images; return Object.values(im).every((x) => x.committedSeq >= x.pendingSeq); });
  assert.equal((await s.diagnostics()).mirror.blocked?.[left], undefined);
  const docs = await s.documents();
  const open = await openDoc(s, "Canvas " + left);
  const binding = open.bindings.find((b) => b.kind === "relation");
  assert.ok(binding, JSON.stringify({ bindings: open.bindings, diag: (await s.diagnostics()).mirror }).slice(0, 1500));
  assert.equal(binding.from.id, "a1");
  assert.equal(binding.to.id, "b1");
  assert.equal(binding.to.documentId, docs.find((d) => d.title === "Canvas " + right).id);
  assert.equal(binding.label, "same");
  assert.equal(binding.original.review, "confirmed");
  assert.equal(JSON.stringify(open.extensions["estampes.beta:mirror"].residual ?? {}).includes("links"), false);
  const pair = async () => (await s.call("get_visual_state", { imageId: left, pairImageId: right })).structuredContent;
  const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === "savedAt" || k === "revision" ? undefined : x)));
  const before = strip(await pair());
  await s.stop();

  // Both canvases, links included, come back from UVA alone.
  s = await start(storage, beta);
  assert.deepEqual(strip(await pair()), before);
  await s.stop();
});

test("a canvas the document cannot hold yet stays in its pending copy and is reported", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta, { idle: "3600" });
  const imageId = await upload(s, "#336633");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .5, y: .5, label: "kept" }] });
  await s.stop();
  // A link without its far end, in a later pending record (as a crashed
  // server of another version might leave it).
  const path = pendingPath(storage, imageId), record = JSON.parse(await readFile(path, "utf8"));
  record.canvas.links = { "img:0000000000000000": [{ id: "k9", left: "a1", label: "half" }] };
  record.seq++;
  await writeFile(path, JSON.stringify(record));
  s = await start(storage, beta);
  const d = await until(async () => { const m = (await s.diagnostics()).mirror; return m.blocked?.[imageId] ? m : null; });
  assert.match(d.blocked[imageId], /endpoint|binding/i);
  assert.equal((await pendingFiles(storage)).length, 1);
  assert.deepEqual(await s.labels(imageId), ["kept"]);
  assert.equal((await s.diagnostics()).mirror.canvasStore.read.pending, 1);
  await s.stop();
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).canvas.links, record.canvas.links, "the pending record is kept");
});

test("a workspace copy of a canvas is committed under its set key and restored from it", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta);
  const imageId = await upload(s, "#335577");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .3, y: .3, label: "orig" }] });
  await s.call("add_image_layer", { imageId });
  const preview = await s.call("split_workspace", { source: imageId, mode: "copy" });
  const done = await s.call("split_workspace", { source: imageId, mode: "copy", commit: true, previewId: preview.structuredContent.previewId });
  const ws = done.structuredContent.workspaceId;
  const doc = await s.get("/api/v1/workspaces/" + ws.slice(3));
  const key = JSON.stringify(doc).match(/img:[0-9a-f]{16}#c[0-9a-f]{12}/)?.[0];
  assert.ok(key, JSON.stringify(doc).slice(0, 400));
  const item = JSON.stringify(doc).match(/"id":"(wi-\d+)"/)[1];
  await s.call("present_visual", { workspaceId: ws, verify: false, annotations: [{ id: "c1", type: "point", x: .6, y: .6, label: "copy only", item }] });
  await until(async () => {
    if ((await pendingFiles(storage)).length) return false;
    const open = await openDoc(s, "Canvas " + key);
    return open?.scenes[0].annotations.some((a) => a.label === "copy only");
  });
  assert.deepEqual(await s.labels(imageId), ["orig"], "the image's own canvas did not get the copy's mark");
  assert.deepEqual(await imageFiles(storage), [], "no set file");
  await s.stop();

  s = await start(storage, beta);
  const again = await s.get("/api/v1/workspaces/" + ws.slice(3));
  assert.ok(JSON.stringify(again).includes("copy only"), JSON.stringify(again).slice(0, 300));
  assert.deepEqual(await s.labels(imageId), ["orig"]);
  await s.call("present_visual", { imageId, annotations: [{ id: "a2", type: "point", x: .6, y: .6, label: "later" }] });
  assert.deepEqual(await s.labels(imageId), ["later", "orig"]);
  await s.stop();
});

test("a save is acknowledged only once its pending record is durable; pending and committed are reported apart", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta, { idle: "3600" });
  const imageId = await upload(s, "#996699");
  const image = async () => (await s.diagnostics()).mirror.canvasStore.images[imageId];
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .2, y: .2, label: "one" }] });
  const first = (await image()).pendingSeq;
  assert.ok(first >= 1);
  assert.equal((await image()).committedSeq, undefined);

  // The pending record cannot be written: the save fails and nothing else holds it.
  const pending = pendingPath(storage, imageId);
  await unlink(pending);
  await mkdir(join(pending, "blocker"), { recursive: true });
  const failed = await s.raw("present_visual", { imageId, annotations: [{ id: "a2", type: "point", x: .4, y: .4, label: "two" }] });
  assert.equal(failed.isError, true, JSON.stringify(failed.content));
  assert.match(failed.content[0].text, /was not saved/);
  const after = await image();
  assert.equal(after.pendingSeq, first);
  assert.equal(after.failedSeq, first + 1);
  assert.deepEqual(await imageFiles(storage), []);
  await rm(pending, { recursive: true });

  // The next save gets the next sequence number, and its commit is reported.
  await s.call("present_visual", { imageId, annotations: [{ id: "a3", type: "point", x: .6, y: .6, label: "three" }] });
  assert.equal((await image()).pendingSeq, first + 1);
  await s.stop();
  s = await start(storage, beta);
  await committed(s, storage);
  assert.equal((await image()).committedSeq, first + 1);
  assert.ok((await s.labels(imageId)).includes("three"));
  const open = await openDoc(s, "Canvas " + imageId);
  assert.equal(open.extensions["estampes.beta:mirror"].sourceSeq, first + 1);
  await s.stop();
});

test("uva-to-legacy writes canvases, copies and image bytes back, so the legacy store has every edit", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta, { idle: "3600" });
  const committedId = await upload(s, "#225588"), pendingId = await upload(s, "#882255");
  await s.call("present_visual", { imageId: committedId, annotations: [{ id: "a1", type: "point", x: .3, y: .3, label: "committed" }] });
  await s.call("present_visual", { imageId: pendingId, annotations: [{ id: "a1", type: "point", x: .6, y: .6, label: "only pending" }] });
  const before = { committed: await pixels(s, committedId) };
  await s.kill();
  // One canvas reaches its document; the other stays a pending record.
  s = await start(storage, beta);
  await committed(s, storage);
  await s.stop();
  s = await start(storage, beta, { idle: "3600" });
  await s.call("present_visual", { imageId: pendingId, annotations: [{ id: "a2", type: "point", x: .1, y: .1, label: "later" }] });
  before.pending = await pixels(s, pendingId);
  await s.kill();
  assert.equal((await pendingFiles(storage)).length, 1, "the later edit is only a pending record");
  assert.deepEqual(await imageFiles(storage), []);

  const run = spawn(process.execPath, ["scripts/uva-to-legacy.mjs", storage, beta], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; run.stdout.on("data", (d) => { out += d; });
  assert.equal(await new Promise((r) => run.once("exit", r)), 0);
  assert.deepEqual(JSON.parse(out).written.canvas, 2, out);
  assert.deepEqual(JSON.parse(out).written.image, 2, out);

  s = await start(storage, beta, { mode: "legacy" });
  assert.deepEqual(await s.labels(committedId), ["committed"]);
  assert.deepEqual(await s.labels(pendingId), ["later", "only pending"]);
  assert.equal(await pixels(s, committedId), before.committed);
  assert.equal(await pixels(s, pendingId), before.pending);
  await s.stop();
});

test("a server whose UVA store holds data but cannot open stops instead of running on stale legacy files", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta);
  const imageId = await upload(s, "#557799");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .5, y: .5, label: "in the store" }] });
  await committed(s, storage);
  // A second server on the same folders: the running one holds the store's lease.
  const run = (env) => new Promise((done) => {
    const proc = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0",
      ESTAMPES_STORAGE_DIR: storage, ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0", ESTAMPES_UVA_DIR: beta, ESTAMPES_UVA_PROFILE: "linux-process-crash-test", ...env } });
    let err = ""; proc.stderr.on("data", (d) => { err += d; }); proc.stdout.on("data", (d) => { err += d; });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 15000);
    proc.once("exit", (code) => { clearTimeout(timer); done({ code, err }); });
  });
  const { code, err } = await run({});
  assert.equal(code, 1, err.slice(-600));
  assert.match(err, /could not open; stopping/);
  await s.stop();
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["in the store"]);
  await s.stop();
});

test("an upload whose durable record failed is not cached as saved: retrying it writes the record", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta, { idle: "3600" });
  const bytes = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#123456" } }).png().toBuffer();
  const imageId = "img:" + (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const pending = pendingPath(storage, imageId);
  await mkdir(join(pending, "blocker"), { recursive: true });
  const data = bytes.toString("base64");
  const args = { total: data.length, offset: 0, data, fileName: "r.png" };
  const failed = await s.raw("upload_visual_image", args);
  assert.equal(failed.isError, true, JSON.stringify(failed.content).slice(0, 300));
  await rm(pending, { recursive: true });
  assert.equal((await s.call("upload_visual_image", args)).structuredContent.imageId, imageId);
  assert.equal((await pendingFiles(storage)).length, 1, "the retry wrote the record");
  await s.kill();
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), []);
  await s.stop();
});

test("a canvas record from before metadata, views and history moved into the store takes them from the older files once", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta, { mode: "legacy" });
  const imageId = await upload(s, "#445566");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .5, y: .5, label: "older" }] });
  const view = (await s.call("process_image", { imageId, ops: [{ op: "levels" }], output: { format: "png" } })).structuredContent.derivedViewId;
  await s.stop();
  // What an earlier UVA canvas store left: the canvas alone.
  const canvas = JSON.parse(await readFile(canvasJson(storage, imageId), "utf8"));
  await mkdir(join(storage, "uva-pending"), { recursive: true });
  await writeFile(pendingPath(storage, imageId), JSON.stringify({ schema: "estampes.canvas-pending/1", seq: 1, canvas }));
  s = await start(storage, beta, { idle: "3600" });
  assert.deepEqual(await s.labels(imageId), ["older"]);
  const record = JSON.parse(await readFile(pendingPath(storage, imageId), "utf8"));
  assert.equal(record.seq, 2);
  assert.equal(record.extra.meta.imageId, imageId);
  assert.ok(record.extra.derived?.views?.some((v) => v.id === view || v.derivedViewId === view), JSON.stringify(record.extra.derived).slice(0, 300));
  assert.ok(record.extra.log.length >= 1);
  await s.kill();
  // The older files are no longer needed.
  await rm(join(storage, "images"), { recursive: true });
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["older"]);
  assert.equal((await s.raw("get_derived_view", { imageId, derivedViewId: view })).isError, undefined);
  await s.stop();
});

test("a derived binding on a canvas moves into its document, survives edits, a kill and a restart, and is not left behind in the legacy file", { timeout: 180000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta, { mode: "legacy" });
  const imageId = await upload(s, "#336699");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .5, y: .5, label: "first" }] });
  await s.stop();
  // Put a module-made object and the binding that refreshes it into the canvas record, as 5B-2b will.
  const file = canvasJson(storage, imageId), canvas = JSON.parse(await readFile(file, "utf8"));
  const hash = "b".repeat(64);
  canvas.objects = [{ id: "o1", type: "axes-2d", props: { xRange: [-1, 1], yRange: [-1, 1] }, revision: 1, visibility: "public", provenance: { author: "module", module: "com.example.demo.producer", moduleVersion: "1.0.0" } }];
  canvas.sceneRevision = 1; canvas.objectSeq = 1;
  const binding = { id: "bind:22222222-2222-4222-8222-222222222222", kind: "derived", version: 1,
    source: { module: "com.example.demo.producer", capability: "make", sourceRef: "opaque to the core", sourceRevision: 1, inputsHash: hash },
    target: { id: "o1" }, lastApplied: { objectRevision: 1, contentHash: hash, sourceRevision: 1 }, policy: "pause-on-user-edit", state: "fresh" };
  canvas.derived = [binding];
  await writeFile(file, JSON.stringify(canvas));

  const derivedOf = async () => {
    await rm(join(storage, "legacy-out"), { recursive: true, force: true });
    const run = spawn(process.execPath, ["scripts/uva-to-legacy.mjs", storage, beta], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
    let out = ""; run.stdout.on("data", (d) => { out += d; });
    assert.equal(await new Promise((r) => run.once("exit", r)), 0, out);
    return JSON.parse(await readFile(canvasJson(storage, imageId), "utf8")).derived;
  };

  // Moves in once, committed to a document.
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["first"]);
  await committed(s, storage);
  // An edit made through the server must not wash the binding out of the document.
  await s.call("present_visual", { imageId, annotations: [{ id: "a2", type: "point", x: .2, y: .2, label: "second" }] });
  await committed(s, storage);
  // The document itself, not only the canvas record, holds the binding.
  const docs = await s.documents(), doc = docs.find((w) => JSON.stringify(w).includes(imageId.slice(4, 12))) ?? docs[0];
  const opened = (await s.call("uva_store", { action: "open", documentId: doc.documentId ?? doc.id })).structuredContent.document;
  const held = opened.bindings.filter((b) => b.kind === "derived");
  assert.equal(held.length, 1, JSON.stringify({ b: opened.bindings.map((b) => b.kind), o: opened.scenes[0].objects.map((o) => o.id), a: JSON.stringify(opened.extensions).slice(0, 600) }));
  assert.deepEqual([held[0].id, held[0].target.kind, held[0].target.id, held[0].state], [binding.id, "object", "o1", "fresh"]);
  await s.stop();
  await rm(join(storage, "images"), { recursive: true });
  assert.deepEqual(await derivedOf(), [binding], "the committed document holds the binding");

  // An edit killed before its commit is recovered with the binding from the pending copy.
  s = await start(storage, beta, { idle: "3600" });
  await s.call("present_visual", { imageId, annotations: [{ id: "a3", type: "point", x: .8, y: .8, label: "third" }] });
  await s.kill();
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["first", "second", "third"]);
  await committed(s, storage);
  await s.stop();
  await rm(join(storage, "images"), { recursive: true, force: true });
  assert.deepEqual(await derivedOf(), [binding]);
});
