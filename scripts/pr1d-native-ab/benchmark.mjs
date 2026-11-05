// Independent native adaptation of the unchanged investigation workload sequence.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const source=process.env.PR1D_SOURCE;
const imp=p=>import(pathToFileURL(join(source,p)));
const {openIsolatedStore}=await imp('src/persistence/lease.js');
const {ManagedFiles}=await imp('src/persistence/filesystem.js');
const {loadCommitted,storeDocument}=await imp('src/persistence/records.js');
const {readVersion}=await imp('src/persistence/archive.js');
const {canonicalJson}=await imp('src/documents/validation.js');
const {document,command,actor,epoch}=await imp('tests/fixtures/uva-persistence.mjs');
const emit=(event,data)=>console.log(JSON.stringify({event,...data}));
const hash=v=>createHash('sha256').update(v).digest('hex');
const options={profile:'linux-local-durable',purpose:'isolated-pr1c-testing',lifecycle:{enabled:true,autoMaintenance:false}};
if(process.argv[3]==='direct'){
 const root=process.argv[2];
 const {assertScratchStore}=await imp('scripts/pr1d-investigation/scratch.mjs');await assertScratchStore(root);
 const {inspectPlatform}=await imp('src/persistence/platform.js');
 const {CommitCoordinator}=await imp('src/persistence/coordinator.js');
 const owner=new CommitCoordinator(new ManagedFiles(root),await inspectPlatform(root,options.profile,options.purpose));
 const start=performance.now(),cpu=process.cpuUsage();await owner.open({lifecycle:options.lifecycle});
 emit('direct-result',{state:owner.state,problem:owner.problem,wallMs:performance.now()-start,cpuUs:process.cpuUsage(cpu),memory:process.memoryUsage(),maxRSSKiB:process.resourceUsage().maxRSS,performance:owner.diagnostics().performance});
 await flush(process.pid);if(owner.state!=='ready')process.exitCode=1;
}else{
 const [mode,valueText]=process.argv.slice(2),value=Number(valueText);
 assert.ok(mode==='history'?value===100:mode==='document'&&[8,16,32].includes(value));
 const root=await mkdtemp(join(process.env.PR1D_SCRATCH,'estampes-pr1c-native-ab-'));
 let d=document();d.persistence='durable';if(mode==='document')d.extensions={'benchmark:payload':'x'.repeat(value*1024**2)};
 const count=mode==='history'?value:1,inputs=[],refs=[],latencies=[];
 // Deterministic inputs outside every commit interval; retain no extra large copies.
 for(let n=1;n<=count;n++){
  const v=n===1?d:{...d,revision:n,title:'history revision '+n};
  inputs.push({n,documentSha256:hash(canonicalJson(v)),storedSha256:hash(canonicalJson(storeDocument(v))),commandSha256:hash(canonicalJson(command([v],n,n===1?null:n-1)))});
 }
 emit('inputs',{fixture:'uva-persistence document(1), durable, ASCII x; seed=original fixture IDs',mode,value,inputs});
 emit('store',{root,mode,value,instrumented:process.env.PR1D_MEASURE==='1',options});
 let store,closed=true,lastCommand,lastAck;
 const current=async()=>JSON.parse(await readFile(join(root,'visual-registry/CURRENT.json'),'utf8'));
 const cpuOf=async(pid)=>{const s=await readFile(`/proc/${pid}/stat`,'utf8');const f=s.slice(s.lastIndexOf(')')+2).split(' ');return {userTicks:Number(f[11]),systemTicks:Number(f[12])};};
 const mem=async()=>{const s=await readFile(`/proc/${store.pid}/status`,'utf8');return {pid:store.pid,rssKiB:Number(s.match(/^VmRSS:\s+(\d+)/m)?.[1]??0),hwmKiB:Number(s.match(/^VmHWM:\s+(\d+)/m)?.[1]??0)};};
 async function open(label){const start=performance.now();store=await openIsolatedStore(root,options);closed=false;const wallMs=performance.now()-start;emit('startup',{label,pid:store.pid,wallMs,status:store.status,workerCpu:await cpuOf(store.pid),workerMemory:await mem(),selectedCurrent:await current()});assert.equal(store.status.state,'ready',JSON.stringify(store.status.problem));}
 async function close(){await flush(store.pid);await store.close();closed=true;}
 try{
  await open('bootstrap');
  for(let n=1;n<=count;n++){
   if(n>1)d={...structuredClone(d),revision:n,title:'history revision '+n};
   lastCommand=command([d],n,n===1?null:n-1);
   const workerBefore=await cpuOf(store.pid),parentCpu=process.cpuUsage(),start=performance.now();
   const result=await store.commit(lastCommand,actor(n),await epoch(store));
   const wallMs=performance.now()-start,parentCpuUs=process.cpuUsage(parentCpu),workerAfter=await cpuOf(store.pid);
   latencies.push(wallMs);lastAck=result.ack;refs.push(lastAck.revisionVector[0]);
   assert.equal(lastAck.durability,'durable');assert.equal(lastAck.revisionVector[0].contentHash,inputs[n-1].storedSha256);
   const diag=await store.diagnostics();
   emit('commit',{n,wallMs,parentCpuUs,workerCpuTicks:{user:workerAfter.userTicks-workerBefore.userTicks,system:workerAfter.systemTicks-workerBefore.systemTicks},ack:lastAck,transaction:diag.performance.transactions.at(-1),verification:diag.performance.verification,workerMemory:await mem()});
  }
  const warmCurrent=await current();emit('warm-summary',{documentJsonBytes:Buffer.byteLength(canonicalJson(d)),usage:await new ManagedFiles(root).usage(),latencies,workerMemory:await mem(),selectedCurrent:warmCurrent});await close();
  const start=performance.now(),child=spawn('/usr/bin/flock',['-n','-E','73','-F',join(root,'WRITER.lock'),process.execPath,fileURLToPath(import.meta.url),root,'direct'],{stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
  const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));clearTimeout(timer);
  emit('direct-cold',{...result,wallMs:performance.now()-start,out,err});assert.equal(result.code,0);
  const beforeCold=await current();const coldStart=performance.now();
  try{await open('cold-client');}catch(e){emit('cold-client-error',{wallMs:performance.now()-coldStart,code:e.code,message:e.message,deadlineMs:30000,selectedCurrent:await current()});throw e;}
  const afterCold=await current();assert.ok(afterCold.generation>beforeCold.generation);
  const replay=await store.commit(lastCommand,actor(999),await epoch(store));assert.equal(replay.replayed,true);assert.deepEqual(replay.ack,lastAck);emit('replay',{exact:true,ack:replay.ack,selectedCurrent:await current()});await close();
  const verifyStart=performance.now(),files=new ManagedFiles(root),snapshot=await loadCommitted(files),verified=[];
  for(const [i,ref] of refs.entries()){const record=await readVersion(files,ref,snapshot.indices.locator);assert.equal(record.document.revision,ref.revision);const sha256=hash(canonicalJson(record));assert.equal(sha256,inputs[i].storedSha256);verified.push({revision:ref.revision,sha256,representation:snapshot.indices.locator.get(hash(canonicalJson(ref)))});}
  assert.equal(snapshot.indices.ledger.size,count);assert.deepEqual(snapshot.envelope,await current());
  emit('verified',{versions:refs.length,ledger:snapshot.indices.ledger.size,wallMs:performance.now()-verifyStart,usage:await files.usage(),selectedCurrent:snapshot.envelope,hashes:verified,exactAckReplay:true});
 }finally{if(store&&!closed){store.kill('SIGKILL');await store.waitForExit();}}
}
async function flush(pid){
 if(process.env.PR1D_MEASURE!=='1')return;
 process.kill(pid,'SIGUSR2');for(let n=0;n<200;n++){try{await access(join(process.env.PR1D_OUTPUT,`profile-${pid}.done`));return;}catch{await new Promise(r=>setTimeout(r,50));}}throw Error('Profile flush timed out');
}
