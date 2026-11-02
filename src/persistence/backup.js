import { open, readdir, lstat, realpath, statfs } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ManagedFiles } from "./filesystem.js";
import { inspectPlatform, assertOwnedWriterLease } from "./platform.js";
import { hashJson, canonicalJson, parse, ContentHashSchema as Hash } from "../documents/validation.js";
import { CurrentEnvelopeSchema } from "./commit-root-schema.js";
import { loadCommitted } from "./records.js";
import { protectedPaths, gcSourceAllowed } from "./gc.js";
import { integrity, fail, PersistenceError } from "./errors.js";
const MB=1024**2;
const fileSchema=z.object({path:z.string().min(1).max(512),hash:Hash,bytes:z.number().int().min(0)}).strict();
const listSchema=z.object({schema:z.literal("estampes.backup-file-index/1"),pages:z.array(Hash).max(100),fileCount:z.number().int().min(1).max(100000),totalBytes:z.number().int().min(0)}).strict();
const manifestSchema=z.object({schema:z.literal("estampes.unified-document-backup/1"),complete:z.literal(true),scope:z.literal("document-store"),fullEstampes:z.literal(false),binaryAssetsIncluded:z.literal(false),
 source:CurrentEnvelopeSchema,storeInstanceId:z.string().uuid(),filesHash:Hash,createdAtMs:z.number().int().min(0)}).strict();
export const backupListPath=hash=>"visual-maintenance/backup-lists/"+parse(Hash,hash)+".json";
const backupListPage=hash=>"visual-maintenance/backup-list-pages/"+parse(Hash,hash)+".json";
function safeCopyPath(path){return gcSourceAllowed(path)||path==="storage-format.json"||path==="visual-registry/CURRENT.json"||/^visual-maintenance\/(gc|backup-lists|backup-list-pages)\/[0-9a-f]{64}\.json$/.test(path);}
export async function readBackupList(files,hash){
 const raw=await files.json(backupListPath(hash),64*1024);integrity(hashJson(raw)===hash,"Backup file index hash mismatch");const list=parse(listSchema,raw);const paths=[backupListPath(hash)],entries=[];
 for(const h of list.pages){const path=backupListPage(h),page=await files.json(path,4*MB);integrity(hashJson(page)===h&&Array.isArray(page)&&page.length<=1024,"Backup descriptor page integrity mismatch");paths.push(path);for(const raw of page){const f=parse(fileSchema,raw);integrity(safeCopyPath(f.path),"Unsafe backup member path");entries.push(f);}}
 integrity(entries.length===list.fileCount&&new Set(entries.map(f=>f.path)).size===entries.length&&entries.reduce((s,f)=>s+f.bytes,0)===list.totalBytes,"Backup counts/duplicates differ");return {files:entries,paths,totalBytes:list.totalBytes};
}
export class BackupManager {
 constructor(manager){this.manager=manager;this.owner=manager.owner;this.files=this.owner.files;this.runtime=new Map();}
 listPath(hash){return backupListPath(hash);}
 readList(hash){return readBackupList(this.files,hash);}
 async start({destination,scope="document-store"}){
  if(scope!=="document-store")fail("UNSUPPORTED_TARGET","Binary assets and other Estampes stores are not integrated; full Estampes backup is unsupported");
  destination=await realpath(destination);integrity(relative(this.files.root,destination).startsWith(".."),"Backup destination must be outside the active store");
  await inspectPlatform(destination,this.owner.platform.profile,"isolated-pr1c-testing");integrity((await readdir(destination)).length===0,"Backup destination must be explicitly empty");
  const {snapshot,paths}=await protectedPaths(this.owner,{includeTemporary:true}),members=[];
  for(const path of paths){if(path==="WRITER.lock"||path.startsWith("gc-quarantine/"))continue;if(!safeCopyPath(path))fail("UNSUPPORTED_TARGET","Backup closure contains an unsupported member");const info=await this.files.digest(path);members.push({path,hash:info.hash,bytes:info.bytes});}
  // Journal/key lifecycle is part of the supported store, not inferred from age.
  for(const dir of await readdir(this.files.path("visual-transactions")))for(const name of await readdir(this.files.path("visual-transactions/"+dir))){const path="visual-transactions/"+dir+"/"+name;if(!safeCopyPath(path)||members.some(f=>f.path===path))continue;const f=await this.files.digest(path);members.push({path,hash:f.hash,bytes:f.bytes});}
  if(members.length>100000)fail("LIMIT","Backup closure exceeds bounded descriptor capacity");
  members.sort((a,b)=>a.path.localeCompare(b.path));const id=randomUUID(),pin=await this.manager.pins.acquire({envelope:snapshot.envelope},members.filter(f=>f.path!=="visual-registry/CURRENT.json").map(f=>f.path),this.manager.now(),{kind:"backup",ttlMs:30*60*1000});
  try{
   const totalBytes=members.reduce((n,f)=>n+f.bytes,0),space=await statfs(destination,{bigint:true});if(space.bavail*space.bsize<BigInt(totalBytes+64*MB))fail("STORAGE_UNAVAILABLE","Backup destination lacks required copy and reserve space");
   const dest=new ManagedFiles(destination),atomicOwner={kind:"backup",id},token={schema:"estampes.backup-owner/1",id,storeInstanceId:snapshot.root.storeInstanceId};await dest.atomic("backup-owner.json",Buffer.from(canonicalJson(token)),"backup-owner",{owner:atomicOwner});
   await dest.atomic("restore-restriction.json",Buffer.from(canonicalJson({schema:"estampes.restore-restriction/1",continuation:"read-only",reason:"Backup artifact is not an active writer namespace"})),"backup-restriction",{owner:atomicOwner});
   const result=await this.manager.publish("backup-start",async({plan})=>{
    const pages=[];for(let i=0;i<members.length;i+=1024){const page=members.slice(i,i+1024),hash=hashJson(page);plan.add(backupListPage(hash),page,4*MB,"backup-index");pages.push(hash);}
    const list={schema:"estampes.backup-file-index/1",pages,fileCount:members.length,totalBytes:members.reduce((s,f)=>s+f.bytes,0)},filesHash=hashJson(list);plan.add(backupListPath(filesHash),list,64*1024,"backup-index");
    const job={schema:"estampes.backup-job/1",id,destination,destinationToken:hashJson(token),source:snapshot.envelope,filesHash,state:"copying",fileIndex:0,offset:0,remainingBytes:list.totalBytes,deadlineMs:this.manager.acceptedTime()+30*60*1000};
    return {retentionChanges:new Map([["backup:"+id,job]]),result:{id,state:"copying",scope:"document-store",files:members.length}};
   });this.runtime.set(id,pin.id);return result.result;
  }catch(e){await this.manager.pins.release(pin.id);throw e;}
 }
 async pin(job,list){
  if(this.runtime.has(job.id)&&this.manager.pins.sessions.has(this.runtime.get(job.id)))return this.manager.pins.sessions.get(this.runtime.get(job.id));
  this.runtime.delete(job.id);
  const pin=await this.manager.pins.acquire({envelope:job.source},list.files.filter(f=>f.path!=="visual-registry/CURRENT.json").map(f=>f.path),this.manager.now(),{kind:"backup",ttlMs:30*60*1000});this.runtime.set(job.id,pin.id);return this.manager.pins.sessions.get(pin.id);
 }
 async step(id){
  const key="backup:"+id,old=this.owner.current.indices.retention.get(key);if(!old)fail("NOT_FOUND","Backup job not found");if(old.state!=="copying")return {id,state:old.state};
  if(this.manager.now()>old.deadlineMs)return this.cancel(id,"DEADLINE_EXPIRED");
  const job=structuredClone(old),list=await this.readList(job.filesHash),session=await this.pin(job,list),dest=new ManagedFiles(job.destination);
  integrity(hashJson(await dest.json("backup-owner.json",4096))===job.destinationToken,"Backup destination ownership token changed");
  const space=await statfs(job.destination,{bigint:true});if(space.bavail*space.bsize<BigInt(Math.min(job.remainingBytes,32*MB)+64*MB))fail("STORAGE_UNAVAILABLE","Backup step free space preflight failed");
  let budget=28*MB,count=0;const buffer=Buffer.alloc(4*MB);session.active++;
  try{
   await this.files.point("backup.before-copy",{id});
   while(job.fileIndex<list.files.length&&budget>0&&count<64){
    const file=list.files[job.fileIndex],part=file.path+".backup-part-"+id;await dest.ensureDirectory(dirname(file.path));
    let target;
    if(await dest.exists(file.path)){integrity((await dest.digest(file.path)).hash===file.hash,"Completed backup member is corrupt");job.remainingBytes-=file.bytes-job.offset;job.offset=0;job.fileIndex++;count++;continue;}
    if(await dest.exists(part)){const info=await dest.info(part);integrity(info.bytes>=job.offset,"Durable backup progress is truncated");target=await open(dest.path(part),"r+");await target.truncate(job.offset);}
    else{integrity(job.offset===0,"Missing durable backup partial member");target=await open(dest.path(part),"wx",0o600);}
    try{
     while(job.offset<file.bytes&&budget>0){const length=Math.min(buffer.length,budget,file.bytes-job.offset);let bytesRead;
      if(file.path==="visual-registry/CURRENT.json"){const bytes=Buffer.from(canonicalJson(job.source));integrity(bytes.length===file.bytes,"Backup virtual CURRENT length mismatch");bytes.copy(buffer,0,job.offset,job.offset+length);bytesRead=length;}
      else{const handle=session.handles.get(file.path);integrity(Boolean(handle),"Backup read escapes its pinned closure");({bytesRead}=await handle.read(buffer,0,length,job.offset));}
      integrity(bytesRead===length,"Backup source truncated");await this.files.point("backup.before-write",{id,path:file.path});await target.write(buffer,0,length,job.offset);job.offset+=length;job.remainingBytes-=length;budget-=length;
     }
     await this.files.point("backup.before-file-fsync",{id});await target.sync();
    }finally{await target.close();}
    await dest.syncDirectory(dirname(dest.path(part)),"backup");
    if(job.offset===file.bytes){integrity((await dest.digest(part)).hash===file.hash,"Copied backup hash mismatch");await dest.move(part,file.path,"backup");job.fileIndex++;job.offset=0;count++;}
    else break;
   }
   if(job.fileIndex===list.files.length){
    for(const f of list.files)integrity((await dest.digest(f.path)).hash===f.hash,"Backup final member verification failed");
    for(const path of list.paths)await dest.atomic(path,await this.files.bytes(path,4*MB),"backup-index",{immutable:true,owner:{kind:"backup",id}});
    const manifest={schema:"estampes.unified-document-backup/1",complete:true,scope:"document-store",fullEstampes:false,binaryAssetsIncluded:false,source:job.source,storeInstanceId:this.owner.current.root.storeInstanceId,filesHash:job.filesHash,createdAtMs:this.manager.now()};parse(manifestSchema,manifest);
    await loadCommitted(dest);await this.files.point("backup.before-complete",{id});await dest.atomic("backup-manifest.json",Buffer.from(canonicalJson(manifest)),"backup-complete",{owner:{kind:"backup",id}});job.state="complete";
   }
   await this.manager.publish("backup-progress",async()=>({retentionChanges:new Map([[key,job]]),result:{id,state:job.state,fileIndex:job.fileIndex,remainingBytes:job.remainingBytes}}));
  }finally{session.active--;if(!session.active)for(const wake of session.waiters.splice(0))wake();}
  if(job.state==="complete"){await this.manager.pins.release(session.id);this.runtime.delete(id);}return {id,state:job.state,fileIndex:job.fileIndex,remainingBytes:job.remainingBytes};
 }
 async cancel(id,reason="OWNER_CANCELLED"){
  const key="backup:"+id,job=this.owner.current.indices.retention.get(key);if(!job)fail("NOT_FOUND","Backup not found");if(job.state==="complete")return {id,state:"complete"};
  if(this.runtime.has(id)){await this.manager.pins.release(this.runtime.get(id));this.runtime.delete(id);}
  await this.manager.publish("backup-cancel",async()=>({retentionChanges:new Map([[key,{...job,state:"cancelled",remainingBytes:0,reason}]]),result:{id,state:"cancelled"}}));return {id,state:"cancelled"};
 }
 async renew(id){const key="backup:"+id,job=this.owner.current.indices.retention.get(key);if(job?.state!=="copying")fail("NOT_FOUND","Active backup is absent");return this.manager.publish("backup-renew",async()=>({retentionChanges:new Map([[key,{...job,deadlineMs:this.manager.acceptedTime()+30*60*1000}]]),result:{id}}));}
}
export async function restoreBackupContents(backup,destination,profile){
 await inspectPlatform(destination,profile,"isolated-pr1c-testing");await assertOwnedWriterLease(destination);
 const existing=await readdir(destination);integrity(existing.every(n=>n==="WRITER.lock"),"Restore refuses a non-empty or active target");
 const source=new ManagedFiles(await realpath(backup)),manifest=parse(manifestSchema,await source.json("backup-manifest.json",64*1024)),list=await readBackupList(source,manifest.filesHash),target=new ManagedFiles(destination),atomicOwner={kind:"restore",id:randomUUID()};
 const format=await source.json("storage-format.json",4096);integrity(format.profile===profile&&format.storeInstanceId===manifest.storeInstanceId,"Restore cannot promote a profile or change store namespace");
 for(const f of list.files)integrity((await source.digest(f.path)).hash===f.hash,"Backup member is missing or corrupt");const verified=await loadCommitted(source);integrity(canonicalJson(verified.envelope)===canonicalJson(manifest.source),"Backup manifest and CURRENT differ");
 await target.atomic("restore-restriction.json",Buffer.from(canonicalJson({schema:"estampes.restore-restriction/1",rootHash:manifest.source.rootHash,continuation:"read-only",reason:"No proof excludes post-backup ACKs or fences the original store"})),"restore-marker",{owner:atomicOwner});
 const buffer=Buffer.alloc(4*MB);
 for(const f of list.files.filter(f=>f.path!=="visual-registry/CURRENT.json")){
  await target.ensureDirectory(dirname(f.path));const input=await open(source.path(f.path),"r"),output=await open(target.path(f.path),"wx",0o600);
  try{let offset=0;for(;;){const {bytesRead}=await input.read(buffer,0,buffer.length,offset);if(!bytesRead)break;await output.write(buffer,0,bytesRead,offset);offset+=bytesRead;}await output.sync();}finally{await input.close();await output.close();}
  await target.syncDirectory(dirname(target.path(f.path)),"restore");integrity((await target.digest(f.path)).hash===f.hash,"Restore member hash mismatch");
 }
 await target.atomic("visual-registry/CURRENT.json",Buffer.from(canonicalJson(manifest.source)),"restore-current",{owner:atomicOwner});const restored=await loadCommitted(target);
 integrity(restored.envelope.rootHash===manifest.source.rootHash,"Restored Root differs");return {restored:true,readOnly:true,fullEstampes:false,storeInstanceId:manifest.storeInstanceId,generation:manifest.source.generation,continuation:"BLOCKED_UNPROVEN_POST_BACKUP_TAIL"};
}
export async function restoreIsolatedBackup(backup,destination,{profile="linux-local-durable"}={}){
 await inspectPlatform(destination,profile,"isolated-pr1c-testing");
 return new Promise((resolveResult,reject)=>{
  const worker=fileURLToPath(new URL("./restore-worker.js",import.meta.url)),child=spawn("/usr/bin/flock",["-n","-E","73","-F",join(destination,"WRITER.lock"),process.execPath,worker,backup,destination,profile],{stdio:["ignore","ignore","pipe","ipc"]});let answer;
  child.on("message",m=>{answer=m;});child.once("error",reject);child.once("exit",(code,signal)=>{if(code===0&&answer?.value)resolveResult(answer.value);else reject(new PersistenceError(answer?.error?.code??"RECOVERY_REQUIRED",answer?.error?.message??"Restore worker failed",{code,signal}));});
 });
}
