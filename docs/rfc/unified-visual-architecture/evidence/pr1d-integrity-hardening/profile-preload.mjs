// Opt-in observation of a disposable worker. No profile or storage decision overrides.
import {Session} from 'node:inspector/promises';
import {PerformanceObserver,performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
if(process.env.PR1D_PROFILE_LABEL&&process.argv[1]?.endsWith('/persistence/worker.js')){
 const {ManagedFiles}=await import(pathToFileURL(join(process.env.PR1D_CODE_ROOT??process.cwd(),'src/persistence/filesystem.js')));
 const io={};for(const name of ['bytes','json','info','digest']){const original=ManagedFiles.prototype[name];ManagedFiles.prototype[name]=async function(...args){const key=name+':'+String(args[0]).split('/')[0],start=performance.now();try{return await original.apply(this,args);}finally{const row=io[key]??={calls:0,totalMs:0};row.calls++;row.totalMs+=performance.now()-start;}};}
 const session=new Session();session.connect();const memory=[],gc=[];const started=performance.now();
 const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())gc.push({duration:e.duration,kind:e.detail?.kind});});observer.observe({entryTypes:['gc']});
 const timer=setInterval(()=>memory.push({...process.memoryUsage(),ms:performance.now()-started}),100);timer.unref();
 await session.post('Profiler.enable');await session.post('Profiler.start');
 await session.post('HeapProfiler.startSampling',{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
 process.once('SIGUSR2',async()=>{
  clearInterval(timer);const cpu=await session.post('Profiler.stop'),heap=await session.post('HeapProfiler.stopSampling');observer.disconnect();
  const base=new URL('./'+process.env.PR1D_PROFILE_LABEL,import.meta.url);
  for(const [suffix,value]of [['cpuprofile',cpu.profile],['heapprofile',heap.profile],['observation.json',{io,memory,gc,encodingCounts:globalThis.__pr1dEncodingCounts,cpu:process.cpuUsage(),resource:process.resourceUsage()}]])await writeFile(new URL(base.href+'.'+suffix),JSON.stringify(value));
  session.disconnect();await writeFile(new URL(base.href+'.done'),'complete\n');
 });
}
