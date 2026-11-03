// Process-crash adaptation of preserved Round 3 assertions. External boundary cases are selected explicitly.
import test from "node:test";
import assert from "node:assert/strict";
import {readFile, writeFile, readdir} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {openIsolatedStore} from "../src/persistence/lease.js";
import {ManagedFiles} from "../src/persistence/filesystem.js";
import {loadCommitted, versionPath} from "../src/persistence/records.js";
import {restoreIsolatedBackup} from "../src/persistence/backup.js";
import {randomUUID} from "node:crypto";
import {canonicalJson, hashJson} from "../src/documents/validation.js";
import {readGcPlan, gcOwnership, gcPlanPath} from "../src/persistence/gc.js";
import {PageStore} from "../src/persistence/pages.js";
import {lifecycleFixture, destination, document, titleEdit, command, actor, epoch, drain, TIME, DAY} from "./fixtures/uva-lifecycle.mjs";

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


for(const kind of ['G1','G2'])for(const phase of ['planned','partial-quarantine','unlink-intent','complete'])test('R3-C1 / exclusive '+kind+' ownership / '+phase,async t=>{
  const f=kind==='G1'?await g1(t):await lifecycleFixture(t),files=new ManagedFiles(f.root);
  if(kind==='G2'){
    await f.store.injectFault({point:'after-staged-writes',mode:'throw',code:'ENOSPC'});
    await assert.rejects(f.store.commit(command([document()]),actor(),await epoch(f.store)),e=>e.code==='STORAGE_UNAVAILABLE');
    await f.reopen();ready(f);
  }
  const first=await f.store.maintenance('gcPlan',{classes:[kind]});assert.equal(first.planned,true);
  if(phase==='partial-quarantine'){
    let hit=false;
    await f.store.injectFault({point:'gc.after-rename',mode:'pause'});
    const reached=new Promise(resolve=>f.store.events.once('stage',()=>{hit=true;resolve();}));
    const pending=f.store.maintenance('gcStep',{id:first.id}).catch(e=>e);
    await reached;f.store.kill();await f.store.waitForExit();assert.equal((await pending).code,'RECOVERY_REQUIRED');assert.equal(hit,true);
    await f.reopen();ready(f);
  }
  if(phase==='unlink-intent'||phase==='complete'){
    if(kind==='G2'){await f.store.maintenance('gcStep',{id:first.id});await f.store.maintenance('clock',{nowMs:TIME+DAY});}
    if(phase==='unlink-intent'){
      await f.store.injectFault({point:'after-publication-durable',nth:2,mode:'pause'});
      const reached=new Promise(resolve=>f.store.events.once('stage',resolve));
      const pending=f.store.maintenance('gcStep',{id:first.id}).catch(e=>e);
      await reached;f.store.kill();await f.store.waitForExit();assert.equal((await pending).code,'RECOVERY_REQUIRED');await f.reopen({testClockMs:TIME+DAY});ready(f);
    }else assert.equal((await f.store.maintenance('gcStep',{id:first.id})).state,'complete');
  }
  const before=await loadCommitted(files),second=await f.store.maintenance('gcPlan',{classes:[kind]});
  if(second.planned){
    // Advancing a full day can admit new terminal-journal candidates. Their
    // objects must be disjoint from every still-owned candidate, rather than
    // incorrectly requiring the whole later plan to be empty.
    const old=before.indices.retention.get('gc:'+first.id),prior=await readGcPlan(files,old);
    const active=old.state==='complete'?new Set():new Set(prior.candidates.filter((_,i)=>!old.deleted.includes(i)).map(c=>c.physical.dev+':'+c.physical.ino));
    const latest=await loadCommitted(files),next=await readGcPlan(files,latest.indices.retention.get('gc:'+second.id));
    assert.equal(next.candidates.some(c=>active.has(c.physical.dev+':'+c.physical.ino)),false,'No overlapping physical deletion authority');
    t.diagnostic(JSON.stringify({kind,phase,laterCandidates:next.candidates.map(c=>({path:c.path,reason:c.reason}))}));
  }
  await f.reopen({testClockMs:TIME+DAY});ready(f);
  if(phase!=='complete'){
    await f.store.maintenance('gcStep',{id:first.id});await f.store.maintenance('clock',{nowMs:TIME+2*DAY});
    assert.equal((await f.store.maintenance('gcStep',{id:first.id})).state,'complete');
  }
  await f.reopen({testClockMs:TIME+2*DAY});ready(f);assert.deepEqual((await f.store.snapshot()).documents,before.documents);
});

test('R3-C1 / disjoint G1 and G2 plans retain independent physical ownership',async t=>{
  const f=await g1(t),files=new ManagedFiles(f.root),first=await f.store.maintenance('gcPlan',{classes:['G1']});
  await f.store.injectFault({point:'after-staged-writes',mode:'throw',code:'ENOSPC'});
  await assert.rejects(f.store.commit(command([doc(2)],20),actor(),await epoch(f.store)),e=>e.code==='STORAGE_UNAVAILABLE');
  await f.reopen();ready(f);
  const second=await f.store.maintenance('gcPlan',{classes:['G2']});assert.equal(second.planned,true);
  const snapshot=await loadCommitted(files),a=await readGcPlan(files,snapshot.indices.retention.get('gc:'+first.id)),b=await readGcPlan(files,snapshot.indices.retention.get('gc:'+second.id));
  const owned=new Set(a.candidates.map(c=>c.physical.dev+':'+c.physical.ino));
  assert.equal(b.candidates.some(c=>owned.has(c.physical.dev+':'+c.physical.ino)),false);
  assert.equal((await f.store.maintenance('gcStep',{id:first.id})).state,'complete');
  assert.equal((await f.store.maintenance('gcStep',{id:second.id})).state,'waiting-grace');
  await f.store.maintenance('clock',{nowMs:TIME+DAY});assert.equal((await f.store.maintenance('gcStep',{id:second.id})).state,'complete');
  await f.reopen({testClockMs:TIME+DAY});ready(f);assert.equal((await f.store.diagnostics()).contentCommits,3);
});


test('R3-B1 / repeated recovery rejects a forged transaction generation',async t=>{
  const f=await lifecycleFixture(t),files=new ManagedFiles(f.root);
  await stopCommit(f,'current.after-dir-fsync',command([document()]));
  await assert.rejects(openIsolatedStore(f.root,{...options,fault:{point:'current.after-dir-fsync',mode:'pause'}},event=>{
    if(event.name==='current.after-dir-fsync')process.kill(event.pid,'SIGKILL');
  }),e=>e.code==='RECOVERY_REQUIRED');
  const claims=await readdir(files.path('visual-temporaries/claims'));
  assert.equal(claims.length,2);
  const claim=await files.json('visual-temporaries/claims/'+claims[0]),path='visual-transactions/'+claim.owner.id+'/prepared.json',prepared=await files.json(path);
  await writeFile(files.path(path),canonicalJson({...prepared,generation:prepared.generation+1}));
  const before=await readFile(files.path(current));
  await f.reopen();assert.equal(f.store.status.state,'read-only-recovery');
  assert.deepEqual(await readFile(files.path(current)),before);
});

test('R3-C1 / independent hashed overlapping plans and false terminal progress fail closed',async t=>{
  const f=await g1(t),files=new ManagedFiles(f.root),first=await f.store.maintenance('gcPlan',{classes:['G1']});
  const snapshot=await loadCommitted(files),record=snapshot.indices.retention.get('gc:'+first.id),plan=await readGcPlan(files,record);
  const duplicate=structuredClone(plan);duplicate.id=randomUUID();
  for(const [i,c]of duplicate.candidates.entries())c.quarantine='gc-quarantine/'+duplicate.id+'/'+i+'-'+c.hash+'.bin';
  const hash=hashJson(duplicate);await files.durableCreate(gcPlanPath(hash),Buffer.from(canonicalJson(duplicate)),'test-ambiguous-plan');
  const retention=new Map(snapshot.indices.retention);retention.set('gc:'+duplicate.id,{...record,planHash:hash});
  await assert.rejects(gcOwnership(files,{...snapshot,indices:{...snapshot.indices,retention}}),e=>e.code==='INTEGRITY_ERROR');
  await assert.rejects(readGcPlan(files,{...record,state:'complete'}),e=>e.code==='INTEGRITY_ERROR');
  await f.reopen();ready(f);assert.equal((await f.store.maintenance('gcStep',{id:first.id})).state,'complete');
});


test('R3-C1 / relocated backup verifies logical history without inheriting physical GC authority',async t=>{
  const f=await g1(t),job=await f.store.maintenance('gcPlan',{classes:['G1']});assert.equal(job.planned,true);
  const before=await f.store.snapshot(),backup=await destination(t),copy=await f.store.maintenance('backupStart',{destination:backup});
  let done=false;for(let n=0;n<100;n++)if((await f.store.maintenance('backupStep',{id:copy.id})).state==='complete'){done=true;break;}
  assert.equal(done,true);
  const target=await destination(t,'restore'),result=await restoreIsolatedBackup(backup,target,{profile});assert.equal(result.readOnly,true);
  const bytes=await readFile(join(target,current)),restored=await openIsolatedStore(target,options);t.after(()=>restored.close());
  assert.equal(restored.status.state,'read-only-recovery');assert.equal(restored.status.problem.cause,'RESTORED_BACKUP_REQUIRES_CONTINUATION_PROOF');
  assert.deepEqual((await restored.snapshot()).documents,before.documents);
  await assert.rejects(restored.maintenance('gcStep',{id:job.id}),e=>e.code==='RECOVERY_REQUIRED');
  await assert.rejects(restored.commit(command([doc(2)],20),actor(),1),e=>e.code==='RECOVERY_REQUIRED');
  assert.deepEqual(await readFile(join(target,current)),bytes);
});
