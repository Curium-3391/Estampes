import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {ManagedFiles} from "../../../../../src/persistence/filesystem.js";
import {loadCommitted} from "../../../../../src/persistence/records.js";
import {readGcPlan} from "../../../../../src/persistence/gc.js";
import {readBackupList} from "../../../../../src/persistence/backup.js";
import {lifecycleFixture,destination,document,command,actor,epoch,TIME,DAY} from "../../../../../tests/fixtures/uva-lifecycle.mjs";

test("native GC re-marks backup dependencies created after its selected plan", async t => {
  const f = await lifecycleFixture(t, {profile:"linux-local-durable"});
  const files = new ManagedFiles(f.root);
  const d = {...document(),persistence:"durable"};
  await f.store.injectFault({point:"after-staged-writes",mode:"throw",code:"ENOSPC"});
  await assert.rejects(f.store.commit(command([d]),actor(),await epoch(f.store)), e=>e.code==="STORAGE_UNAVAILABLE");
  await f.reopen();
  assert.equal(f.store.status.state,"ready");
  await f.store.maintenance("clock",{nowMs:TIME+DAY});
  const job = await f.store.maintenance("gcPlan",{classes:["G2"]});
  assert.equal(job.planned,true);
  const dest = await destination(t);
  const backup = await f.store.maintenance("backupStart",{destination:dest});
  const before = await loadCommitted(files);
  const plan = await readGcPlan(files,before.indices.retention.get("gc:"+job.id));
  const list = await readBackupList(files,before.indices.retention.get("backup:"+backup.id).filesHash);
  const required = new Set(list.files.map(entry=>entry.path));
  const protectedCandidates = plan.candidates.filter(entry=>required.has(entry.path));
  assert.ok(protectedCandidates.length>0,"Must protect paths already in the selected GC plan");
  const step = await f.store.maintenance("gcStep",{id:job.id});
  for (const c of protectedCandidates) {
    assert.equal(await files.exists(c.path),true);
    assert.equal(await files.exists(c.quarantine),false);
    assert.equal((await files.digest(c.path)).hash,c.hash);
  }
  let result;
  for (let i=0;i<100;i++) {
    result = await f.store.maintenance("backupStep",{id:backup.id});
    if(result.state==="complete")break;
  }
  assert.equal(result.state,"complete");
  assert.equal(JSON.parse(await readFile(dest+"/backup-manifest.json","utf8")).complete,true);
  assert.deepEqual((await loadCommitted(new ManagedFiles(dest))).documents,[]);
  t.diagnostic(JSON.stringify({step, protectedCandidates:protectedCandidates.map(c=>c.path), backup:result.state}));
});
