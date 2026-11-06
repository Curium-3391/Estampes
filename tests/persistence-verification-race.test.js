// Process-crash adaptation of original cache-ack-race-v2; injection marker is required.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedFiles } from "../src/persistence/filesystem.js";
import { loadCommitted, versionPath } from "../src/persistence/records.js";
import { lifecycleFixture, document, command, actor, epoch } from "./fixtures/uva-lifecycle.mjs";

test("verification read race must reject before acknowledging a commit", async t => {
  const f = await lifecycleFixture(t, {profile: "linux-process-crash-test"});
  const first = {...document(1), persistence: "memory"};
  const second = {...document(2), persistence: "memory"};
  const initial = await f.store.commit(command([first]), actor(), await epoch(f.store));
  const path = versionPath(initial.ack.revisionVector[0]), files = new ManagedFiles(f.root);
  process.env.NODE_OPTIONS = "--import=" + fileURLToPath(new URL("./fixtures/verification-read-race.mjs", import.meta.url));
  process.env.PR1D_CACHE_RACE_ROOT = f.root;
  try { await f.reopen(); }
  finally {
    delete process.env.NODE_OPTIONS;
    delete process.env.PR1D_CACHE_RACE_ROOT;
  }
  assert.equal(f.store.status.state, "ready");
  const before = await files.json("visual-registry/CURRENT.json");
  await utimes(files.path(path), new Date(0), new Date(0)); // Force a real read instead of a cache hit.
  await writeFile(join(f.root, "test-read-race-trigger"), path);
  const result = await f.store.commit(command([second], 2), actor(2), await epoch(f.store)).catch(error => ({code: error.code}));
  assert.equal(await readFile(join(f.root, "test-read-race-observed"), "utf8"), path);
  const after = await files.json("visual-registry/CURRENT.json");
  const cold = await loadCommitted(files).catch(error => error);
  await f.reopen();
  t.diagnostic(JSON.stringify({ack: result.ack, error: result.code, before, after, coldError: cold.code, restart: f.store.status.state}));
  assert.equal(cold.code, "INTEGRITY_ERROR");
  assert.equal(f.store.status.state, "read-only-recovery");
  assert.equal(result.code, "RECOVERY_REQUIRED");
  assert.deepEqual(after, before);
});

for(const mode of ['before-open','after-open','in-place','inode-replacement','size','mtime','ctime']){
  test('coherent observation rejects '+mode+' changes and cannot seed a warm proof',async t=>{
    const {mkdtemp,rm,rename,chmod}=await import('node:fs/promises');
    const {tmpdir}=await import('node:os');
    const root=await mkdtemp(join(tmpdir(),'estampes-verification-observation-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const path='record.json',files=new ManagedFiles(root);await writeFile(files.path(path),'{"a":1}');
    const io=files.observation(),originalInfo=io.info.bind(io);let calls=0,injected=false;
    const mutate=async()=>{
      injected=true;
      if(mode==='inode-replacement'||mode==='before-open'||mode==='after-open'){
        await writeFile(files.path('replacement'),'{"a":2}');await rename(files.path('replacement'),files.path(path));
      }else if(mode==='mtime')await utimes(files.path(path),new Date(0),new Date(0));
      else if(mode==='ctime')await chmod(files.path(path),0o400);
      else await writeFile(files.path(path),mode==='size'?'{}':'{"a":2}');
    };
    if(mode==='before-open'||mode==='after-open'){
      io.info=async name=>{
        const inject=name===path&&++calls===(mode==='before-open'?1:2);
        if(inject&&mode==='after-open')await mutate();
        const info=await originalInfo(name);
        if(inject&&mode==='before-open')await mutate();
        return info;
      };
      await assert.rejects(io.json(path),error=>error.code==='INTEGRITY_ERROR');
    }else{
      assert.deepEqual(await io.json(path),{a:1});
      await mutate();
      const {VerificationCache}=await import('../src/persistence/records.js');
      const cache=new VerificationCache();
      await assert.rejects(cache.remember(io,'test',{bytes:7},[path],null),error=>error.code==='INTEGRITY_ERROR');
      assert.equal(cache.versions.size,0);
      assert.equal(cache.proofTotal,0);
    }
    assert.equal(injected,true);
  });
}

test('cold verification shares only hash-checked delta prefixes within a bounded operation',async t=>{
  const f=await lifecycleFixture(t);let d=document();
  for(let n=1;n<=12;n++){
    if(n>1)d={...d,revision:n,title:'prefix '+n};
    await f.store.commit(command([d],n,n===1?null:n-1),actor(n),await epoch(f.store));
  }
  await f.store.close();const metrics={},files=new ManagedFiles(f.root);
  const snapshot=await loadCommitted(files,{metrics});
  assert.deepEqual(snapshot.documents,[d]);
  assert.equal(metrics.verification.versionReconstructions,12);
  assert.equal(metrics.verification.deltaApplications,11);
  assert.ok(metrics.verification.operationPrefixHits>=11);
  const delta=[...snapshot.indices.locator.values()].find(row=>row.kind==='delta');
  const manifest=await files.json('visual-history/deltas/'+delta.manifest+'.json');
  await writeFile(files.path('visual-history/chunks/'+manifest.chunks[0]+'.bin'),'corrupt shared dependency');
  await assert.rejects(loadCommitted(files),error=>error.code==='INTEGRITY_ERROR');
  await f.reopen();assert.equal(f.store.status.state,'read-only-recovery');
});

test('a new verification operation cannot inherit another observation\'s metadata trust',async t=>{
  const {PageStore,pagePath}=await import('../src/persistence/pages.js');
  const f=await lifecycleFixture(t);await f.store.commit(command([document()]),actor(),await epoch(f.store));await f.store.close();
  const files=new ManagedFiles(f.root),scoped=files.observation(),head=await files.json('visual-registry/CURRENT.json');
  const root=await files.json('visual-registry/roots/'+head.rootHash+'.json');
  await new PageStore(scoped).read(root.roots.registry,'registry');
  await writeFile(files.path(pagePath(root.roots.registry)),'{}');
  await assert.rejects(loadCommitted(scoped),error=>error.code==='INTEGRITY_ERROR');
});

test('shared canonical representations still pass the complete strict Document schema gate',async t=>{
  const {StagingPlan}=await import('../src/persistence/filesystem.js');
  const {PageStore}=await import('../src/persistence/pages.js');
  const {storeDocument,readRegistrySnapshot}=await import('../src/persistence/records.js');
  const {hashJson}=await import('../src/documents/validation.js');
  const {randomUUID}=await import('node:crypto');
  const f=await lifecycleFixture(t),files=new ManagedFiles(f.root),snapshot=await loadCommitted(files),record=storeDocument(document());
  record.document.title=123; // valid JSON and stored envelope, invalid Document
  const ref={storeInstanceId:snapshot.root.storeInstanceId,entityId:record.document.id,revision:1,contentHash:hashJson(record)};
  const plan=new StagingPlan(files),pages=new PageStore(files,plan),path=versionPath(ref);
  plan.add(path,record,64*1024**2);
  const registry=await pages.update(null,'registry',new Map([['entity:'+ref.entityId,ref]]));
  const locator=await pages.update(null,'locator',new Map([[hashJson(ref),{kind:'full',logical:ref,relativePath:path,bytes:plan.records.get(path).bytes.length}]]));
  await plan.flush(()=>true,{kind:'transaction',id:randomUUID()});
  await assert.rejects(readRegistrySnapshot(files,registry,locator,ref.storeInstanceId,snapshot.root.generation),error=>error.code==='INVALID_INPUT');
  assert.deepEqual((await loadCommitted(files)).documents,[]);
});
