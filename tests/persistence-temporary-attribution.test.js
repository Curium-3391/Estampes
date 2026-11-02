import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { lifecycleFixture, document, command, actor, epoch, TIME, DAY } from "./fixtures/uva-lifecycle.mjs";
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

test("PR-1D: two durable claims for one target are ambiguous and fail closed",async t=>{
  const f=await lifecycleFixture(t),files=new ManagedFiles(f.root),owner=id=>({kind:"transaction",id});
  for(const claimId of [randomUUID(),randomUUID()]){
    const claim={schema:"estampes.temporary-claim/1",claimId,owner:owner(randomUUID()),finalPath:"visual-registry/CURRENT.json",temporaryPath:"visual-registry/CURRENT.json.tmp-"+claimId,hash:"a".repeat(64),bytes:1,label:"conflict"};
    await files.durableCreate("visual-temporaries/claims/"+claimId+".json",Buffer.from(canonicalJson(claim)),"test-claim");
  }
  await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");
});
