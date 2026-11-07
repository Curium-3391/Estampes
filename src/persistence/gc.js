// Destructive work is only permitted by a plan committed in the sole CommitRoot.
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { PageStore } from "./pages.js";
import { parseCommitRoot, assertCurrentEnvelope, CurrentEnvelopeSchema } from "./commit-root-schema.js";
import { GcRecordSchema, DAY, policyOf } from "./lifecycle-state.js";
import { hashJson, canonicalJson, parse, ContentHashSchema as Hash, bounded } from "../documents/validation.js";
import { loadCommitted } from "./records.js";
import { integrity, fail } from "./errors.js";
import { randomUUID } from "node:crypto";
import { IntentSchema } from "./journal.js";
import { TemporaryRecoverySchema, readTemporaryClaim, temporaryClaimPath } from "./temporary-attribution.js";
const uuid="[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",hash="[0-9a-f]{64}";
const allowed=new RegExp("^(?:(?:visual-documents/"+uuid+"/generations/[1-9][0-9]*-"+hash+"\\.json|visual-registry/(?:pages|roots)/"+hash+"\\.json|visual-history/(?:chunks/"+hash+"\\.bin|deltas/"+hash+"\\.json)|visual-maintenance/(?:gc|backup-lists|backup-list-pages)/"+hash+"\\.json|visual-transactions/"+uuid+"/(?:intent|prepared|outcome)\\.json|visual-registry/CURRENT\\.json|storage-format\\.json)(?:\\.tmp-"+uuid+")?|visual-temporaries/claims/"+uuid+"\\.json)$");
export const gcSourceAllowed=path=>typeof path==="string"&&allowed.test(path);
const physicalSchema=z.object({dev:z.string().regex(/^\d{1,32}$/),ino:z.string().regex(/^\d{1,32}$/)}).strict();
const objectKey=value=>value?value.dev+":"+value.ino:null;
const candidateSchema=z.object({path:z.string().refine(gcSourceAllowed),hash:Hash,bytes:z.number().int().min(0),class:z.enum(["G1","G2"]),quarantine:z.string(),reason:z.string().max(160),physical:physicalSchema.optional()}).strict();
const temporaryDispositionSchema=z.object({recovery:TemporaryRecoverySchema,claimCandidate:z.number().int().min(0).max(127),temporaryCandidate:z.number().int().min(0).max(127).nullable()}).strict();
export const GcPlanSchema=bounded(z.object({schema:z.literal("estampes.gc-plan/1"),id:z.string().uuid(),storeInstanceId:z.string().uuid(),sourceGeneration:z.number().int().positive(),
 sourceRootHash:Hash,rootsetHash:Hash,pinsEpoch:z.number().int().min(0),createdAtMs:z.number().int().min(0),candidates:z.array(candidateSchema).min(1).max(128),temporaryDispositions:z.array(temporaryDispositionSchema).max(64).optional()}).strict());
export const gcPlanPath=hash=>"visual-maintenance/gc/"+parse(Hash,hash)+".json";
export async function readGcPlan(files,record){
 const r=parse(GcRecordSchema,record),raw=await files.json(gcPlanPath(r.planHash),4*1024**2),validated=GcPlanSchema.safeParse(raw);integrity(validated.success,"Invalid committed GC plan schema");const plan=validated.data;integrity(hashJson(plan)===r.planHash,"GC plan hash mismatch");
 integrity(new Set(r.moved).size===r.moved.length&&new Set(r.deleted).size===r.deleted.length&&new Set(r.unlinking??[]).size===(r.unlinking??[]).length&&r.moved.every(i=>i<plan.candidates.length)&&r.deleted.every(i=>r.moved.includes(i))&&(r.unlinking??[]).every(i=>r.moved.includes(i)&&!r.deleted.includes(i)),"GC progress differs from candidate inventory");
 integrity(new Set(plan.candidates.map(c=>c.path)).size===plan.candidates.length&&(r.state!=="complete"||r.deleted.length===plan.candidates.length),"GC plan repeats a candidate or has incomplete terminal progress");
 for(const [i,c]of plan.candidates.entries())integrity(c.quarantine===`gc-quarantine/${plan.id}/${i}-${c.hash}.bin`,"Unsafe GC quarantine path");return plan;
}
// Absence is an outcome only when an earlier selected Root already authorized
// that exact candidate's unlink. A new intent cannot explain an older loss.
async function verifyGcLocations(files,plan,record){
 for(const [i,c]of plan.candidates.entries()){
  const source=await files.exists(c.path),quarantine=await files.exists(c.quarantine);
  if(record.deleted.includes(i)){
   integrity(!quarantine,"Terminal GC quarantine candidate reappeared");
   // A later transaction may legitimately recreate the content-addressed
   // source path. This terminal plan has no deletion authority over it.
   if(source){const digest=await files.digest(c.path);integrity(digest.hash===c.hash&&digest.bytes===c.bytes,"Reused terminal GC source differs from its content identity");}
   continue;
  }
  if(!source&&!quarantine){integrity(record.moved.includes(i)&&(record.unlinking??[]).includes(i),"GC candidate missing without prior durable unlink intent");continue;}
  // A later content transaction can recreate its immutable source while the
  // earlier copy is still quarantined. Verify both, retain the new source,
  // and let the live-root re-mark postpone deletion of the old copy.
  for(const path of [...(source?[c.path]:[]),...(quarantine?[c.quarantine]:[])]){
   const digest=await files.digest(path);integrity(digest.hash===c.hash&&digest.bytes===c.bytes,"GC candidate physical identity changed");
   if(c.physical&&(path===c.quarantine||(!quarantine&&!(record.unlinking??[]).includes(i))))integrity(objectKey(digest)===objectKey(c.physical),"GC candidate object differs from selected ownership");
  }
 }
}
// Reservations are derived from the sole selected retention root, not a second
// authority. Terminal candidates release ownership; pathname reuse is a new
// object. Old plans without object identity reserve their paths conservatively.
export async function gcOwnership(files,snapshot){
 const objects=new Set(),legacyPaths=new Set(),paths=new Map();let count=0;
 for(const [key,record]of snapshot.indices.retention)if(key.startsWith("gc:")){
  const plan=await readGcPlan(files,record);
  integrity(key==="gc:"+plan.id&&plan.storeInstanceId===snapshot.root.storeInstanceId&&plan.sourceGeneration<=snapshot.root.generation,"GC ownership namespace differs from selected root");
  if(record.state==="complete")continue;
  await verifyGcLocations(files,plan,record);
  for(const [i,c]of plan.candidates.entries()){
   if(record.deleted.includes(i))continue;
   if(++count>4096)fail("STORAGE_UNAVAILABLE","Active GC ownership exceeds bounded inventory");
   const object=objectKey(c.physical),prior=paths.get(c.path)??[];
   integrity(!legacyPaths.has(c.path)&&(!object?prior.length===0:!objects.has(object)),"Physical candidate has overlapping active GC owners");
   if(object)objects.add(object);else legacyPaths.add(c.path);
   prior.push(object);paths.set(c.path,prior);
  }
 }
 return {objects,legacyPaths,count};
}
async function rootMetadata(files,envelope,paths){
 const pages=new PageStore(files),root=parseCommitRoot(await pages.hashed(envelope.rootHash,"visual-registry/roots",64*1024));assertCurrentEnvelope(root,envelope);
 for(const [kind,hash]of Object.entries(root.roots))await pages.read(hash,kind);for(const p of pages.track)paths.add(p);
}
export async function protectedPaths(owner,{verify=true,includeTemporary=false}={}){
 const snapshot=verify?await loadCommitted(owner.files):owner.current;
 integrity(snapshot.envelope.rootHash===owner.current.envelope.rootHash,"CURRENT changed outside serialized maintenance");
 const paths=new Set(snapshot.files);paths.add("storage-format.json");paths.add("WRITER.lock");
 for(const [key,value]of snapshot.indices.retention){
  if(key.startsWith("recovery:"))await rootMetadata(owner.files,value.envelope,paths);
  if(key.startsWith("checkpoint:")&&value.envelope)await rootMetadata(owner.files,value.envelope,paths);
  if(key.startsWith("gc:")){paths.add(gcPlanPath(value.planHash));const plan=await readGcPlan(owner.files,value);if(!["complete","failed"].includes(value.state))for(const c of plan.candidates)if(await owner.files.exists(c.quarantine))paths.add(c.quarantine);}
  if(key.startsWith("backup:")){
   const list=await owner.lifecycle.backups.readList(value.filesHash);for(const p of list.paths)paths.add(p);if(value.state==="copying")for(const f of list.files)paths.add(f.path);
  }
  if(includeTemporary&&key.startsWith("temporary:")){const recovery=parse(TemporaryRecoverySchema,value);paths.add(temporaryClaimPath(recovery.claimId));if(await owner.files.exists(recovery.temporaryPath))paths.add(recovery.temporaryPath);}
 }
 for(const path of owner.lifecycle.pins.paths)paths.add(path);
 const pending=policyOf(snapshot.indices.retention)?.maintenance.pending;
 if(pending)for(const hash of pending.writtenChunks??[])paths.add("visual-history/chunks/"+hash+".bin");
 return {snapshot,paths,hash:hashJson([...paths].sort())};
}
export class GarbageCollector {
 constructor(manager){this.manager=manager;this.owner=manager.owner;this.files=this.owner.files;}
 async plan({classes=["G1","G2"]}={}){
  integrity(Array.isArray(classes)&&classes.length>0&&classes.every(v=>["G1","G2"].includes(v)),"Invalid GC class filter");
  const {snapshot,paths,hash:rootsetHash}=await protectedPaths(this.owner),candidates=[],proofs=new Map(),selected=new Set(),temporaryDispositions=[];
  const ownership=await gcOwnership(this.files,snapshot);
  const add=async(path,kind,reason)=>{if(!classes.includes(kind)||candidates.length>=128||selected.has(path)||paths.has(path)||!gcSourceAllowed(path)||!await this.files.exists(path))return false;
   const info=await this.files.digest(path);if(ownership.legacyPaths.has(path)||ownership.objects.has(objectKey(info)))return false;
   if(ownership.count+candidates.length>=4096)fail("STORAGE_UNAVAILABLE","Active GC ownership budget exhausted");
   selected.add(path);candidates.push({path,hash:info.hash,bytes:info.bytes,class:kind,reason,quarantine:"",physical:{dev:info.dev,ino:info.ino}});return true;};
  for(const row of snapshot.indices.locator.values())if(row.kind==="delta"){
   const ref=row.logical,path=`visual-documents/${ref.entityId.slice(4)}/generations/${ref.revision}-${ref.contentHash}.json`;
   await add(path,"G1","Verified committed delta reconstructs the same logical version");
  }
  const now=this.manager.now(),safeClock=this.manager.canAge();
  for(const [key,raw]of snapshot.indices.retention){
   if(!key.startsWith("temporary:")||!classes.includes("G2")||candidates.length>126||temporaryDispositions.length>=64)continue;
   const recovery=parse(TemporaryRecoverySchema,raw);integrity(key==="temporary:"+recovery.claimId,"Temporary recovery key mismatch");
   const claim=await readTemporaryClaim(this.files,recovery.claimId);
   integrity(claim.claimId===recovery.claimId&&canonicalJson(claim.owner)===canonicalJson(recovery.owner)&&claim.finalPath===recovery.finalPath&&claim.temporaryPath===recovery.temporaryPath&&claim.hash===recovery.hash&&claim.bytes===recovery.bytes,"Temporary claim differs from durable recovery classification");
   const hasTemporary=await this.files.exists(claim.temporaryPath);let temporaryCandidate=null;if(hasTemporary){integrity(await add(claim.temporaryPath,"G2","Attributed temporary from a durably classified transaction"),"Attributed temporary could not enter GC plan");temporaryCandidate=candidates.length-1;}
   integrity(await add(temporaryClaimPath(claim.claimId),"G2","Durable temporary ownership claim after terminal classification"),"Temporary claim could not enter GC plan");
   temporaryDispositions.push({recovery,claimCandidate:candidates.length-1,temporaryCandidate});
   proofs.set(key,undefined);
  }
  for(const dir of await readdir(this.files.path("visual-transactions"))){
   if(!new RegExp("^"+uuid+"$").test(dir))fail("INTEGRITY_ERROR","Unknown transaction directory during GC planning");
   const prefix="visual-transactions/"+dir,tx="tx:"+dir,member=snapshot.indices.commitIndex.get(tx);
   if(!await this.files.exists(prefix+"/intent.json"))continue;
   const rawIntent=await this.files.json(prefix+"/intent.json"),validated=IntentSchema.safeParse(rawIntent);integrity(validated.success,"GC encountered an invalid terminal intent");
   const intent=validated.data,outcome=await this.files.json(prefix+"/outcome.json");
   integrity(intent.commitId===tx&&intent.storeInstanceId===snapshot.root.storeInstanceId&&outcome.commitId===tx&&outcome.outcome===(member?"committed":"aborted"),"Journal is not terminal/consistent for GC");
   if(member){
    integrity(member.payloadHash===intent.payloadHash&&member.requestKeyDigest===intent.requestKeyDigest&&outcome.membership?.generation===member.generation&&outcome.membership?.registryRootHash===member.registryRootHash&&outcome.membership?.resultHash===member.resultHash,"GC terminal journal differs from authoritative membership");
    if(intent.requestKeyDigest){const v=snapshot.indices.ledger.get(intent.requestKeyDigest),entry=v?.kind==="tombstone"?v.record:v;integrity(entry?.acceptedAt===intent.acceptedAt&&entry?.payloadHash===intent.payloadHash,"GC journal differs from permanent Ledger");}
   }
   for(const f of intent.stagedFiles??[])if(!paths.has(f.path))await add(f.path,"G2","Unreachable file from a terminal transaction plan");
   const age=now-Date.parse(intent.acceptedAt),wait=member?7*DAY:DAY;
   if(safeClock&&age>=wait){
    proofs.set("journal-compacted:"+tx,{schema:"estampes.compacted-journal/1",commitId:tx,payloadHash:intent.payloadHash,outcome:member?"committed":"aborted",atMs:now});
    if(intent.requestKeyDigest)proofs.set("journal-key:"+intent.requestKeyDigest,{payloadHash:intent.payloadHash});
    for(const name of ["intent.json","prepared.json","outcome.json"])await add(prefix+"/"+name,"G2","Terminal journal with durable membership/key retention proof");
   }
  }
  if(!candidates.length)return {planned:false,reason:"No provably unreachable managed files"};
  const id=randomUUID();for(const [i,c]of candidates.entries())c.quarantine=`gc-quarantine/${id}/${i}-${c.hash}.bin`;
  const plan={schema:"estampes.gc-plan/1",id,storeInstanceId:snapshot.root.storeInstanceId,sourceGeneration:snapshot.root.generation,sourceRootHash:snapshot.envelope.rootHash,rootsetHash,pinsEpoch:this.manager.pins.epoch,createdAtMs:now,candidates,...(temporaryDispositions.length?{temporaryDispositions}:{})};parse(GcPlanSchema,plan);
  await this.manager.publish("gc-plan",async({plan:staging})=>{const hash=hashJson(plan);staging.add(gcPlanPath(hash),plan,4*1024**2,"gc-plan");return {retentionChanges:new Map([...proofs,["gc:"+id,{schema:"estampes.gc-state/1",planHash:hash,state:"planned",quarantinedAtMs:null,moved:[],deleted:[]}]]),result:{id,candidates:candidates.length}};});
  return {planned:true,id,candidates:candidates.length};
 }
 async step(id){
  const key="gc:"+id,record=this.owner.current.indices.retention.get(key);if(!record)fail("NOT_FOUND","GC plan not found");
  const plan=await readGcPlan(this.files,record);integrity(plan.storeInstanceId===this.owner.current.root.storeInstanceId,"GC plan namespace differs");
  await gcOwnership(this.files,this.owner.current);
  await verifyGcLocations(this.files,plan,record);if(record.state==="complete")return {id,state:"complete"};
  const priorUnlinking=new Set(record.unlinking??[]);
  const state=structuredClone(record),{paths}=await protectedPaths(this.owner);let progressed=0;
  await this.files.point("gc.before-quarantine",{id});
  for(const [i,c]of plan.candidates.entries()){
   if(state.moved.includes(i))continue;
   if(paths.has(c.path)){state.reason="PINNED_OR_REACHABLE";continue;}
   if(await this.files.exists(c.quarantine)){const digest=await this.files.digest(c.quarantine);integrity(digest.hash===c.hash&&digest.bytes===c.bytes,"Quarantined file changed");}
   else if(await this.files.exists(c.path)){
    const digest=await this.files.digest(c.path);integrity(digest.hash===c.hash&&digest.bytes===c.bytes,"GC source changed since plan");
    await this.files.move(c.path,c.quarantine,"gc");
   }else fail("INTEGRITY_ERROR","GC source vanished before quarantine");
   state.moved.push(i);progressed++;
  }
  if(state.quarantinedAtMs===null&&state.moved.length)state.quarantinedAtMs=this.manager.acceptedTime();
  state.state="quarantining";
  await this.manager.publish("gc-quarantine-progress",async()=>({retentionChanges:new Map([[key,state]]),result:{id,moved:state.moved.length}}));
  await this.files.point("gc.after-quarantine",{id});
  // Re-mark after durable quarantine progress; callbacks cannot use the old mark.
  const remarked=await protectedPaths(this.owner);
  let next=structuredClone(this.owner.current.indices.retention.get(key)),waiting=false;const deletionIntent=[];
  for(const i of next.moved){
   if(next.deleted.includes(i))continue;const c=plan.candidates[i];
   if(remarked.paths.has(c.path)){waiting=true;continue;}
   if(c.class==="G2"&&(!this.manager.canAge()||this.manager.now()-next.quarantinedAtMs<DAY)){waiting=true;continue;}
   if(await this.files.exists(c.quarantine)){const digest=await this.files.digest(c.quarantine);integrity(digest.hash===c.hash&&digest.bytes===c.bytes,"Quarantine changed before unlink authorization");}
   else integrity(priorUnlinking.has(i),"Missing quarantine cannot acquire a new unlink intent");
   deletionIntent.push(i);
  }
  if(deletionIntent.length){
   next.state="unlinking";next.unlinking=deletionIntent;
   await this.manager.publish("gc-unlink-intent",async()=>({retentionChanges:new Map([[key,next]]),result:{id,unlinking:deletionIntent.length}}));
   const finalMark=await protectedPaths(this.owner);next=structuredClone(this.owner.current.indices.retention.get(key));
   for(const i of next.unlinking??[]){const c=plan.candidates[i];if(finalMark.paths.has(c.path)){waiting=true;continue;}
   if(await this.files.exists(c.quarantine)){
    const digest=await this.files.digest(c.quarantine);integrity(digest.hash===c.hash&&digest.bytes===c.bytes,"Quarantine checksum failed before unlink");
    await this.files.remove(c.quarantine,"gc",{allowMissing:false,expected:digest});
   }else {integrity(priorUnlinking.has(i),"Quarantine vanished after new unlink authorization");await this.files.syncDirectory(this.files.path("gc-quarantine/"+id),"gc");}
   next.deleted.push(i);progressed++;
   }
   delete next.unlinking;
  }
  next.state=next.deleted.length===plan.candidates.length?"complete":waiting?"waiting-grace":"quarantining";
  await this.manager.publish("gc-unlink-progress",async()=>({retentionChanges:new Map([[key,next]]),result:{id,state:next.state,deleted:next.deleted.length}}));
  return {id,state:next.state,progressed,moved:next.moved.length,deleted:next.deleted.length};
 }
}
// Before a full logical load, restore any quarantined representation that a
// committed Locator still requires. Plans come only from hashed CURRENT data.
export async function recoverQuarantine(files){
 if(!await files.exists("visual-registry/CURRENT.json"))return;
 const envelope=parse(CurrentEnvelopeSchema,await files.json("visual-registry/CURRENT.json",64*1024)),pages=new PageStore(files),root=parseCommitRoot(await pages.hashed(envelope.rootHash,"visual-registry/roots",64*1024));assertCurrentEnvelope(root,envelope);
 const retention=await pages.read(root.roots.retention,"retention");
 // Only a committed GC plan can have quarantined anything. Without one there is
 // nothing to restore, and the Locator/manifest walk below would be O(history).
 if(![...retention.keys()].some(key=>key.startsWith("gc:")))return;
 const locator=await pages.read(root.roots.locator,"locator"),required=new Set(pages.track);
 await gcOwnership(files,{root,indices:{retention}});
 for(const row of locator.values()){
  if(row.kind==="full")required.add(row.relativePath);
  const delta=row.kind==="delta"?row:row.alternative;
  if(delta){const path="visual-history/deltas/"+delta.manifest+".json";required.add(path);if(await files.exists(path)){const m=await files.json(path,4*1024**2);integrity(hashJson(m)===delta.manifest,"Recovery delta manifest mismatch");for(const h of m.chunks)required.add("visual-history/chunks/"+h+".bin");}}
 }
 for(const [key,value]of retention)if(key.startsWith("backup:")&&value.state==="copying"){
  const {readBackupList}=await import("./backup.js"),list=await readBackupList(files,value.filesHash);for(const f of list.files)required.add(f.path);
 }
 for(const [key,value]of retention)if(key.startsWith("gc:")){
  const plan=await readGcPlan(files,value);integrity(plan.storeInstanceId===root.storeInstanceId,"Recovery GC namespace mismatch");
  await verifyGcLocations(files,plan,value);
  for(const c of plan.candidates)if(await files.exists(c.quarantine)){
   integrity((await files.digest(c.quarantine)).hash===c.hash,"Corrupt quarantine during recovery");
   if(required.has(c.path)&&!await files.exists(c.path))await files.move(c.quarantine,c.path,"gc-recovery");
  }
 }
}
