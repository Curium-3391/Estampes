// Direct coordinator timing, separately leased; does not alter client's deadline.
import { CommitCoordinator } from '../../src/persistence/coordinator.js';
import { ManagedFiles } from '../../src/persistence/filesystem.js';
import { inspectPlatform } from '../../src/persistence/platform.js';
import { performance } from 'node:perf_hooks';
import { assertScratchStore } from './scratch.mjs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
const root=process.argv[2];await assertScratchStore(root);
const platform=await inspectPlatform(root,'linux-process-crash-test','isolated-pr1c-testing');
const owner=new CommitCoordinator(new ManagedFiles(root),platform),start=performance.now(),cpu=process.cpuUsage();
await owner.open({lifecycle:{enabled:true,autoMaintenance:false}});
console.log(JSON.stringify({state:owner.state,problem:owner.problem,wallMs:performance.now()-start,cpuUs:process.cpuUsage(cpu),memory:process.memoryUsage(),maxRSSKiB:process.resourceUsage().maxRSS,performance:owner.diagnostics().performance}));
if(process.env.PR1D_MEASURE==='1'){
 process.kill(process.pid,'SIGUSR2');let saved=false;
 for(let i=0;i<200;i++){try{await access(join(process.env.PR1D_OUTPUT,`profile-${process.pid}.done`));saved=true;break;}catch{await new Promise(r=>setTimeout(r,50));}}if(!saved)throw Error('Profile flush failed');
}
if(owner.state!=='ready')process.exitCode=1;
