import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { assertScratchStore, safeInventory } from '../scripts/pr1d-investigation/scratch.mjs';
import { expectedFixtureG2State } from '../scripts/pr1d-investigation/g2-expectation.mjs';
import { preserveG2Failure } from '../scripts/pr1d-investigation/preserve-g2.mjs';
import { openIsolatedStore } from '../src/persistence/lease.js';
import { document, command, actor, epoch } from './fixtures/uva-persistence.mjs';
import { TIME, DAY } from './fixtures/uva-lifecycle.mjs';

// Separate process per test file; environment is restored for normal test discovery.
async function scratch(t){
 const parent=await mkdtemp(join(tmpdir(),'pr1d-preserve-test-'));
 const old={...Object.fromEntries(['PR1D_SCRATCH','PR1D_OUTPUT','PR1D_G2_PRESERVE'].map(k=>[k,process.env[k]]))};
 const out=process.env.PR1D_OUTPUT?join(process.env.PR1D_OUTPUT,basename(parent)):join(parent,'output');await mkdir(out,{mode:0o700});
 process.env.PR1D_SCRATCH=parent;process.env.PR1D_OUTPUT=out;process.env.PR1D_G2_PRESERVE='1';
 t.after(async()=>{for(const [k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await rm(parent,{recursive:true,force:true});});
 return {parent,out};
}
test('evidence guard rejects out-of-scratch, symlink and hardlink candidates',async t=>{
 const {parent}=await scratch(t),root=await mkdtemp(join(parent,'estampes-pr1c-'));
 await assert.rejects(assertScratchStore(parent));
 await writeFile(join(root,'sentinel'),'untouched');
 await symlink(join(root,'sentinel'),join(root,'alias'));
 await assert.rejects(safeInventory(root));assert.equal(await readFile(join(root,'sentinel'),'utf8'),'untouched');
 await rm(join(root,'alias'));const {link}=await import('node:fs/promises');await link(join(root,'sentinel'),join(root,'hardlink'));
 await assert.rejects(safeInventory(root));
 delete process.env.PR1D_G2_PRESERVE;assert.equal(await preserveG2Failure('/untrusted',{}),false);
});
test('opt-in teardown seals stopped selected Store before one restart and same-plan step',async t=>{
 const {parent,out}=await scratch(t),root=await mkdtemp(join(parent,'estampes-pr1c-'));
 const options={profile:'linux-process-crash-test',purpose:'isolated-pr1c-testing',testClockMs:TIME,lifecycle:{enabled:true,autoMaintenance:false}};
 let store=await openIsolatedStore(root,options);t.after(async()=>{store.kill('SIGKILL');await store.waitForExit();});
 // Produce a real G2 plan from an interrupted unpublished content transaction.
 await store.injectFault({point:'after-staged-writes',mode:'pause'});
 const hit=new Promise(resolve=>store.events.on('stage',e=>{if(e.name==='after-staged-writes')resolve();}));
 const pending=store.commit(command([document()]),actor(),await epoch(store)).catch(e=>e);await hit;store.kill('SIGKILL');await store.waitForExit();await pending;
 store=await openIsolatedStore(root,options);assert.equal(store.status.state,'ready');
 const job=await store.maintenance('gcPlan',{classes:['G2']});assert.equal(job.planned,true);
 await store.maintenance('gcStep',{id:job.id});await store.maintenance('clock',{nowMs:TIME+DAY});
 store.kill('SIGKILL');await store.waitForExit();
 const before=await readFile(join(root,'visual-registry/CURRENT.json'));
 // Explicit test trigger exercises preservation independently of the intermittent.
 const marker={root,id:job.id,clock:{nowMs:TIME+DAY},control:'synthetic preservation trigger; no reproduced G2 failure'};
 await writeFile(join(out,`failure-${basename(root)}.json`),JSON.stringify(marker));
 assert.equal(await preserveG2Failure(root,options),true);
 const bundle=join(out,`preserved-${basename(root)}`);
 assert.deepEqual(await readFile(join(bundle,'before/visual-registry/CURRENT.json')),before);
 const retry=JSON.parse(await readFile(join(bundle,'retry.json')));assert.equal(retry.open.state,'ready');assert.equal(retry.step.state,'complete');
 const inventory=JSON.parse(await readFile(join(bundle,'before-inventory.json')));assert.ok(inventory.files.every(f=>f.sha256&&f.dev&&f.ino));
 await access(join(root,'storage-format.json'));assert.notDeepEqual(await readFile(join(root,'visual-registry/CURRENT.json')),before);
});

test('G2 evidence oracle covers both early-grace and terminal assertion failures',()=>{
 const progress={quarantinedAtMs:TIME};
 assert.equal(expectedFixtureG2State(progress,{nowMs:TIME,canAge:true}),'waiting-grace');
 assert.equal(expectedFixtureG2State(progress,{nowMs:TIME+DAY,canAge:true}),'complete');
 assert.equal(expectedFixtureG2State(progress,{nowMs:TIME+DAY,canAge:false}),'waiting-grace');
});
