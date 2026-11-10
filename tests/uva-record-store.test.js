// ESTAMPES_CANVAS_STORE=uva: workspaces, panel surfaces and calculator
// notebooks live only in UVA record documents; no file of theirs is written.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
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

test("chooseRecord takes the higher seq", () => {
  const v1 = { id: "ws:1", n: 1 }, v2 = { id: "ws:1", n: 2 };
  assert.equal(chooseRecord({}), null);
  const uva = { seq: 4, value: v1 }, pending = { seq: 5, value: v2 };
  assert.deepEqual(chooseRecord({ uva, pending }), { from: "pending", value: v2, seq: 5, log: [] });
  assert.equal(chooseRecord({ uva: { ...uva, seq: 6 }, pending }).from, "uva");
});

// An in-memory UVA service: syncRecord fails the first `failures` times.
function fakeService({ failures = 0 } = {}) {
  let calls = 0;
  const held = new Map();
  return {
    held, get calls() { return calls; },
    noteMirror() {}, recordKeys: async () => [...held.keys()], recordState: async (key) => held.get(key) ?? null,
    async syncRecord({ key, value, seq, log }) {
      if (++calls <= failures) throw Object.assign(new Error("disk briefly unavailable"), { code: "EIO" });
      held.set(key, { value, seq, log, valueHash: hashJson(value) });
      return { status: "created", sourceHash: hashJson(value), logHash: hashJson(log ?? []), seq };
    },
  };
}

test("a write is durable before it resolves, is committed, and a failed commit is tried again", { timeout: 30000 }, async (t) => {
  const { storage } = await folders(t);
  const ws = "ws:" + "ab".repeat(8), doc = { id: ws, name: "w", items: [], revision: 1 };
  const service = fakeService({ failures: 1 });
  const store = await createRecordStore({ service, storageDir: storage, idleMs: 0, retryEveryMs: 50 });
  t.after(() => store.close());
  assert.equal(await store.write("workspace", ws, doc), 1);
  assert.deepEqual(await store.read("workspace", ws), doc, "read back before its commit, from the durable pending copy");
  await until(async () => service.held.has("workspace/" + ws) && !(await pendingRecords(storage)).length, 10000);
  assert.ok(service.calls >= 2, "retried after the failure");
  assert.deepEqual(service.held.get("workspace/" + ws).value, doc);
  assert.equal(await store.write("workspace", ws, { ...doc, revision: 2 }), 2, "seq grows by one per accepted write");
  await assert.rejects(store.write("workspace", ws, { id: "ws:" + "00".repeat(8), items: [] }), /Not a valid workspace/);
  assert.deepEqual(await readdir(storage).then((n) => n.filter((x) => x !== "uva-pending")), [], "no workspace file is written");
});

test("an older file is migrated in once, then never read or written again", { timeout: 30000 }, async (t) => {
  const { storage } = await folders(t);
  const ws = "ws:" + "cd".repeat(8), a = { id: ws, name: "A", items: [], revision: 1 };
  await mkdir(join(storage, "workspaces"), { recursive: true });
  await writeFile(wsFile(storage, ws), JSON.stringify(a));
  await writeFile(join(storage, "workspaces", ws.slice(3) + ".history.jsonl"), JSON.stringify({ kind: "create" }) + "\nbroken\n");
  const service = fakeService();
  let store = await createRecordStore({ service, storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
  assert.deepEqual(await store.list("workspace"), [ws]);
  assert.deepEqual(await store.read("workspace", ws), a);
  assert.deepEqual(await store.log("workspace", ws), [{ kind: "create" }]);
  await store.write("workspace", ws, { ...a, name: "B", revision: 2 }, { line: { kind: "rename" } });
  assert.deepEqual(await store.log("workspace", ws), [{ kind: "create" }, { kind: "rename" }]);
  await store.close();
  // The file is now stale; the store's record wins, even when the file changes.
  await writeFile(wsFile(storage, ws), JSON.stringify({ ...a, name: "edited by hand" }));
  store = await createRecordStore({ service, storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
  assert.equal((await store.read("workspace", ws)).name, "B");
  await store.close();
  assert.equal((await readJson(wsFile(storage, ws))).name, "edited by hand", "the old file is never rewritten");
});

test("a migration that fails is tried again on the next read, and an older record gets its history file", { timeout: 30000 }, async (t) => {
  const { storage } = await folders(t);
  const ws = "ws:" + "12".repeat(8), a = { id: ws, name: "A", items: [], revision: 1 };
  await mkdir(join(storage, "workspaces"), { recursive: true });
  await writeFile(wsFile(storage, ws), JSON.stringify(a));
  await writeFile(join(storage, "workspaces", ws.slice(3) + ".history.jsonl"), JSON.stringify({ kind: "create" }) + "\n");
  const service = fakeService({ failures: 0 });
  const real = service.syncRecord; let fail = true;
  service.syncRecord = async (x) => { if (fail) throw Object.assign(new Error("disk briefly unavailable"), { code: "EIO" }); return real(x); };
  const store = await createRecordStore({ service, storageDir: storage, idleMs: 0, retryEveryMs: 0 });
  t.after(() => store.close());
  await store.read("workspace", ws).catch(() => {});
  fail = false;
  assert.deepEqual(await store.read("workspace", ws), a, "the next read migrates the file in");
  assert.deepEqual(await store.log("workspace", ws), [{ kind: "create" }]);
  // A record written earlier without a history: its history file is carried over once.
  const other = "ws:" + "34".repeat(8);
  await writeFile(join(storage, "workspaces", other.slice(3) + ".history.jsonl"), JSON.stringify({ kind: "old" }) + "\n");
  service.held.set("workspace/" + other, { value: { id: other, name: "N", items: [], revision: 1 }, seq: 1, log: null, valueHash: "x" });
  await store.read("workspace", other);
  assert.deepEqual(await store.log("workspace", other), [{ kind: "old" }]);
});

test("a store that cannot be read fails the read instead of passing for no record", { timeout: 30000 }, async (t) => {
  const { storage } = await folders(t);
  const ws = "ws:" + "ef".repeat(8);
  await mkdir(join(storage, "workspaces"), { recursive: true });
  await writeFile(wsFile(storage, ws), JSON.stringify({ id: ws, name: "old", items: [] }));
  const service = { ...fakeService(), recordState: async () => { throw new Error("writer unavailable"); } };
  const store = await createRecordStore({ service, storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
  t.after(() => store.close());
  await assert.rejects(store.read("workspace", ws), /writer unavailable/);
  assert.deepEqual(await pendingRecords(storage), [], "the old file was not migrated over the unreadable store");
});

test("workspaces live in UVA and come back after a restart; no workspace file is written", { timeout: 180000 }, async (t) => {
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
  assert.equal((await s.call("uva_store", { action: "list" })).structuredContent.workspaces.filter((d) => /^Record /.test(d.title)).length, 0, "record documents are not listed as canvases");
  await assert.rejects(readFile(wsFile(storage, ws)), { code: "ENOENT" });
  await assert.rejects(readFile(join(storage, "workspaces", ws.slice(3) + ".history.jsonl")), { code: "ENOENT" });
  await s.stop();

  s = await start(storage, beta);
  const state = await s.call("get_workspace_state", { workspace: ws, history: 10 });
  assert.equal(state.structuredContent.name ?? state.structuredContent.workspace?.name, "改名後");
  assert.ok(JSON.stringify(state.structuredContent).includes("history"), "the change log comes back too");
  const http = await s.get("/api/v1/workspaces/" + ws.slice(3));
  assert.equal(http.items?.length ?? http.workspace?.items?.length, 3);
  await s.stop();
  // Switching back to legacy: the records are written out to the files it reads.
  const out = spawnSync(process.execPath, ["scripts/uva-to-legacy.mjs", storage, beta], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).written.workspace, 1);
  assert.equal((await readJson(wsFile(storage, ws))).name, "改名後");
  assert.ok((await readFile(join(storage, "workspaces", ws.slice(3) + ".history.jsonl"), "utf8")).trim().split("\n").length >= 2);
});

test("an edit killed before its commit is recovered from its durable pending record", { timeout: 180000 }, async (t) => {
  const { storage, beta } = await folders(t);
  // Commits wait long enough for the process to be killed with only the pending copy.
  let s = await start(storage, beta, { idle: "600" });
  const a = await upload(s, "#123456"), b = await upload(s, "#654321");
  const made = await s.call("create_workspace", { name: "first", canvases: [a, b] });
  const ws = made.structuredContent.workspaceId ?? made.structuredContent.workspace?.id;
  const cur = (await s.call("get_workspace_state", { workspace: ws })).structuredContent;
  await s.call("edit_workspace", { workspaceId: ws, name: "before the kill", expectedRevision: cur.revision ?? cur.workspace?.revision });
  const records = await s.records();
  assert.ok(records.records["workspace/" + ws].pendingSeq > (records.records["workspace/" + ws].committedSeq ?? 0), "pending durable, not committed yet: " + JSON.stringify(records.records));
  await s.kill();
  s = await start(storage, beta);
  const state = (await s.call("get_workspace_state", { workspace: ws })).structuredContent;
  assert.equal(state.name ?? state.workspace?.name, "before the kill");
  await settled(s, storage);
  await s.stop();
});

test("a calculator notebook and its panel live in UVA, come back after a restart, and a bundle is exported from them", { skip: noPython, timeout: 180000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await start(storage, beta, { cas: true });
  await s.enable(["org.estampes.graph", "org.estampes.cas"]);
  const opened = await s.call("manage_surface_panels", { action: "open", module: "org.estampes.cas", panel: "calculator" });
  const imageId = opened.structuredContent.imageId, nb = opened.structuredContent.surface.panels.find((p) => p.kind === "calculator").notebook;
  const def = await s.call("surface_cas", { imageId, capability: "define", params: { notebook: nb, name: "f", params: ["x"], text: "3*x^2" } });
  assert.ok(!def.isError, JSON.stringify(def.content));
  await settled(s, storage);
  await until(async () => (await s.records()).records["notebook/" + nb]?.committedSeq >= 1);
  assert.ok(Object.keys((await s.records()).records).some((k) => k.startsWith("surface/")), "the panel layout is a record too");
  await assert.rejects(readdir(join(storage, "cas", "notebooks")), { code: "ENOENT" });
  await assert.rejects(readdir(join(storage, "surfaces")), { code: "ENOENT" });
  await s.stop();

  s = await start(storage, beta, { cas: true });
  const state = await s.call("surface_cas", { imageId, capability: "get_notebook", params: { notebook: nb, full: true } });
  assert.ok(JSON.stringify(state.structuredContent).includes("3*x^2"), "the notebook reads back its definition");
  const panels = await s.call("manage_surface_panels", { imageId, action: "list" }).catch(() => null);
  if (panels) assert.ok(JSON.stringify(panels.structuredContent).includes(nb), "the panel still shows the notebook");
  const bundle = await s.call("export_workspace_bundle", { workspace: imageId });
  assert.ok(bundle.structuredContent.bytes > 0);
  await s.stop();
});
