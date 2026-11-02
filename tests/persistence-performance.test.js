import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture, actor, command, document, epoch } from "./fixtures/uva-persistence.mjs";
import { versionPath, VerificationCache } from "../src/persistence/records.js";
import { ManagedFiles } from "../src/persistence/filesystem.js";

test("PR-1D: warm verification reconstructs each new logical version once, not all retained versions twice",async t=>{
  const f=await fixture(t);let d=document();
  for(let n=1;n<=16;n++){
    if(n>1){d=structuredClone(d);d.revision++;d.title="revision "+n;}
    await f.store.commit(command([d],n,n===1?null:n-1),actor(n),await epoch(f.store));
  }
  const diagnostics=await f.store.diagnostics(),verification=diagnostics.performance.verification;
  assert.equal(diagnostics.contentCommits,16);
  assert.equal(diagnostics.performance.transactions.length,17); // genesis plus content commits
  assert.equal(verification.snapshotLoads,17);
  assert.ok(verification.versionReconstructions<=16,JSON.stringify(verification));
  // A non-lifecycle Registry is verified once while current and once after its
  // resolver Locator becomes historical; neither path grows with later commits.
  assert.ok(verification.registryMaterializations<=verification.snapshotLoads*3,JSON.stringify(verification));
  assert.ok(verification.versionHits>verification.versionReconstructions,JSON.stringify(verification));
  assert.ok(verification.proofMetadataBytes<=verification.proofMetadataBudget,JSON.stringify(verification));
  assert.ok(verification.physicalFingerprints>=verification.versionProofs,JSON.stringify(verification));
  for(const transaction of diagnostics.performance.transactions){
    for(const field of ["buildAndPreflightMs","stageAndPrepareMs","candidateVerificationMs","currentPublicationMs","postPublicationMs","totalMs"])
      assert.ok(Number.isFinite(transaction[field])&&transaction[field]>=0,`${field}: ${transaction[field]}`);
  }
});

test("PR-1D native finding M-01: history proofs deduplicate physical fingerprints within the explicit budget",async t=>{
  const f=await fixture(t);let d=document();
  for(let n=1;n<=50;n++){
    if(n>1){d=structuredClone(d);d.revision++;d.title="bounded proof revision "+n;}
    await f.store.commit(command([d],n,n===1?null:n-1),actor(n),await epoch(f.store));
  }
  const verification=(await f.store.diagnostics()).performance.verification;
  assert.ok(verification.proofMetadataBytes<=verification.proofMetadataBudget,JSON.stringify(verification));
  assert.ok(verification.metadataPathsTraversed>0,JSON.stringify(verification));
  assert.ok(verification.physicalFingerprints<=300,JSON.stringify(verification));
});

test("PR-1D native finding M-01: a small proof budget evicts trust and forces later verification",async t=>{
  const root=await mkdtemp(join(tmpdir(),"estampes-proof-budget-"));t.after(()=>rm(root,{recursive:true,force:true}));const files=new ManagedFiles(root),paths=[];
  for(let n=0;n<8;n++){const path="proof/"+n+".json";await files.durableCreate(path,Buffer.from("{}"),"proof-test");paths.push(path);}
  const cache=new VerificationCache({proofBytes:900});
  for(let n=0;n<8;n++)await cache.remember(files,"key-"+n,{bytes:2,n},paths.slice(0,n+1),null);
  assert.ok(cache.proofTotal<=cache.proofBytes);assert.ok(cache.stats.proofEvictions>0);assert.ok(cache.versions.size<8);
  const evicted=await cache.valid(files,"key-0",{bytes:2,n:0},new Set());assert.equal(evicted,false);
});

test("PR-1D: a live generation replacement invalidates the cache and fences the writer",async t=>{
  const f=await fixture(t),d=document(),result=await f.store.commit(command([d]),actor(),await epoch(f.store));
  const ref=result.ack.revisionVector[0];
  await writeFile(join(f.root,versionPath(ref)),"{}");
  const changed=structuredClone(d);changed.title="changed";changed.revision++;
  await assert.rejects(f.store.commit(command([changed],2,1),actor(2),await epoch(f.store)),error=>error.code==="RECOVERY_REQUIRED");
  assert.equal((await f.store.diagnostics()).state,"read-only-recovery");
});
