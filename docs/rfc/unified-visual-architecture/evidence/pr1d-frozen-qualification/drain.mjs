import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { ManagedFiles } from "../../../../../src/persistence/filesystem.js";
import { openIsolatedStore } from "../../../../../src/persistence/lease.js";
import { restoreIsolatedBackup } from "../../../../../src/persistence/backup.js";
import { loadCommitted } from "../../../../../src/persistence/records.js";
import { readGcPlan } from "../../../../../src/persistence/gc.js";
import { readVersion } from "../../../../../src/persistence/archive.js";
import { hashJson } from "../../../../../src/documents/validation.js";
import { actor, command, document, epoch } from "../../../../../tests/fixtures/uva-persistence.mjs";

const root = await mkdtemp(join(tmpdir(), "estampes-pr1c-pr1d-drain-"));
const backup = await mkdtemp(join(tmpdir(), "estampes-pr1c-backup-"));
const restored = await mkdtemp(join(tmpdir(), "estampes-pr1c-restored-"));
const files = new ManagedFiles(root);
const profile = "linux-local-durable", TIME = Date.now(), DAY = 86400000;
const options = { profile, purpose: "isolated-pr1c-testing" };
const emit = (event, details) => console.log(JSON.stringify({ event, ...details }));
const refs = [], acks = [];
let store, readOnly, passed = false, clockMs = TIME;
const started = performance.now();

async function kill(client) {
  if (client) {
    client.kill("SIGKILL");
    await client.waitForExit();
  }
}

async function open({ lifecycle = true, observe = false } = {}) {
  await kill(store);
  const begin = performance.now();
  if (observe) process.env.NODE_OPTIONS = "--import=" + process.argv[2];
  try {
    store = await openIsolatedStore(root, { ...options, testClockMs: clockMs,
      ...(lifecycle ? { lifecycle: { enabled: true, autoMaintenance: false } } : {}) });
  } finally { if (observe) delete process.env.NODE_OPTIONS; }
  emit("open", { elapsedMs: performance.now() - begin, state: store.status.state, problem: store.status.problem,
    recovery: store.status.recovery, lifecycle: store.status.lifecycle });
  assert.equal(store.status.state, "ready");
}

async function observe(label) {
  const snap = await loadCommitted(files);
  const plans = [...snap.indices.retention].filter(([key, row]) => key.startsWith("gc:") && row.state !== "complete");
  const pending = await Promise.all(plans.map(async ([key, row]) => {
    const plan = await readGcPlan(files, row);
    return { key, row, pending: plan.candidates.map((_, i) => i).filter(i => !row.deleted.includes(i)) };
  }));
  const status = (await store.diagnostics()).lifecycle;
  emit("inventory", { label, envelope: snap.envelope, full: [...snap.indices.locator.values()].filter(r => r.kind === "full").length,
    ledger: snap.indices.ledger.size, policy: status.policy, pins: status.pins, pending, usage: await files.usage() });
  return snap;
}

async function maintenance(action, args = {}) {
  const start = performance.now();
  const result = await store.maintenance(action, args);
  emit("maintenance", { action, args, result, elapsedMs: performance.now() - start, usage: await files.usage() });
  return result;
}

async function crash(point, operation) {
  await store.injectFault({ point, mode: "pause" });
  let hit;
  const listener = event => {
    if (event.name !== point) return;
    hit = event;
    store.kill("SIGKILL");
  };
  store.events.on("stage", listener);
  try {
    await assert.rejects(operation, { code: "RECOVERY_REQUIRED" });
    assert.ok(hit);
    emit("crash", { point, details: hit.details });
  } finally {
    store.events.off("stage", listener);
    await kill(store);
  }
}

function doc(n) {
  return { ...document(), persistence: "durable", revision: n, title: "controlled history " + n,
    extensions: { "benchmark:payload": "x".repeat(256 * 1024) } };
}

try {
  emit("stores", { root, backup, restored });
  await open({ lifecycle: false });
  for (let n = 1; n <= 12; n++) {
    const result = await store.commit(command([doc(n)], n, n === 1 ? null : n - 1), actor(n), await epoch(store));
    acks.push(result.ack);
    refs.push(result.ack.revisionVector[0]);
  }
  clockMs = Date.now();
  const graceStart = clockMs;
  await open();
  const legacy = await observe("legacy-full-versions");
  const pin = await maintenance("pin", { historyRefs: refs });
  const fixed = await store.snapshot();
  const job = await maintenance("backupStart", { destination: backup });
  let idle;
  for (let i = 0; i < 24; i++) {
    idle = await maintenance("compact");
    if (idle.state === "idle") break;
  }
  assert.equal(idle.state, "idle");
  const compacted = await observe("compaction-drained");
  assert.deepEqual(compacted.indices.ledger, legacy.indices.ledger);
  assert.ok([...compacted.indices.locator.values()].some(row => row.kind === "delta"));
  assert.equal((await maintenance("gcPlan", { classes: ["G1"] })).planned, false);
  assert.deepEqual(await store.maintenance("readPin", { id: pin.id }), fixed.documents);
  await maintenance("releasePin", { id: pin.id });
  assert.equal((await maintenance("gcPlan", { classes: ["G1"] })).planned, false);
  let done;
  for (let i = 0; i < 16; i++) {
    done = await maintenance("backupStep", { id: job.id });
    if (done.state === "complete") break;
  }
  assert.equal(done.state, "complete");
  assert.equal((await restoreIsolatedBackup(backup, restored, { profile })).readOnly, true);
  readOnly = await openIsolatedStore(restored, options);
  assert.equal(readOnly.status.state, "read-only-recovery");
  assert.deepEqual((await readOnly.snapshot()).documents, fixed.documents);
  await assert.rejects(readOnly.maintenance("gcPlan", { classes: ["G1"] }), { code: "RECOVERY_REQUIRED" });
  await kill(readOnly);

  const g1 = await maintenance("gcPlan", { classes: ["G1"] });
  assert.equal(g1.planned, true);
  const selected = await observe("g1-planned");
  const plan = await readGcPlan(files, selected.indices.retention.get("gc:" + g1.id));
  let reclaimable = 0;
  for (const candidate of plan.candidates) reclaimable += (await stat(files.path(candidate.path))).blocks * 512;
  const before = await files.usage();
  await crash("gc.after-rename", () => store.maintenance("gcStep", { id: g1.id }));
  await open();
  const g1Done = await maintenance("gcStep", { id: g1.id });
  assert.equal(g1Done.state, "complete");
  assert.equal(g1Done.deleted, g1.candidates);
  for (const candidate of plan.candidates) {
    assert.equal(await files.exists(candidate.path), false);
    assert.equal(await files.exists(candidate.quarantine), false);
  }
  const after = await files.usage();
  emit("g1-reclamation", { reclaimableCandidateBlocks: reclaimable,
    netAllocatedReclaimed: before.allocatedBytes - after.allocatedBytes, before, after });
  assert.ok(after.allocatedBytes < before.allocatedBytes);

  const abandoned = command([doc(13)], 13, 12);
  const epochBeforeKill = await epoch(store);
  await crash("current.before-rename", () => store.commit(abandoned, actor(13), epochBeforeKill));
  process.env.PR1D_G2_TRACE = join(tmpdir(), "g2-trace.jsonl");
  await open({ observe: true });
  await observe("g2-recovered-aborted-content");
  const g2 = await maintenance("gcPlan", { classes: ["G2"] });
  assert.equal(g2.planned, true);
  const step = () => maintenance("gcStep", { id: g2.id });
  const first = await step();
  assert.equal(first.state, "waiting-grace");
  assert.equal(first.deleted, 0);
  await maintenance("clock", { nowMs: graceStart - DAY });
  assert.equal((await step()).deleted, 0);
  clockMs = graceStart + DAY;
  await maintenance("clock", { nowMs: clockMs });
  const g2Done = await step();
  if (g2Done.state !== "complete") {
    await observe("unexpected-g2-preserve");
    await open({ observe: true });
    await step();
    throw new Error("Unexpected first G2 post-grace state, preserved for adjudication");
  }
  assert.equal(g2Done.deleted, g2.candidates);
  await open();
  const final = await observe("cold-final");
  assert.deepEqual(final.indices.ledger, legacy.indices.ledger);
  const replay = await store.commit(command([doc(12)], 12, 11), actor(14), await epoch(store));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.ack, acks.at(-1));
  for (const ref of refs) assert.equal(hashJson(await readVersion(files, ref, final.indices.locator)), ref.contentHash);
  emit("drain-verified", { elapsedMs: performance.now() - started, g1: g1Done, g2: g2Done,
    reconstructed: refs.length, usage: await files.usage() });
  passed = true;
} finally {
  await kill(store);
  await kill(readOnly);
  if (passed) for (const path of [root, backup, restored]) await rm(path, { recursive: true });
  else emit("preserved", { root, backup, restored });
}
