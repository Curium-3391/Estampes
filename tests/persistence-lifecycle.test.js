import test from "node:test";
import assert from "node:assert/strict";
import { readFile,writeFile,open } from "node:fs/promises";
import { join } from "node:path";
import { lifecycleFixture,document,command,actor,epoch,titleEdit,richDocument,drain,TIME,DAY } from "./fixtures/uva-lifecycle.mjs";
import { loadCommitted,storeDocument } from "../src/persistence/records.js";
import { ManagedFiles } from "../src/persistence/filesystem.js";
import { readVersion,makePatch,applyPatch,hashBytes } from "../src/persistence/archive.js";
import { ReaderPins } from "../src/persistence/pins.js";
import { hashJson,canonicalJson } from "../src/documents/validation.js";
const error=code=>e=>e.code===code;

test("UVA-46/63: content deltas preserve logical IDs, original rich history and exact ACKs",async t=>{
 const f=await lifecycleFixture(t),d=richDocument(),first=await f.store.commit(command([d]),actor(),await epoch(f.store)),docs=[d],acks=[first];let current=d;
 for(let i=2;i<=6;i++){current=titleEdit(current);current.title="version "+i;docs.push(current);acks.push(await f.store.commit(command([current],i,i-1),actor(),await epoch(f.store)));}
 const snapshot=await loadCommitted(new ManagedFiles(f.root));assert.equal([...snapshot.indices.locator.values()].filter(r=>r.kind==="delta").length,5);
 for(const [i,expected]of docs.entries()){const ref=acks[i].ack.revisionVector[0];assert.deepEqual(await readVersion(new ManagedFiles(f.root),ref,snapshot.indices.locator),storeDocument(expected));}
 await f.reopen();assert.equal(f.store.status.state,"ready");assert.deepEqual((await f.store.commit(command([d]),actor(3),await epoch(f.store))).ack,first.ack);
});
test("UVA-46/47: verified full-generation replacement is blocked by an old physical reader pin",async t=>{
 const f=await lifecycleFixture(t,{legacy:true});let d=document();for(let i=1;i<=4;i++){if(i>1){d=titleEdit(d);d.title="v"+i;}await f.store.commit(command([d],i,i===1?null:i-1),actor(),await epoch(f.store));}
 const legacy=await loadCommitted(new ManagedFiles(f.root)),historyRefs=[...legacy.indices.locator.values()].map(r=>r.logical);await f.enable();const pin=await f.store.maintenance("pin",{historyRefs}),before=await f.store.maintenance("readPin",{id:pin.id});await drain(f.store);
 const blocked=await f.store.maintenance("gcPlan",{classes:["G1"]});assert.equal(blocked.planned,false);
 assert.deepEqual(await f.store.maintenance("readPin",{id:pin.id}),before);
 await f.store.maintenance("releasePin",{id:pin.id});const plan=await f.store.maintenance("gcPlan",{classes:["G1"]});assert.equal(plan.planned,true);const finished=await f.store.maintenance("gcStep",{id:plan.id});assert.equal(finished.state,"complete");
 await f.reopen();assert.equal(f.store.status.state,"ready");assert.equal((await f.store.snapshot()).documents[0].revision,4);
 const snapshot=await loadCommitted(new ManagedFiles(f.root));for(const row of snapshot.indices.locator.values())assert.equal((await readVersion(new ManagedFiles(f.root),row.logical,snapshot.indices.locator)).document.revision,row.logical.revision);
});
test("UVA-48: seven-day ACKs, tombstones and mismatch survive compaction and restart",async t=>{
 const f=await lifecycleFixture(t),d=document(),cmd=command([d]),first=await f.store.commit(cmd,actor(),await epoch(f.store));
 await f.store.maintenance("clock",{nowMs:TIME+7*DAY-1});await f.store.maintenance("ledger");assert.deepEqual((await f.store.commit(cmd,actor(2),await epoch(f.store))).ack,first.ack);
 await f.store.maintenance("clock",{nowMs:TIME+7*DAY});await f.store.maintenance("ledger");await assert.rejects(f.store.commit(cmd,actor(),await epoch(f.store)),error("RETRY_WINDOW_EXPIRED"));
 const changed=structuredClone(cmd);changed.changes[0].document.title="bad";await assert.rejects(f.store.commit(changed,actor(),await epoch(f.store)),error("IDEMPOTENCY_MISMATCH"));
 await f.reopen({testClockMs:TIME+7*DAY});await assert.rejects(f.store.commit(cmd,actor(),await epoch(f.store)),error("RETRY_WINDOW_EXPIRED"));assert.equal((await f.store.diagnostics()).contentCommits,1);
});
test("clock rollback cannot shorten ACK retention or erase persisted high-water state",async t=>{
 const f=await lifecycleFixture(t),d=document(),cmd=command([d]),first=await f.store.commit(cmd,actor(),await epoch(f.store));
 await f.store.maintenance("clock",{nowMs:TIME+6*DAY});await f.store.maintenance("clock",{nowMs:TIME+DAY});await f.store.maintenance("ledger");
 assert.deepEqual((await f.store.commit(cmd,actor(),await epoch(f.store))).ack,first.ack);
 await f.reopen({testClockMs:TIME+2*DAY});assert.ok(f.store.status.lifecycle.policy.highWaterMs>=TIME+6*DAY);assert.deepEqual((await f.store.commit(cmd,actor(),await epoch(f.store))).ack,first.ack);
});
test("UVA-46: checkpoints survive compaction, archived Documents stay rooted and explicit release is required",async t=>{
 const f=await lifecycleFixture(t),d=document();await f.store.commit(command([d]),actor(),await epoch(f.store));await f.store.maintenance("checkpoint",{name:"before"});
 await assert.rejects(f.store.maintenance("checkpoint",{name:"before"}),error("CONFLICT"));
 const archived={...d,state:"archived",revision:2};await f.store.commit(command([archived],2,1),actor(),await epoch(f.store));await drain(f.store);assert.equal((await f.store.snapshot()).documents[0].state,"archived");
 const r=await loadCommitted(new ManagedFiles(f.root)),cp=[...r.indices.retention].find(([k])=>k.startsWith("checkpoint:"));assert.ok(cp);assert.equal(cp[1].resolverLocatorRootHash,r.root.roots.locator);
 await f.store.maintenance("dropCheckpoint",{name:"before"});assert.equal([... (await loadCommitted(new ManagedFiles(f.root))).indices.retention.keys()].some(k=>k.startsWith("checkpoint:")),false);
});
test("UVA-65: reader limits count the physical hash union, expire no active read and release after quiescence",async t=>{
 const f=await lifecycleFixture(t);await f.store.commit(command([document()]),actor(),await epoch(f.store));
 const files=new ManagedFiles(f.root),path="storage-format.json",pins=new ReaderPins(files,{maxSessions:2,maxBytes:1024**2}),p=await pins.acquire({},[path],TIME,{ttlMs:1000}),size=p.bytes,q=await pins.acquire({},[path],TIME,{ttlMs:1000});
 assert.equal(pins.bytes,size);await assert.rejects(pins.acquire({},[path],TIME),error("LIMIT"));
 let release;const gate=new Promise(r=>release=r);const read=pins.read(p.id,TIME,async(s,io)=>{await gate;return io.json(path);});
 await pins.expire(TIME+2000);assert.equal(pins.sessions.has(p.id),true);assert.equal(pins.sessions.has(q.id),false);
 const closing=pins.release(p.id);assert.equal(pins.sessions.has(p.id),true);release();await read;await closing;assert.equal(pins.bytes,0);
 const small=new ReaderPins(files,{maxBytes:1});await assert.rejects(small.acquire({},[path],TIME),error("LIMIT"));
});
test("multiple concurrent readers remain fixed while writes advance the one authoritative Root",async t=>{
 const f=await lifecycleFixture(t),d=document();await f.store.commit(command([d]),actor(),await epoch(f.store));const a=await f.store.maintenance("pin"),b=await f.store.maintenance("pin");
 const next=titleEdit(d);const results=await Promise.all([f.store.maintenance("readPin",{id:a.id}),f.store.commit(command([next],2,1),actor(),await epoch(f.store)),f.store.maintenance("readPin",{id:b.id})]);
 assert.deepEqual(results[0],[d]);assert.deepEqual(results[2],[d]);assert.deepEqual((await f.store.snapshot()).documents,[next]);await f.store.maintenance("releasePin",{id:a.id});await f.store.maintenance("releasePin",{id:b.id});
});
test("lossless patch handles insert/delete/splice, Unicode and hostile JSON keys without prototype mutation",()=>{
 const before=JSON.parse('{"a":[1,2,3],"__proto__":{"x":1},"text":"繁體"}'),after=JSON.parse('{"a":[1,5,6,3],"__proto__":{"x":2},"other":"🙂"}'),id={storeInstanceId:"00000001-0000-4000-8000-000000000001",entityId:"doc:00000001-0000-4000-8000-000000000001",revision:1,contentHash:hashJson(before)},to={...id,revision:2,contentHash:hashJson(after)};
 const patch=makePatch(before,after,id,to);assert.deepEqual(applyPatch(before,patch),after);assert.equal({}.x,undefined);assert.throws(()=>applyPatch({...before,a:[]},patch),error("INTEGRITY_ERROR"));
});
test("maintenance makes bounded progress under sustained writes and accounts allocated blocks",async t=>{
 const f=await lifecycleFixture(t,{lifecycle:{enabled:true,autoMaintenance:true}});let d=document();for(let i=1;i<=8;i++){if(i>1){d=titleEdit(d);d.title="small "+i;}await f.store.commit(command([d],i,i===1?null:i-1),actor(),await epoch(f.store));}
 await f.store.maintenance("compact");const before=(await f.store.diagnostics()).lifecycle.policy.maintenance.steps;
 d=titleEdit(d);await f.store.commit(command([d],9,8),actor(),await epoch(f.store));const after=(await f.store.diagnostics()).lifecycle.policy.maintenance.steps;assert.ok(after>before);
 const usage=await f.store.maintenance("usage");assert.ok(usage.allocatedBytes>0&&usage.logicalBytes>0);assert.equal((await f.store.snapshot()).documents[0].revision,9);
});
