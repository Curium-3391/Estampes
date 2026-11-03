// Run only via actual flock on an owned disposable store. No client timeout alteration.
import {CommitCoordinator} from "../../../../../src/persistence/coordinator.js";
import {ManagedFiles} from "../../../../../src/persistence/filesystem.js";
import {inspectPlatform} from "../../../../../src/persistence/platform.js";
import {performance} from "node:perf_hooks";
const cpuBefore=process.resourceUsage();
const started=performance.now(),root=process.argv[2],profile="linux-local-durable";
const owner=new CommitCoordinator(new ManagedFiles(root),await inspectPlatform(root,profile,"isolated-pr1c-testing"));
await owner.open({maxContentCommits:1000,lifecycle:{enabled:true,autoMaintenance:false}});
const cpuAfter=process.resourceUsage();
console.log(JSON.stringify({cpuMs:{user:(cpuAfter.userCPUTime-cpuBefore.userCPUTime)/1000,system:(cpuAfter.systemCPUTime-cpuBefore.systemCPUTime)/1000},elapsedMs:performance.now()-started,maxRSSKiB:process.resourceUsage().maxRSS,verificationProofs:{versions:owner.verification.versions.size,versionPhysicalRows:[...owner.verification.versions.values()].reduce((n,p)=>n+p.paths.length,0),registries:owner.verification.registries.size,registryPhysicalRows:[...owner.verification.registries.values()].reduce((n,p)=>n+p.paths.length,0)},diagnostics:owner.diagnostics()}));
