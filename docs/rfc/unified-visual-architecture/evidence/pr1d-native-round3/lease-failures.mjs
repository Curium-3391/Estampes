import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { openIsolatedStore } from "../../../../../src/persistence/lease.js";

const options = {profile: "linux-local-durable", purpose: "isolated-pr1c-testing"};
const open = root => openIsolatedStore(root, options);

for (const [mode, expected] of [["missing", "UNSUPPORTED_STORAGE"], ["transport", "RECOVERY_REQUIRED"], ["callback", "RECOVERY_REQUIRED"]]) {
  test("real ext4 lease / " + mode + " startup failure", async t => {
    const root = await mkdtemp(join(tmpdir(), "estampes-pr1c-lease-"));
    t.after(() => rm(root, {recursive: true, force: true}));
    const writer = await open(root);
    writer.kill("SIGKILL");
    await writer.waitForExit();
    const current = join(root, "visual-registry/CURRENT.json"), lock = join(root, "WRITER.lock");
    const before = await readFile(current), identity = (await lstat(lock)).ino;
    process.env.PR1D_LEASE_ROOT = root;
    process.env.PR1D_LEASE_INJECTION = mode;
    const start = performance.now();
    try {
      await assert.rejects(open(root), error => {
        const elapsedMs = performance.now() - start;
        t.diagnostic(JSON.stringify({mode, elapsedMs, code: error.code, message: error.message, details: error.details}));
        assert.equal(error.code, expected);
        if (mode === "missing") assert.equal(error.details.cause, "ENOENT");
        if (mode === "transport") assert.equal(error.details.cause, "EIO");
        if (mode === "callback") {
          assert.match(error.message, /startup timed out/);
          assert.ok(elapsedMs >= 29500 && elapsedMs <= 33000);
        }
        return true;
      });
    } finally {
      delete process.env.PR1D_LEASE_ROOT;
      delete process.env.PR1D_LEASE_INJECTION;
    }
    assert.deepEqual(await readFile(current), before);
    assert.equal((await lstat(lock)).ino, identity);
    // The client's rejection can precede reaping the killed child.
    let reopened;
    for (let i = 0; i < 20 && !reopened; i++) {
      try { reopened = await open(root); }
      catch (error) {
        assert.equal(error.code, "STORAGE_UNAVAILABLE");
        assert.equal(error.details.exitCode, 73);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    assert.equal(reopened?.status.state, "ready");
    await reopened.close();
  });
}
