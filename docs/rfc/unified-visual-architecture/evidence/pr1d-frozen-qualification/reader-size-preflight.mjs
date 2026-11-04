import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { ManagedFiles } from "../../../../../src/persistence/filesystem.js";
import { openIsolatedStore } from "../../../../../src/persistence/lease.js";
import { MAX_DOCUMENT_BYTES, canonicalJson } from "../../../../../src/documents/validation.js";
import { actor, command, document, epoch } from "../../../../../tests/fixtures/uva-persistence.mjs";

const root = await mkdtemp(join(tmpdir(), "estampes-pr1c-reader-size-"));
const backup = await mkdtemp(join(tmpdir(), "estampes-pr1c-backup-size-"));
const files = new ManagedFiles(root);
const options = { profile: "linux-local-durable", purpose: "isolated-pr1c-testing",
  lifecycle: { enabled: true, autoMaintenance: false } };
const d = { ...document(), persistence: "durable",
  extensions: { "benchmark:payload": "p".repeat(MAX_DOCUMENT_BYTES - 32 * 1024) } };
let store, passed = false;
try {
  console.log(JSON.stringify({ event: "pressure-store", root, backup, documentBytes: Buffer.byteLength(canonicalJson(d)) }));
  store = await openIsolatedStore(root, options);
  assert.equal(store.status.state, "ready");
  const start = performance.now();
  const first = await store.commit(command([d]), actor(), await epoch(store));
  assert.equal(first.ack.durability, "durable");
  console.log(JSON.stringify({ event: "pressure-commit", elapsedMs: performance.now() - start, usage: await files.usage() }));
  await store.close();
  const cold = performance.now();
  store = await openIsolatedStore(root, options);
  assert.equal(store.status.state, "ready");
  console.log(JSON.stringify({ event: "pressure-cold", elapsedMs: performance.now() - cold }));
  const backupStart = performance.now();
  const job = await store.maintenance("backupStart", { destination: backup });
  let result;
  for (let n = 0; n < 12; n++) {
    result = await store.maintenance("backupStep", { id: job.id });
    if (result.state === "complete") break;
  }
  assert.equal(result.state, "complete");
  console.log(JSON.stringify({ event: "pressure-backup", elapsedMs: performance.now() - backupStart,
    source: await files.usage(), backup: await new ManagedFiles(backup).usage() }));
  passed = true;
} finally {
  if (store) { store.kill(); await store.waitForExit(); }
  if (passed) for (const path of [root, backup]) await rm(path, { recursive: true });
  else console.log(JSON.stringify({ event: "preserved", root, backup }));
}
