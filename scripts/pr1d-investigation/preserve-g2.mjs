// Fixture teardown support, inert unless explicitly enabled by the bounded runner.
import assert from 'node:assert/strict';
import { access, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertScratchStore, safeInventory } from './scratch.mjs';
import { inspectSelected } from './selected-state.mjs';
export async function preserveG2Failure(root,options){
 if(process.env.PR1D_G2_PRESERVE!=='1')return false;
 await assertScratchStore(root);
 const output=resolve(process.env.PR1D_OUTPUT),marker=join(output,`failure-${basename(root)}.json`);
 try{await access(marker);}catch(e){if(e.code==='ENOENT')return false;throw e;}
 const failure=JSON.parse(await readFile(marker,'utf8'));assert.equal(failure.root,root);
 const bundle=join(output,`preserved-${basename(root)}`);await mkdir(bundle,{mode:0o700});
 async function snapshot(label){
  const inventory=await safeInventory(root,64*1024**2);
  for(const row of inventory.files)row.sha256=createHash('sha256').update(await readFile(join(root,row.path))).digest('hex');
  await writeFile(join(bundle,label+'-inventory.json'),JSON.stringify(inventory,null,2)+'\n');
  await cp(root,join(bundle,label),{recursive:true,errorOnExist:true,force:false,preserveTimestamps:true});
  // Copied inodes are evidence bytes only, never a GC/recovery execution target.
  for(const row of inventory.files){const bytes=await readFile(join(bundle,label,row.path));assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);}
 }
 await snapshot('before');
 try{await writeFile(join(bundle,'selected-before.json'),JSON.stringify(await inspectSelected(root),null,2)+'\n');}
 catch(e){await writeFile(join(bundle,'inspection-error.json'),JSON.stringify({message:e.message,code:e.code}));return true;}
 const command=[process.execPath,fileURLToPath(new URL('./g2-retry.mjs',import.meta.url)),root,failure.id,JSON.stringify({...options,testClockMs:failure.clock.nowMs})];
 const env={...process.env};delete env.PR1D_G2_PRESERVE;
 const child=spawn(command[0],command.slice(1),{env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
 const receipt=await new Promise(resolve=>{
  child.once('error',e=>resolve({spawnError:e.code}));child.once('exit',(exitCode,signal)=>resolve({exitCode,signal}));
 });clearTimeout(timer);
 await writeFile(join(bundle,'retry-receipt.json'),JSON.stringify({command,...receipt,stdout,stderr},null,2)+'\n');
 try{await writeFile(join(bundle,'retry.json'),JSON.stringify(JSON.parse(stdout),null,2)+'\n');}catch{}
 await snapshot('after');return true;
}
