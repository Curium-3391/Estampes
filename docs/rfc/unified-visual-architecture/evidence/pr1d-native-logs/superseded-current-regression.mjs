import test from "node:test";
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import {join} from "node:path";
import {lifecycleFixture,document,command,actor,epoch} from "../../../../../tests/fixtures/uva-lifecycle.mjs";
import {ManagedFiles} from "../../../../../src/persistence/filesystem.js";
import {loadCommitted} from "../../../../../src/persistence/records.js";
for(const profile of ["linux-process-crash-test","linux-local-durable"])for(const laterCommit of [false,true])test("independent regression: a completed CURRENT claim survives a second legitimate restart / "+profile+" / laterContent="+laterCommit,async t=>{
 const f=await lifecycleFixture(t,{profile}),d=document();if(profile==="linux-local-durable")d.persistence="durable";
 const cmd=command([d]);let timer,listener;
 const reached=new Promise((resolve,reject)=>{listener=e=>{if(e.name==="current.after-dir-fsync"){clearTimeout(timer);f.store.events.off("stage",listener);resolve();}};f.store.events.on("stage",listener);timer=setTimeout(()=>reject(Error("CURRENT barrier not reached")),20000);});
 t.after(()=>{clearTimeout(timer);f.store.events.off("stage",listener);});
 await f.store.injectFault({point:"current.after-dir-fsync",mode:"pause"});
 const pending=f.store.commit(cmd,actor(),await epoch(f.store)).catch(e=>e);await reached;
 const names=await readdir(join(f.root,"visual-temporaries/claims"));assert.equal(names.length,1);
 const claim=JSON.parse(await readFile(join(f.root,"visual-temporaries/claims",names[0]),"utf8"));assert.equal(claim.finalPath,"visual-registry/CURRENT.json");
 f.store.kill("SIGKILL");await f.store.waitForExit();assert.equal((await pending).code,"RECOVERY_REQUIRED");
 await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
 const proof=(await loadCommitted(new ManagedFiles(f.root))).indices.retention.get("temporary:"+claim.claimId);assert.equal(proof.outcome,"completed");
 const replay=await f.store.commit(cmd,actor(2),await epoch(f.store));assert.equal(replay.replayed,true);assert.equal((await f.store.diagnostics()).contentCommits,1);
 assert.notEqual((await new ManagedFiles(f.root).digest(claim.finalPath)).hash,claim.hash,"Recovery-epoch legitimately superseded CURRENT");
 let expected=d;const expectedEffects=laterCommit?2:1;
 if(laterCommit){expected={...structuredClone(d),revision:2,title:"later valid acknowledged content"};const second=await f.store.commit(command([expected],2,1),actor(3),await epoch(f.store));assert.equal(second.ack.durability,profile==="linux-local-durable"?"durable":"process-crash-test");}
 await f.reopen();
 const current=await loadCommitted(new ManagedFiles(f.root));
 t.diagnostic(JSON.stringify({profile,laterCommit,claimId:claim.claimId,currentGeneration:current.root.generation,currentDocuments:current.documents.length,ledgerEntries:current.indices.ledger.size,status:{state:f.store.status.state,problem:f.store.status.problem}}));
 assert.deepEqual(current.documents,[expected]);assert.equal(current.indices.ledger.size,expectedEffects);
 assert.equal(f.store.status.state,"ready","A classified old CURRENT claim must not fence a later valid CURRENT: "+JSON.stringify(f.store.status.problem));
});
