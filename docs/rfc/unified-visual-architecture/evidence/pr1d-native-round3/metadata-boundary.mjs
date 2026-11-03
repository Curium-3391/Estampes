import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ManagedFiles, physicalFingerprint} from "../../../../../src/persistence/filesystem.js";

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "estampes-round3-metadata-"));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const files = new ManagedFiles(root);
  return {files, path:files.path("record.json")};
}

test("same-inode rewrite after FD open and before the first read is rejected", async t => {
  const {files, path} = await fixture(t);
  await fs.writeFile(path, '{"a":1}');
  const original = fs.open;
  let marker;
  fs.open = async function (name, ...args) {
    const fd = await original.call(this,name,...args);
    if (name !== path) return fd;
    const read = fd.readFile.bind(fd);
    fd.readFile = async function (...args) {
      const before = physicalFingerprint(await files.info("record.json"));
      await fs.writeFile(path, '{"a":1111}');
      const after = physicalFingerprint(await files.info("record.json"));
      marker = {before,after};
      return read(...args);
    };
    return fd;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(files.observation().json("record.json"), e => e.code === "INTEGRITY_ERROR"); }
  finally { fs.open = original; syncBuiltinESMExports(); }
  assert.ok(marker);
  assert.notEqual(marker.before, marker.after);
  assert.equal(marker.before.split(":")[1], marker.after.split(":")[1]);
  t.diagnostic(JSON.stringify(marker));
});

test("record real ext4 timestamp coalescing during bounded same-size rewrites", async t => {
  const {files,path} = await fixture(t);
  const attempts = 128;
  let same = 0, specimen;
  for (let i = 0; i < attempts; i++) {
    await fs.writeFile(path, '{"a":1}');
    const io = files.observation();
    assert.deepEqual(await io.json("record.json"), {a:1});
    const before = io.observations.get("record.json");
    await fs.writeFile(path, '{"a":2}');
    const after = physicalFingerprint(await files.info("record.json"));
    if (before === after) {
      same++;
      const accepted = await io.proofFingerprint("record.json");
      assert.equal(accepted, before);
      specimen ??= {before,after,accepted,actual:await files.json("record.json")};
    }
  }
  t.diagnostic(JSON.stringify({attempts, identicalFingerprints:same, specimen}));
});
