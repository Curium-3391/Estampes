// Automatic history compaction (lifecycle option autoCompaction). What no
// retained root needs is retired: Locator rows outside every retained registry
// and its delta chains, memberships and Ledger tombstones below the horizon and
// outside the ACK window, journal proofs and finished GC records. The files only
// that history reached leave through GC quarantine and the G2 grace.
import test from "node:test";
import assert from "node:assert/strict";
import {readdir} from "node:fs/promises";
import {join} from "node:path";
import {ManagedFiles} from "../src/persistence/filesystem.js";
import {loadCommitted} from "../src/persistence/records.js";
import {lifecycleFixture, document, titleEdit, command, actor, epoch, TIME, DAY} from "./fixtures/uva-lifecycle.mjs";

// Scheduled units are off here (no idle units, no inline units) so each test
// decides when compaction runs.
const lifecycle={lifecycle:{enabled:true,autoMaintenance:false,autoCompaction:true},compactionIdleMs:0,compactionInline:false};
const ready=f=>assert.equal(f.store.status.state,"ready",JSON.stringify(f.store.status.problem));
const count=async dir=>{let n=0;for(const e of await readdir(dir,{withFileTypes:true}).catch(()=>[]))n+=e.isDirectory()?await count(join(dir,e.name)):1;return n;};
const sizes=async f=>{const s=await loadCommitted(new ManagedFiles(f.root));
  return {locator:s.indices.locator.size,ledger:s.indices.ledger.size,commitIndex:s.indices.commitIndex.size,retention:s.indices.retention.size,
    history:await count(join(f.root,"visual-history"))+await count(join(f.root,"visual-documents")),journals:(await readdir(join(f.root,"visual-transactions"))).length};};

async function edits(f,from,to,doc,clock){
  let d=doc;
  for(let n=from;n<=to;n++){
    if(n>1)d={...titleEdit(d),title:"edit "+n};
    await f.store.commit(command([d],n,n===1?null:n-1),actor(n),await epoch(f.store));
    if(clock&&n%clock.every===0){clock.now+=clock.step;await f.store.maintenance("clock",{nowMs:clock.now});}
  }
  return d;
}

test("compaction keeps history bounded by the retained roots, not by the number of commits",async t=>{
  const f=await lifecycleFixture(t,lifecycle),clock={now:TIME,every:10,step:DAY};
  let d=await edits(f,1,70,{...document(),persistence:"memory"},clock);
  for(let i=0;i<3;i++){clock.now+=DAY;await f.store.maintenance("clock",{nowMs:clock.now});await f.store.maintenance("autoCompact");}
  const mid=await sizes(f);
  d=await edits(f,71,140,d,clock);
  for(let i=0;i<3;i++){clock.now+=DAY;await f.store.maintenance("clock",{nowMs:clock.now});await f.store.maintenance("autoCompact");}
  const end=await sizes(f);
  // Twice the commits, the same retained shape.
  for(const k of ["locator","ledger","commitIndex","history","journals"])assert.ok(end[k]<=Math.max(mid[k]*2,mid[k]+16),`${k}: ${mid[k]} -> ${end[k]}`);
  assert.ok(end.locator<=40,JSON.stringify(end));assert.ok(end.commitIndex<=150,JSON.stringify(end));
  const documents=(await f.store.snapshot()).documents;
  assert.equal(documents[0].revision,140);
  assert.equal((await f.store.maintenance("verify")).verified,true);
  await f.reopen({testClockMs:clock.now});ready(f);
  assert.deepEqual((await f.store.snapshot()).documents,documents);
  // A forgotten request cannot apply twice: its expected revision is long gone.
  const old=await f.store.commit(command([{...titleEdit({...document(),persistence:"memory"}),title:"edit 2"}],2,1),actor(2),await epoch(f.store)).catch(e=>e);
  assert.equal(old.code,"CONFLICT");
  assert.deepEqual((await f.store.snapshot()).documents,documents);
  // A request still inside the ACK window replays its ACK.
  const replay=await f.store.commit(command([d],140,139),actor(140),await epoch(f.store));
  assert.equal(replay.replayed,true);
});

// SIGKILL inside each kind of compaction work: an ACK/prune publication, a GC
// quarantine rename, a GC unlink and the journal folder removal. Every reopen
// is ready with the same Documents, verifies, and the next pass completes.
async function killAt(f,point,nth=1){
  await f.store.injectFault({point,mode:"pause",nth});
  let listener,timer;
  const reached=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error("Did not reach "+point)),60000);listener=e=>{if(e.name===point)resolve();};f.store.events.on("stage",listener);});
  const pending=f.store.maintenance("autoCompact").catch(e=>e);
  try{await reached;}finally{clearTimeout(timer);f.store.events.off("stage",listener);f.store.kill("SIGKILL");await f.store.waitForExit();}
  await pending;
}
test("a crash anywhere in compaction leaves a ready store with the same Documents",async t=>{
  const f=await lifecycleFixture(t,lifecycle),clock={now:TIME,every:10,step:DAY};
  let d=await edits(f,1,60,{...document(),persistence:"memory"},clock),n=60;
  for(const [point,nth]of [["after-publication-durable",1],["gc.before-rename",3],["gc.before-unlink",2],["history-prune.before-dir-fsync",1],["after-staged-writes",2]]){
    d=await edits(f,n+1,n+12,d,clock);n+=12;clock.now+=2*DAY;await f.store.maintenance("clock",{nowMs:clock.now});
    const documents=(await f.store.snapshot()).documents;
    await killAt(f,point,nth);
    await f.reopen({testClockMs:clock.now});ready(f);
    assert.deepEqual((await f.store.snapshot()).documents,documents,point);
    try{await f.store.maintenance("autoCompact");}catch(e){throw Error(point+": "+JSON.stringify(e.details??e.message)+" "+JSON.stringify(f.store.status.problem));}
    assert.equal((await f.store.maintenance("verify")).verified,true,point);
    assert.deepEqual((await f.store.snapshot()).documents,documents,point);
  }
});

// A large plan can compact many journals at once; their retention proofs must
// fit one bounded maintenance publication (it once exceeded the 128-page budget
// and fenced the writer). The remaining journals wait for the next plan.
test("a 1024-candidate plan over many old journals stays within the maintenance budget",async t=>{
  const f=await lifecycleFixture(t);
  await edits(f,1,130,{...document(),persistence:"memory"});
  await f.store.maintenance("clock",{nowMs:TIME+8*DAY});
  const plan=await f.store.maintenance("gcPlan",{sweep:true,limit:1024});
  assert.equal(plan.planned,true);ready(f);
  const s=await loadCommitted(new ManagedFiles(f.root)),proofs=[...s.indices.retention.keys()].filter(k=>k.startsWith("journal-"));
  assert.ok(proofs.length>0&&new Set(proofs.map(k=>k)).size<=192,String(proofs.length));
  const second=await f.store.maintenance("gcPlan",{sweep:true,limit:1024});
  assert.equal(second.planned,true,"the remaining journals are planned next");ready(f);
});

// A commit waits for at most one compaction unit, never a whole pass: each
// unit is one piece of work, and units run while the writer is idle.
test("compaction runs one unit at a time, inline under load and while idle",async t=>{
  const f=await lifecycleFixture(t,{...lifecycle,compactionInline:true}),clock={now:TIME,every:10,step:DAY};
  let d=await edits(f,1,60,{...document(),persistence:"memory"},clock);
  clock.now+=2*DAY;await f.store.maintenance("clock",{nowMs:clock.now});
  // Under load (no idle delay), units ran after commits, one at a time.
  const inline=(await f.store.diagnostics()).compaction;
  assert.ok(inline&&inline.units>=1&&!inline.error,JSON.stringify(inline));
  const kinds=new Set(["gc-step","acks","prune","reclaim","gc-plan",null]);
  for(let i=0;i<40;i++){const r=await f.store.maintenance("compactUnit");assert.ok(kinds.has(r.unit),JSON.stringify(r));assert.equal(r.report,undefined);if(!r.unit)break;}
  ready(f);
  // With an idle delay, units run with no commit at all and drain the work.
  await f.reopen({compactionIdleMs:50,testClockMs:clock.now+2*DAY});ready(f);
  d=await edits(f,61,80,d);
  const documents=(await f.store.snapshot()).documents;
  let diag;for(let i=0;i<200;i++){diag=(await f.store.diagnostics()).compaction;if(diag?.unit===null)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(diag?.unit,null,"idle units drained: "+JSON.stringify(diag));
  assert.ok(diag.units>=1,JSON.stringify(diag));ready(f);
  assert.equal((await f.store.maintenance("verify")).verified,true);
  assert.deepEqual((await f.store.snapshot()).documents,documents);
});
