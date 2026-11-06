import test from "node:test";
import assert from "node:assert/strict";
import { writeFile,stat } from "node:fs/promises";
import { join } from "node:path";
import { lifecycleFixture,document,command,actor,epoch } from "./fixtures/uva-lifecycle.mjs";
import { CapacityManager,DEFAULT_QUOTA,WORK_BYTES } from "../src/persistence/capacity.js";
import { ManagedFiles,StagingPlan } from "../src/persistence/filesystem.js";
import { stageDelta,ARCHIVE_BYTES,MIB } from "../src/persistence/archive.js";
import { hashJson } from "../src/documents/validation.js";
test("UVA-64: actual allocated blocks, outstanding reservations and recovery reserve participate in admission",async t=>{
 const f=await lifecycleFixture(t,{quotaBytes:128*MIB}),files=new ManagedFiles(f.root),capacity=new CapacityManager(files,128*MIB),before=await files.usage();
 await writeFile(join(f.root,"capacity-fixture"),Buffer.alloc(2*MIB,5));const after=await files.usage();assert.ok(after.allocatedBytes>=before.allocatedBytes+2*MIB);assert.equal((await stat(join(f.root,"capacity-fixture"))).blocks*512,2*MIB);
 await capacity.reserve("first",16*MIB);await assert.rejects(capacity.reserve("second",16*MIB),e=>e.code==="STORAGE_UNAVAILABLE");capacity.release("first");await capacity.reserve("second",16*MIB);capacity.release("second");
 await assert.rejects(capacity.reserve("backup-space",1,{reservedJobs:64*MIB}),e=>e.code==="STORAGE_UNAVAILABLE");assert.equal(DEFAULT_QUOTA,10*1024**3);assert.equal(WORK_BYTES,32*MIB);
});
test("UVA-64: quota pressure rejects a real content command before intent and preserves its draft and Root",async t=>{
 const f=await lifecycleFixture(t,{quotaBytes:128*MIB}),files=new ManagedFiles(f.root),fixed=await f.store.snapshot();await writeFile(join(f.root,"capacity-fixture"),Buffer.alloc(33*MIB,7));const cmd=command([document()]),copy=structuredClone(cmd);
 await assert.rejects(f.store.commit(cmd,actor(),await epoch(f.store)),e=>e.code==="STORAGE_UNAVAILABLE");assert.deepEqual(cmd,copy);assert.equal((await f.store.snapshot()).envelope.rootHash,fixed.envelope.rootHash);assert.equal((await f.store.diagnostics()).contentCommits,0);
});
test("UVA-63: real archive threshold chooses a full anchor at 32 MiB without staging an oversized delta",()=>{
 const before={document:{id:"doc:00000001-0000-4000-8000-000000000001",revision:1,title:"a"}},after={document:{...before.document,revision:2,title:"b"}},from={storeInstanceId:"00000001-0000-4000-8000-000000000001",entityId:before.document.id,revision:1,contentHash:hashJson(before)},to={...from,revision:2,contentHash:hashJson(after)},plan=new StagingPlan(null);
 const delta=stageDelta(plan,before,after,from,to,{kind:"delta",deltaBytes:ARCHIVE_BYTES-1,span:999});assert.equal(delta,null);assert.equal(plan.records.size,0);
 const small=new StagingPlan(null),accepted=stageDelta(small,before,after,from,to,{kind:"full"});assert.equal(accepted.kind,"delta");assert.ok(accepted.deltaBytes<ARCHIVE_BYTES);assert.ok(small.bytes<4096);
});
