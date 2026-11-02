// Disposable process-crash profile for bounded commit/restart behavior. This is
// not native-filesystem durability evidence and does not establish a release SLA.
import { mkdtemp,rm,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openIsolatedStore } from "../../../../src/persistence/lease.js";
import { document,command,actor,epoch } from "../../../../tests/fixtures/uva-persistence.mjs";
import { ManagedFiles } from "../../../../src/persistence/filesystem.js";
import { loadCommitted } from "../../../../src/persistence/records.js";

const commands=Number(process.argv[2]??100);
if(!Number.isInteger(commands)||commands<1||commands>1000)throw new Error("command count must be 1..1000");
const root=await mkdtemp(join(tmpdir(),"estampes-pr1c-history-")),latencies=[];let store,peakWorkerRssKiB=0;
const sample=async()=>{if(!store)return;try{const status=await readFile(`/proc/${store.pid}/status`,"utf8");peakWorkerRssKiB=Math.max(peakWorkerRssKiB,Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]??0));}catch{}};
try{
  const openStarted=performance.now();store=await openIsolatedStore(root,{profile:"linux-process-crash-test",purpose:"isolated-pr1c-testing",maxContentCommits:1000,lifecycle:{enabled:true,autoMaintenance:false}});const initialOpenMs=performance.now()-openStarted;
  let value=document(),lastCommand;
  for(let n=1;n<=commands;n++){
    if(n>1){value=structuredClone(value);value.revision++;value.title="history revision "+n;}
    lastCommand=command([value],n,n===1?null:n-1);const started=performance.now();await store.commit(lastCommand,actor(n),await epoch(store));latencies.push(performance.now()-started);if(n%10===0)await sample();
  }
  const before=await store.snapshot(),beforeDiagnostics=await store.diagnostics(),files=new ManagedFiles(root),usage=await files.usage();await sample();
  store.kill("SIGKILL");await store.waitForExit();const restartStarted=performance.now();store=await openIsolatedStore(root,{profile:"linux-process-crash-test",purpose:"isolated-pr1c-testing",maxContentCommits:1000,lifecycle:{enabled:true,autoMaintenance:false}});const recoveryOpenMs=performance.now()-restartStarted;
  const after=await store.snapshot(),replay=await store.commit(lastCommand,actor(commands+1),before.authority.epoch),afterDiagnostics=await store.diagnostics(),verified=await loadCommitted(new ManagedFiles(root)),sorted=[...latencies].sort((a,b)=>a-b);
  process.stdout.write(JSON.stringify({node:process.version,profile:"linux-process-crash-test",filesystem:"tmpfs",commands,initialOpenMs,recoveryOpenMs,peakWorkerRssKiB,usage,
    latencyMs:{min:sorted[0],p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],max:sorted.at(-1),total:latencies.reduce((a,b)=>a+b,0)},
    before:{generation:before.root.generation,documents:before.documents.length,performance:beforeDiagnostics.performance},after:{generation:after.root.generation,documents:after.documents.length,performance:afterDiagnostics.performance},
    verifiedGeneration:verified.root.generation,replayed:replay.replayed,contentCommits:afterDiagnostics.contentCommits,limits:"Process-crash tmpfs only; native ext4/XFS power-loss, 10 GiB fill and production SLA remain external gates."},null,2)+"\n");
}finally{if(store){store.kill("SIGKILL");await store.waitForExit();}await rm(root,{recursive:true,force:true});}
