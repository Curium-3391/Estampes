// Opt-in disposable-worker observation. No source edits or authority/profile overrides.
import {ManagedFiles} from "../../../../../src/persistence/filesystem.js";
import {Session} from "node:inspector/promises";
import {PerformanceObserver,performance} from "node:perf_hooks";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
if(process.env.PR1D_PROFILE_MODE==="1"&&process.argv[1]?.endsWith("/persistence/worker.js")){
 const io={};for(const name of ["bytes","json","info","digest"]){const original=ManagedFiles.prototype[name];ManagedFiles.prototype[name]=async function(...args){const key=name+":"+(String(args[0]).split("/")[0]),start=performance.now();try{return await original.apply(this,args);}finally{const row=io[key]??={calls:0,totalMs:0};row.calls++;row.totalMs+=performance.now()-start;}};}
 const session=new Session();session.connect();const gc=[],memory=[];const started=performance.now();
 const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())gc.push({startTime:e.startTime,duration:e.duration,kind:e.detail?.kind});});observer.observe({entryTypes:["gc"]});
 const timer=setInterval(()=>memory.push({ms:performance.now()-started,...process.memoryUsage(),maxRSSKiB:process.resourceUsage().maxRSS}),100);timer.unref();
 await session.post("Profiler.enable");await session.post("Profiler.start");
 await session.post("HeapProfiler.startSampling",{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
 process.once("SIGUSR2",async()=>{
  clearInterval(timer);const cpu=await session.post("Profiler.stop"),heap=await session.post("HeapProfiler.stopSampling");observer.disconnect();
  const stem=join(process.env.PR1D_ACCEPT_ROOT,"profiles",process.env.PR1D_PROFILE_NAME+"-"+process.pid);
  await writeFile(stem+".cpuprofile",JSON.stringify(cpu.profile));await writeFile(stem+".heapprofile",JSON.stringify(heap.profile));
  await writeFile(stem+".observation.json",JSON.stringify({pid:process.pid,elapsedMs:performance.now()-started,io,gc,memory,encodingCounts:globalThis.__pr1dEncodingCounts,maxRSSKiB:process.resourceUsage().maxRSS,finalMemory:process.memoryUsage()}));
  session.disconnect();await writeFile(stem+".done","complete\n");
 });
}
