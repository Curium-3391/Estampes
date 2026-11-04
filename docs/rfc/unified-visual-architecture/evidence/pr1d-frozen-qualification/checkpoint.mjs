import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { openIsolatedStore } from "../../../../../src/persistence/lease.js";
import { ManagedFiles } from "../../../../../src/persistence/filesystem.js";
import { loadCommitted, storeDocument } from "../../../../../src/persistence/records.js";
import { readGcPlan } from "../../../../../src/persistence/gc.js";
import { ARCHIVE_BYTES, makePatch, readVersion } from "../../../../../src/persistence/archive.js";
import { canonicalJson, hashJson } from "../../../../../src/documents/validation.js";
import { normalizeRequestId } from "../../../../../src/documents/identity.js";
import { actor, command, document, epoch } from "../../../../../tests/fixtures/uva-persistence.mjs";

const mode = process.argv[2];
const target = mode === "archive" ? 4 : Number(mode);
assert.ok([2, 4, 100, 200, 1000].includes(target));
const root = await mkdtemp(join(tmpdir(), "estampes-pr1c-checkpoint-"));
const files = new ManagedFiles(root);
const options = {
  profile: "linux-local-durable", purpose: "isolated-pr1c-testing", maxContentCommits: 1000,
  lifecycle: { enabled: true, autoMaintenance: false },
};
const emit = (event, value) => console.log(JSON.stringify({ event, ...value }));
const refs = [], acks = [], latencies = [], startups = [];
let store, passed = false, peakWorkerRssKiB = 0;
const timer = setInterval(async () => {
  if (!store) return;
  const status = await readFile("/proc/" + store.pid + "/status", "utf8").catch(() => "");
  peakWorkerRssKiB = Math.max(peakWorkerRssKiB, Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0));
}, 500);

async function open(label) {
  const start = performance.now();
  try {
    store = await openIsolatedStore(root, options);
    const { state, problem, performance: profile } = store.status;
    const cold = { label, elapsedMs: performance.now() - start, state, problem, profile };
    startups.push(cold);
    emit("startup", cold);
    assert.equal(state, "ready");
  } catch (error) {
    emit("startup-error", { label, elapsedMs: performance.now() - start, code: error.code, message: error.message });
    throw error;
  }
}

async function close() {
  if (store) {
    store.kill("SIGKILL");
    await store.waitForExit();
    store = undefined;
  }
}

async function crashCommit(cmd, n, point) {
  await store.injectFault({ point, mode: "pause" });
  let hit;
  const listener = event => {
    if (event.name !== point) return;
    hit = event;
    store.kill("SIGKILL");
  };
  store.events.on("stage", listener);
  try {
    const expected = await epoch(store);
    await assert.rejects(store.commit(cmd, actor(n), expected), e => e.code === "RECOVERY_REQUIRED");
    assert.ok(hit, "Original production fault hook must be reached");
    emit("checkpoint-crash", { point, details: hit.details });
  } finally {
    store.events.off("stage", listener);
    await close();
  }
}

function stats(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const p = percent => sorted[Math.ceil(percent * sorted.length) - 1];
  return { n: sorted.length, p50: p(.5), p95: p(.95), max: sorted.at(-1), total: sorted.reduce((a,b) => a+b, 0) };
}

function revision(n) {
  const d = { ...document(), persistence: "durable", revision: n, title: "history revision " + n };
  if (mode === "archive") d.extensions = { "benchmark:payload": String(n).repeat(12 * 1024**2) };
  return d;
}

async function verifyOperationalThinning(locator, head) {
  const backup = await mkdtemp(join(tmpdir(), "estampes-pr1c-checkpoint-backup-"));
  const pin = await store.maintenance("pin", { historyRefs: [locator.logical] });
  const job = await store.maintenance("backupStart", { destination: backup });
  const next = command([revision(1001)], 1001, 1000);
  const later = await store.commit(next, actor(1001), await epoch(store));
  assert.equal(later.ack.revisionVector[0].revision, 1001);

  let replacement;
  for (let i = 0; i < 4; i++) {
    await store.maintenance("compact");
    const snap = await loadCommitted(files);
    const row = snap.indices.locator.get(hashJson(locator.logical));
    if (row.kind === "delta") { replacement = row; break; }
  }
  assert.ok(replacement, "Historical operational checkpoint must have a selected verified replacement");
  assert.equal(await files.exists(locator.relativePath), true);
  assert.equal((await store.maintenance("history", { id: pin.id, ref: locator.logical })).document.revision, 1000);
  const blocked = await store.maintenance("gcPlan", { classes: ["G1"] });
  if (blocked.planned) {
    const snap = await loadCommitted(files);
    const plan = await readGcPlan(files, snap.indices.retention.get("gc:" + blocked.id));
    assert.ok(!plan.candidates.some(candidate => candidate.path === locator.relativePath));
  }
  await store.maintenance("releasePin", { id: pin.id });
  await store.maintenance("backupCancel", { id: job.id });
  const released = await store.maintenance("gcPlan", { classes: ["G1"] });
  assert.equal(released.planned, true);
  const snap = await loadCommitted(files);
  const plan = await readGcPlan(files, snap.indices.retention.get("gc:" + released.id));
  assert.ok(plan.candidates.some(candidate => candidate.path === locator.relativePath));
  const progress = await store.maintenance("gcStep", { id: released.id });
  assert.equal(progress.state, "complete");
  assert.equal(await files.exists(locator.relativePath), false);
  await close();
  await open("post-thinning-recovery");
  const after = await loadCommitted(files);
  assert.equal(after.indices.ledger.size, head.indices.ledger.size + 1);
  for (const [key, ack] of head.indices.ledger) assert.deepEqual(after.indices.ledger.get(key), ack);
  for (const ref of refs) assert.equal(hashJson(await readVersion(files, ref, after.indices.locator)), ref.contentHash);
  emit("operational-thinning", { removed: locator.relativePath, replacement, progress,
    before: head.envelope, after: after.envelope, checkedVersions: refs.length });
  await rm(backup, { recursive: true });
}

try {
  emit("store", { root, mode, target });
  await open("bootstrap");
  let previous;
  let last;
  let crossing;
  for (let n = 1; n <= target; n++) {
    const d = revision(n);
    last = command([d], n, n === 1 ? null : n - 1);
    const targetCrash = n === target && (mode === "archive" || target === 1000);
    if (targetCrash) {
      const before = await loadCommitted(files);
      if (mode === "archive") {
        const stored = storeDocument(d), from = refs.at(-1);
        const to = { ...from, revision: n, contentHash: hashJson(stored) };
        const prior = before.indices.locator.get(hashJson(from));
        crossing = { priorBytes: prior.deltaBytes, nextPatchBytes: Buffer.byteLength(canonicalJson(makePatch(previous, stored, from, to))) };
        crossing.totalBytes = crossing.priorBytes + crossing.nextPatchBytes;
        emit("archive-threshold", { ...crossing, threshold: ARCHIVE_BYTES });
        assert.ok(crossing.priorBytes < ARCHIVE_BYTES && crossing.totalBytes >= ARCHIVE_BYTES);
      }
      await crashCommit(last, n, "current.before-rename");
      const stopped = await loadCommitted(files);
      assert.deepEqual(stopped.envelope, before.envelope);
      assert.equal(stopped.indices.ledger.size, n - 1);
      await open("checkpoint-pre-rename-recovery");
      await crashCommit(last, n, "current.after-dir-fsync");
      const selected = await loadCommitted(files);
      assert.equal(selected.indices.ledger.size, n);
      const entry = [...selected.indices.ledger.values()].find(e => e.key.commandId === normalizeRequestId(last.requestId));
      assert.ok(entry);
      refs.push(entry.ack.revisionVector[0]);
      acks.push(entry.ack);
      emit("checkpoint-selected", { envelope: selected.envelope, locator: selected.indices.locator.get(hashJson(refs.at(-1))), ledger: n });
      await open("checkpoint-post-fsync-recovery");
      const reply = await store.commit(last, actor(n), await epoch(store));
      assert.equal(reply.replayed, true);
      assert.deepEqual(reply.ack, entry.ack);
    } else {
      const start = performance.now();
      const reply = await store.commit(last, actor(n), await epoch(store));
      const elapsedMs = performance.now() - start;
      assert.equal(reply.replayed, false);
      assert.equal(reply.ack.durability, "durable");
      refs.push(reply.ack.revisionVector[0]);
      acks.push(reply.ack);
      latencies.push(elapsedMs);
      emit("commit", { n, elapsedMs, peakWorkerRssKiB, envelope: reply.envelope, ref: refs.at(-1) });
    }
    if (mode === "archive" && n === 3) previous = storeDocument(d);
  }
  const diagnostics = await store.diagnostics();
  const usage = await files.usage();
  const commitProfile = stats(latencies);
  emit("before-cold", { commitProfile, usage, peakWorkerRssKiB, performance: diagnostics.performance,
    policy: diagnostics.lifecycle.policy });
  await close();
  await open("cold-client");
  const replay = await store.commit(last, actor(target + 1), await epoch(store));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.ack, acks.at(-1));
  const verifyStart = performance.now();
  const selected = await loadCommitted(files);
  const rows = [...selected.indices.locator.values()];
  assert.equal(rows.length, target);
  assert.equal(selected.indices.ledger.size, target);
  const actualAcks = new Map([...selected.indices.ledger.values()].map(e => [e.ack.commitId, e.ack]));
  for (const ack of acks) assert.deepEqual(actualAcks.get(ack.commitId), ack);
  for (const ref of refs) {
    const record = await readVersion(files, ref, selected.indices.locator);
    assert.equal(hashJson(record), ref.contentHash);
  }
  const locator = selected.indices.locator.get(hashJson(refs.at(-1)));
  if (mode === "archive" || target === 1000) {
    assert.equal(locator.kind, "full");
    if (target === 1000) assert.ok(locator.alternative);
    assert.equal((await files.digest(locator.relativePath)).hash, refs.at(-1).contentHash);
  }
  emit("history-verified", {
    count: target, envelope: selected.envelope, roots: selected.root.roots, locator,
    full: rows.filter(row => row.kind === "full").length, delta: rows.filter(row => row.kind === "delta").length,
    reconstructionMs: performance.now() - verifyStart, usage: await files.usage(), peakWorkerRssKiB,
    recovery: stats(startups.filter(x => x.label !== "bootstrap").map(x => x.elapsedMs)),
    crossing,
  });
  if (target === 1000) await verifyOperationalThinning(locator, selected);
  passed = true;
} finally {
  clearInterval(timer);
  await close();
  if (passed) await rm(root, { recursive: true });
  else emit("preserved", { root });
}
