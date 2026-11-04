// Called with an owned scratch Store so the same opt-in preload guard applies.
import assert from 'node:assert/strict';
import { canonicalJson, hashJson, assertJson } from '../../src/documents/validation.js';
import { createHash } from 'node:crypto';
import { document, command, actor, epoch } from '../../tests/fixtures/uva-persistence.mjs';
import { openIsolatedStore } from '../../src/persistence/lease.js';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
const root=process.argv[2],d=document();
assert.equal(canonicalJson({z:0,a:[null,false,'x']}),'{"a":[null,false,"x"],"z":0}');
assert.equal(hashJson(d),createHash('sha256').update(canonicalJson(d)).digest('hex'));
for(const input of [NaN,()=>{},new Date(),{get x(){throw Error('must not invoke');}}])assert.throws(()=>assertJson(input),e=>e.code==='INVALID_INPUT');
const store=await openIsolatedStore(root,{profile:'linux-process-crash-test',purpose:'isolated-pr1c-testing',lifecycle:{enabled:true,autoMaintenance:false}});
try{
 const cmd=command([d]),first=await store.commit(cmd,actor(),await epoch(store));
 assert.equal(first.ack.revisionVector[0].revision,1);assert.deepEqual((await store.commit(cmd,actor(2),await epoch(store))).ack,first.ack);
 await assert.rejects(store.commit({...cmd,changes:[{document:{...d,title:'mismatch'},expectedRevision:null}]},actor(3),await epoch(store)),e=>e.code==='IDEMPOTENCY_MISMATCH');
 if(process.env.PR1D_MEASURE==='1'){
  process.kill(store.pid,'SIGUSR2');for(let n=0;n<200;n++){try{await access(join(process.env.PR1D_OUTPUT,`profile-${store.pid}.done`));break;}catch{await new Promise(r=>setTimeout(r,50));}}
 }
 console.log(JSON.stringify({canonicalHash:hashJson(d),ledger:(await store.diagnostics()).contentCommits,parity:'passed'}));
}finally{await store.close();}
if(process.env.PR1D_MEASURE==='1'){process.kill(process.pid,'SIGUSR2');for(let n=0;n<200;n++){try{await access(join(process.env.PR1D_OUTPUT,`profile-${process.pid}.done`));break;}catch{await new Promise(r=>setTimeout(r,50));}}}
