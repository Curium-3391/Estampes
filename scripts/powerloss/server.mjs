#!/usr/bin/env node
// Power-loss simulator for the whole server (issue #91): the default UVA
// canvas store, its durable pending records, the legacy files and the record
// store, driven through the real MCP tools.
//
//   node scripts/powerloss/server.mjs --dir <folder> [--profile linux-local-durable]
//        [--edits 12] [--points 60] [--out report.json]
//
// The server runs with trace.mjs (see model.mjs for the crash model). The
// client records an acknowledgement after each tool result: images uploaded,
// marks drawn, image layers and workspaces made. For each crash point the
// folders are rebuilt as a power cut would leave them, a fresh server is
// started on them, and every acknowledged result must still be readable
// through the tools, and the canvas must accept a new mark.
import { mkdir, rm, writeFile, readFile, open } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { durableState, materialize, identityTolerantChecker } from "./model.mjs";

const HERE = fileURLToPath(import.meta.url), ROOT = resolve(dirname(HERE), "../..");
const arg = (name, dflt) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : dflt; };
const PROFILE = arg("profile", "linux-process-crash-test");
const freePort = () => new Promise((done) => { const s = createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => done(port)); }); });
async function syncDir(path) { const fd = await open(path, "r"); try { await fd.sync(); } finally { await fd.close(); } }

async function startServer(run, env = {}, cwd = ROOT) {
  const port = await freePort();
  const proc = spawn(process.execPath, ["server.js"], { cwd, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PORT: String(port),
    ESTAMPES_STORAGE_DIR: join(run, "storage"), ESTAMPES_UVA_DIR: join(run, "uva"), ESTAMPES_UVA_PROFILE: PROFILE, ESTAMPES_CANVAS_STORE: "uva", ESTAMPES_UVA_MIRROR_IDLE_SEC: "0",
    ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0", ESTAMPES_RATE_LIMIT_PER_MIN: "0", ESTAMPES_MAX_RESULT_CHARS: "0", ...env } });
  let stderr = ""; proc.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  const exited = new Promise((done) => proc.once("exit", done));
  for (let i = 0; i < 300; i++) { try { if ((await fetch("http://127.0.0.1:" + port + "/")).ok) break; } catch {} if (proc.exitCode !== null) break; await sleep(100); }
  if (proc.exitCode !== null) throw new Error("server exited at start: " + stderr.slice(-600));
  const client = new Client({ name: "powerloss", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp")));
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(name + ": " + JSON.stringify(r.content).slice(0, 400));
    return r;
  };
  const stop = async (signal = "SIGKILL") => { await client.close().catch(() => {}); proc.kill(signal); await exited; };
  return { call, stop, stderr: () => stderr };
}

// Key order is not content: objects are compared with sorted keys.
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
// What a mark must still be after recovery: its kind, label and geometry.
const fingerprint = (m) => canonical({ type: m.type, label: m.label ?? null, geometry: m.geometry ?? null });
// What a workspace must still be: each item's id, what it refers to and where it sits, in order.
// What the image layers must still be: each one's id and props (region, the PNG
// or its reference), hashed.
const imageLayers = (doc) => createHash("sha256").update(canonical((doc.objects ?? []).filter((o) => o.type === "image").map((o) => ({ id: o.id, props: o.props ?? null })))).digest("hex");
const workspaceItems = (doc) => canonical((doc.items ?? []).map((it) => ({ id: it.id, asset: it.asset ?? null, set: it.set ?? null, placement: it.placement ?? null })));

async function photo(seed) {
  const bytes = await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: seed * 70 % 255, g: 120, b: 60 } } }).png().toBuffer();
  return bytes.toString("base64");
}

// ---- workload ---------------------------------------------------------------
async function workload(run, log) {
  const s = await startServer(run, { NODE_OPTIONS: ((process.env.NODE_OPTIONS ?? "") + " --import " + join(dirname(HERE), "trace.mjs")).trim(),
    ESTAMPES_POWERLOSS_ROOT: run, ESTAMPES_POWERLOSS_LOG: log });
  const ack = (e) => appendFileSync(log, JSON.stringify({ t: "ack", ...e }) + "\n");
  try {
    const images = [];
    for (const seed of [1, 2]) {
      const data = await photo(seed);
      const id = (await s.call("upload_visual_image", { total: data.length, offset: 0, data, fileName: "p" + seed + ".png" })).structuredContent.imageId;
      images.push({ id, marks: {} }); ack({ key: id, kind: "image", marks: {} });
    }
    const edits = +arg("edits", 12);
    for (let i = 1; i <= edits; i++) {
      const img = images[i % 2], id = "e" + i;
      await s.call("present_visual", { imageId: img.id, verify: false, annotations: [{ id, type: "point", x: (i % 9) / 10 + .05, y: .5, label: "edit " + i }] });
      // The acknowledged content, as the server reports it right after the save.
      const saved = (await s.call("get_visual_state", { imageId: img.id })).structuredContent.marks.find((m) => m.id === id);
      img.marks[id] = fingerprint(saved); ack({ key: img.id, kind: "image", marks: { ...img.marks } });
      // Give the UVA commit of this edit time to run, so cuts land inside it too.
      await sleep(+arg("pause-ms", 400));
      if (i === 3) { await s.call("add_image_layer", { imageId: img.id }); ack({ key: img.id + "/layer", kind: "layer", imageId: img.id, layers: imageLayers((await s.call("get_visual_state", { imageId: img.id })).structuredContent) }); }
      if (i === 5) {
        const ws = (await s.call("create_workspace", { canvases: images.map((m) => m.id) })).structuredContent.workspaceId;
        const doc = (await s.call("get_workspace_state", { workspace: ws })).structuredContent;
        ack({ key: ws, kind: "workspace", items: workspaceItems(doc) });
      }
    }
  } finally { await s.stop("SIGTERM"); }
}

// ---- check one crash point --------------------------------------------------
let checkerRoot = ROOT;
async function check(events, k, run, scratch) {
  const state = durableState(events, k), target = join(scratch, "s" + k);
  await rm(target, { recursive: true, force: true });
  await materialize(state, run, target);
  const out = { point: k, after: events[k - 1]?.t ?? "start", acked: state.acks.size };
  let s;
  try {
    s = await startServer(target, {}, checkerRoot);
    // The server falls back to the legacy files when UVA cannot open; that is
    // a failed recovery here, even if the legacy files hold every result.
    const store = async () => (await s.call("uva_store", { action: "status" })).structuredContent?.diagnostics?.mirror?.canvasStore;
    if (!(await store())) throw new Error("the UVA canvas store did not open");
    for (const [key, a] of state.acks) {
      if (a.kind === "image") {
        const doc = (await s.call("get_visual_state", { imageId: key })).structuredContent;
        const have = new Map(doc.marks.map((m) => [m.id, fingerprint(m)]));
        const lost = Object.keys(a.marks).filter((id) => !have.has(id));
        if (lost.length) throw new Error(key + " lost acknowledged marks " + lost.join(","));
        const changed = Object.keys(a.marks).filter((id) => have.get(id) !== a.marks[id]);
        if (changed.length) throw new Error(key + " changed acknowledged marks " + changed.map((id) => id + ": " + have.get(id) + " != " + a.marks[id]).join("; ").slice(0, 400));
      } else if (a.kind === "layer") {
        const doc = (await s.call("get_visual_state", { imageId: a.imageId })).structuredContent;
        if (!(doc.objects ?? []).some((o) => o.type === "image")) throw new Error(a.imageId + " lost its acknowledged image layer");
        if (imageLayers(doc) !== a.layers) throw new Error(a.imageId + " image layers differ from the acknowledged ones");
      } else if (a.kind === "workspace") {
        const doc = (await s.call("get_workspace_state", { workspace: key })).structuredContent;
        if (workspaceItems(doc) !== a.items) throw new Error(key + " items differ from the acknowledged ones: " + workspaceItems(doc).slice(0, 300) + " != " + a.items.slice(0, 300));
      }
    }
    const image = [...state.acks.values()].find((a) => a.kind === "image");
    if (image) {
      const before = (await store()).writes;
      await s.call("present_visual", { imageId: image.key, verify: false, annotations: [{ id: "after-cut", type: "point", x: .5, y: .5, label: "after" }] });
      // The new write must reach its UVA durability boundary (a pending record).
      const after = await store();
      if (!(after.writes > before) || !Number.isSafeInteger(after.images?.[image.key]?.pendingSeq)) throw new Error("the write after the cut was not recorded durably in UVA: " + JSON.stringify(after).slice(0, 300));
    }
    out.pass = true;
  } catch (error) {
    out.pass = false; out.error = String(error?.message || error).slice(0, 600);
    if (s) out.serverLog = s.stderr().split("\n").filter((l) => /error|warn/i.test(l)).slice(-5);
  } finally {
    await s?.stop();
    await rm(target, { recursive: true, force: true });
  }
  return out;
}

async function main() {
  const base = resolve(arg("dir") ?? (() => { throw new Error("--dir is required"); })());
  const id = randomBytes(4).toString("hex"), run = join(base, "pls-run-" + id), scratch = join(base, "pls-check-" + id), log = join(base, "pls-" + id + ".jsonl");
  await mkdir(join(run, "storage"), { recursive: true, mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
  await syncDir(join(run, "storage")); await syncDir(run); await syncDir(base);
  // The folders the operator made before starting the server already exist.
  await writeFile(log, JSON.stringify({ t: "d", path: run, entries: [["storage", "baseline", 1]] }) + "\n");
  const started = Date.now();
  await workload(run, log);
  const workloadMs = Date.now() - started;
  const events = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const ackAt = events.flatMap((e, i) => e.t === "ack" ? [i] : []);
  const points = new Set([1, events.length]);
  for (const a of ackAt) for (const d of [-1, 0, 1]) if (a + d >= 1 && a + d <= events.length) points.add(a + d);
  const extra = +arg("points", 60);
  for (let j = 1; j <= extra; j++) points.add(Math.max(1, Math.round(j * events.length / (extra + 1))));
  checkerRoot = await identityTolerantChecker(ROOT);
  const results = [];
  for (const k of [...points].sort((a, b) => a - b)) {
    const r = await check(events, k, run, scratch);
    results.push(r);
    if (!r.pass) console.error("FAIL at record " + k + " (after " + r.after + "): " + r.error);
  }
  const fsType = (() => { try { return execFileSync("sh", ["-c", "findmnt -no FSTYPE -T " + JSON.stringify(base)]).toString().trim(); } catch { return "unknown"; } })();
  const failures = results.filter((r) => !r.pass);
  const report = {
    generatedAt: new Date().toISOString(), node: process.version, kernel: execFileSync("uname", ["-r"]).toString().trim(), filesystem: fsType, profile: PROFILE,
    model: "pessimistic POSIX power cut (scripts/powerloss/model.mjs) over the server's storage and UVA folders",
    workload: { edits: +arg("edits", 12), records: events.length, fileSyncs: events.filter((e) => e.t === "f").length, dirSyncs: events.filter((e) => e.t === "d").length,
      acknowledged: ackAt.length, ms: workloadMs },
    crashPoints: results.length, passed: results.length - failures.length, failed: failures.length, failures: failures.slice(0, 200), pass: failures.length === 0,
  };
  await rm(checkerRoot, { recursive: true, force: true });
  if (!process.argv.includes("--keep")) { await rm(run, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); await rm(log, { force: true }); }
  const text = JSON.stringify(report, null, 2);
  if (arg("out")) await writeFile(arg("out"), text + "\n");
  console.log(text);
  process.exitCode = report.pass ? 0 : 1;
}
main().catch((error) => { console.error(error); process.exitCode = 2; });
