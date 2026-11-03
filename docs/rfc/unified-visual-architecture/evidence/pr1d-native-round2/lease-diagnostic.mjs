// Bounded real-flock contention; no locks are removed or stolen.
import {mkdtemp,rm,readFile,lstat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import assert from "node:assert/strict";
import {openIsolatedStore} from "../../../../../src/persistence/lease.js";
const root=await mkdtemp(join(tmpdir(),"estampes-pr1c-lease-diagnostic-")),options={profile:"linux-local-durable",purpose:"isolated-pr1c-testing"};let writer;
const attempts=Number(process.env.PR1D_DIAGNOSTIC_ATTEMPTS??200),errors=[],counts={};
try{
 writer=await openIsolatedStore(root,options);assert.equal(writer.status.state,"ready");
 const before=await readFile(join(root,"visual-registry/CURRENT.json")),inode=(await lstat(join(root,"WRITER.lock"))).ino;
 for(let n=1;n<=attempts;n++){
  try{const unexpected=await openIsolatedStore(root,options);await unexpected.close();assert.fail("Kernel lease admitted a second writer");}
  catch(e){assert.notEqual(e.code,"ERR_ASSERTION");const key=e.code+":"+(e.details?.exitCode??e.details?.cause??"unknown");counts[key]=(counts[key]??0)+1;
   if(e.code!=="STORAGE_UNAVAILABLE"||e.details?.exitCode!==73)errors.push({attempt:n,code:e.code,message:e.message,details:e.details});}
 }
 assert.deepEqual(await readFile(join(root,"visual-registry/CURRENT.json")),before);assert.equal((await lstat(join(root,"WRITER.lock"))).ino,inode);assert.equal((await writer.diagnostics()).state,"ready");
 const result={attempts,counts,unexpectedTypedErrors:errors,originalWriterRemainsReady:true,currentAndLockUnchanged:true,profile:"linux-local-durable"};
 await writeFile(new URL("./"+(process.env.PR1D_LEASE_TAG??"lease-contention-results")+".json",import.meta.url),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result,null,2));if(errors.length)process.exitCode=1;
}finally{if(writer){writer.kill("SIGKILL");await writer.waitForExit();}await rm(root,{recursive:true,force:true});}
