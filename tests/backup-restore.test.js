// The documented backup (both data roots in one archive) must restore every
// kind of work on a new server, both while changes are pending and after
// they were committed into the UVA store (architecture review A01). The
// procedure itself lives in scripts/verify-backup-restore.mjs so operators
// can run the same check.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("backup of both roots restores pending and committed work; the storage folder alone does not", { timeout: 600000 }, () => {
  const run = spawnSync(process.execPath, ["scripts/verify-backup-restore.mjs"], { encoding: "utf8", timeout: 590000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /All \d+ checks passed/);
  assert.match(run.stdout, /\[committed\] a backup of the storage folder alone misses committed work/);
});
