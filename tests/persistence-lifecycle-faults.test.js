import test from "node:test";
import assert from "node:assert/strict";
import { readFile,writeFile,unlink } from "node:fs/promises";
import { join } from "node:path";
import { lifecycleFixture,document,command,actor,epoch,titleEdit,drain,TIME,DAY } from "./fixtures/uva-lifecycle.mjs";
import { ManagedFiles } from "../src/persistence/filesystem.js";
import { loadCommitted } from "../src/persistence/records.js";
import { gcPlanPath,readGcPlan } from "../src/persistence/gc.js";
import { readVersion } from "../src/persistence/archive.js";

const code=c=>e=>e.code===c;
async function pauseKill(t,f,point,operation){
 let listener,timer;const reached=new Promise((resolve,reject)=>{listener=e=>{if(e.name===point){clearTimeout(timer);f.store.events.off("stage",listener);resolve();}};f.store.events.on("stage",listener);timer=setTimeout(()=>reject(new Error("Fault stage not reached: "+point)),20000);});
 t.after(()=>{clearTimeout(timer);f.store.events.off("stage",listener);});await f.store.injectFault({point,mode:"pause"});const running=operation().catch(e=>e);await reached;f.store.kill("SIGKILL");await f.store.waitForExit();assert.equal((await running).code,"RECOVERY_REQUIRED");
}
async function legacyHistory(t){
 const f=await lifecycleFixture(t,{legacy:true});let d=document();for(let i=1;i<=3;i++){if(i>1){d=titleEdit(d);d.title="v"+i;}await f.store.commit(command([d],i,i===1?null:i-1),actor(),await epoch(f.store));}await f.enable();return f;
}
for(const point of ["gc.before-quarantine","gc.after-rename","gc.after-unlink"]){
 test("UVA-49/59: SIGKILL at "+point+" resumes durable GC without losing a logical version",async t=>{
  const f=await legacyHistory(t);await drain(f.store);const p=await f.store.maintenance("gcPlan",{classes:["G1"]});assert.equal(p.planned,true);
  await pauseKill(t,f,point,()=>f.store.maintenance("gcStep",{id:p.id}));await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
  assert.equal((await f.store.maintenance("gcStep",{id:p.id})).state,"complete");const s=await loadCommitted(new ManagedFiles(f.root));for(const r of s.indices.locator.values())assert.equal((await readVersion(new ManagedFiles(f.root),r.logical,s.indices.locator)).document.revision,r.logical.revision);
 });
}
test("UVA-47: G2 requires terminal proof and a full quarantine day; rollback clock cannot age it",async t=>{
 const f=await lifecycleFixture(t),cmd=command([document()]);await f.store.injectFault({point:"after-staged-writes",mode:"throw",code:"ENOSPC"});await assert.rejects(f.store.commit(cmd,actor(),await epoch(f.store)));await f.reopen();
 const p=await f.store.maintenance("gcPlan",{classes:["G2"]});assert.equal(p.planned,true);assert.equal((await f.store.maintenance("gcStep",{id:p.id})).state,"waiting-grace");
 await f.store.maintenance("clock",{nowMs:TIME-DAY});assert.equal((await f.store.maintenance("gcStep",{id:p.id})).deleted,0);
 await f.store.maintenance("clock",{nowMs:TIME+DAY});assert.equal((await f.store.maintenance("gcStep",{id:p.id})).state,"complete");
 await f.reopen({testClockMs:TIME+DAY});assert.equal(f.store.status.state,"ready");assert.equal((await f.store.snapshot()).documents.length,0);
});
test("UVA-49: corrupt committed GC plan stops maintenance and fences writes",async t=>{
 const f=await legacyHistory(t);await drain(f.store);const p=await f.store.maintenance("gcPlan",{classes:["G1"]}),s=await loadCommitted(new ManagedFiles(f.root)),r=s.indices.retention.get("gc:"+p.id);
 await writeFile(join(f.root,gcPlanPath(r.planHash)),"{}");await assert.rejects(f.store.maintenance("gcStep",{id:p.id}));assert.equal((await f.store.diagnostics()).state,"read-only-recovery");await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");
});
test("UVA-49: corrupt quarantined bytes are never unlinked as verified duplicates",async t=>{
 const f=await legacyHistory(t);await drain(f.store);const p=await f.store.maintenance("gcPlan",{classes:["G1"]});
 await pauseKill(t,f,"gc.after-quarantine",()=>f.store.maintenance("gcStep",{id:p.id}));const files=new ManagedFiles(f.root),s=await loadCommitted(files),r=s.indices.retention.get("gc:"+p.id),plan=await readGcPlan(files,r);
 await writeFile(join(f.root,plan.candidates[0].quarantine),"corrupt");await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");assert.equal(await readFile(join(f.root,plan.candidates[0].quarantine),"utf8"),"corrupt");
});
for(const point of ["current.before-rename","after-publication-durable"]){
 test("UVA-49/63: compaction SIGKILL at "+point+" preserves stable references",async t=>{
  const f=await legacyHistory(t);await f.store.maintenance("compact");const before=await f.store.snapshot();await pauseKill(t,f,point,()=>f.store.maintenance("compact"));await f.reopen();assert.equal(f.store.status.state,"ready");await drain(f.store);assert.deepEqual((await f.store.snapshot()).documents,before.documents);await f.store.maintenance("verify");
 });
}
test("UVA-59: missing archive chunk and corrupt checkpoint envelope fail closed",async t=>{
 const f=await lifecycleFixture(t),d=document();await f.store.commit(command([d]),actor(),await epoch(f.store));await f.store.commit(command([titleEdit(d)],2,1),actor(),await epoch(f.store));const files=new ManagedFiles(f.root),s=await loadCommitted(files),delta=[...s.indices.locator.values()].find(r=>r.kind==="delta"),manifest=await files.json("visual-history/deltas/"+delta.manifest+".json");
 await unlink(join(f.root,"visual-history/chunks/"+manifest.chunks[0]+".bin"));await assert.rejects(f.store.maintenance("verify"));assert.equal((await f.store.diagnostics()).state,"read-only-recovery");await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");
});
test("UVA-59: corrupt named checkpoint Root cannot be ignored by GC",async t=>{
 const f=await lifecycleFixture(t);await f.store.commit(command([document()]),actor(),await epoch(f.store));const head=(await f.store.snapshot()).envelope;await f.store.maintenance("checkpoint",{name:"protected"});await writeFile(join(f.root,"visual-registry/roots/"+head.rootHash+".json"),"{}");await assert.rejects(f.store.maintenance("gcPlan"));assert.equal((await f.store.diagnostics()).state,"read-only-recovery");
});
test("UVA-59: external CURRENT drift never publishes a stale maintenance Root",async t=>{
 const f=await lifecycleFixture(t),old=await readFile(join(f.root,"visual-registry/CURRENT.json"));await f.store.commit(command([document()]),actor(),await epoch(f.store));await writeFile(join(f.root,"visual-registry/CURRENT.json"),old);await assert.rejects(f.store.maintenance("checkpoint",{name:"drift"}));assert.equal((await f.store.diagnostics()).state,"read-only-recovery");assert.deepEqual(await readFile(join(f.root,"visual-registry/CURRENT.json")),old);
});
for(const [action,point]of [["checkpoint","staged.before-write"],["gcStep","gc.before-rename"]])test("UVA-59: ENOSPC during "+action+" yields no false completion and preserves content",async t=>{
 const f=await legacyHistory(t);await drain(f.store);let args={name:"space"};if(action==="gcStep")args={id:(await f.store.maintenance("gcPlan",{classes:["G1"]})).id};const before=(await f.store.snapshot()).documents;await f.store.injectFault({point,mode:"throw",code:"ENOSPC"});await assert.rejects(f.store.maintenance(action,args));await f.reopen();assert.equal(f.store.status.state,"ready");assert.deepEqual((await f.store.snapshot()).documents,before);await f.store.maintenance("verify");
});
test("UVA-48/59: journal compaction retains permanent key binding through quarantine and restart",async t=>{
 const f=await lifecycleFixture(t),cmd=command([document()]);await f.store.commit(cmd,actor(),await epoch(f.store));await f.store.maintenance("clock",{nowMs:TIME+8*DAY});await f.store.maintenance("ledger");const p=await f.store.maintenance("gcPlan",{classes:["G2"]});assert.equal(p.planned,true);await f.store.maintenance("gcStep",{id:p.id});await f.store.maintenance("clock",{nowMs:TIME+9*DAY});assert.equal((await f.store.maintenance("gcStep",{id:p.id})).state,"complete");await f.reopen({testClockMs:TIME+9*DAY});assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));await assert.rejects(f.store.commit(cmd,actor(),await epoch(f.store)),code("RETRY_WINDOW_EXPIRED"));const changed=structuredClone(cmd);changed.changes[0].document.title="wrong";await assert.rejects(f.store.commit(changed,actor(),await epoch(f.store)),code("IDEMPOTENCY_MISMATCH"));assert.equal((await f.store.diagnostics()).contentCommits,1);
});
test("UVA-48/59: live terminal-journal tampering cannot manufacture a GC retention proof",async t=>{
 const f=await lifecycleFixture(t),result=await f.store.commit(command([document()]),actor(),await epoch(f.store)),path=join(f.root,"visual-transactions/"+result.ack.commitId.slice(3)+"/intent.json"),intent=JSON.parse(await readFile(path,"utf8"));intent.payloadHash="e".repeat(64);
 const {canonicalJson}=await import("../src/documents/validation.js");await writeFile(path,canonicalJson(intent));await f.store.maintenance("clock",{nowMs:TIME+8*DAY});await assert.rejects(f.store.maintenance("gcPlan"));assert.equal((await f.store.diagnostics()).state,"read-only-recovery");assert.equal(JSON.parse(await readFile(path,"utf8")).payloadHash,intent.payloadHash);
});
