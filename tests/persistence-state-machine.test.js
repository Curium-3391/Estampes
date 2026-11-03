// Process-crash adaptation of preserved Round 3 assertions. External boundary cases are selected explicitly.
import test from "node:test";
import assert from "node:assert/strict";
import {readFile, writeFile, readdir} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {openIsolatedStore} from "../src/persistence/lease.js";
import {ManagedFiles} from "../src/persistence/filesystem.js";
import {loadCommitted, versionPath} from "../src/persistence/records.js";
import {readGcPlan} from "../src/persistence/gc.js";
import {PageStore} from "../src/persistence/pages.js";
import {lifecycleFixture, document, titleEdit, command, actor, epoch, drain, TIME, DAY} from "./fixtures/uva-lifecycle.mjs";

const profile = "linux-process-crash-test";
const current = "visual-registry/CURRENT.json";
const options = {profile, purpose: "isolated-pr1c-testing", testClockMs: TIME,
  lifecycle: {enabled: true, autoMaintenance: false}};
const doc = (id = 1) => ({...document(id), persistence: "memory"});
const ready = f => assert.equal(f.store.status.state, "ready", JSON.stringify(f.store.status.problem));

async function reopenObserved(f) {
  const old = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--import=" + fileURLToPath(new URL("./fixtures/round3-boundary-preload.mjs", import.meta.url));
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

for(const initialStage of ['current.after-dir-fsync','current.before-rename'])test('R3-B1 / four interrupted recovery epochs preserve exact claims and retry / '+initialStage,async t=>{
  const f=await lifecycleFixture(t),files=new ManagedFiles(f.root),cmd=command([document()]);
  await stopCommit(f,initialStage,cmd);
  const first=await loadCommitted(files),original=[...first.indices.ledger.values()][0]?.ack;
  for(let n=0;n<4;n++){
    let hit=false;
    await assert.rejects(openIsolatedStore(f.root,{...options,fault:{point:'current.after-dir-fsync',mode:'pause'}},event=>{
      if(event.name==='current.after-dir-fsync'){hit=true;process.kill(event.pid,'SIGKILL');}
    }),e=>e.code==='RECOVERY_REQUIRED'&&e.details?.signal==='SIGKILL');
    assert.equal(hit,true);
    assert.equal((await loadCommitted(files)).indices.ledger.size,original?1:0);
  }
  assert.equal((await readdir(files.path('visual-temporaries/claims'))).length,5);
  await f.reopen();ready(f);
  const replay=await f.store.commit(cmd,actor(2),await epoch(f.store));
  assert.equal(replay.replayed,Boolean(original));if(original)assert.deepEqual(replay.ack,original);
  await assert.rejects(f.store.commit(command([{...document(),title:'different payload'}]),actor(3),await epoch(f.store)),e=>e.code==='IDEMPOTENCY_MISMATCH');
  await f.reopen();ready(f);assert.deepEqual((await f.store.commit(cmd,actor(4),await epoch(f.store))).ack,replay.ack);
  const job=await f.store.maintenance('gcPlan',{classes:['G2']});assert.equal(job.planned,true);
  assert.equal((await f.store.maintenance('gcStep',{id:job.id})).state,'waiting-grace');
  await f.store.maintenance('clock',{nowMs:TIME+DAY});assert.equal((await f.store.maintenance('gcStep',{id:job.id})).state,'complete');
  await f.reopen({testClockMs:TIME+DAY});ready(f);assert.equal((await f.store.diagnostics()).contentCommits,1);
});
