// Real isolated native ext4 workloads. Profiling results are not uninstrumented SLAs.
import {mkdtemp,rm,readFile,writeFile,access} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {performance} from "node:perf_hooks";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
import {openIsolatedStore} from "../../../../../src/persistence/lease.js";
import {document,richDocument,command,actor,epoch,id} from "../../../../../tests/fixtures/uva-persistence.mjs";
import {ManagedFiles} from "../../../../../src/persistence/filesystem.js";
import {loadCommitted} from "../../../../../src/persistence/records.js";
import {readVersion} from "../../../../../src/persistence/archive.js";
import {canonicalJson} from "../../../../../src/documents/validation.js";
const mode=process.argv[2],count=Number(process.argv[3]??0),profile="linux-local-durable",results=[];
const workloads=mode==="capacity"?[{name:"128KiB",bytes:128*1024,commands:12},{name:"1MiB",bytes:1024**2,commands:8},{name:"8MiB",bytes:8*1024**2,commands:4},{name:"strokes",strokes:12,commands:8}]:mode==="profile8"?[{name:"8MiB-profiled",bytes:8*1024**2,commands:4}]:mode==="8mib"?[{name:"8MiB",bytes:8*1024**2,commands:4}]:[{name:"history-"+count,commands:count,history:true}];
for(const w of workloads){
 const root=await mkdtemp(join(tmpdir(),"estampes-pr1c-independent-")),options={profile,purpose:"isolated-pr1c-testing",maxContentCommits:w.history?1000:100,lifecycle:{enabled:true,autoMaintenance:!w.history}};
 let store,peakWorkerRssKiB=0,sampling=false;const latencies=[],refs=[];let timer;
 const sample=async()=>{if(sampling||!store)return;sampling=true;try{const s=await readFile(`/proc/${store.pid}/status`,"utf8");peakWorkerRssKiB=Math.max(peakWorkerRssKiB,Number(s.match(/^VmHWM:\s+(\d+)/m)?.[1]??0));}catch{}finally{sampling=false;}};
 try{
  process.env.PR1D_PROFILE_NAME=w.name;const opened=performance.now();store=await openIsolatedStore(root,options);assert.equal(store.status.state,"ready",JSON.stringify(store.status.problem));const initialOpenMs=performance.now()-opened;
  timer=setInterval(sample,100);let d=w.strokes?richDocument():document();d.persistence="durable";if(w.bytes)d.extensions={"benchmark:payload":"x".repeat(w.bytes)};
  let lastCommand,initialBytes=0,naiveSnapshotBytes=0;const elapsedStart=performance.now();
  for(let n=1;n<=w.commands;n++){
   if(n>1){d=structuredClone(d);d.revision++;d.title=w.history?"history revision "+n:"revision "+n;}
   if(w.strokes){const s=d.scenes[0],template=structuredClone(s.annotations[0]);if(n>1)s.revision++;
    for(let j=0;j<w.strokes;j++){const annotation={...structuredClone(template),id:id("ann",n*100+j),type:"polyline",geometry:{points:Array.from({length:64},(_,k)=>({x:k,y:n*100+j+k/10}))},revision:1};s.annotations.push(annotation);s.layers[0].content.push({kind:"annotation",id:annotation.id});}}
   const bytes=Buffer.byteLength(canonicalJson(d));initialBytes||=bytes;naiveSnapshotBytes+=bytes;
   lastCommand=command([d],n,n===1?null:n-1);const start=performance.now();const answer=await store.commit(lastCommand,w.history?actor(n):actor(),await epoch(store));latencies.push(performance.now()-start);refs.push(answer.ack.revisionVector[0]);await sample();
   assert.equal(answer.ack.durability,"durable");if(n%10===0)console.error(JSON.stringify({workload:w.name,commits:n,elapsedMs:performance.now()-elapsedStart,lastCommitMs:latencies.at(-1),peakWorkerRssKiB}));
   if(w.history&&performance.now()-elapsedStart>600000)throw Error("Controlled history limit: exceeded ten minutes of commits; stop scaling");
  }
  await sample();clearInterval(timer);const diagnostics=await store.diagnostics(),files=new ManagedFiles(root),usage=await files.usage(),sorted=[...latencies].sort((a,b)=>a-b);
  if(process.env.PR1D_PROFILE_MODE==="1"){
   const done=join(process.env.PR1D_ACCEPT_ROOT,"profiles",w.name+"-"+store.pid+".done");process.kill(store.pid,"SIGUSR2");let complete=false;
   for(let i=0;i<300;i++){try{await access(done);complete=true;break;}catch{await new Promise(r=>setTimeout(r,50));}}assert.ok(complete,"Profiler must finish before worker shutdown");
  }
  let startup=null,replay=null;
  if(w.history){
   await store.close();const probeStart=performance.now();
   const direct=await new Promise(resolve=>{const child=spawn("/usr/bin/flock",["-n","-E","73","-F",join(root,"WRITER.lock"),process.execPath,fileURLToPath(new URL("./recovery-probe.mjs",import.meta.url)),root],{stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);const deadline=setTimeout(()=>child.kill("SIGKILL"),60000);child.on("exit",(code,signal)=>{clearTimeout(deadline);resolve({code,signal,out,err,wallMs:performance.now()-probeStart});});});
   let actual=null;try{actual=JSON.parse(direct.out);}catch{}
   const restartStart=performance.now();let clientError=null;try{store=await openIsolatedStore(root,options);}catch(e){clientError={code:e.code,message:e.message,details:e.details};}
   const clientOpenMs=performance.now()-restartStart;startup={direct:{...direct,out:undefined,result:actual},clientOpenMs,clientError,status:clientError?null:{state:store.status.state,problem:store.status.problem,performance:store.status.performance}};
   if(!clientError&&store.status.state==="ready"){replay=await store.commit(lastCommand,actor(count+1),await epoch(store));assert.equal(replay.replayed,true);assert.equal((await store.diagnostics()).contentCommits,w.commands);}
  }
  const verifyStart=performance.now(),verified=await loadCommitted(files);let reconstructed=0;for(const ref of refs){const record=await readVersion(files,ref,verified.indices.locator);assert.equal(record.document.revision,ref.revision);reconstructed++;}
  const reconstructionPlan={logicalVersions:verified.indices.locator.size,fullVersions:[...verified.indices.locator.values()].filter(r=>r.kind==="full").length,deltaVersions:[...verified.indices.locator.values()].filter(r=>r.kind==="delta").length,maxDeltaSpan:Math.max(0,...[...verified.indices.locator.values()].map(r=>r.span??0)),sumDeltaSpans:[...verified.indices.locator.values()].reduce((n,r)=>n+(r.span??0),0)};
  const result={...w,reconstructionPlan,profile,filesystem:"ext4",instrumented:process.env.PR1D_PROFILE_MODE==="1",initialOpenMs,initialBytes,naiveSnapshotBytes,peakWorkerRssKiB,usage,latencyMs:{p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],max:sorted.at(-1),total:latencies.reduce((a,b)=>a+b,0)},performance:diagnostics.performance,maintenance:diagnostics.lifecycle?.policy?.maintenance,startup,replayed:replay?.replayed??null,verifiedHistoryVersions:reconstructed,coldParentVerifyAndReconstructionMs:performance.now()-verifyStart};
  results.push(result);console.error("Measured "+w.name);
 }finally{clearInterval(timer);if(store){store.kill("SIGKILL");await store.waitForExit();}await rm(root,{recursive:true,force:true});}
}
const output={node:process.version,mode,results,limits:"WSL2 ext4 application/process-crash measurements; no power-loss or deployment SLA; direct leased startup probe does not change the real 30s client timeout."};
await writeFile(fileURLToPath(new URL("./metrics-"+mode+(count?"-"+count:"")+".json",import.meta.url)),JSON.stringify(output,null,2)+"\n");console.log(JSON.stringify(output,null,2));
