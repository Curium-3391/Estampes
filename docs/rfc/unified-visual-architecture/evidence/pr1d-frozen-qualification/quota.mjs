import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { CapacityManager, DEFAULT_QUOTA, WORK_BYTES } from "../../../../../src/persistence/capacity.js";
import { ManagedFiles } from "../../../../../src/persistence/filesystem.js";
import { openIsolatedStore } from "../../../../../src/persistence/lease.js";
import { loadCommitted } from "../../../../../src/persistence/records.js";
import { actor, command, document, epoch } from "../../../../../tests/fixtures/uva-persistence.mjs";

const MiB = 1024**2, GiB = 1024**3;
const root = await mkdtemp(join(tmpdir(), "estampes-pr1c-quota-"));
const files = new ManagedFiles(root);
const options = {
  profile: "linux-local-durable", purpose: "isolated-pr1c-testing",
  lifecycle: { enabled: true, autoMaintenance: false },
};
const fixture = join(root, "qualification-allocated-extent");
const sentinel = join(root, "qualification-unrelated-file");
const emit = (event, detail) => console.log(JSON.stringify({ event, ...detail }));
let store, passed = false;

async function allocate(bytes) {
  const fs = await statfs(root, { bigint: true });
  assert.ok(fs.bavail * fs.bsize >= 64n * BigInt(GiB));
  const hostFree = {};
  for (const drive of ["/mnt/c", "/mnt/d", "/mnt/e"]) {
    const mounted = await statfs(drive, { bigint: true });
    hostFree[drive] = Number(mounted.bavail * mounted.bsize);
  }
  emit("allocation-safety", { guestFree: Number(fs.bavail * fs.bsize), hostFree });
  // Budget as though all requested extents could consume real backing blocks.
  assert.ok(Math.min(...Object.values(hostFree)) >= 59 * GiB);
  assert.ok(bytes <= DEFAULT_QUOTA && fixture.startsWith(tmpdir() + "/"));
  const p = spawnSync("python3", ["-c", [
    "import os, sys",
    "flags = os.O_RDWR | os.O_NOFOLLOW",
    "if sys.argv[3]=='first': flags |= os.O_CREAT | os.O_EXCL",
    "with os.fdopen(os.open(sys.argv[1], flags, 0o600), 'rb+') as f:",
    "    os.posix_fallocate(f.fileno(), 0, int(sys.argv[2]))",
    "    os.fsync(f.fileno())",
  ].join("\n"), fixture, String(bytes), bytes === 9 * GiB ? "first" : "extend"], { encoding: "utf8", timeout: 30000 });
  assert.equal(p.status, 0, p.stderr);
  const info = await stat(fixture), usage = await files.usage();
  assert.ok(info.blocks * 512 >= bytes && usage.allocatedBytes >= bytes);
  emit("allocated", { requested: bytes, extentBytes: info.blocks * 512, usage });
}

async function open() {
  const start = performance.now();
  store = await openIsolatedStore(root, options);
  emit("open", { elapsedMs: performance.now() - start, state: store.status.state, problem: store.status.problem });
  assert.equal(store.status.state, "ready");
}

async function commit(cmd, n) {
  const start = performance.now();
  const result = await store.commit(cmd, actor(n), await epoch(store));
  emit("commit", { n, elapsedMs: performance.now() - start, replayed: result.replayed, ack: result.ack });
  return result;
}

async function unchanged(before) {
  const selected = await loadCommitted(files);
  assert.deepEqual(selected.envelope, before.envelope);
  assert.deepEqual(selected.indices.ledger, before.indices.ledger);
  assert.equal(await readFile(sentinel, "utf8"), "independent fixture");
}

try {
  await open();
  await writeFile(sentinel, "independent fixture", { mode: 0o600, flag: "wx" });
  const format = await files.json("storage-format.json");
  assert.equal(format.quotaBytes, 10 * GiB);
  const first = command([{ ...document(), persistence: "durable" }]);
  const second = command([{ ...document(), persistence: "durable", revision: 2, title: "admitted under pressure" }], 2, 1);
  const third = command([{ ...document(), persistence: "durable", revision: 3, title: "preserved draft" }], 3, 2);
  const ack = (await commit(first, 1)).ack;
  await allocate(9 * GiB);
  await commit(second, 2);
  const capacity = new CapacityManager(files, DEFAULT_QUOTA);
  await capacity.reserve("without-backup-pressure", 1);
  capacity.release("without-backup-pressure");
  await assert.rejects(capacity.reserve("with-backup-pressure", 1, { reservedJobs: GiB }), error => {
    emit("backup-reservation-pressure", { code: error.code, details: error.details });
    return error.code === "STORAGE_UNAVAILABLE" && error.details?.reservedJobs === GiB;
  });
  await allocate(10 * GiB - 120 * MiB);
  const before = await loadCommitted(files);
  const draft = structuredClone(third);
  const journals = (await readdir(files.path("visual-transactions"))).sort();
  const start = performance.now();
  await assert.rejects(commit(third, 3), error => {
    emit("quota-reject", { elapsedMs: performance.now() - start, code: error.code, details: error.details });
    assert.equal(error.details?.quota, DEFAULT_QUOTA);
    assert.equal(error.details.workspace, WORK_BYTES);
    assert.equal(error.details.reserve, Math.ceil(DEFAULT_QUOTA / 100));
    return error.code === "STORAGE_UNAVAILABLE";
  });
  assert.deepEqual(third, draft);
  assert.deepEqual((await readdir(files.path("visual-transactions"))).sort(), journals);
  await unchanged(before);
  assert.deepEqual((await commit(first, 4)).ack, ack);
  await unlink(fixture);
  await files.syncDirectory(root, "qualification-fixture-release");
  await store.injectFault({ point: "staged.before-write", mode: "throw", code: "ENOSPC" });
  await assert.rejects(commit(third, 3), error => {
    emit("injected-enospc", { code: error.code, details: error.details });
    return error.code === "STORAGE_UNAVAILABLE";
  });
  await unchanged(before);
  await store.close();
  await open();
  assert.deepEqual((await commit(first, 5)).ack, ack);
  const recovered = await commit(third, 3);
  assert.equal(recovered.replayed, false);
  const after = await loadCommitted(files);
  assert.equal(after.indices.ledger.size, 3);
  assert.equal(await readFile(sentinel, "utf8"), "independent fixture");
  emit("quota-verified", { envelope: after.envelope, ledger: 3, usage: await files.usage() });
  passed = true;
} finally {
  if (store) { store.kill(); await store.waitForExit(); }
  if (passed) await rm(root, { recursive: true });
  else emit("preserved", { root });
}
