import test from 'node:test';
import assert from 'node:assert/strict';
import {lifecycleFixture,destination,document,titleEdit,command,actor,epoch,drain} from '/tmp/estampes-state-machine-baseline/tests/fixtures/uva-lifecycle.mjs';
import {restoreIsolatedBackup} from '/tmp/estampes-state-machine-baseline/src/persistence/backup.js';
import {openIsolatedStore} from '/tmp/estampes-state-machine-baseline/src/persistence/lease.js';
test('active GC physical reservations do not authorize mutations in a relocated read-only backup',async t=>{
 const f=await lifecycleFixture(t,{legacy:true});let d=document();
 for(let n=1;n<=3;n++){if(n>1)d={...titleEdit(d),title:"history "+n};await f.store.commit(command([d],n,n===1?null:n-1),actor(n),await epoch(f.store));}
 await f.enable();await drain(f.store);const gc=await f.store.maintenance('gcPlan',{classes:['G1']});assert.equal(gc.planned,true);
 const before=await f.store.snapshot(),backup=await destination(t),job=await f.store.maintenance('backupStart',{destination:backup});
 let done=false;for(let n=0;n<100;n++){if((await f.store.maintenance('backupStep',{id:job.id})).state==='complete'){done=true;break;}}assert.equal(done,true);
 const target=await destination(t,'restore'),r=await restoreIsolatedBackup(backup,target,{profile:'linux-process-crash-test'});assert.equal(r.readOnly,true);
 const restored=await openIsolatedStore(target,{profile:'linux-process-crash-test',purpose:'isolated-pr1c-testing'});t.after(()=>restored.close());
 t.diagnostic(JSON.stringify(restored.status));assert.equal(restored.status.state,'read-only-recovery');assert.deepEqual((await restored.snapshot()).documents,before.documents);
 await assert.rejects(restored.maintenance('gcStep',{id:gc.id}),e=>e.code==='RECOVERY_REQUIRED');
});
