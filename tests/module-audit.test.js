// The module audit log: read() sees every entry recorded before it was called,
// even while the file append is still in flight (it once raced the append, and
// tests/packages.test.js failed now and then in CI).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudit } from "../src/modules/audit.js";

test("read() right after record() returns the new entries from disk", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (let round = 0; round < 20; round++) {
    const audit = createAudit(join(dir, "r" + round));
    audit.record({ kind: "network", module: "org.test.a", host: "api.example.org" });
    audit.record({ kind: "run", module: "org.test.a" });
    const read = await audit.read();
    assert.deepEqual(read.map((e) => e.kind), ["run", "network"], "round " + round);
  }
});
