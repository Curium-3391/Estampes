// ESTAMPES_CANVAS_STORE=uva: workspaces, panel surfaces and calculator
// notebooks are committed to UVA record documents and restored from them.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { chooseRecord, createRecordStore } from "../src/uva/record-store.js";
import { hashJson } from "../src/documents/validation.js";

const python = process.env.PYTHON ?? "python3";
const noPython = spawnSync(python, ["-c", "import sympy"]).status === 0 ? false : "python3 with sympy is not installed";
const running = new Set();
test.after(() => { for (const p of running) p.kill("SIGKILL"); });
async function freePort() { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
async function start(storage, beta, { idle = "0", cas = false } = {}) {
  const port = await freePort(), sock = join(storage, "..", "cas-" + port + ".sock");
  const casProc = cas ? spawn(python, ["-m", "estampes_cas"], { cwd: "cas-service", env: { ...process.env, ESTAMPES_CAS_SOCKET: sock, PYTHONPATH: "cas-service" }, stdio: "ignore" }) : null;
  if (casProc) running.add(casProc);
  const proc = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), stdio: "ignore", env: { ...process.env, PORT: String(port),
    ESTAMPES_STORAGE_DIR: storage, ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0", ESTAMPES_RATE_LIMIT_PER_MIN: "0",
    ESTAMPES_UVA_BETA_DIR: beta, ESTAMPES_UVA_BETA_PROFILE: "linux-process-crash-test",
    ESTAMPES_CANVAS_STORE: "uva", ESTAMPES_UVA_MIRROR_IDLE_SEC: idle, ...(cas ? { ESTAMPES_CAS_SOCKET: sock } : {}) } });
  for (let i = 0; i < 300; i++) { try { if ((await fetch("http://127.0.0.1:" + port + "/")).ok) break; } catch {} await sleep(100); }
  const client = new Client({ name: "record-store", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp")));
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, name + ": " + JSON.stringify(r.content)); return r; };
  running.add(proc);
  const exited = new Promise((r) => proc.once("exit", () => { running.delete(proc); casProc?.kill("SIGKILL"); if (casProc) running.delete(casProc); r(); }));
  const diagnostics = async () => (await call("uva_store", { action: "status" })).structuredContent.diagnostics;
  return {
    call, diagnostics, port,
    records: async () => (await diagnostics()).mirror.recordStore,
    get: async (path) => (await fetch("http://127.0.0.1:" + port + path)).json(),
    async enable(ids) {
      for (const id of ids) {
        const prep = await call("prepare_module_change", { action: "enable", module: id });
        await call("store_commit_plan", { planId: prep.structuredContent.plan.planId, consent: prep._meta["estampes/consent"].consent });
      }
    },
    async stop() { await client.close().catch(() => {}); proc.kill("SIGTERM"); await exited; },
    async kill() { await client.close().catch(() => {}); proc.kill("SIGKILL"); await exited; },
  };
}
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error("timed out waiting"); await sleep(100); }
}
async function folders(t) {
  const root = await mkdtemp(join(tmpdir(), "record-store-")), storage = join(root, "legacy"), beta = join(root, "uva");
  await mkdir(storage); await mkdir(beta, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { storage, beta };
}
async function upload(server, color) {
  const data = (await sharp({ create: { width: 160, height: 100, channels: 3, background: color } }).png().toBuffer()).toString("base64");
  return (await server.call("upload_visual_image", { total: data.length, offset: 0, data, fileName: "c.png" })).structuredContent.imageId;
}
const pendingRecords = async (storage) => (await readdir(join(storage, "uva-pending", "records")).catch(() => [])).filter((n) => n.endsWith(".json"));
const wsFile = (storage, id) => join(storage, "workspaces", id.slice(3) + ".json");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const settled = (s, storage) => until(async () => !(await pendingRecords(storage)).length && (await s.records())?.committed > 0).catch(async (e) => { throw new Error(e.message + ": " + JSON.stringify({ pending: await pendingRecords(storage), records: await s.records(), mirror: (await s.diagnostics()).mirror.lastError })); });

test("chooseRecord orders records by seq and adopts only a file it does not know", () => {
  const v1 = { id: "ws:1", n: 1 }, v2 = { id: "ws:1", n: 2 }, v3 = { id: "ws:1", n: 3 };
  assert.equal(chooseRecord({}), null);
  assert.deepEqual(chooseRecord({ legacy: v1 }), { from: "legacy", value: v1, adopt: true, seq: 0 });
  const uva = { seq: 4, value: v1, legacyHash: hashJson(v1) }, pending = { seq: 5, value: v2, legacyHash: hashJson(v2) };
  assert.equal(chooseRecord({ uva, pending, legacy: v2 }).from, "pending", "the higher seq wins");
  assert.equal(chooseRecord({ uva, pending, legacy: v2 }).repairLegacy, false);
  const newer = { ...uva, seq: 6, legacyHash: hashJson(v2) };
  assert.equal(chooseRecord({ uva: newer, pending, legacy: v2 }).from, "uva");
  assert.equal(chooseRecord({ uva: newer, pending, legacy: v2 }).repairLegacy, true, "a file the latest record knows is rewritten to it");
  const adopted = chooseRecord({ uva, pending, legacy: v3 });
  assert.equal(adopted.adopt, true, "a file neither record knows was written behind the server's back");
  assert.equal(adopted.seq, 5);
  assert.equal(chooseRecord({ uva, legacy: { ...v1 } }).adopt, false);
});

test("a pending record whose commit failed is committed again without another edit", { timeout: 30000 }, async (t) => {
  const { storage } = await folders(t);
  const ws = "ws:" + "ab".repeat(8), doc = { id: ws, name: "w", items: [], revision: 1 };
  await mkdir(join(storage, "workspaces"), { recursive: true });
  await writeFile(wsFile(storage, ws), JSON.stringify(doc));
  let calls = 0;
  const held = new Map();
  const service = {
    noteMirror() {}, recordKeys: async () => [...held.keys()], recordState: async (key) => held.get(key) ?? null,
    async syncRecord({ key, value, seq }) {
      if (++calls === 1) throw Object.assign(new Error("disk briefly unavailable"), { code: "EIO" });
      held.set(key, { value, seq, valueHash: hashJson(value), legacyHash: hashJson(value) });
      return { status: "created", sourceHash: hashJson(value), seq };
    },
  };
  const store = await createRecordStore({ service, storageDir: storage, idleMs: 0, scanEveryMs: 50 });
  t.after(() => store.close());
  await until(async () => calls >= 1);
  await until(async () => held.has("workspace/" + ws) && !(await pendingRecords(storage)).length, 10000);
  assert.ok(calls >= 2, "retried after the failure");
  assert.deepEqual(held.get("workspace/" + ws).value, doc);
});

test("an edit that lands while its record is being written is adopted on restart, not overwritten", { timeout: 30000 }, async (t) => {
  const { storage } = await folders(t);
  const ws = "ws:" + "cd".repeat(8), a = { id: ws, name: "A", items: [], revision: 1 }, b = { ...a, name: "B", revision: 2 };
  await mkdir(join(storage, "workspaces"), { recursive: true });
  let raced = false;
  // Commits never happen here; the edit lands between the scan's read and the pending write.
  const service = { noteMirror() {}, recordKeys: async () => [], syncRecord: async () => { throw new Error("offline"); },
    async recordState() { if (!raced) { raced = true; await writeFile(wsFile(storage, ws), JSON.stringify(b)); } return null; } };
  const store = await createRecordStore({ service, storageDir: storage, idleMs: 600000, scanEveryMs: 0 });
  await writeFile(wsFile(storage, ws), JSON.stringify(a));
  await store.settle();
  assert.ok(raced);
  const [name] = await pendingRecords(storage);
  const pending = await readJson(join(storage, "uva-pending", "records", name));
  // The server dies before its next scan would record B (no close()).
  assert.equal(pending.value.name, "A");
  assert.equal(pending.legacyHash, hashJson(a), "the pending copy names the content it holds, not the newer file");
  const again = await createRecordStore({ service: { ...service, recordState: async () => null }, storageDir: storage, idleMs: 600000, scanEveryMs: 0 });
  await again.close();
  assert.equal((await readJson(wsFile(storage, ws))).name, "B", "the newer file is adopted, never rewritten to A");
});

test("workspaces are committed to UVA and restored from it after a restart", { timeout: 180000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta);
  const a = await upload(s, "#336699"), b = await upload(s, "#993366"), c = await upload(s, "#669933");
  const made = await s.call("create_workspace", { name: "三張圖", canvases: [a, b, c] });
  const ws = made.structuredContent.workspaceId ?? made.structuredContent.workspace?.id;
  assert.match(ws, /^ws:[0-9a-f]{16}$/);
  await s.call("edit_workspace", { workspaceId: ws, name: "改名後", expectedRevision: made.structuredContent.revision ?? made.structuredContent.workspace?.revision });
  await settled(s, storage);
  const r = await s.records();
  assert.ok(r.records["workspace/" + ws]?.committedSeq >= 2, JSON.stringify(r.records));
  assert.equal((await s.call("uva_store", { action: "list" })).structuredContent.workspaces.filter((d) => /^Record /.test(d.title)).length, 0, "record documents are not offered as Beta workspaces");
  const before = await readJson(wsFile(storage, ws));
  assert.equal(before.name, "改名後");
  await s.stop();

  // Without its file the workspace comes back from UVA, byte for byte.
  await unlink(wsFile(storage, ws));
  s = await start(storage, beta);
  assert.deepEqual(await readJson(wsFile(storage, ws)), before);
  assert.equal((await s.records()).repaired, 1);
  const state = await s.call("get_workspace_state", { workspace: ws });
  assert.equal(state.structuredContent.name ?? state.structuredContent.workspace?.name, "改名後");
  const http = await s.get("/api/v1/workspaces/" + ws.slice(3));
  assert.equal(http.items?.length ?? http.workspace?.items?.length, 3);
  await s.stop();
});

test("a workspace file written behind the server's back is adopted; an edit killed before its commit is recovered", { timeout: 180000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta);
  const a = await upload(s, "#123456"), b = await upload(s, "#654321");
  const made = await s.call("create_workspace", { name: "first", canvases: [a, b] });
  const ws = made.structuredContent.workspaceId ?? made.structuredContent.workspace?.id;
  await settled(s, storage);
  await s.stop();

  // A newer file the records do not know (a legacy-mode run, a restore by hand).
  const doc = await readJson(wsFile(storage, ws));
  await writeFile(wsFile(storage, ws), JSON.stringify({ ...doc, name: "edited offline", revision: doc.revision + 1 }));
  s = await start(storage, beta);
  assert.equal((await s.records()).adopted, 1);
  await settled(s, storage);
  await s.stop();
  await unlink(wsFile(storage, ws));

  // Commits wait long enough for the process to be killed with only the pending copy.
  s = await start(storage, beta, { idle: "600" });
  assert.equal((await readJson(wsFile(storage, ws))).name, "edited offline", "the adopted file is now the committed record");
  const cur = await readJson(wsFile(storage, ws));
  await s.call("edit_workspace", { workspaceId: ws, name: "before the kill", expectedRevision: cur.revision });
  const records = await s.records();
  assert.ok(records.records["workspace/" + ws].pendingSeq > (records.records["workspace/" + ws].committedSeq ?? 0), "pending durable, not committed yet: " + JSON.stringify(records.records));
  assert.equal((await pendingRecords(storage)).length, 1);
  await s.kill();
  await unlink(wsFile(storage, ws));
  s = await start(storage, beta);
  assert.equal((await readJson(wsFile(storage, ws))).name, "before the kill");
  await settled(s, storage);
  await s.stop();
});

test("a calculator notebook and its panel are committed to UVA and restored, and a bundle is exported from them", { skip: noPython, timeout: 180000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta, { cas: true });
  await s.enable(["org.estampes.graph", "org.estampes.cas"]);
  const opened = await s.call("manage_surface_panels", { action: "open", module: "org.estampes.cas", panel: "calculator" });
  const imageId = opened.structuredContent.imageId, nb = opened.structuredContent.surface.panels.find((p) => p.kind === "calculator").notebook;
  const def = await s.call("surface_cas", { imageId, capability: "define", params: { notebook: nb, name: "f", params: ["x"], text: "3*x^2" } });
  assert.ok(!def.isError, JSON.stringify(def.content));
  await settled(s, storage);
  await until(async () => (await s.records()).records["notebook/" + nb]?.committedSeq >= 1);
  const nbPath = join(storage, "cas", "notebooks", nb.replace(":", "_") + ".json");
  const book = await readJson(nbPath);
  const surfaceKey = Object.keys((await s.records()).records).find((k) => k.startsWith("surface/"));
  assert.ok(surfaceKey, "the panel layout is a record too");
  const surfacePath = join(storage, "surfaces", surfaceKey.slice(8).replace(":", "_") + ".json");
  const surface = await readJson(surfacePath);
  await s.stop();

  await unlink(nbPath); await unlink(surfacePath);
  s = await start(storage, beta, { cas: true });
  assert.deepEqual(await readJson(nbPath), book);
  assert.deepEqual(await readJson(surfacePath), surface);
  const state = await s.call("surface_cas", { imageId, capability: "get_notebook", params: { notebook: nb, full: true } });
  assert.ok(JSON.stringify(state.structuredContent).includes("3*x^2"), "the notebook reads back its definition");
  const bundle = await s.call("export_workspace_bundle", { workspace: imageId });
  assert.ok(bundle.structuredContent.bytes > 0);
  await s.stop();
});
