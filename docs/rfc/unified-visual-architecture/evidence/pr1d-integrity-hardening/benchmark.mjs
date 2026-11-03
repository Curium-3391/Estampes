// Identical workloads for baseline and candidate. New empty JS caches on reopen;
// OS page cache is not dropped. All stores are owned disposable process-crash fixtures.
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const ticks=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}));
const cpu=async pid=>{const raw=await readFile('/proc/'+pid+'/stat','utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);return {userMs:Number(fields[11])*1000/ticks,systemMs:Number(fields[12])*1000/ticks};};
const code=process.env.PR1D_CODE_ROOT??process.cwd();
const mod=p=>import(pathToFileURL(join(code,p)));
const {openIsolatedStore}=await mod('src/persistence/lease.js');
const {document,command,actor,epoch}=await mod('tests/fixtures/uva-persistence.mjs');
const {ManagedFiles}=await mod('src/persistence/filesystem.js');
const {loadCommitted}=await mod('src/persistence/records.js');
const {readVersion}=await mod('src/persistence/archive.js');
const count=Number(process.argv[2]),payload=Number(process.argv[3]??0),label=process.argv[4];
assert.ok(count>0&&count<=1000&&label);
const root=await mkdtemp(join(tmpdir(),'estampes-pr1c-hardening-bench-'));
const options={profile:'linux-process-crash-test',purpose:'isolated-pr1c-testing',maxContentCommits:1000,lifecycle:{enabled:true,autoMaintenance:false}};
let store,timer,peak=0;const times=[],refs=[];
const sample=async()=>{try{const s=await readFile(`/proc/${store.pid}/status`,'utf8');peak=Math.max(peak,Number(s.match(/^VmHWM:\s+(\d+)/m)?.[1]??0));}catch{}};
try{
 store=await openIsolatedStore(root,options);assert.equal(store.status.state,'ready');timer=setInterval(sample,100);
 let d=document();if(payload)d.extensions={'benchmark:payload':'x'.repeat(payload)};
 let last,ack;const started=performance.now();
 for(let n=1;n<=count;n++){
  if(n>1)d={...d,revision:n,title:'history revision '+n};
  last=command([d],n,n===1?null:n-1);const begin=performance.now();ack=await store.commit(last,actor(n),await epoch(store));times.push(performance.now()-begin);refs.push(ack.ack.revisionVector[0]);await sample();
  if(n%25===0)console.error(JSON.stringify({label,commits:n,elapsedMs:performance.now()-started,lastMs:times.at(-1)}));
  assert.ok(performance.now()-started<600000,'Stop after ten minutes, do not increase workload');
 }
 const warm=await store.diagnostics(),warmCpu=await cpu(store.pid);await sample();
 if(process.env.PR1D_PROFILE_LABEL){
  process.kill(store.pid,'SIGUSR2');let done=false;
  for(let n=0;n<400;n++){try{await readFile(new URL('./'+process.env.PR1D_PROFILE_LABEL+'.done',import.meta.url));done=true;break;}catch{await new Promise(r=>setTimeout(r,25));}}
  assert.equal(done,true,'Worker profile completed');
 }
 await store.close();
 let coldMs=null,cold=null,replay=null,coldCpu=null;
 if(process.env.PR1D_PROFILE_WARM_ONLY!=='1'){
  const begin=performance.now();store=await openIsolatedStore(root,options);coldMs=performance.now()-begin;
  assert.equal(store.status.state,'ready',JSON.stringify(store.status.problem));cold=await store.diagnostics();coldCpu=await cpu(store.pid);await sample();
  replay=await store.commit(last,actor(count+1),await epoch(store));assert.equal(replay.replayed,true);assert.deepEqual(replay.ack,ack.ack);assert.equal(cold.contentCommits,count);
 }
 const files=new ManagedFiles(root),snapshot=await loadCommitted(files);assert.deepEqual(snapshot.documents,[d]);
 let verified=0;for(const ref of refs){const record=await readVersion(files,ref,snapshot.indices.locator);assert.equal(record.document.revision,ref.revision);verified++;}
 const sorted=[...times].sort((a,b)=>a-b),result={label,node:process.version,code,profile:options.profile,filesystem:'overlay workspace / tmpfs disposable store (see environment.log)',count,payload,peakWorkerRssKiB:peak,latencyMs:{p50:sorted[Math.floor(count*.5)],p95:sorted[Math.min(count-1,Math.floor(count*.95))],max:sorted.at(-1),total:times.reduce((a,b)=>a+b,0)},coldMs,warmCpu,coldCpu,warm:warm.performance,cold:cold?.performance??null,maintenance:warm.lifecycle?.policy,usage:await files.usage(),verified,exactReplay:replay?.replayed??null};
 await writeFile(new URL('./'+label+'.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{clearInterval(timer);if(store){store.kill();await store.waitForExit();}await rm(root,{recursive:true,force:true});}
