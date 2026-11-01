import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fixture, actor, command, document, richDocument, epoch, titleEdit, id } from "./fixtures/uva-persistence.mjs";
import { embed } from "./fixtures/uva-pr1a.mjs";
import { hashJson, canonicalJson } from "../src/documents/validation.js";
import { readCommittedSnapshot } from "../src/persistence/coordinator.js";
import { ManagedFiles, StagingPlan } from "../src/persistence/filesystem.js";
import { PageStore, pagePath } from "../src/persistence/pages.js";

const code=expected=>e=>e.code===expected;
test("PR-1C immutable generations preserve rich metadata and retry exact ACK across restart",async t=>{
  const f=await fixture(t),d=richDocument(),cmd=command([d]),e=await epoch(f.store),first=await f.store.commit(cmd,actor(),e);
  assert.equal(first.ack.durability,"process-crash-test");assert.equal(first.replayed,false);assert.equal(first.ack.revisionVector.length,1);
  const before=await f.store.snapshot();assert.deepEqual(before.documents,[d]);assert.equal(Object.keys(before.root.roots).length,6);
  const again=await f.store.commit(cmd,actor(2),e);assert.equal(again.replayed,true);assert.deepEqual(again.ack,first.ack);
  await f.reopen();assert.equal(f.store.status.state,"ready");const after=await f.store.snapshot();
  assert.deepEqual(after.documents,[d]);assert.ok(after.authority.epoch>before.authority.epoch);
  const retry=await f.store.commit(cmd,actor(3),e);assert.deepEqual(retry.ack,first.ack);assert.equal((await f.store.diagnostics()).contentCommits,1);
  assert.deepEqual((await readCommittedSnapshot(f.root)).documents,[d]);
});
test("same key with a different canonical payload is rejected before OCC; principal lanes are stable and separate",async t=>{
  const f=await fixture(t),d=document(),cmd=command([d]),e=await epoch(f.store);await f.store.commit(cmd,actor(),e);
  const altered=structuredClone(cmd);altered.changes[0].document.title="different";
  await assert.rejects(f.store.commit(altered,actor(2),e),code("IDEMPOTENCY_MISMATCH"));
  const other=actor(2);other.principal.principalId="owner:other";
  await assert.rejects(f.store.commit(cmd,other,e),code("CONFLICT"));assert.equal((await f.store.diagnostics()).contentCommits,1);
});
test("serialized competing writes use Document OCC and do not expose partial multi-Document changes",async t=>{
  const f=await fixture(t),e=await epoch(f.store),a=document(),b=document(2);
  await f.store.commit(command([a,b]),actor(),e);const fixed=await f.store.snapshot();
  const ca=command([titleEdit(a)],2,1),cb=command([titleEdit(b)],3,1);
  await Promise.all([f.store.commit(ca,actor(),e),f.store.commit(cb,actor(),e)]);
  const updated=await f.store.snapshot();assert.equal(updated.documents.length,2);assert.ok(updated.documents.every(d=>d.revision===2&&d.title==="changed"));
  assert.ok(fixed.documents.every(d=>d.revision===1));assert.notEqual(fixed.envelope.rootHash,updated.envelope.rootHash);
  await assert.rejects(f.store.commit(command([titleEdit(a)],4,1),actor(),e),code("CONFLICT"));
  const partial=command([{...updated.documents[0],revision:3,title:"should rollback"},{...updated.documents[1],revision:3,title:"should rollback"}],5,2);partial.changes[1].expectedRevision=1;
  await assert.rejects(f.store.commit(partial,actor(),e),code("CONFLICT"));assert.deepEqual((await f.store.snapshot()).documents,updated.documents);
});
test("duplicate in-flight requests serialize into one ledger effect and one generation",async t=>{
  const f=await fixture(t),e=await epoch(f.store),cmd=command([document()]);const base=(await f.store.snapshot()).root.generation;
  const results=await Promise.all(Array.from({length:8},(_,i)=>f.store.commit(cmd,actor(i+1),e)));
  assert.equal(results.filter(r=>!r.replayed).length,1);for(const r of results)assert.deepEqual(r.ack,results[0].ack);
  assert.equal((await f.store.snapshot()).root.generation,base+1);assert.equal((await f.store.diagnostics()).contentCommits,1);
});
test("strict complete closure is used before writing an intent; cross-Document embeds can commit atomically",async t=>{
  const f=await fixture(t),e=await epoch(f.store),parent=embed(),child=document(2);
  await assert.rejects(f.store.commit(command([parent]),actor(),e),code("UNRESOLVED_REFERENCE"));
  assert.equal((await readdir(f.root+"/visual-transactions")).length,1); // genesis only
  await f.store.commit(command([parent,child],2),actor(),e);
  assert.deepEqual((await f.store.snapshot()).documents,[parent,child]);await f.reopen();assert.equal(f.store.status.state,"ready");
});
test("read-set revisions/hashes and runtime epoch are checked without rebasing content",async t=>{
  const f=await fixture(t),e=await epoch(f.store),d=document();await f.store.commit(command([d]),actor(),e);
  const cmd=command([titleEdit(d)],2,1);cmd.readSet=[{documentId:d.id,revision:1,contentHash:"b".repeat(64)}];
  await assert.rejects(f.store.commit(cmd,actor(),e),code("CONFLICT"));cmd.readSet[0].contentHash=hashJson(d);
  await f.reopen();await assert.rejects(f.store.commit(cmd,actor(),e),code("STALE_AUTHORITY"));
  await f.store.commit(cmd,actor(2),await epoch(f.store));assert.equal((await f.store.snapshot()).documents[0].revision,2);
});
test("internal snapshots preserve immutable authorship and enforce scene/entity revision axes",async t=>{
  const f=await fixture(t),e=await epoch(f.store),d=richDocument();await f.store.commit(command([d]),actor(),e);
  const changed=structuredClone(d);changed.revision=2;changed.scenes[0].revision=2;changed.scenes[0].annotations[0].revision=2;
  changed.scenes[0].annotations[0].provenance.createdBy={kind:"user",principalId:"forged"};changed.scenes[0].annotations[0].provenance.author="user";
  await assert.rejects(f.store.commit(command([changed],2,1),actor(),e),code("FORBIDDEN"));
  const bad=titleEdit(d);bad.scenes[0].revision=2;await assert.rejects(f.store.commit(command([bad],3,1),actor(),e),code("INTEGRITY_ERROR"));
  assert.deepEqual((await f.store.snapshot()).documents,[d]);
});
test("bounded test admission stops before unlimited generations; ordinary no-op does not bump Document revision",async t=>{
  const f=await fixture(t,{maxContentCommits:2}),e=await epoch(f.store),d=document();await f.store.commit(command([d]),actor(),e);
  const noop=await f.store.commit(command([d],2,1),actor(),e);assert.equal(noop.ack.noChange,true);assert.equal((await f.store.snapshot()).documents[0].revision,1);
  await assert.rejects(f.store.commit(command([titleEdit(d)],3,1),actor(),e),code("STORAGE_UNAVAILABLE"));
});
test("COW index pages are bounded, partitioned, chained, immutable and strictly verified",async t=>{
  const f=await fixture(t);await f.store.close();const files=new ManagedFiles(f.root),plan=new StagingPlan(files),pages=new PageStore(files,plan);
  const large="x".repeat(256*1024),entries=new Map();let bucket;
  for(let i=0;entries.size<18;i++){const key="test:"+i,b=hashJson(key).slice(0,2);bucket??=b;if(b===bucket)entries.set(key,{large});}
  const first=await pages.update(null,"registry",entries);await plan.flush();assert.equal((await new PageStore(files).read(first,"registry")).size,18);
  for(const {bytes}of plan.records.values())assert.ok(bytes.length<=4*1024*1024);
  const plan2=new StagingPlan(files),next=new PageStore(files,plan2),key=entries.keys().next().value;
  const second=await next.update(first,"registry",new Map([[key,{large:"updated"}]]));await plan2.flush();
  assert.notEqual(first,second);assert.deepEqual((await new PageStore(files).read(first,"registry")).get(key),{large});
  await writeFile(files.path(pagePath(second)),"{}");await assert.rejects(new PageStore(files).read(second,"registry"),code("INTEGRITY_ERROR"));
});

test("barrier trace orders intent, staged files, prepared root, CURRENT directory flush and ACK",async t=>{
  const f=await fixture(t);await f.store.commit(command([document()]),actor(),await epoch(f.store));const trace=(await f.store.diagnostics()).trace;
  const start=trace.lastIndexOf("before-intent"),part=trace.slice(start),points=["intent.after-file-fsync","intent.after-dir-fsync","after-intent-durable","staged.after-dir-fsync","after-staged-writes","root.after-dir-fsync","prepared.after-dir-fsync","current.after-rename","current.after-dir-fsync","after-publication-durable","outcome.after-dir-fsync","before-ack"];
  let previous=-1;for(const point of points){const i=part.indexOf(point);assert.ok(i>previous,point);previous=i;}
});

test("future tombstones keep the committed key bound without reapplying or pretending a full ACK remains",async t=>{
  const f=await fixture(t),cmd=command([document()]),result=await f.store.commit(cmd,actor(),await epoch(f.store));
  const {loadCommitted,replayLedgerEntry}=await import("../src/persistence/records.js"),snapshot=await loadCommitted(new ManagedFiles(f.root)),[entry]=snapshot.indices.ledger.values();
  const {key,payloadHash,commitId,resultHash,acceptedAt}=entry,tombstone={kind:"tombstone",record:{key,payloadHash,commitId,resultHash,acceptedAt}};
  assert.deepEqual(replayLedgerEntry(entry,payloadHash).ack,result.ack);
  assert.throws(()=>replayLedgerEntry(tombstone,payloadHash),e=>e.code==="RETRY_WINDOW_EXPIRED");
  assert.throws(()=>replayLedgerEntry(tombstone,"b".repeat(64)),e=>e.code==="IDEMPOTENCY_MISMATCH");
  assert.ok(Buffer.byteLength(canonicalJson(tombstone.record))<=1024);assert.equal((await f.store.diagnostics()).contentCommits,1);
});
