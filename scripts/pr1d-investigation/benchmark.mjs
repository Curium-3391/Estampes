import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { openIsolatedStore } from '../../src/persistence/lease.js';
import { ManagedFiles } from '../../src/persistence/filesystem.js';
import { loadCommitted } from '../../src/persistence/records.js';
import { readVersion } from '../../src/persistence/archive.js';
import { canonicalJson } from '../../src/documents/validation.js';
import { document, command, actor, epoch } from '../../tests/fixtures/uva-persistence.mjs';
const [mode,valueText]=process.argv.slice(2),value=Number(valueText);
assert.ok(mode==='history'?[25,50,100,150].includes(value):mode==='document'&&[1,8,16,32,63.96875].includes(value));
const root=await mkdtemp(join(process.env.PR1D_SCRATCH,'estampes-pr1c-bench-'));
const options={profile:'linux-process-crash-test',purpose:'isolated-pr1c-testing',lifecycle:{enabled:true,autoMaintenance:false}};
const emit=(event,data)=>console.log(JSON.stringify({event,...data}));
let store,closed=false;
async function flushProfile(){if(process.env.PR1D_MEASURE!=='1')return;process.kill(store.pid,'SIGUSR2');const done=join(process.env.PR1D_OUTPUT,`profile-${store.pid}.done`);for(let n=0;n<200;n++){try{await access(done);return;}catch{await new Promise(r=>setTimeout(r,50));}}throw Error('Profile flush timed out');}
async function open(label){const start=performance.now();store=await openIsolatedStore(root,options);closed=false;emit('startup',{label,pid:store.pid,wallMs:performance.now()-start,status:store.status});assert.equal(store.status.state,'ready',JSON.stringify(store.status.problem));}
async function close(){await flushProfile();await store.close();closed=true;}
async function directProbe(){
 const start=performance.now();const child=spawn('/usr/bin/flock',['-n','-E','73','-F',join(root,'WRITER.lock'),process.execPath,fileURLToPath(new URL('./cold-probe.mjs',import.meta.url)),root],{stdio:['ignore','pipe','pipe']});
 let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
 const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));clearTimeout(timer);emit('direct-cold',{...result,wallMs:performance.now()-start,out,err});assert.equal(result.code,0);assert.equal(JSON.parse(out).state,'ready');
}
emit('store',{root,mode,value,instrumented:process.env.PR1D_MEASURE==='1'});
try {
 await open('bootstrap');let d=document();d.persistence='memory';
 if(mode==='document')d.extensions={'benchmark:payload':'x'.repeat(Math.floor(value*1024**2))};
 const count=mode==='history'?value:1,refs=[],latencies=[];let lastCommand,lastAck;
 for(let n=1;n<=count;n++){
  if(n>1)d={...structuredClone(d),revision:n,title:'history revision '+n};
  lastCommand=command([d],n,n===1?null:n-1);const start=performance.now();
  const result=await store.commit(lastCommand,actor(n),await epoch(store));
  const elapsed=performance.now()-start;latencies.push(elapsed);lastAck=result.ack;refs.push(result.ack.revisionVector[0]);
  const diag=await store.diagnostics();emit('commit',{n,wallMs:elapsed,transaction:diag.performance.transactions.at(-1),verification:diag.performance.verification});assert.equal(result.ack.durability,'process-crash-test');
 }
 const usage=await new ManagedFiles(root).usage();emit('warm-summary',{documentJsonBytes:Buffer.byteLength(canonicalJson(d)),usage,latencies});await close();
 await directProbe();
 const start=performance.now();try{await open('cold-client');}catch(e){emit('cold-client-error',{wallMs:performance.now()-start,code:e.code,message:e.message});throw e;}
 const replay=await store.commit(lastCommand,actor(999),await epoch(store));assert.equal(replay.replayed,true);assert.deepEqual(replay.ack,lastAck);await close();
 const verifyStart=performance.now(),files=new ManagedFiles(root),snapshot=await loadCommitted(files);
 for(const ref of refs){const record=await readVersion(files,ref,snapshot.indices.locator);assert.equal(record.document.revision,ref.revision);}
 assert.equal(snapshot.indices.ledger.size,count);emit('verified',{versions:refs.length,ledger:count,wallMs:performance.now()-verifyStart,usage:await files.usage()});
}finally{if(store&&!closed){store.kill('SIGKILL');await store.waitForExit();}}
