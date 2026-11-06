// External, opt-in diagnostic preload. No hooks execute without the flag.
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { Hash } from 'node:crypto';
import { Session } from 'node:inspector';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { assertScratchStore } from './scratch.mjs';

if (process.env.PR1D_MEASURE === '1' && process.argv[2]?.includes('/estampes-pr1c-')) {
  await assertScratchStore(process.argv[2]);
  const output = process.env.PR1D_OUTPUT;
  const als = new AsyncLocalStorage();
  const advance=(scope,phase)=>{
    if(!scope?.phaseData)return;
    const now=performance.now(),cpu=process.cpuUsage();
    if(scope.phase){const prior=scope.phaseData[scope.phase]??={wallMs:0,userUs:0,systemUs:0,operations:{}};prior.wallMs+=now-scope.phaseStart;prior.userUs+=cpu.user-scope.phaseCpu.user;prior.systemUs+=cpu.system-scope.phaseCpu.system;prior.memory=process.memoryUsage();}
    scope.phase=phase;scope.phaseStart=now;scope.phaseCpu=cpu;
  };
  const add = (key, ms=0, bytes=0) => {
    const scope=als.getStore(); if (!scope) return;
    const row=scope.operations[key]??={calls:0,ms:0,bytes:0};row.calls++;row.ms+=ms;row.bytes+=bytes;
    if(scope.phaseData&&scope.phase){const phase=scope.phaseData[scope.phase]??={wallMs:0,userUs:0,systemUs:0,operations:{}};const r=phase.operations[key]??={calls:0,ms:0,bytes:0};r.calls++;r.ms+=ms;r.bytes+=bytes;}
  };
  globalThis.__pr1dMeasure=(name, original, args)=>{
    const start=performance.now();let result;
    try {result=original(...args);return result;}
    finally {add(name,performance.now()-start,name==='canonicalJson'&&typeof result==='string'?Buffer.byteLength(result):0);}
  };
  await import('./measure-hooks.mjs');
  const hashUpdate=Hash.prototype.update;
  Hash.prototype.update=function(data,...rest){const t=performance.now();try{return hashUpdate.call(this,data,...rest);}finally{add('sha256.update',performance.now()-t,typeof data==='string'?Buffer.byteLength(data,rest[0]):data.byteLength);}};
  // Capture all builtin metadata operations, plus actual FD reads and barriers.
  for(const name of ['open','lstat','readdir','statfs','rename','unlink','mkdir']) {
    const original=fs[name];
    fs[name]=async function(...args){const t=performance.now();let result;try{
      result=await original.apply(this,args);
      if(name==='open')for(const method of ['stat','readFile','read','sync','writeFile']){
        const fn=result[method];result[method]=async function(...a){const start=performance.now();let value;try{value=await fn.apply(this,a);return value;}finally{add('fd.'+method,performance.now()-start,method==='readFile'?(value?.byteLength??0):method==='read'?(value?.bytesRead??0):0);}};
      }
      return result;
    }finally{add('fs.'+name,performance.now()-t);}};
  }
  syncBuiltinESMExports();
  const { ManagedFiles }=await import('../../src/persistence/filesystem.js');
  const { PageStore }=await import('../../src/persistence/pages.js');
  const { VerificationCache }=await import('../../src/persistence/records.js');
  const { CommitCoordinator }=await import('../../src/persistence/coordinator.js');
  const { IntentJournal }=await import('../../src/persistence/journal.js');
  const { LifecycleManager }=await import('../../src/persistence/lifecycle.js');
  for(const [klass,names] of [[ManagedFiles,['bytes','json','digest','info','verifyObservations','checkFingerprint','proofIdentity','usage','resync']], [PageStore,['read','hashed','update']], [VerificationCache,['valid','remember','registry','rememberRegistry']], [IntentJournal,['recover']], [LifecycleManager,['admit','reserve']]])
    for(const name of names){const original=klass.prototype[name];klass.prototype[name]=async function(...args){const start=performance.now();try{return await original.apply(this,args);}finally{add(klass.name+'.'+name,performance.now()-start);}};}
  const audit=ManagedFiles.prototype.auditBoundary;
  ManagedFiles.prototype.auditBoundary=async function(...args){const scope=als.getStore();if(scope){scope.audits=(scope.audits??0)+1;if(scope.operation==='commit'||scope.audits===2)advance(scope,'build-preflight');}return audit.apply(this,args);};
  const point=ManagedFiles.prototype.point;
  ManagedFiles.prototype.point=async function(name,...args){const scope=als.getStore();if(scope){const phase={'before-intent':'stage-prepare','after-prepared':'candidate-verification','current.before-write':'current-publication','after-publication-durable':'post-publication'}[name];if(phase)advance(scope,phase);scope.stages[name]=(scope.stages[name]??0)+1;scope.lastStage=name;}return point.call(this,name,...args);};
  let n=0;
  for(const name of ['open','commit']){const original=CommitCoordinator.prototype[name];CommitCoordinator.prototype[name]=async function(...args){
    const row={pid:process.pid,operation:name,ordinal:name==='commit'?++n:0,operations:{},stages:{},...(process.env.PR1D_PHASES==='1'?{phaseData:{}}:{})};advance(row,name==='open'?'cold-before-recovery-publish':'admission');
    const start=performance.now(),cpu=process.cpuUsage();
    return als.run(row,async()=>{try{return await original.apply(this,args);}finally{
      advance(row,null);row.wallMs=performance.now()-start;row.cpuUs=process.cpuUsage(cpu);row.memory=process.memoryUsage();row.maxRSSKiB=process.resourceUsage().maxRSS;
      row.verification={...this.verification.stats};row.transaction=this.performance.transactions.at(-1);row.open=this.performance.open;
      appendFileSync(join(output,`measure-${process.pid}.jsonl`),JSON.stringify(row)+'\n');
    }});
  };}
  const session=new Session();session.connect();
  const post=(name,args={})=>new Promise((resolve,reject)=>session.post(name,args,(e,r)=>e?reject(e):resolve(r)));
  await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:10000});await post('Profiler.start');
  await post('HeapProfiler.enable');await post('HeapProfiler.startSampling',{samplingInterval:1024*1024});
  let saved=false;
  process.on('SIGUSR2',async()=>{if(saved)return;saved=true;try{
    const cpu=await post('Profiler.stop'),heap=await post('HeapProfiler.stopSampling');
    writeFileSync(join(output,`cpu-${process.pid}.json.gz`),gzipSync(JSON.stringify(cpu.profile)));
    writeFileSync(join(output,`heap-${process.pid}.json.gz`),gzipSync(JSON.stringify(heap.profile)));
    writeFileSync(join(output,`profile-${process.pid}.done`),'complete\n');
  }catch(e){writeFileSync(join(output,`profile-${process.pid}.error`),String(e));}finally{session.disconnect();}});
}
