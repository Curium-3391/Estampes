// Continue evidence collection from the preserved selected checkpoint after a
// test-side Ledger key lookup error. Do not re-run either checkpoint crash.
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ManagedFiles } from "../../../../../src/persistence/filesystem.js";
import { openIsolatedStore } from "../../../../../src/persistence/lease.js";
import { loadCommitted, storeDocument } from "../../../../../src/persistence/records.js";
import { readVersion } from "../../../../../src/persistence/archive.js";
import { hashJson } from "../../../../../src/documents/validation.js";
import { normalizeRequestId } from "../../../../../src/documents/identity.js";
import { actor, command, document, epoch } from "../../../../../tests/fixtures/uva-persistence.mjs";

const scratch = process.env.QUAL_SCRATCH;
const raw = await readFile(join(scratch, "evidence/archive-32mib.log"), "utf8");
const records = raw.split("\n").filter(line => line.startsWith("{\"event\"")).map(line => JSON.parse(line));
const preserved = records.find(row => row.event === "preserved");
assert.ok(preserved && preserved.root.startsWith(join(scratch, "tmp/archive-32mib") + "/"));
assert.equal(await realpath(preserved.root), preserved.root);
assert.deepEqual(records.filter(row => row.event === "checkpoint-crash").map(row => row.point),
  ["current.before-rename", "current.after-dir-fsync"]);
const files = new ManagedFiles(preserved.root);
const selected = await loadCommitted(files);
assert.equal(selected.indices.ledger.size, 4);
const d = { ...document(), persistence: "durable", revision: 4, title: "history revision 4",
  extensions: { "benchmark:payload": "4".repeat(12 * 1024**2) } };
const cmd = command([d], 4, 3);
const exact = [...selected.indices.ledger.values()].find(e => e.key.commandId === normalizeRequestId(cmd.requestId));
assert.ok(exact);
const ref = exact.ack.revisionVector[0];
const full = selected.indices.locator.get(hashJson(ref));
assert.equal(full.kind, "full");
assert.equal(hashJson(storeDocument(d)), ref.contentHash);
assert.equal((await files.digest(full.relativePath)).hash, ref.contentHash);
const refs = records.filter(row => row.event === "commit").map(row => row.ref).concat(ref);
assert.equal(refs.length, 4);
assert.equal(selected.indices.locator.size, 4);
for (const prior of refs) assert.equal(hashJson(await readVersion(files, prior, selected.indices.locator)), prior.contentHash);
console.log(JSON.stringify({ event: "checkpoint-selected", envelope: selected.envelope, roots: selected.root.roots,
  full, refs, ledger: 4, usage: await files.usage() }));
const start = performance.now();
let store;
try {
  store = await openIsolatedStore(preserved.root, { profile: "linux-local-durable",
    purpose: "isolated-pr1c-testing", maxContentCommits: 1000, lifecycle: { enabled: true, autoMaintenance: false } });
  console.log(JSON.stringify({ event: "cold-client", elapsedMs: performance.now() - start,
    state: store.status.state, problem: store.status.problem, performance: store.status.performance }));
  assert.equal(store.status.state, "ready");
  const result = await store.commit(cmd, actor(4), await epoch(store));
  assert.equal(result.replayed, true);
  assert.deepEqual(result.ack, exact.ack);
  assert.equal((await store.diagnostics()).contentCommits, 4);
  console.log(JSON.stringify({ event: "archive-verified", ack: result.ack, count: refs.length }));
} finally {
  if (store) { store.kill(); await store.waitForExit(); }
}
