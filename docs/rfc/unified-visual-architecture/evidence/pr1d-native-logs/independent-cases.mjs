import test from "node:test";
import {randomUUID} from "node:crypto";
import assert from "node:assert/strict";
import {readFile,readdir,writeFile,unlink,rename} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {lifecycleFixture,document,command,actor,epoch,titleEdit,TIME,DAY} from "../../../../../tests/fixtures/uva-lifecycle.mjs";
import {ManagedFiles} from "../../../../../src/persistence/filesystem.js";
import {loadCommitted} from "../../../../../src/persistence/records.js";
import {canonicalJson} from "../../../../../src/documents/validation.js";
import {openIsolatedStore} from "../../../../../src/persistence/lease.js";
const options={profile:"linux-local-durable",purpose:"isolated-pr1c-testing",lifecycle:{enabled:true,autoMaintenance:false},testClockMs:TIME};
const durable=()=>({...document(),persistence:"durable"});
async function pauseKill(t,f,point,operation){
 let listener,timer;const reached=new Promise((resolve,reject)=>{listener=e=>{if(e.name===point){clearTimeout(timer);f.store.events.off("stage",listener);resolve(e);}};f.store.events.on("stage",listener);timer=setTimeout(()=>reject(Error("Stage not reached: "+point)),20000);});
 t.after(()=>{clearTimeout(timer);f.store.events.off("stage",listener);});
 await f.store.injectFault({point,mode:"pause"});const pending=operation().catch(e=>e);await reached;
 f.store.kill("SIGKILL");await f.store.waitForExit();assert.equal((await pending).code,"RECOVERY_REQUIRED");
 const files=new ManagedFiles(f.root);return await files.exists("visual-temporaries/claims")?Promise.all((await readdir(join(f.root,"visual-temporaries/claims"))).map(n=>files.json("visual-temporaries/claims/"+n))):[];
}
for(const point of ["temporary-claim.after-dir-fsync","staged.before-write","staged.after-file-fsync","staged.before-rename","staged.after-rename","staged.before-dir-fsync","staged.after-dir-fsync","before-ack"])test("native independent SIGKILL / "+point,async t=>{
 const f=await lifecycleFixture(t,options),d=durable(),cmd=command([d]);await pauseKill(t,f,point,async()=>f.store.commit(cmd,actor(),await epoch(f.store)));
 await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
 const published=point==="before-ack";assert.deepEqual((await f.store.snapshot()).documents,published?[d]:[]);
 const result=await f.store.commit(cmd,actor(2),await epoch(f.store));assert.equal(result.replayed,published);assert.equal(result.ack.durability,"durable");
 await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));assert.equal((await f.store.diagnostics()).contentCommits,1);
 assert.deepEqual((await f.store.commit(cmd,actor(3),await epoch(f.store))).ack,result.ack);
});
for(const point of ["gc.before-quarantine","gc.after-rename","gc.after-unlink"])test("native regression: interrupted attributed G2 drain / "+point,async t=>{
 const f=await lifecycleFixture(t,options),d=durable();await f.store.commit(command([d]),actor(),await epoch(f.store));
 const changed=titleEdit(d),claims=await pauseKill(t,f,"staged.before-file-fsync",async()=>f.store.commit(command([changed],2,1),actor(),await epoch(f.store)));assert.equal(claims.length,1);const claim=claims[0];
 await f.reopen();assert.equal(f.store.status.state,"ready");const plan=await f.store.maintenance("gcPlan",{classes:["G2"]});assert.equal(plan.planned,true);
 if(point==="gc.after-unlink"){assert.equal((await f.store.maintenance("gcStep",{id:plan.id})).state,"waiting-grace");await f.store.maintenance("clock",{nowMs:TIME+DAY});}
 await pauseKill(t,f,point,()=>f.store.maintenance("gcStep",{id:plan.id}));await f.reopen({testClockMs:TIME+DAY});assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
 await f.store.maintenance("gcStep",{id:plan.id});await f.store.maintenance("clock",{nowMs:TIME+2*DAY});assert.equal((await f.store.maintenance("gcStep",{id:plan.id})).state,"complete");
 const files=new ManagedFiles(f.root),snapshot=await loadCommitted(files),claimExists=await files.exists("visual-temporaries/claims/"+claim.claimId+".json"),proof=snapshot.indices.retention.get("temporary:"+claim.claimId);
 let nextGcProblem=null;try{await f.store.maintenance("gcPlan",{classes:["G2"]});}catch(e){nextGcProblem={code:e.code,message:e.message};}
 t.diagnostic(JSON.stringify({point,claimExists,staleTemporaryProof:proof??null,documents:snapshot.documents.length,ledger:snapshot.indices.ledger.size,nextGcProblem,writerState:(await f.store.diagnostics()).state}));
 assert.deepEqual(snapshot.documents,[d]);assert.equal(snapshot.indices.ledger.size,1);assert.equal(claimExists,false);
 assert.equal(nextGcProblem,null,"A completed G2 plan must not leave a missing claim that fences subsequent GC");
 assert.equal(proof,undefined,"A committed GC disposition must not be replaced by a dangling startup classification");
 await f.store.maintenance("gcPlan",{classes:["G2"]});await f.reopen({testClockMs:TIME+2*DAY});assert.equal(f.store.status.state,"ready");
});
for(const corruption of ["claim-schema","claim-hash","temporary-bytes","claim-missing","journal-missing"])test("native attribution corruption safely preserves bytes / "+corruption,async t=>{
 const f=await lifecycleFixture(t,options),d=durable();const committed=corruption==="journal-missing";
 const claims=await pauseKill(t,f,committed?"current.after-dir-fsync":"staged.before-file-fsync",async()=>f.store.commit(command([d]),actor(),await epoch(f.store)));const claim=claims[0],claimPath=join(f.root,"visual-temporaries/claims/"+claim.claimId+".json");
 let preserve=claim.temporaryPath;
 if(corruption==="claim-schema")await writeFile(claimPath,"{}");
 if(corruption==="claim-hash")await writeFile(claimPath,canonicalJson({...claim,hash:"e".repeat(64)}));
 if(corruption==="temporary-bytes")await writeFile(join(f.root,claim.temporaryPath),"modified only in disposable fixture");
 if(corruption==="claim-missing")await unlink(claimPath);
 if(corruption==="journal-missing"){await unlink(join(f.root,"visual-transactions/"+claim.owner.id+"/intent.json"));preserve="visual-registry/CURRENT.json";}
 const before=await readFile(join(f.root,preserve));await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");assert.deepEqual(await readFile(join(f.root,preserve)),before);
 await assert.rejects(f.store.commit(command([d]),actor(2),1),e=>e.code==="RECOVERY_REQUIRED");
});
for(const mode of ["classification","history"])test("native SIGKILL inside actual startup "+mode+" read",async t=>{
 const f=await lifecycleFixture(t,options),d=durable();let expected=d;
 if(mode==="classification")await pauseKill(t,f,"staged.before-file-fsync",async()=>f.store.commit(command([d]),actor(),await epoch(f.store)));
 else{await f.store.commit(command([d]),actor(),await epoch(f.store));expected=titleEdit(d);await f.store.commit(command([expected],2,1),actor(),await epoch(f.store));await f.store.close();}
 const saved={NODE_OPTIONS:process.env.NODE_OPTIONS,PR1D_FAULT_ROOT:process.env.PR1D_FAULT_ROOT,PR1D_FAULT_MODE:process.env.PR1D_FAULT_MODE};
 process.env.NODE_OPTIONS="--import="+fileURLToPath(new URL("./fault-preload.mjs",import.meta.url));process.env.PR1D_FAULT_ROOT=f.root;process.env.PR1D_FAULT_MODE=mode;
 try{await assert.rejects(openIsolatedStore(f.root,options),e=>e.code==="RECOVERY_REQUIRED"&&e.details?.diagnostic?.includes("INDEPENDENT_SIGKILL_"+mode));}
 finally{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
 await f.reopen();assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));assert.deepEqual((await f.store.snapshot()).documents,mode==="history"?[expected]:[]);
});

for(const target of ["historical-locator-page","historical-generation"])test("native cache invalidates atomic physical replacement / "+target,async t=>{
 const f=await lifecycleFixture(t,target==="historical-locator-page"?{profile:"linux-local-durable",legacy:true}:options),first=durable();
 const ack=await f.store.commit(command([first]),actor(),await epoch(f.store)),old=await f.store.snapshot();let d=first;
 for(let n=2;n<=3;n++){d=titleEdit(d);d.title="cache revision "+n;await f.store.commit(command([d],n,n-1),actor(n),await epoch(f.store));}
 if(target==="historical-locator-page"){const live=await loadCommitted(new ManagedFiles(f.root));assert.equal(live.indices.retention.get("registry:"+old.root.roots.registry).resolverLocatorRootHash,old.root.roots.locator,"Replacement must target a still-retained resolver, not an obsolete lifecycle locator");}
 const before=await readFile(join(f.root,"visual-registry/CURRENT.json"));
 const ref=ack.ack.revisionVector[0],path=target==="historical-locator-page"?"visual-registry/pages/"+old.root.roots.locator+".json":"visual-documents/"+ref.entityId.slice(4)+"/generations/"+ref.revision+"-"+ref.contentHash+".json";
 const replacement=join(f.root,"independent-replacement");await writeFile(replacement,"{}");await rename(replacement,join(f.root,path));
 const next=titleEdit(d);await assert.rejects(f.store.commit(command([next],4,3),actor(4),await epoch(f.store)),e=>e.code==="RECOVERY_REQUIRED");
 assert.equal((await f.store.diagnostics()).state,"read-only-recovery");assert.deepEqual(await readFile(join(f.root,"visual-registry/CURRENT.json")),before);
 await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");assert.equal(await readFile(join(f.root,path),"utf8"),"{}");
});

test("native reused transaction owner with competing claims fails closed",async t=>{
 const f=await lifecycleFixture(t,options),d=durable();
 const claims=await pauseKill(t,f,"staged.before-file-fsync",async()=>f.store.commit(command([d]),actor(),await epoch(f.store)));assert.equal(claims.length,1);
 const original=claims[0],claimId=randomUUID(),duplicate={...original,claimId,temporaryPath:original.finalPath+".tmp-"+claimId},files=new ManagedFiles(f.root);
 await files.durableCreate("visual-temporaries/claims/"+claimId+".json",Buffer.from(canonicalJson(duplicate)),"independent-owner-reuse");
 const before=await readFile(join(f.root,original.temporaryPath));await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");
 assert.deepEqual(await readFile(join(f.root,original.temporaryPath)),before);assert.equal(await files.exists("visual-temporaries/claims/"+claimId+".json"),true);
});

test("partial native temporary write: owned bytes survive SIGKILL with no false ACK",async t=>{
 const f=await lifecycleFixture(t,options),d=durable();await f.store.close();
 const prior={NODE_OPTIONS:process.env.NODE_OPTIONS,PR1D_FAULT_ROOT:process.env.PR1D_FAULT_ROOT};
 process.env.NODE_OPTIONS="--import="+fileURLToPath(new URL("./partial-write-preload.mjs",import.meta.url));process.env.PR1D_FAULT_ROOT=f.root;
 try{await f.reopen();}finally{for(const [k,v]of Object.entries(prior))if(v===undefined)delete process.env[k];else process.env[k]=v;}
 const head=await readFile(join(f.root,"visual-registry/CURRENT.json"));
 await assert.rejects(f.store.commit(command([d]),actor(),await epoch(f.store)),e=>e.code==="RECOVERY_REQUIRED"&&e.details?.diagnostic?.includes("INDEPENDENT_SIGKILL_PARTIAL_WRITE"));
 const files=new ManagedFiles(f.root),names=await readdir(join(f.root,"visual-temporaries/claims"));assert.equal(names.length,1);
 const claim=await files.json("visual-temporaries/claims/"+names[0]),bytes=await readFile(join(f.root,claim.temporaryPath));assert.ok(bytes.length>0&&bytes.length<claim.bytes);
 assert.deepEqual(await readFile(join(f.root,"visual-registry/CURRENT.json")),head);
 await f.reopen();assert.equal(f.store.status.state,"read-only-recovery");assert.deepEqual(await readFile(join(f.root,claim.temporaryPath)),bytes);assert.deepEqual((await loadCommitted(files)).documents,[]);
});
