import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { openIsolatedStore } from "../../../../../src/persistence/lease.js";
import { ManagedFiles } from "../../../../../src/persistence/filesystem.js";
import { loadCommitted, storeDocument } from "../../../../../src/persistence/records.js";
import { ARCHIVE_BYTES, makePatch, readVersion } from "../../../../../src/persistence/archive.js";
import { canonicalJson, hashJson } from "../../../../../src/documents/validation.js";
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
      const entry = [...selected.indices.ledger.values()].find(e => e.key.requestId === last.requestId);
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
  passed = true;
} finally {
  clearInterval(timer);
  await close();
  if (passed) await rm(root, { recursive: true });
  else emit("preserved", { root });
}
