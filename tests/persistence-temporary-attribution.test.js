import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile, mkdir, link } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { lifecycleFixture, document, command, actor, epoch, titleEdit, TIME, DAY } from "./fixtures/uva-lifecycle.mjs";
import { ManagedFiles } from "../src/persistence/filesystem.js";
import { loadCommitted } from "../src/persistence/records.js";
import { openIsolatedStore } from "../src/persistence/lease.js";
import { canonicalJson } from "../src/documents/validation.js";

async function killAt(t,f,point){
  let listener,timer;const reached=new Promise((resolve,reject)=>{listener=event=>{if(event.name===point){clearTimeout(timer);f.store.events.off("stage",listener);resolve();}};
    f.store.events.on("stage",listener);timer=setTimeout(()=>reject(new Error("Stage not reached: "+point)),20000);});
  t.after(()=>{clearTimeout(timer);f.store.events.off("stage",listener);});await f.store.injectFault({point,mode:"pause"});
  const pending=f.store.commit(command([document()]),actor(),await epoch(f.store)).catch(error=>error);await reached;
  const names=await readdir(join(f.root,"visual-temporaries/claims"));assert.equal(names.length,1);
  const claim=JSON.parse(await readFile(join(f.root,"visual-temporaries/claims",names[0])));assert.equal(claim.owner.kind,"transaction");
  f.store.kill("SIGKILL");await f.store.waitForExit();assert.equal((await pending).code,"RECOVERY_REQUIRED");return claim;
}

async function killOperationAt(t,f,point,operation){
  let listener,timer;const reached=new Promise((resolve,reject)=>{listener=event=>{if(event.name===point){clearTimeout(timer);f.store.events.off("stage",listener);resolve();}};
    f.store.events.on("stage",listener);timer=setTimeout(()=>reject(new Error("Stage not reached: "+point)),20000);});
  t.after(()=>{clearTimeout(timer);f.store.events.off("stage",listener);});await f.store.injectFault({point,mode:"pause"});
  const pending=operation().catch(error=>error);await reached;f.store.kill("SIGKILL");await f.store.waitForExit();assert.equal((await pending).code,"RECOVERY_REQUIRED");
}

test("PR-1D: pre-rename crash temporary has one durable owner and drains only through G2 grace",async t=>{
  const f=await lifecycleFixture(t),claim=await killAt(t,f,"staged.before-file-fsync");
  assert.equal(await new ManagedFiles(f.root).exists(claim.temporaryPath),true);
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));assert.deepEqual((await f.store.snapshot()).documents,[]);
  let snapshot=await loadCommitted(new ManagedFiles(f.root));assert.equal(snapshot.indices.retention.get("temporary:"+claim.claimId)?.outcome,"aborted");
  const plan=await f.store.maintenance("gcPlan",{classes:["G2"]});assert.equal(plan.planned,true);
  assert.equal((await f.store.maintenance("gcStep",{id:plan.id})).state,"waiting-grace");
  await f.store.maintenance("clock",{nowMs:TIME+DAY});assert.equal((await f.store.maintenance("gcStep",{id:plan.id})).state,"complete");
  assert.equal(await new ManagedFiles(f.root).exists(claim.temporaryPath),false);assert.equal(await new ManagedFiles(f.root).exists("visual-temporaries/claims/"+claim.claimId+".json"),false);
  snapshot=await loadCommitted(new ManagedFiles(f.root));assert.equal(snapshot.indices.retention.has("temporary:"+claim.claimId),false);
});

test("PR-1D: crash after CURRENT rename classifies the exact claim and preserves the committed effect",async t=>{
  const f=await lifecycleFixture(t),claim=await killAt(t,f,"current.after-rename");await f.reopen();
  assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));assert.equal((await f.store.snapshot()).documents.length,1);
  const snapshot=await loadCommitted(new ManagedFiles(f.root)),proof=snapshot.indices.retention.get("temporary:"+claim.claimId);
  assert.equal(proof.outcome,"completed");assert.equal(proof.finalPath,"visual-registry/CURRENT.json");
});

test("PR-1D: an unclaimed atomic-shaped temporary is preserved and forces read-only recovery",async t=>{
  const f=await lifecycleFixture(t),path="visual-registry/CURRENT.json.tmp-"+randomUUID();await writeFile(join(f.root,path),"unknown");
  await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");assert.equal(await readFile(join(f.root,path),"utf8"),"unknown");
});

for(const point of ["temporary-claim.before-write","temporary-claim.before-file-fsync","temporary-claim.before-dir-fsync","temporary-claim.before-unlink"]){
  test("PR-1D: crash at "+point+" never creates an unattributed effect",async t=>{
    const f=await lifecycleFixture(t);let listener,timer;const reached=new Promise((resolve,reject)=>{listener=event=>{if(event.name===point){clearTimeout(timer);f.store.events.off("stage",listener);resolve();}};
      f.store.events.on("stage",listener);timer=setTimeout(()=>reject(new Error("Stage not reached: "+point)),20000);});t.after(()=>{clearTimeout(timer);f.store.events.off("stage",listener);});
    await f.store.injectFault({point,mode:"pause"});const pending=f.store.commit(command([document()]),actor(),await epoch(f.store)).catch(error=>error);await reached;
    f.store.kill("SIGKILL");await f.store.waitForExit();assert.equal((await pending).code,"RECOVERY_REQUIRED");await f.reopen();
    assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));assert.equal((await f.store.snapshot()).documents.length,0);
  });
}

test("PR-1D: bootstrap claim left after rename is completed idempotently on restart",async t=>{
  const root=await mkdtemp(join(tmpdir(),"estampes-pr1c-bootstrap-"));t.after(()=>rm(root,{recursive:true,force:true}));
  await assert.rejects(openIsolatedStore(root,{profile:"linux-process-crash-test",purpose:"isolated-pr1c-testing",fault:{point:"bootstrap.after-rename",mode:"pause"}},event=>process.kill(event.pid,"SIGKILL")),error=>error.code==="RECOVERY_REQUIRED");
  const store=await openIsolatedStore(root,{profile:"linux-process-crash-test",purpose:"isolated-pr1c-testing"});t.after(async()=>{store.kill("SIGKILL");await store.waitForExit();});
  assert.equal(store.status.state,"ready",JSON.stringify(store.status.problem));assert.equal((await store.snapshot()).documents.length,0);assert.deepEqual(await readdir(join(root,"visual-temporaries/claims")),[]);
});

test("qualification: a writer killed after creating, before writing, a claim file leaves an empty claim that recovery removes",async t=>{
  const f=await lifecycleFixture(t),claimId=randomUUID(),path="visual-temporaries/claims/"+claimId+".json";
  await mkdir(join(f.root,"visual-temporaries/claims"),{recursive:true,mode:0o700});await writeFile(join(f.root,path),"",{mode:0o600});
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
  assert.equal(await new ManagedFiles(f.root).exists(path),false);
});

test("qualification: an empty claim next to a temporary file carrying its identity still fails closed",async t=>{
  const f=await lifecycleFixture(t),claimId=randomUUID();
  await mkdir(join(f.root,"visual-temporaries/claims"),{recursive:true,mode:0o700});
  await writeFile(join(f.root,"visual-temporaries/claims/"+claimId+".json"),"",{mode:0o600});
  await writeFile(join(f.root,"visual-registry/CURRENT.json.tmp-"+claimId),"{}",{mode:0o600});
  await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");
});

test("qualification: a truncated non-empty claim still fails closed",async t=>{
  const f=await lifecycleFixture(t),claimId=randomUUID();
  await mkdir(join(f.root,"visual-temporaries/claims"),{recursive:true,mode:0o700});
  await writeFile(join(f.root,"visual-temporaries/claims/"+claimId+".json"),'{"schema":"estampes.tem',{mode:0o600});
  await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");
});

test("qualification: a zero-byte temporary of an uncommitted transaction is an interrupted write and does not wedge the store",async t=>{
  const f=await lifecycleFixture(t),files=new ManagedFiles(f.root),claimId=randomUUID(),finalPath="visual-registry/pages/"+"a".repeat(64)+".json";
  const claim={schema:"estampes.temporary-claim/1",claimId,owner:{kind:"transaction",id:randomUUID()},finalPath,temporaryPath:finalPath+".tmp-"+claimId,hash:"b".repeat(64),bytes:120,label:"page"};
  await files.durableCreate("visual-temporaries/claims/"+claimId+".json",Buffer.from(canonicalJson(claim)),"test-claim");
  await writeFile(join(f.root,claim.temporaryPath),"",{mode:0o600});
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
  const next=document(),result=await f.store.commit(command([next]),actor(),await epoch(f.store));assert.ok(result.ack);
});

test("qualification: a partly written temporary of an uncommitted transaction is removed at open",async t=>{
  const f=await lifecycleFixture(t),files=new ManagedFiles(f.root),claimId=randomUUID(),finalPath="visual-registry/pages/"+"a".repeat(64)+".json";
  const claim={schema:"estampes.temporary-claim/1",claimId,owner:{kind:"transaction",id:randomUUID()},finalPath,temporaryPath:finalPath+".tmp-"+claimId,hash:"b".repeat(64),bytes:120,label:"page"};
  await files.durableCreate("visual-temporaries/claims/"+claimId+".json",Buffer.from(canonicalJson(claim)),"test-claim");
  await writeFile(join(f.root,claim.temporaryPath),"{partial",{mode:0o600});
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
  assert.equal(await files.exists(claim.temporaryPath),false);
});

test("qualification: a staged claim left by an interrupted create is removed at open",async t=>{
  const f=await lifecycleFixture(t),claimId=randomUUID(),path="visual-temporaries/claims/"+claimId+".json.partial";
  await mkdir(join(f.root,"visual-temporaries/claims"),{recursive:true,mode:0o700});await writeFile(join(f.root,path),'{"sche',{mode:0o600});
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
  assert.equal(await new ManagedFiles(f.root).exists(path),false);
});

test("qualification: a claim interrupted between link and unlink (two names, one inode) is recovered",async t=>{
  const f=await lifecycleFixture(t),files=new ManagedFiles(f.root),claimId=randomUUID(),finalPath="visual-registry/pages/"+"c".repeat(64)+".json";
  const claim={schema:"estampes.temporary-claim/1",claimId,owner:{kind:"transaction",id:randomUUID()},finalPath,temporaryPath:finalPath+".tmp-"+claimId,hash:"d".repeat(64),bytes:3,label:"page"};
  const path="visual-temporaries/claims/"+claimId+".json";
  await files.durableCreate(path,Buffer.from(canonicalJson(claim)),"test-claim");
  await link(join(f.root,path),join(f.root,path+".partial"));
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
  assert.equal(await files.exists(path+".partial"),false);
});

test("qualification: two never-classified aborted CURRENT claims are closed at open",async t=>{
  const f=await lifecycleFixture(t),files=new ManagedFiles(f.root);
  for(let i=0;i<2;i++){const claimId=randomUUID(),body=Buffer.from('{"never":"published-'+i+'"}');
    const claim={schema:"estampes.temporary-claim/1",claimId,owner:{kind:"transaction",id:randomUUID()},finalPath:"visual-registry/CURRENT.json",temporaryPath:"visual-registry/CURRENT.json.tmp-"+claimId,hash:createHash("sha256").update(body).digest("hex"),bytes:body.length,label:"current"};
    await files.durableCreate("visual-temporaries/claims/"+claimId+".json",Buffer.from(canonicalJson(claim)),"test-claim");
    await writeFile(join(f.root,claim.temporaryPath),body,{mode:0o600});}
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
  const next=document(),result=await f.store.commit(command([next]),actor(),await epoch(f.store));assert.ok(result.ack);
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
});

// Changed by the engine rework: a CURRENT claim whose transaction never became a
// commit member was never published (publication puts the membership in the very
// root CURRENT names), so several of them are closed as aborted rather than
// leaving the store read-only. A claim that matches CURRENT without membership
// still fails closed (H-01 tests below).
test("PR-1D: two never-published durable claims for CURRENT are closed as aborted",async t=>{
  const f=await lifecycleFixture(t),files=new ManagedFiles(f.root),owner=id=>({kind:"transaction",id});
  for(const claimId of [randomUUID(),randomUUID()]){
    const claim={schema:"estampes.temporary-claim/1",claimId,owner:owner(randomUUID()),finalPath:"visual-registry/CURRENT.json",temporaryPath:"visual-registry/CURRENT.json.tmp-"+claimId,hash:"a".repeat(64),bytes:1,label:"conflict"};
    await files.durableCreate("visual-temporaries/claims/"+claimId+".json",Buffer.from(canonicalJson(claim)),"test-claim");
  }
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
  assert.deepEqual(f.store.status.recovery.filter(r=>r.claimId).map(r=>r.outcome),["aborted","aborted"]);
});

for(const laterCommit of [false,true])test("PR-1D native finding H-01: superseded CURRENT claim retains exact historical publication proof / later="+laterCommit,async t=>{
  const f=await lifecycleFixture(t),first=document(),cmd=command([first]);await killOperationAt(t,f,"current.after-dir-fsync",async()=>f.store.commit(cmd,actor(),await epoch(f.store)));
  const files=new ManagedFiles(f.root),names=await readdir(join(f.root,"visual-temporaries/claims"));assert.equal(names.length,1);
  const claim=await files.json("visual-temporaries/claims/"+names[0]);await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
  const replay=await f.store.commit(cmd,actor(2),await epoch(f.store));assert.equal(replay.replayed,true);assert.notEqual((await files.digest(claim.finalPath)).hash,claim.hash);
  let expected=first;if(laterCommit){expected={...structuredClone(first),revision:2,title:"later acknowledged content"};await f.store.commit(command([expected],2,1),actor(3),await epoch(f.store));}
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));assert.deepEqual((await f.store.snapshot()).documents,[expected]);
  const retry=await f.store.commit(cmd,actor(4),await epoch(f.store));assert.equal(retry.replayed,true);assert.deepEqual(retry.ack,replay.ack);
});

for(const point of ["gc.before-quarantine","gc.after-rename","gc.after-unlink"])test("PR-1D native finding H-02: GC disposition remains sole temporary owner after "+point,async t=>{
  const f=await lifecycleFixture(t),first=document();await f.store.commit(command([first]),actor(),await epoch(f.store));
  const changed=titleEdit(first);await killOperationAt(t,f,"staged.before-file-fsync",async()=>f.store.commit(command([changed],2,1),actor(2),await epoch(f.store)));
  await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));const plan=await f.store.maintenance("gcPlan",{classes:["G2"]});assert.equal(plan.planned,true);
  if(point==="gc.after-unlink"){assert.equal((await f.store.maintenance("gcStep",{id:plan.id})).state,"waiting-grace");await f.store.maintenance("clock",{nowMs:TIME+DAY});}
  await killOperationAt(t,f,point,()=>f.store.maintenance("gcStep",{id:plan.id}));await f.reopen({testClockMs:TIME+DAY});assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
  await f.store.maintenance("gcStep",{id:plan.id});await f.store.maintenance("clock",{nowMs:TIME+2*DAY});assert.equal((await f.store.maintenance("gcStep",{id:plan.id})).state,"complete");
  const snapshot=await loadCommitted(new ManagedFiles(f.root));assert.equal([...snapshot.indices.retention.keys()].some(key=>key.startsWith("temporary:")),false);
  await f.store.maintenance("gcPlan",{classes:["G2"]});await f.reopen({testClockMs:TIME+2*DAY});assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
});
