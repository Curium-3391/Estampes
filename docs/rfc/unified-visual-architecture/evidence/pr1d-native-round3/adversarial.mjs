import test from "node:test";
import assert from "node:assert/strict";
import {readFile, writeFile, readdir} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {openIsolatedStore} from "../../../../../src/persistence/lease.js";
import {ManagedFiles} from "../../../../../src/persistence/filesystem.js";
import {loadCommitted, versionPath} from "../../../../../src/persistence/records.js";
import {readGcPlan} from "../../../../../src/persistence/gc.js";
import {PageStore} from "../../../../../src/persistence/pages.js";
import {lifecycleFixture, document, titleEdit, command, actor, epoch, drain, TIME, DAY} from "../../../../../tests/fixtures/uva-lifecycle.mjs";

const profile = "linux-local-durable";
const current = "visual-registry/CURRENT.json";
const options = {profile, purpose: "isolated-pr1c-testing", testClockMs: TIME,
  lifecycle: {enabled: true, autoMaintenance: false}};
const doc = (id = 1) => ({...document(id), persistence: "durable"});
const ready = f => assert.equal(f.store.status.state, "ready", JSON.stringify(f.store.status.problem));

async function reopenObserved(f) {
  const old = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--import=" + fileURLToPath(new URL("./boundary-preload.mjs", import.meta.url));
  process.env.PR1D_ROUND3_FAULT_ROOT = f.root;
  try { await f.reopen(); }
  finally {
    if (old === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = old;
    delete process.env.PR1D_ROUND3_FAULT_ROOT;
  }
  ready(f);
}

async function stopCommit(f, point, cmd) {
  await f.store.injectFault({point, mode: "pause"});
  let timer, listener;
  const reached = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error("Did not reach " + point)), 20000);
    listener = event => { if (event.name === point) resolve(); };
    f.store.events.on("stage", listener);
  });
  const pending = epoch(f.store).then(e => f.store.commit(cmd, actor(), e)).catch(error => error);
  try { await reached; }
  finally {
    clearTimeout(timer);
    f.store.events.off("stage", listener);
    f.store.kill("SIGKILL");
    await f.store.waitForExit();
  }
  assert.equal((await pending).code, "RECOVERY_REQUIRED");
}

for (const [point, mode] of [["after-prepared", "overwrite"], ["current.before-rename", "replace"], ["before-ack", "overwrite"]]) {
  test("native candidate proof remains valid through " + point, async t => {
    const f = await lifecycleFixture(t, {profile}), files = new ManagedFiles(f.root);
    const first = await f.store.commit(command([doc()]), actor(), await epoch(f.store));
    await reopenObserved(f);
    const before = await loadCommitted(files);
    const fault = {point, mode, target: versionPath(first.ack.revisionVector[0])};
    await writeFile(join(f.root, "round3-trigger.json"), JSON.stringify(fault));
    const result = await f.store.commit(command([doc(2)], 2), actor(2), await epoch(f.store))
      .catch(error => ({error: error.code, details: error.details}));
    const marker = JSON.parse(await readFile(join(f.root, "round3-observed.json"), "utf8"));
    assert.equal(marker.point, point);
    assert.equal(marker.workerPid, f.store.pid);
    assert.notEqual(marker.before, marker.after);
    assert.equal(marker.before.split(":")[1] === marker.after.split(":")[1], mode === "overwrite");
    const after = await files.json(current);
    const pages = new PageStore(files);
    const root = await pages.hashed(after.rootHash, "visual-registry/roots", 65536);
    const ledger = await pages.read(root.roots.ledger, "ledger");
    const warm = (await f.store.diagnostics()).state;
    const cold = await loadCommitted(files).catch(error => error);
    await f.reopen();
    t.diagnostic(JSON.stringify({marker, before: before.envelope, after, ledgerBefore: before.indices.ledger.size,
      ledgerAfter: ledger.size, result, warm, coldError: cold.code, restart: f.store.status.state}));
    assert.equal(cold.code, "INTEGRITY_ERROR");
    assert.equal(f.store.status.state, "read-only-recovery");
    assert.equal(result.error, "RECOVERY_REQUIRED");
    assert.equal(warm, "read-only-recovery");
    assert.deepEqual(after, before.envelope);
    assert.equal(ledger.size, before.indices.ledger.size);
  });
}

for (const stage of ["after-prepared", "current.after-dir-fsync", "after-publication-durable"]) {
  test("native selected CURRENT proof survives interrupted recovery at " + stage, async t => {
    const f = await lifecycleFixture(t, {profile}), files = new ManagedFiles(f.root), cmd = command([doc()]);
    await stopCommit(f, "current.after-dir-fsync", cmd);
    const first = await loadCommitted(files);
    const original = [...first.indices.ledger.values()][0].ack;
    const [claimFile] = await readdir(join(f.root, "visual-temporaries/claims"));
    const claim = await files.json("visual-temporaries/claims/" + claimFile);
    let boundary;
    await assert.rejects(openIsolatedStore(f.root, {...options, fault:{point:stage, mode:"pause"}}, event => {
      if (event.name === stage) {
        boundary = event.name;
        process.kill(event.pid, "SIGKILL");
      }
    }), error => error.code === "RECOVERY_REQUIRED" && error.details?.signal === "SIGKILL");
    assert.equal(boundary, stage);
    const selected = await loadCommitted(files);
    const proof = selected.indices.retention.get("temporary:" + claim.claimId)?.publication;
    if (stage === "after-prepared") assert.equal(proof, undefined);
    else assert.deepEqual(proof.envelope, first.envelope);
    const claimNames = await readdir(join(f.root, "visual-temporaries/claims"));
    await f.reopen();
    t.diagnostic(JSON.stringify({stage, selectedProof:proof, selectedGeneration:selected.root.generation,
      claimNames, state:f.store.status.state, problem:f.store.status.problem, ledger:selected.indices.ledger.size}));
    ready(f);
    for (let n = 0; n < 2; n++) {
      assert.deepEqual((await f.store.commit(cmd, actor(n+2), await epoch(f.store))).ack, original);
      assert.equal((await f.store.diagnostics()).contentCommits, 1);
      await f.reopen();
      ready(f);
    }
  });
}

async function g1(t) {
  const f = await lifecycleFixture(t, {profile, legacy: true});
  let d = doc();
  for (let n = 1; n <= 3; n++) {
    if (n > 1) d = {...titleEdit(d), title: "legacy " + n};
    await f.store.commit(command([d], n, n===1?null:n-1), actor(n), await epoch(f.store));
  }
  await f.enable();
  await drain(f.store);
  return f;
}

test("native repeated planning must not orphan an overlapping active GC plan", async t => {
  const f = await g1(t), files = new ManagedFiles(f.root);
  const plan = () => f.store.maintenance("gcPlan", {classes:["G1"]});
  const first = await plan(), second = await plan();
  assert.ok(first.planned);
  const before = await loadCommitted(files);
  const paths = async id => (await readGcPlan(files, before.indices.retention.get("gc:"+id))).candidates.map(c => c.path);
  const firstPaths = await paths(first.id);
  const overlap = second.planned ? (await paths(second.id)).filter(p => new Set(firstPaths).has(p)) : [];
  const result = await f.store.maintenance("gcStep", {id:first.id});
  await f.reopen();
  t.diagnostic(JSON.stringify({first, second, overlap, result, state:f.store.status.state, problem:f.store.status.problem}));
  ready(f);
  assert.deepEqual((await f.store.snapshot()).documents, before.documents);
});

test("native GC does not unlink a different inode at the authorized quarantine path", async t => {
  const f = await lifecycleFixture(t, {profile}), files = new ManagedFiles(f.root);
  await f.store.injectFault({point:"after-staged-writes",mode:"throw",code:"ENOSPC"});
  await assert.rejects(f.store.commit(command([doc()]), actor(), await epoch(f.store)), e => e.code === "STORAGE_UNAVAILABLE");
  await reopenObserved(f);
  const job = await f.store.maintenance("gcPlan", {classes:["G2"]});
  const step = () => f.store.maintenance("gcStep", {id:job.id});
  assert.equal((await step()).state, "waiting-grace");
  const snapshot = await loadCommitted(files);
  const plan = await readGcPlan(files, snapshot.indices.retention.get("gc:"+job.id));
  const target = plan.candidates[0].quarantine;
  await f.store.maintenance("clock", {nowMs:TIME+DAY});
  await writeFile(join(f.root,"round3-trigger.json"), JSON.stringify({point:"gc.before-unlink",pointPath:target,target,mode:"replace"}));
  const result = await step().catch(error => ({error:error.code}));
  const marker = JSON.parse(await readFile(join(f.root,"round3-observed.json"),"utf8"));
  assert.equal(marker.target, target);
  assert.notEqual(marker.before.split(":")[1], marker.after.split(":")[1]);
  const exists = await files.exists(target);
  t.diagnostic(JSON.stringify({marker,result,exists,writer:(await f.store.diagnostics()).state}));
  assert.equal(result.error, "RECOVERY_REQUIRED");
  assert.equal(exists, true);
});
