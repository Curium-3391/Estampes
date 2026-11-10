#!/usr/bin/env node
// Power-loss simulator for the UVA store (issue #91).
//
//   node scripts/powerloss/simulate.mjs --dir <folder> [--profile linux-local-durable]
//        [--commits 24] [--points 80] [--every-first 2] [--out report.json]
//
// A workload process commits canvases while trace.mjs records every fsync
// (file bytes, directory entries) in order, plus every acknowledged commit.
// After the run, each chosen crash point k is rebuilt as the state a power
// cut right after record k could leave behind under the POSIX contract:
// a directory holds only the entries of its last fsync (none if it was never
// fsynced), and a file holds only the bytes of its last fsync (empty if it
// was never fsynced). This is the most pessimistic state a filesystem that
// honours fsync may produce; real ext4/XFS keep more. The store is then
// opened on that state and must (1) open without manual repair, (2) return
// every commit acknowledged before k with exactly the acknowledged content,
// and (3) accept a new commit.
//
// What this proves: the store's barriers are complete, so no acknowledged
// commit depends on data a power cut may drop. What it cannot prove: that a
// given disk, controller, hypervisor or Docker Desktop VM honours fsync.
import { mkdir, rm, writeFile, readFile, open } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { createUvaService } from "../../src/uva/service.js";
let checkerService = null; // createUvaService from the identity-tolerant checker copy

const HERE = fileURLToPath(import.meta.url);
const arg = (name, dflt) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : dflt; };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const PROFILE = arg("profile", "linux-process-crash-test");

async function image(seed) {
  const bytes = await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: seed * 40 % 255, g: 90, b: 160 } } }).png().toBuffer();
  return { bytes, imageId: "img:" + sha(bytes).slice(0, 16) };
}
function canvas(img, n) {
  const marks = [];
  for (let i = 0; i < n; i++) marks.push({ id: "m" + i, author: i % 3 ? "user" : "gpt", type: "rect", x: (i % 10) / 12, y: (Math.floor(i / 10) % 10) / 12, x2: (i % 10) / 12 + .05, y2: (Math.floor(i / 10) % 10) / 12 + .05, label: "mark " + i + " of " + n });
  return { version: 1, imageId: img.imageId, width: 320, height: 200, marks, layers: [], savedAt: "2026-11-10T00:00:00.000Z" };
}
const fingerprint = (c) => sha(JSON.stringify(c.marks.map((m) => [m.id, m.label, m.x, m.y])));
const openService = (dir, create = createUvaService) => create({ enabled: true, directory: dir, profile: PROFILE, canvasStore: true, compactionIdleMs: 0 });
async function syncDir(path) { const fd = await open(path, "r"); try { await fd.sync(); } finally { await fd.close(); } }

// ---- workload (runs under trace.mjs) ----------------------------------------
async function workload() {
  const root = arg("root"), log = process.env.ESTAMPES_POWERLOSS_LOG, commits = +arg("commits", 24);
  const images = [await image(1), await image(2)];
  let svc = await openService(join(root, "uva"));
  for (let i = 1; i <= commits; i++) {
    // A restart in the middle exercises recovery on a store that has history.
    if (i === Math.ceil(commits / 2)) { await svc.close(); svc = await openService(join(root, "uva")); appendFileSync(log, JSON.stringify({ t: "reopen" }) + "\n"); }
    const img = images[i % 2], c = canvas(img, 1 + Math.floor(i / 2));
    const r = await svc.syncCanvas({ canvas: c, bytes: img.bytes });
    if (r.status === "blocked") throw new Error("blocked: " + JSON.stringify(r.issues));
    appendFileSync(log, JSON.stringify({ t: "ack", key: img.imageId, revision: r.revision, marks: c.marks.length, fp: fingerprint(c) }) + "\n");
  }
  await svc.close();
}

import { durableState, materialize, identityTolerantChecker } from "./model.mjs";

async function check(events, k, run, scratch) {
  const state = durableState(events, k), target = join(scratch, "s" + k);
  await rm(target, { recursive: true, force: true });
  await materialize(state, run, target);
  const out = { point: k, after: events[k - 1]?.t ?? "start", acked: state.acks.size };
  let svc;
  try {
    svc = await openService(join(target, "uva"), checkerService);
    for (const [key, ack] of state.acks) {
      const got = await svc.canvasState(key);
      if (!got) throw new Error("acknowledged canvas " + key + " revision " + ack.revision + " is missing");
      const { canvas: c, revision } = got;
      if (revision < ack.revision) throw new Error(key + " went back from acknowledged revision " + ack.revision + " to " + revision);
      if (revision === ack.revision && fingerprint(c) !== ack.fp) throw new Error(key + " revision " + revision + " differs from the acknowledged content");
    }
    const img = await image(3);
    const r = await svc.syncCanvas({ canvas: canvas(img, 2), bytes: img.bytes });
    if (r.status === "blocked") throw new Error("store refuses a new commit: " + JSON.stringify(r.issues));
    out.pass = true;
  } catch (error) {
    out.pass = false; out.error = String(error?.code ? error.code + ": " : "") + String(error?.message || error);
  } finally {
    await svc?.close().catch(() => {});
    await rm(target, { recursive: true, force: true });
  }
  return out;
}

// ---- driver -----------------------------------------------------------------
async function main() {
  if (process.argv.includes("--child")) return workload();
  const base = resolve(arg("dir") ?? (() => { throw new Error("--dir is required (a folder on the filesystem to test)"); })());
  const id = randomBytes(4).toString("hex"), run = join(base, "pl-run-" + id), scratch = join(base, "pl-check-" + id), log = join(base, "pl-" + id + ".jsonl");
  await mkdir(run, { mode: 0o700 }); await mkdir(scratch, { mode: 0o700 }); await syncDir(base);
  const started = Date.now();
  await new Promise((done, failed) => {
    // NODE_OPTIONS, not --import: the store's writer runs in its own process
    // (src/persistence/lease.js) and must be traced too.
    const child = spawn(process.execPath, [HERE, "--child", "--root", run, "--commits", arg("commits", "24"), "--profile", PROFILE],
      { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, NODE_OPTIONS: ((process.env.NODE_OPTIONS ?? "") + " --import " + join(dirname(HERE), "trace.mjs")).trim(),
        ESTAMPES_POWERLOSS_ROOT: run, ESTAMPES_POWERLOSS_LOG: log } });
    child.on("exit", (code) => code === 0 ? done() : failed(new Error("workload exited " + code)));
  });
  const events = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const workloadMs = Date.now() - started;
  // Crash points: every record of the first --every-first commits (store
  // creation is the most fragile part), every record around the restart and
  // around each acknowledgement, plus --points spread over the rest.
  const ackAt = events.flatMap((e, i) => e.t === "ack" ? [i] : []), reopenAt = events.findIndex((e) => e.t === "reopen");
  const points = new Set([0, events.length]);
  const firstEnd = ackAt[Math.max(0, +arg("every-first", 2) - 1)] ?? events.length;
  for (let k = 0; k <= firstEnd + 1; k++) points.add(k);
  if (reopenAt >= 0) for (let k = Math.max(0, reopenAt - 30); k <= Math.min(events.length, reopenAt + 60); k++) points.add(k);
  for (const a of ackAt) for (const d of [-2, -1, 0, 1, 2]) if (a + d >= 0 && a + d <= events.length) points.add(a + d);
  const extra = +arg("points", 80);
  for (let j = 1; j <= extra; j++) points.add(Math.round(j * events.length / (extra + 1)));
  if (arg("only")) { points.clear(); for (const v of arg("only").split(",")) points.add(v === "end" ? events.length : +v); }
  const checker = await identityTolerantChecker(resolve(dirname(HERE), "../.."));
  checkerService = (await import(join(checker, "src", "uva", "service.js"))).createUvaService;
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
    model: "pessimistic POSIX power cut: directories keep only their last fsynced entries, files only their last fsynced bytes",
    workload: { commits: +arg("commits", 24), restartInMiddle: true, records: events.length, fileSyncs: events.filter((e) => e.t === "f").length,
      dirSyncs: events.filter((e) => e.t === "d").length, acknowledged: ackAt.length, ms: workloadMs },
    crashPoints: results.length, passed: results.length - failures.length, failed: failures.length, failures: failures.slice(0, 200),
    pass: failures.length === 0,
    checker: "copies cannot keep inode numbers, so the one inode-identity comparison (GC candidate ownership, src/persistence/gc.js) is relaxed in the checker; its content-hash check stays",
    notProven: ["that a specific disk, controller, VM or Docker Desktop honours fsync", "torn writes inside one fsynced file (the model keeps whole files)"],
  };
  await rm(checker, { recursive: true, force: true });
  if (!process.argv.includes("--keep")) { await rm(run, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); await rm(log, { force: true }); }
  const text = JSON.stringify(report, null, 2);
  if (arg("out")) await writeFile(arg("out"), text + "\n");
  console.log(text);
  process.exitCode = report.pass ? 0 : 1;
}
main().catch((error) => { console.error(error); process.exitCode = 2; });
