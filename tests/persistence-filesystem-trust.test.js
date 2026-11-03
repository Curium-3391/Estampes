// Controlled external mutations are detection tests, not proof of same-UID exclusion.
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
    if(point==='before-ack'){
      // Publication has already selected the new transaction. Detection must
      // fence without fabricating an ACK or restoring an older CURRENT.
      assert.equal(after.generation,before.envelope.generation+1);
      assert.equal(ledger.size,before.indices.ledger.size+1);
    }else{assert.deepEqual(after,before.envelope);assert.equal(ledger.size,before.indices.ledger.size);}
  });
}

for(const replacementMode of ["replace","replace-same"])test("GC retains a replaced quarantine inode / "+replacementMode, async t => {
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
  await writeFile(join(f.root,"round3-trigger.json"), JSON.stringify({point:"gc.before-unlink",pointPath:target,target,mode:replacementMode}));
  const result = await step().catch(error => ({error:error.code}));
  const marker = JSON.parse(await readFile(join(f.root,"round3-observed.json"),"utf8"));
  assert.equal(marker.target, target);
  assert.notEqual(marker.before.split(":")[1], marker.after.split(":")[1]);
  const exists = await files.exists(target);
  t.diagnostic(JSON.stringify({marker,result,exists,writer:(await f.store.diagnostics()).state}));
  assert.equal(result.error, "RECOVERY_REQUIRED");
  assert.equal(exists, true);
});


test('R3-A2 / bounded real same-inode equal-length rewrites always reject stale content proof',async t=>{
  const fs=await import('node:fs/promises'),{tmpdir}=await import('node:os');
  const root=await fs.mkdtemp(join(tmpdir(),'estampes-trust-collision-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const files=new ManagedFiles(root);let collisions=0;
  for(let n=0;n<128;n++){
    await fs.writeFile(files.path('record.json'),'{"a":1}');const io=files.observation();await io.json('record.json');
    const old=io.observations.get('record.json');await fs.writeFile(files.path('record.json'),'{"a":2}');
    const {physicalFingerprint}=await import('../src/persistence/filesystem.js');
    if(physicalFingerprint(await files.info('record.json'))===old)collisions++;
    await assert.rejects(io.proofFingerprint('record.json'),e=>e.code==='INTEGRITY_ERROR');
  }
  t.diagnostic(JSON.stringify({attempts:128,identicalFingerprints:collisions,staleProofsAccepted:0,filesystem:'actual temporary filesystem; not asserted ext4'}));
});

test('R3-A2 / forced metadata alias cannot reuse a cache proof with different real bytes',async t=>{
  const fs=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{VerificationCache}=await import('../src/persistence/records.js');
  const root=await fs.mkdtemp(join(tmpdir(),'estampes-trust-alias-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const files=new ManagedFiles(root),cache=new VerificationCache();await fs.writeFile(files.path('record.json'),'{"a":1}');
  const original=await files.info('record.json');await cache.remember(files,'test',{bytes:7},['record.json'],{a:1});
  await fs.writeFile(files.path('record.json'),'{"a":2}');
  const digest=files.digest.bind(files);let hits=0;
  files.digest=async path=>{const actual=await digest(path);hits++;return {...actual,mtimeNs:original.mtimeNs,ctimeNs:original.ctimeNs};};
  // Only the metadata returned by the observer is masked. File reads and
  // cryptographic hashing remain real; no durability result is mocked.
  assert.equal(await cache.valid(files,'test',{bytes:7},new Set()),false);assert.ok(hits>0);assert.equal(cache.versions.size,0);
});

for(const fault of ['directory permissions','file permissions','hardlink','symlink'])test('private tree rejects '+fault+' on reopen and preserves CURRENT',async t=>{
  const fs=await import('node:fs/promises');const f=await lifecycleFixture(t),files=new ManagedFiles(f.root);
  const answer=await f.store.commit(command([document()]),actor(),await epoch(f.store)),path=files.path(versionPath(answer.ack.revisionVector[0]));
  const before=await readFile(files.path(current));await f.store.close();
  if(fault==='directory permissions')await fs.chmod(files.path('visual-registry'),0o777);
  if(fault==='file permissions')await fs.chmod(path,0o666);
  if(fault==='hardlink')await fs.link(path,files.path('unmanaged-alias'));
  if(fault==='symlink')await fs.symlink(path,files.path('unmanaged-symlink'));
  await f.reopen();assert.equal(f.store.status.state,'read-only-recovery');assert.deepEqual(await readFile(files.path(current)),before);
});

test('unsafe writable ancestry is refused before creating the OS lease',async t=>{
  const fs=await import('node:fs/promises'),{tmpdir}=await import('node:os');
  const parent=await fs.mkdtemp(join(tmpdir(),'estampes-trust-parent-'));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const root=join(parent,'estampes-pr1c-child');await fs.mkdir(root,{mode:0o700});await fs.chmod(parent,0o777);
  await assert.rejects(openIsolatedStore(root,options),e=>e.code==='INTEGRITY_ERROR');assert.deepEqual(await fs.readdir(root),[]);
});

test('runtime root mode changes fence before publication without automatic chmod',async t=>{
  const fs=await import('node:fs/promises');const f=await lifecycleFixture(t),files=new ManagedFiles(f.root),before=await readFile(files.path(current));
  await fs.chmod(f.root,0o770);
  await assert.rejects(f.store.commit(command([document()]),actor(),await epoch(f.store)),e=>e.code==='RECOVERY_REQUIRED');
  assert.equal((await fs.stat(f.root)).mode&0o777,0o770);assert.deepEqual(await readFile(files.path(current)),before);
});

test('same UID remains able to rewrite its own private tree; diagnostics exclude that adversary',async t=>{
  const fs=await import('node:fs/promises');const f=await lifecycleFixture(t),files=new ManagedFiles(f.root);
  const diagnostics=await f.store.diagnostics();assert.equal(diagnostics.filesystemTrust.sameUidAdversary,'unsupported-not-isolated');
  await fs.writeFile(files.path('owned.json'),'{"a":1}',{mode:0o400});
  await fs.chmod(files.path('owned.json'),0o600);await fs.writeFile(files.path('owned.json'),'{"a":2}');
  assert.deepEqual(await files.json('owned.json'),{a:2});assert.equal((await fs.stat(f.root)).mode&0o777,0o700);
});
