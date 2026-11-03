import test from "node:test";
import assert from "node:assert/strict";
import {readdir} from "node:fs/promises";
import {openIsolatedStore} from "../../../../../src/persistence/lease.js";
import {ManagedFiles} from "../../../../../src/persistence/filesystem.js";
import {loadCommitted} from "../../../../../src/persistence/records.js";
import {readGcPlan} from "../../../../../src/persistence/gc.js";
import {PageStore} from "../../../../../src/persistence/pages.js";
import {lifecycleFixture,document,command,actor,epoch,TIME,DAY} from "../../../../../tests/fixtures/uva-lifecycle.mjs";

const profile="linux-local-durable";
const options={profile,purpose:"isolated-pr1c-testing",testClockMs:TIME,lifecycle:{enabled:true,autoMaintenance:false}};
const point="current.before-rename";

async function interruptInitial(f,cmd) {
  await f.store.injectFault({point,mode:"pause"});
  let timer, listener;
  const hit=new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(Error("Did not reach initial CURRENT rename")),20000);
    listener=event=>{if(event.name===point)resolve();};
    f.store.events.on("stage",listener);
  });
  const pending=epoch(f.store).then(e=>f.store.commit(cmd,actor(),e)).catch(error=>error);
  try {await hit;}
  finally {
    clearTimeout(timer);
    f.store.events.off("stage",listener);
    f.store.kill("SIGKILL");
    await f.store.waitForExit();
  }
  assert.equal((await pending).code,"RECOVERY_REQUIRED");
}

async function inspect(files,id) {
  const snapshot=await loadCommitted(files);
  const record=snapshot.indices.retention.get("gc:"+id);
  const plan=await readGcPlan(files,record);
  const recoveryPaths=new Set();
  for (const [key,value] of snapshot.indices.retention) {
    if (!(key.startsWith("recovery:") || key.startsWith("checkpoint:")) || !value.envelope)continue;
    const pages=new PageStore(files);
    const root=await pages.hashed(value.envelope.rootHash,"visual-registry/roots",65536);
    for(const [kind,hash] of Object.entries(root.roots))await pages.read(hash,kind);
    for(const p of pages.track)recoveryPaths.add(p);
  }
  const live=new Set(snapshot.files);
  const remaining=[];
  for(const [i,c] of plan.candidates.entries()) {
    if(record.deleted.includes(i))continue;
    remaining.push({i,path:c.path,reason:c.reason,moved:record.moved.includes(i),
      source:await files.exists(c.path),quarantine:await files.exists(c.quarantine),
      selectedClosure:live.has(c.path),recoveryClosure:recoveryPaths.has(c.path)});
  }
  return {generation:snapshot.root.generation,ledger:snapshot.indices.ledger.size,record,remaining};
}

test("bounded native replay of pre-rename crash, four recovery crashes and subsequent G2 drain", async t=>{
  let reproduced=false;
  for(let attempt=1;attempt<=4 && !reproduced;attempt++){
    await t.test("native diagnostic attempt "+attempt, async sub=>{
      const f=await lifecycleFixture(sub,{profile});
      const files=new ManagedFiles(f.root);
      const d={...document(),persistence:"durable"};
      const cmd=command([d]);
      await interruptInitial(f,cmd);
      for(let i=0;i<4;i++){
        let hit=false;
        await assert.rejects(openIsolatedStore(f.root,{...options,fault:{point:"current.after-dir-fsync",mode:"pause"}},event=>{
          if(event.name==="current.after-dir-fsync"){
            hit=true;
            process.kill(event.pid,"SIGKILL");
          }
        }),error=>error.code==="RECOVERY_REQUIRED"&&error.details?.signal==="SIGKILL");
        assert.equal(hit,true);
        assert.equal((await loadCommitted(files)).indices.ledger.size,0);
      }
      assert.equal((await readdir(files.path("visual-temporaries/claims"))).length,5);
      await f.reopen();
      assert.equal(f.store.status.state,"ready");
      const selected=await f.store.commit(cmd,actor(2),await epoch(f.store));
      assert.equal(selected.replayed,false);
      await assert.rejects(f.store.commit(command([{...d,title:"different payload"}]),actor(3),await epoch(f.store)),error=>error.code==="IDEMPOTENCY_MISMATCH");
      await f.reopen();
      assert.equal(f.store.status.state,"ready");
      assert.deepEqual((await f.store.commit(cmd,actor(4),await epoch(f.store))).ack,selected.ack);
      const job=await f.store.maintenance("gcPlan",{classes:["G2"]});
      const step=()=>f.store.maintenance("gcStep",{id:job.id});
      assert.equal(job.planned,true);
      const atPlan=await inspect(files,job.id);
      const first=await step();
      assert.equal(first.state,"waiting-grace");
      await f.store.maintenance("clock",{nowMs:TIME+DAY});
      const before=await inspect(files,job.id);
      const result=await step();
      const after=await inspect(files,job.id);
      reproduced=result.state!=="complete";
      sub.diagnostic(JSON.stringify({attempt,first,result,atPlan:atPlan.remaining.filter(c=>c.selectedClosure||c.recoveryClosure),
        before:before.remaining.filter(c=>!c.moved),after,writer:(await f.store.diagnostics()).state}));
      if(reproduced){
        await f.reopen({testClockMs:TIME+DAY});
        const restart={state:f.store.status.state,problem:f.store.status.problem};
        const again=restart.state==="ready"?await step().catch(e=>({code:e.code,message:e.message})):null;
        sub.diagnostic(JSON.stringify({restart,again,postRestart:await inspect(files,job.id)}));
      }
      assert.equal(result.state,"complete");
    });
  }
});
