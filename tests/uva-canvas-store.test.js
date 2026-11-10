// ESTAMPES_CANVAS_STORE=uva: real server processes over real storage folders,
// restarted and killed between steps.
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
const committed = (server, storage) => until(async () => !(await pendingFiles(storage)).length && (await server.diagnostics()).mirror.canvasStore?.committed > 0);

test("a canvas is committed to its UVA document and restored from it after a restart", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta);
  const imageId = await upload(s, "#336699");
  await s.call("present_visual", { imageId, layer: "第一輪", annotations: [{ id: "a1", type: "rect", x: .1, y: .2, x2: .4, y2: .5, label: "first" }, { id: "a2", type: "point", x: .7, y: .7, label: "second" }] });
  await committed(s, storage);
  const [doc] = await s.documents();
  const open = (await s.call("uva_store", { action: "open", documentId: doc.id })).structuredContent.document;
  const ext = open.extensions["estampes.beta:mirror"];
  assert.equal(ext.authority, "uva");
  assert.equal(open.extensions["estampes.beta:legacyArchives"], undefined, "the raw canvas is not stored again as a sidecar");
  assert.deepEqual(open.scenes[0].annotations.map((a) => a.label).sort(), ["first", "second"]);
  assert.equal((await s.diagnostics()).mirror.lastResidualBytes, 0, JSON.stringify(ext.residual));
  await s.stop();

  // canvas.json is only the legacy copy now: without it the canvas comes from
  // UVA, and the copy is written again at startup for the sealed modules.
  await unlink(canvasJson(storage, imageId));
  s = await start(storage, beta);
  const repaired = JSON.parse(await readFile(canvasJson(storage, imageId), "utf8"));
  assert.deepEqual(repaired.marks.map((m) => m.label).sort(), ["first", "second"]);
  assert.equal((await s.diagnostics()).mirror.canvasStore.repaired, 1);
  assert.deepEqual(await s.labels(imageId), ["first", "second"]);
  // Further edits keep updating the same document.
  await s.call("present_visual", { imageId, annotations: [{ id: "a3", type: "point", x: .2, y: .8, label: "third" }] });
  await committed(s, storage);
  assert.equal((await s.documents()).length, 1);
  await s.stop();
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["first", "second", "third"]);
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
  // The legacy copy is gone too: only the pending copy holds the edit.
  await unlink(canvasJson(storage, imageId));
  s = await start(storage, beta);
  await committed(s, storage);
  assert.deepEqual(await s.labels(imageId), ["unsaved?"]);
  assert.equal((await s.documents()).length, 1);
  await s.stop();
});

test("a legacy canvas moves into UVA on open, and a newer canvas.json written behind the server's back wins", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta, { mode: "legacy" });
  const imageId = await upload(s, "#669933");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .5, y: .5, label: "old canvas" }] });
  await s.stop();
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["old canvas"]);
  await committed(s, storage);
  assert.equal((await s.diagnostics()).mirror.canvasStore.migrated, 1);
  await s.stop();

  // e.g. the workspace or bundle modules, which write canvas.json themselves.
  // Its clock time does not matter (here it is far in the past): content the
  // store's records do not know is a newer save.
  const legacy = JSON.parse(await readFile(canvasJson(storage, imageId), "utf8"));
  legacy.marks.push({ ...legacy.marks[0], id: "a2", label: "written later" });
  await writeFile(canvasJson(storage, imageId), JSON.stringify({ ...legacy, savedAt: "2000-01-01T00:00:00.000Z" }));
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["old canvas", "written later"]);
  await committed(s, storage);
  const [doc] = await s.documents();
  const open = (await s.call("uva_store", { action: "open", documentId: doc.id })).structuredContent.document;
  assert.equal(open.scenes[0].annotations.length, 2);
  await s.stop();

  // Switching back to legacy still has every edit.
  s = await start(storage, beta, { mode: "legacy" });
  assert.deepEqual(await s.labels(imageId), ["old canvas", "written later"]);
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
  const before = JSON.parse(await readFile(canvasJson(storage, imageId), "utf8"));
  const pngs = before.objects.filter((o) => o.type === "image").map((o) => o.props.png);
  assert.equal(pngs.length, 2);
  assert.equal(before.baseAsObject, true);
  const [doc] = (await s.documents()).filter((d) => d.title === "Canvas " + imageId);
  const open = (await s.call("uva_store", { action: "open", documentId: doc.id })).structuredContent.document;
  const scene = open.scenes[0];
  assert.equal(scene.background.kind, "transparent");
  const images = scene.objects.filter((o) => o.type === "image");
  assert.equal(images.length, 2);
  // The document holds references, not the PNG text.
  for (const o of images) assert.match(o.props.asset.assetId, /^asset:sha256:[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(open).includes("data:image/png"));
  assert.ok(Buffer.byteLength(JSON.stringify(open)) < 64 * 1024);
  // Render works without a background asset.
  const r = await s.call("uva_store", { action: "render", documentId: doc.id });
  const pixels = r.content.find((c) => c.type === "image");
  assert.ok(pixels?.data.length > 100, JSON.stringify(r.content).slice(0, 300));
  // The export carries every image the document references.
  const exported = (await s.call("uva_store", { action: "export", documentId: doc.id })).structuredContent;
  const zip = await readFile(join(beta, "exports", exported.exportId + ".zip"));
  for (const o of images) assert.ok(zip.includes(Buffer.from("assets/" + o.props.asset.assetId.slice(13))), o.props.asset.assetId);
  await s.stop();

  // The legacy copy is gone: the canvas, including every PNG, comes back from UVA.
  await unlink(canvasJson(storage, imageId));
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["kept"]);
  assert.equal((await s.diagnostics()).mirror.canvasStore.restored.uva, 1);
  const after = JSON.parse(await readFile(canvasJson(storage, imageId), "utf8"));
  assert.deepEqual(after.objects.filter((o) => o.type === "image").map((o) => o.props.png), pngs);
  // Moving an image layer is an object edit; it commits and survives a restart.
  const moved = after.objects.find((o) => o.type === "image" && o.props.region.x === .1);
  await s.call("edit_scene_object", { imageId, id: moved.id, props: { region: { x: .2, y: .2, x2: .6, y2: .7 } } });
  await committed(s, storage);
  await s.stop();
  await unlink(canvasJson(storage, imageId));
  s = await start(storage, beta);
  const last = JSON.parse(await readFile(canvasJson(storage, imageId), "utf8"));
  assert.deepEqual(last.objects.find((o) => o.id === moved.id).props.region, { x: .2, y: .2, x2: .6, y2: .7 });
  assert.equal(last.objects.find((o) => o.id === moved.id).props.png, moved.props.png);
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
  const before = { left: JSON.parse(await readFile(canvasJson(storage, left), "utf8")), right: JSON.parse(await readFile(canvasJson(storage, right), "utf8")) };
  assert.equal(before.left.links[right].length, 1);
  assert.equal((await s.diagnostics()).mirror.blocked?.[left], undefined);
  const docs = await s.documents();
  const doc = docs.find((d) => d.title === "Canvas " + left);
  const open = (await s.call("uva_store", { action: "open", documentId: doc.id })).structuredContent.document;
  const binding = open.bindings.find((b) => b.kind === "relation");
  assert.ok(binding, JSON.stringify({ bindings: open.bindings, ext: open.extensions, diag: (await s.diagnostics()).mirror }).slice(0, 1500));
  assert.equal(binding.from.id, "a1");
  assert.equal(binding.to.id, "b1");
  // The far end names the other canvas's own document.
  assert.equal(binding.to.documentId, docs.find((d) => d.title === "Canvas " + right).id);
  assert.equal(binding.label, "same");
  assert.equal(binding.original.review, "confirmed");
  // The link lives in the document structure, not in the exact-difference patch.
  assert.equal(JSON.stringify(open.extensions["estampes.beta:mirror"].residual ?? {}).includes("links"), false);
  await s.stop();

  // Both canvases, links included, come back from UVA alone.
  await unlink(canvasJson(storage, left));
  await unlink(canvasJson(storage, right));
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(left), ["left"]);
  const after = JSON.parse(await readFile(canvasJson(storage, left), "utf8")), afterRight = JSON.parse(await readFile(canvasJson(storage, right), "utf8"));
  const strip = ({ savedAt, ...rest }) => rest;
  assert.deepEqual(strip(after), strip(before.left));
  assert.deepEqual(strip(afterRight), strip(before.right));
  await s.stop();
});

test("a canvas the document cannot hold yet stays in its pending copy and is reported", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta);
  const imageId = await upload(s, "#336633");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .5, y: .5, label: "kept" }] });
  await committed(s, storage);
  await s.stop();
  // A link without its far end, written past the server (adopted on restore).
  const legacy = JSON.parse(await readFile(canvasJson(storage, imageId), "utf8"));
  legacy.links = { "img:0000000000000000": [{ id: "k9", left: "a1", label: "half" }] };
  await writeFile(canvasJson(storage, imageId), JSON.stringify(legacy));
  s = await start(storage, beta);
  const d = await until(async () => { const m = (await s.diagnostics()).mirror; return m.blocked?.[imageId] ? m : null; });
  assert.match(d.blocked[imageId], /endpoint|binding/i);
  assert.equal((await pendingFiles(storage)).length, 1);
  await s.stop();
  await unlink(canvasJson(storage, imageId));
  s = await start(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["kept"]);
  assert.deepEqual(JSON.parse(await readFile(canvasJson(storage, imageId), "utf8")).links, legacy.links);
  assert.equal((await s.diagnostics()).mirror.canvasStore.restored.pending, 1);
  await s.stop();
});

test("a workspace copy of a canvas is committed under its set key and restored from it", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta);
  const imageId = await upload(s, "#335577");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .3, y: .3, label: "orig" }] });
  // The base image is promoted to an image layer, so the copy has a transparent background.
  await s.call("add_image_layer", { imageId });
  const preview = await s.call("split_workspace", { source: imageId, mode: "copy" });
  const done = await s.call("split_workspace", { source: imageId, mode: "copy", commit: true, previewId: preview.structuredContent.previewId });
  const ws = done.structuredContent.workspaceId;
  const doc = await s.get("/api/v1/workspaces/" + ws.slice(3));
  const key = JSON.stringify(doc).match(/img:[0-9a-f]{16}#c[0-9a-f]{12}/)?.[0];
  assert.ok(key, JSON.stringify(doc).slice(0, 400));
  const setFile = join(storage, "images", imageId.slice(4), "sets", key.split("#")[1] + ".json");
  await until(async () => !(await pendingFiles(storage)).length && (await s.documents()).some((d) => d.title === "Canvas " + key));
  // An edit of the copy through the workspace is committed too.
  const item = JSON.stringify(doc).match(/"id":"(wi-\d+)"/)[1];
  await s.call("present_visual", { workspaceId: ws, verify: false, annotations: [{ id: "c1", type: "point", x: .6, y: .6, label: "copy only", item }] });
  await until(async () => {
    if ((await pendingFiles(storage)).length) return false;
    const d = (await s.documents()).find((x) => x.title === "Canvas " + key);
    const open = (await s.call("uva_store", { action: "open", documentId: d.id })).structuredContent.document;
    return open.scenes[0].annotations.some((a) => a.label === "copy only");
  });
  const before = JSON.parse(await readFile(setFile, "utf8"));
  assert.equal(before.setId, key.split("#")[1]);
  assert.equal(before.baseAsObject, true);
  // The image's own canvas did not get the copy's mark.
  assert.deepEqual(await s.labels(imageId), ["orig"]);
  await s.stop();

  // The copy's set file is gone: it comes back from its UVA document.
  await unlink(setFile);
  s = await start(storage, beta);
  const strip = ({ savedAt, ...rest }) => rest;
  assert.deepEqual(strip(JSON.parse(await readFile(setFile, "utf8"))), strip(before));
  const again = await s.get("/api/v1/workspaces/" + ws.slice(3));
  assert.ok(JSON.stringify(again).includes("copy only"), JSON.stringify(again).slice(0, 300));
  await s.stop();
});

test("a workspace read over HTTP after a restart shows the committed canvas, and later edits keep it", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta);
  const imageId = await upload(s, "#663399");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .3, y: .3, label: "committed" }] });
  await committed(s, storage);
  const ws = (await s.call("create_workspace", { canvases: [imageId] })).structuredContent.workspaceId;
  await s.stop();
  await unlink(canvasJson(storage, imageId));
  s = await start(storage, beta);
  // The HTTP route loads the images through the workspace module itself.
  const doc = await s.get("/api/v1/workspaces/" + ws.slice(3));
  assert.ok(JSON.stringify(doc).includes("committed"), JSON.stringify(doc).slice(0, 300));
  await s.call("present_visual", { imageId, annotations: [{ id: "a2", type: "point", x: .6, y: .6, label: "later" }] });
  assert.deepEqual(await s.labels(imageId), ["committed", "later"]);
  await s.stop();
});

test("a save is acknowledged only once its pending record is durable; legacy, pending and committed are reported apart", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta, { idle: "3600" });
  const imageId = await upload(s, "#996699");
  const image = async () => (await s.diagnostics()).mirror.canvasStore.images[imageId];
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .2, y: .2, label: "one" }] });
  assert.deepEqual(await image(), { pendingSeq: 1, legacy: "matches" });

  // The pending record cannot be written: the save fails, although canvas.json has it.
  const pending = join(storage, "uva-pending", imageId.slice(4) + ".json");
  await unlink(pending);
  await mkdir(join(pending, "blocker"), { recursive: true });
  const failed = await s.raw("present_visual", { imageId, annotations: [{ id: "a2", type: "point", x: .4, y: .4, label: "two" }] });
  assert.equal(failed.isError, true, JSON.stringify(failed.content));
  assert.match(failed.content[0].text, /not saved to the UVA canvas store/);
  assert.ok((await readFile(canvasJson(storage, imageId), "utf8")).includes('"two"'), "the legacy copy was written");
  const after = await image();
  assert.equal(after.pendingSeq, 1);
  assert.equal(after.failedSeq, 2);
  assert.equal(after.committedSeq, undefined);
  await rm(pending, { recursive: true });

  // The next save gets a later sequence number, and its commit is reported.
  // (The store may first re-record the legacy copy that holds "two", so the
  // number is 2 or 3 depending on timing; it never reuses 1.)
  await s.call("present_visual", { imageId, annotations: [{ id: "a3", type: "point", x: .6, y: .6, label: "three" }] });
  const seq = (await image()).pendingSeq;
  assert.ok(seq === 2 || seq === 3, "pendingSeq " + seq);
  await s.stop();
  s = await start(storage, beta);
  await committed(s, storage);
  assert.deepEqual(await s.labels(imageId), ["one", "three", "two"]);
  const [doc] = await s.documents();
  const open = (await s.call("uva_store", { action: "open", documentId: doc.id })).structuredContent.document;
  assert.equal(open.extensions["estampes.beta:mirror"].sourceSeq, seq);
  await s.stop();
});
