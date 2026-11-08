import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { lifecycleFixture,document,command,actor,epoch,titleEdit } from "./fixtures/uva-lifecycle.mjs";
import { loadCommitted } from "../src/persistence/records.js";
import { ManagedFiles } from "../src/persistence/filesystem.js";
import { readVersion } from "../src/persistence/archive.js";
import { RECLAIM_EVERY } from "../src/persistence/coordinator.js";

const pages=async root=>(await readdir(join(root,"visual-registry/pages"))).length+(await readdir(join(root,"visual-registry/roots"))).length;
async function history(f,n,from=null){
 let d=from,acks=[];if(!d){d=document();acks.push(await f.store.commit(command([d]),actor(),await epoch(f.store)));}
 for(let i=0;acks.length<n||(from&&i<n);i++){const r=d.revision+1;d=titleEdit(d);d.title="version "+r;acks.push(await f.store.commit(command([d],r,r-1),actor(),await epoch(f.store)));if(from&&acks.length>=n)break;}
 return {d,acks};
}

test("reclamation: unreachable index pages are removed; current, recovery points, checkpoints and every version stay readable",async t=>{
 const f=await lifecycleFixture(t);
 const first=await history(f,3),acks=first.acks;await f.store.maintenance("checkpoint",{name:"keep"});
 const more=await history(f,26,first.d);
 const before=await pages(f.root),result=await f.store.maintenance("reclaimPages",{});
 assert.ok(result.reclaimed>0,"something was unreachable");assert.equal(await pages(f.root),before-result.reclaimed);
 assert.equal((await f.store.maintenance("reclaimPages",{})).reclaimed,0,"a second sweep finds nothing");
 // Full history verification (every version, retained root, ACK registry) still passes.
 assert.equal((await f.store.maintenance("verify")).verified,true);
 const files=new ManagedFiles(f.root),snapshot=await loadCommitted(files);
 for(const answer of [...acks,...more.acks])for(const ref of answer.ack.revisionVector)assert.ok(await readVersion(files,ref,snapshot.indices.locator));
 const pin=await f.store.maintenance("pin",{registryRootHash:[...snapshot.indices.retention].find(([k])=>k.startsWith("checkpoint:"))[1].registryRootHash});
 assert.equal((await f.store.maintenance("readPin",{id:pin.id})).length,1);await f.store.maintenance("releasePin",{id:pin.id});
 await f.reopen();assert.equal(f.store.status.state,"ready");
 assert.equal((await history(f,1,more.d)).acks.length,1);
});

test("reclamation runs on its own every RECLAIM_EVERY commits without failing them",async t=>{
 const f=await lifecycleFixture(t);
 await history(f,RECLAIM_EVERY+1);
 const reclaim=(await f.store.diagnostics()).reclaim;
 assert.ok(reclaim&&reclaim.reclaimed>0,JSON.stringify(reclaim));assert.equal((await f.store.diagnostics()).state,"ready");
 assert.equal((await f.store.maintenance("verify")).verified,true);
});

test("reclamation is interruptible: a kill between unlinks leaves a store that opens and sweeps again",async t=>{
 const f=await lifecycleFixture(t);await history(f,26);
 const before=await pages(f.root);
 await f.reopen({fault:{point:"reclaim.before-unlink",mode:"throw",code:"EIO",nth:3}});
 await assert.rejects(f.store.maintenance("reclaimPages",{}));
 await f.reopen();assert.equal(f.store.status.state,"ready");
 const after=await f.store.maintenance("reclaimPages",{});assert.ok(after.reclaimed>0);assert.ok(await pages(f.root)<before);
 assert.equal((await f.store.maintenance("verify")).verified,true);
});
