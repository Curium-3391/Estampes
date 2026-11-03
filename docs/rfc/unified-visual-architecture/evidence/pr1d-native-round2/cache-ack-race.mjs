import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedFiles } from "../../../../../src/persistence/filesystem.js";
import { loadCommitted, versionPath } from "../../../../../src/persistence/records.js";
import { lifecycleFixture, document, command, actor, epoch } from "../../../../../tests/fixtures/uva-lifecycle.mjs";

test("verification read race must reject before acknowledging a commit", async t => {
  const f = await lifecycleFixture(t, {profile: "linux-local-durable"});
  const first = {...document(1), persistence: "durable"};
  const second = {...document(2), persistence: "durable"};
  const initial = await f.store.commit(command([first]), actor(), await epoch(f.store));
  const path = versionPath(initial.ack.revisionVector[0]), files = new ManagedFiles(f.root);
  process.env.NODE_OPTIONS = "--import=" + fileURLToPath(new URL("./cache-read-race-preload.mjs", import.meta.url));
  process.env.PR1D_CACHE_RACE_ROOT = f.root;
  try { await f.reopen(); }
  finally {
    delete process.env.NODE_OPTIONS;
    delete process.env.PR1D_CACHE_RACE_ROOT;
  }
  assert.equal(f.store.status.state, "ready");
  const before = await files.json("visual-registry/CURRENT.json");
  await utimes(files.path(path), new Date(0), new Date(0)); // Force a real read instead of a cache hit.
  await writeFile(join(f.root, "test-read-race-trigger"), path);
  const result = await f.store.commit(command([second], 2), actor(2), await epoch(f.store)).catch(error => ({code: error.code}));
  assert.equal(await readFile(join(f.root, "test-read-race-observed"), "utf8"), path);
  const after = await files.json("visual-registry/CURRENT.json");
  const cold = await loadCommitted(files).catch(error => error);
  await f.reopen();
  t.diagnostic(JSON.stringify({ack: result.ack, error: result.code, before, after, coldError: cold.code, restart: f.store.status.state}));
  assert.equal(cold.code, "INTEGRITY_ERROR");
  assert.equal(f.store.status.state, "read-only-recovery");
  assert.equal(result.code, "RECOVERY_REQUIRED");
  assert.deepEqual(after, before);
});
