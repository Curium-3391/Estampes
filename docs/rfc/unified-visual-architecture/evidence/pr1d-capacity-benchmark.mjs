// Disposable real coordinator measurements. Not a production SLA or a native FS substitute.
import { mkdtemp,rm,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openIsolatedStore } from "../../../../src/persistence/lease.js";
import { document,richDocument,command,actor,epoch,id } from "../../../../tests/fixtures/uva-persistence.mjs";
import { ManagedFiles } from "../../../../src/persistence/filesystem.js";
import { loadCommitted } from "../../../../src/persistence/records.js";
import { canonicalJson } from "../../../../src/documents/validation.js";
const results=[];
for(const workload of [{name:"title-edits-128KiB",bytes:128*1024,commands:12},{name:"title-edits-1MiB",bytes:1024**2,commands:8},{name:"title-edits-8MiB",bytes:8*1024**2,commands:4},{name:"handwriting-64-points",strokes:12,commands:8}]){
 const root=await mkdtemp(join(tmpdir(),"estampes-pr1c-benchmark-"));let store,peakRssKiB=0,sampling=false;
 try{
  store=await openIsolatedStore(root,{profile:"linux-process-crash-test",purpose:"isolated-pr1c-testing",lifecycle:{enabled:true,autoMaintenance:true}});
  const sample=async()=>{if(sampling)return;sampling=true;try{const s=await readFile(`/proc/${store.pid}/status`,"utf8");peakRssKiB=Math.max(peakRssKiB,Number(s.match(/^VmHWM:\s+(\d+)/m)?.[1]??0));}catch{}finally{sampling=false;}};
  const timer=setInterval(sample,100);let d=workload.strokes?richDocument():document(),initialBytes=0,naiveSnapshotBytes=0,latencies=[];
  if(workload.bytes)d.extensions={"benchmark:payload":"x".repeat(workload.bytes)};
  try{for(let n=1;n<=workload.commands;n++){
   if(n>1){d=structuredClone(d);d.revision++;d.title="revision "+n;}
   if(workload.strokes){const s=d.scenes[0],template=structuredClone(s.annotations[0]);if(n>1)s.revision++;
    for(let j=0;j<workload.strokes;j++){const annotation={...structuredClone(template),id:id("ann",n*100+j),type:"polyline",geometry:{points:Array.from({length:64},(_,k)=>({x:k,y:n*100+j+k/10}))},revision:1};s.annotations.push(annotation);s.layers[0].content.push({kind:"annotation",id:annotation.id});}}
   const bytes=Buffer.byteLength(canonicalJson(d));initialBytes||=bytes;naiveSnapshotBytes+=bytes;const start=performance.now();await store.commit(command([d],n,n===1?null:n-1),actor(),await epoch(store));latencies.push(performance.now()-start);await sample();
  }}finally{clearInterval(timer);}
  const files=new ManagedFiles(root),s=await loadCommitted(files),usage=await files.usage(),all=[...s.indices.locator.values()],sorted=[...latencies].sort((a,b)=>a-b);
  results.push({...workload,initialBytes,naiveSnapshotBytes,logicalVersions:all.length,fullVersions:all.filter(r=>r.kind==="full").length,deltaVersions:all.filter(r=>r.kind==="delta").length,usage,peakWorkerRssKiB:peakRssKiB,latencyMs:{min:sorted[0],p50:sorted[Math.floor(sorted.length/2)],max:sorted.at(-1)},notes:"Physical allocated usage includes journal and metadata. No native/power-loss or full UVA-64/65 SLA claim."});
  process.stderr.write("Measured "+workload.name+"\n");
 }finally{if(store){store.kill("SIGKILL");await store.waitForExit();}await rm(root,{recursive:true,force:true});}
}
process.stdout.write(JSON.stringify({node:process.version,platform:process.platform,profile:"linux-process-crash-test",temporaryMount:"tmpfs",results,limits:"Small real workloads only. 100k-stroke, 10GiB fill, 64-reader and 1000-command checkpoint capacity gates remain unexecuted."},null,2)+"\n");
