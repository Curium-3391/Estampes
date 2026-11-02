import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, actor, command, document, epoch } from "./fixtures/uva-persistence.mjs";
import { versionPath } from "../src/persistence/records.js";

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
  for(const transaction of diagnostics.performance.transactions){
    for(const field of ["buildAndPreflightMs","stageAndPrepareMs","candidateVerificationMs","currentPublicationMs","postPublicationMs","totalMs"])
      assert.ok(Number.isFinite(transaction[field])&&transaction[field]>=0,`${field}: ${transaction[field]}`);
  }
});

test("PR-1D: a live generation replacement invalidates the cache and fences the writer",async t=>{
  const f=await fixture(t),d=document(),result=await f.store.commit(command([d]),actor(),await epoch(f.store));
  const ref=result.ack.revisionVector[0];
  await writeFile(join(f.root,versionPath(ref)),"{}");
  const changed=structuredClone(d);changed.title="changed";changed.revision++;
  await assert.rejects(f.store.commit(command([changed],2,1),actor(2),await epoch(f.store)),error=>error.code==="RECOVERY_REQUIRED");
  assert.equal((await f.store.diagnostics()).state,"read-only-recovery");
});
