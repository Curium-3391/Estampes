import test from "node:test";
import assert from "node:assert/strict";
import { readFile,writeFile,unlink } from "node:fs/promises";
import { join } from "node:path";
import { lifecycleFixture,destination,richDocument,document,command,actor,epoch,titleEdit,TIME,DAY } from "./fixtures/uva-lifecycle.mjs";
import { ManagedFiles } from "../src/persistence/filesystem.js";
import { loadCommitted } from "../src/persistence/records.js";
import { restoreIsolatedBackup,readBackupList } from "../src/persistence/backup.js";
import { openIsolatedStore } from "../src/persistence/lease.js";
async function complete(f,id){for(let i=0;i<100;i++){const r=await f.store.maintenance("backupStep",{id});if(r.state==="complete")return r;}throw new Error("Backup did not complete within test bound");}
const profile="linux-process-crash-test";
test("UVA-50: complete supported backup preserves rich history, bindings, tombstones and namespace; restore stays read-only",async t=>{
 const f=await lifecycleFixture(t),d=richDocument(),cmd=command([d]);await f.store.commit(cmd,actor(),await epoch(f.store));await f.store.commit(command([titleEdit(d)],2,1),actor(),await epoch(f.store));await f.store.maintenance("checkpoint",{name:"save"});await f.store.maintenance("clock",{nowMs:TIME+8*DAY});await f.store.maintenance("ledger");const fixed=await f.store.snapshot(),dest=await destination(t),job=await f.store.maintenance("backupStart",{destination:dest});
 const newer=titleEdit(fixed.documents[0]);newer.title="post backup ACK";await f.store.commit(command([newer],3,2),actor(),await epoch(f.store));await complete(f,job.id);const manifest=JSON.parse(await readFile(join(dest,"backup-manifest.json"),"utf8"));assert.equal(manifest.complete,true);assert.equal(manifest.fullEstampes,false);assert.equal(manifest.binaryAssetsIncluded,false);
 const target=await destination(t,"restore"),r=await restoreIsolatedBackup(dest,target,{profile});assert.equal(r.readOnly,true);assert.equal(r.storeInstanceId,fixed.root.storeInstanceId);const restored=await openIsolatedStore(target,{profile,purpose:"isolated-pr1c-testing"});t.after(()=>restored.close());assert.equal(restored.status.state,"read-only-recovery");assert.deepEqual((await restored.snapshot()).documents,fixed.documents);await assert.rejects(restored.commit(cmd,actor(),1),e=>e.code==="RECOVERY_REQUIRED");const snapshot=await loadCommitted(new ManagedFiles(target));assert.equal(snapshot.indices.ledger.size,2);assert.ok([...snapshot.indices.ledger.values()].every(x=>x.kind==="tombstone"));assert.ok([...snapshot.indices.retention.keys()].some(k=>k.startsWith("checkpoint:")));assert.equal(snapshot.indices.locator.size,2);
 await assert.rejects(restoreIsolatedBackup(dest,f.root,{profile}));assert.equal((await f.store.snapshot()).documents[0].revision,3);
});
test("UVA-50/59: backup ENOSPC cannot publish complete and resumes safely after restart",async t=>{
 const f=await lifecycleFixture(t);await f.store.commit(command([document()]),actor(),await epoch(f.store));const dest=await destination(t),job=await f.store.maintenance("backupStart",{destination:dest});await f.store.injectFault({point:"backup.before-write",mode:"throw",code:"ENOSPC"});await assert.rejects(f.store.maintenance("backupStep",{id:job.id}));await assert.rejects(readFile(join(dest,"backup-manifest.json")),e=>e.code==="ENOENT");await f.reopen();assert.equal(f.store.status.state,"ready");await complete(f,job.id);assert.equal((await loadCommitted(new ManagedFiles(dest))).documents.length,1);
});
test("UVA-50/59: SIGKILL before backup completion leaves an incomplete artifact and resumes",async t=>{
 const f=await lifecycleFixture(t);await f.store.commit(command([document()]),actor(),await epoch(f.store));const dest=await destination(t),job=await f.store.maintenance("backupStart",{destination:dest});let hit;const reached=new Promise(r=>hit=r),listener=e=>{if(e.name==="backup.before-complete")hit();};f.store.events.on("stage",listener);await f.store.injectFault({point:"backup.before-complete",mode:"pause"});const pending=f.store.maintenance("backupStep",{id:job.id}).catch(e=>e);await reached;f.store.kill("SIGKILL");await f.store.waitForExit();await pending;await assert.rejects(readFile(join(dest,"backup-manifest.json")),e=>e.code==="ENOENT");await f.reopen();await complete(f,job.id);
});
test("UVA-50: restore rejects a missing Ledger page and never overwrites an active store",async t=>{
 const f=await lifecycleFixture(t);await f.store.commit(command([document()]),actor(),await epoch(f.store));const dest=await destination(t),job=await f.store.maintenance("backupStart",{destination:dest});await complete(f,job.id);const s=await loadCommitted(new ManagedFiles(dest));await unlink(join(dest,"visual-registry/pages/"+s.root.roots.ledger+".json"));const target=await destination(t,"restore");await assert.rejects(restoreIsolatedBackup(dest,target,{profile}));await assert.rejects(readFile(join(target,"visual-registry/CURRENT.json")),e=>e.code==="ENOENT");
});
test("UVA-50/65: deadline cancellation releases pins and an altered destination token is rejected",async t=>{
 const f=await lifecycleFixture(t);await f.store.commit(command([document()]),actor(),await epoch(f.store));const dest=await destination(t),job=await f.store.maintenance("backupStart",{destination:dest});assert.equal((await f.store.diagnostics()).lifecycle.pins.sessions,1);await f.store.maintenance("clock",{nowMs:TIME+DAY});assert.equal((await f.store.maintenance("backupStep",{id:job.id})).state,"cancelled");assert.equal((await f.store.diagnostics()).lifecycle.pins.sessions,0);await assert.rejects(readFile(join(dest,"backup-manifest.json")),e=>e.code==="ENOENT");
 const other=await destination(t),second=await f.store.maintenance("backupStart",{destination:other});await writeFile(join(other,"backup-owner.json"),"{}");await assert.rejects(f.store.maintenance("backupStep",{id:second.id}));assert.equal((await f.store.diagnostics()).state,"read-only-recovery");
});
test("UVA-50: full Estampes backup and non-empty destinations are explicitly unsupported",async t=>{
 const f=await lifecycleFixture(t),dest=await destination(t);await assert.rejects(f.store.maintenance("backupStart",{destination:dest,scope:"full-estampes"}),e=>e.code==="UNSUPPORTED_TARGET");await writeFile(join(dest,"unrelated-user-file"),"keep");await assert.rejects(f.store.maintenance("backupStart",{destination:dest}));assert.equal(await readFile(join(dest,"unrelated-user-file"),"utf8"),"keep");
});
test("UVA-50/65: renewed backup safely reacquires an expired runtime pin from its durable file closure",async t=>{
 const f=await lifecycleFixture(t);await f.store.commit(command([document()]),actor(),await epoch(f.store));const dest=await destination(t),job=await f.store.maintenance("backupStart",{destination:dest});await f.store.maintenance("clock",{nowMs:TIME+20*60*1000});await f.store.maintenance("backupRenew",{id:job.id});
 await f.store.maintenance("clock",{nowMs:TIME+31*60*1000});await f.store.maintenance("compact");const cmd=command([document(2)],2);await f.store.commit(cmd,actor(),await epoch(f.store));assert.equal((await f.store.diagnostics()).lifecycle.pins.sessions,0);await complete(f,job.id);assert.equal((await loadCommitted(new ManagedFiles(dest))).documents.length,1);
});
