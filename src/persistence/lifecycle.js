import { parse, hashJson, canonicalJson } from "../documents/validation.js";
import { ReaderPins } from "./pins.js";
import { CapacityManager } from "./capacity.js";
import { GarbageCollector, recoverQuarantine, protectedPaths, reclaimIndexPages, readGcPlan } from "./gc.js";
import { readdir, rmdir } from "node:fs/promises";
import { readTemporaryClaim } from "./temporary-attribution.js";
import { BackupManager } from "./backup.js";
import { readVersion, physicalVersionPaths, stageDelta, MIB } from "./archive.js";
import { readRegistrySnapshot } from "./records.js";
import { policyOf, initialPolicy, LifecycleOptionsSchema, checkpointKey, ACK_WINDOW, DAY } from "./lifecycle-state.js";
const GC_PLAN_UNIT=256,ACK_BATCH=64,RECHECK={acks:16,prune:16,reclaim:32,plan:32,held:64};
import { integrity, fail, PersistenceError } from "./errors.js";
import { PageStore } from "./pages.js";
import { parseCommitRoot, assertCurrentEnvelope } from "./commit-root-schema.js";

export class LifecycleManager {
 constructor(owner,options,publish,clockMs){this.owner=owner;this.files=owner.files;this.options=parse(LifecycleOptionsSchema,options);this.publish=publish;this.clockMs=clockMs;this.legacyClockFloor=[...owner.current?.indices.ledger.values()??[]].reduce((n,v)=>Math.max(n,Date.parse((v.kind==="tombstone"?v.record:v).acceptedAt)),0);
  this.pins=new ReaderPins(this.files,{maxSessions:this.options.pinSessions,maxBytes:this.options.pinBytes});this.capacity=new CapacityManager(this.files,owner.format.quotaBytes);this.gc=new GarbageCollector(this);this.backups=new BackupManager(this);}
 static recoverPhysical(files){return recoverQuarantine(files);}
 now(){return this.clockMs??Date.now();}
 acceptedTime(){return Math.max(this.now(),this.legacyClockFloor,policyOf(this.owner.current?.indices.retention)?.highWaterMs??0);}
 canAge(){return this.now()>=Math.max(this.legacyClockFloor,policyOf(this.owner.current?.indices.retention)?.highWaterMs??0);}
 status(){return {pins:this.pins.status(),policy:policyOf(this.owner.current?.indices.retention),reservations:[...this.capacity.pending.values()].reduce((a,b)=>a+b,0)};}
 async reserve(id,bytes,maintenance,changes=new Map()){const all=new Map([...(this.owner.current?.indices.retention??[]),...changes]);const jobs=[...all].filter(([k,v])=>k.startsWith("backup:")&&v?.state==="copying").reduce((sum,[,job])=>sum+job.remainingBytes,0);return this.capacity.reserve(id,bytes,{maintenance,reservedJobs:jobs});}
 async onOpen(){if(await this.files.exists("restore-restriction.json")){this.owner.state="read-only-recovery";this.owner.problem={code:"RECOVERY_REQUIRED",cause:"RESTORED_BACKUP_REQUIRES_CONTINUATION_PROOF",message:"Backup is a historical snapshot; writable continuation is not authorized"};}}
 async publishPolicy(name,mutate){return this.publish(name,async()=>{const policy=structuredClone(policyOf(this.owner.current.indices.retention)??initialPolicy(this.options,this.now()));mutate(policy);return {retentionChanges:new Map([["lifecycle",policy]]),result:{state:policy.maintenance.state}};});}
 async admit(){
  await this.pins.expire(this.now());if(!this.options.autoMaintenance)return;
  const p=policyOf(this.owner.current.indices.retention),usage=await this.files.usage();
  const fullBytes=[...this.owner.current.indices.locator.values()].filter(v=>v.kind==="full").reduce((s,v)=>s+v.bytes,0);
  if(p.maintenance.state!=="idle"||p.contentSinceMaintenance>=100||fullBytes>=256*MIB||usage.allocatedBytes>=this.owner.format.quotaBytes*0.8){
   await this.compactStep();
   const active=[...this.owner.current.indices.retention].find(([k,v])=>k.startsWith("gc:")&&!["complete","failed"].includes(v.state));
   if(active)await this.gc.step(active[0].slice(3));else await this.gc.plan();
   const latest=policyOf(this.owner.current.indices.retention);if(latest.maintenance.conflicts>=2)fail("STORAGE_UNAVAILABLE","Maintenance has priority after repeated conflicts; draft remains uncommitted");
  }
 }
 async compactStep(){
  const snapshot=this.owner.current,policy=structuredClone(policyOf(snapshot.indices.retention)),rows=[...snapshot.indices.locator].sort(([,a],[,b])=>a.logical.entityId.localeCompare(b.logical.entityId)||a.logical.revision-b.logical.revision);
  const position=row=>row.logical.entityId+"|"+String(row.logical.revision).padStart(16,"0"),pending=policy.maintenance.pending;
  let item=pending?rows.find(([key])=>key===pending.key):rows.find(([,v])=>v.kind==="full"&&(!policy.maintenance.cursor||position(v)>policy.maintenance.cursor));
  if(!item){await this.publishPolicy("maintenance-drained",p=>{p.maintenance={state:"idle",cursor:null,conflicts:0,steps:p.maintenance.steps+1};p.contentSinceMaintenance=0;});return {state:"idle",progressed:0};}
  const [key,row]=item,current=snapshot.indices.registry.get("entity:"+row.logical.entityId),prior=rows.filter(([,v])=>v.logical.entityId===row.logical.entityId&&v.logical.revision<row.logical.revision).at(-1)?.[1];
  if(pending&&pending.sourceRowHash!==hashJson(row)){
   await this.publishPolicy("maintenance-conflict",p=>{p.maintenance.conflicts++;delete p.maintenance.pending;p.maintenance.state="scheduled";});return {state:"conflict",progressed:0};
  }
  const result=await this.publish("history-compaction",async({plan})=>{
   const changes=new Map();let converted=false;
   if(row.kind==="full"&&row.alternative&&hashJson(current)!==hashJson(row.logical)){await readVersion(this.files,row.logical,snapshot.indices.locator,new Set(),row.alternative);changes.set(key,row.alternative);converted=true;}
   else if(prior&&row.kind==="full"&&!row.alternative){
    const before=await readVersion(this.files,prior.logical,snapshot.indices.locator),after=await readVersion(this.files,row.logical,snapshot.indices.locator);
    const temporary=new (plan.constructor)(this.files),delta=stageDelta(temporary,before,after,prior.logical,row.logical,prior);
    if(delta){
     let budget=28*MIB,written=new Set(pending?.writtenChunks??[]),remaining=false;
     for(const [path,value]of temporary.records){if(!path.endsWith(".bin"))continue;const hash=path.split("/").at(-1).slice(0,-4);if(written.has(hash))continue;
      if(value.bytes.length>budget){remaining=true;break;}plan.addBytes(path,value.bytes,"archive");budget-=value.bytes.length;written.add(hash);
     }
     if(remaining){policy.maintenance.pending={key,sourceRowHash:hashJson(row),manifestHash:delta.manifest,writtenChunks:[...written]};policy.maintenance.state="compacting";}
     else{for(const [path,value]of temporary.records)if(!path.endsWith(".bin"))plan.addBytes(path,value.bytes,"archive");
      changes.set(key,row.logical.revision%1000===0&&hashJson(current)===hashJson(row.logical)?{...row,alternative:delta}:delta);converted=true;delete policy.maintenance.pending;
     }
    }
   }
   if(!policy.maintenance.pending){policy.maintenance.cursor=position(row);policy.maintenance.state="compacting";}
   policy.maintenance.steps++;policy.maintenance.conflicts=0;
   return {locatorChanges:changes,retentionChanges:new Map([["lifecycle",policy]]),result:{converted,logical:row.logical,state:policy.maintenance.state}};
  });return {...result.result,progressed:1};
 }
 async compactLedger(keys){
  const entries=this.owner.current.indices.ledger,selected=keys??[...entries.keys()];let changed=0;
  return this.publish("ledger-compaction",async()=>{
   const changes=new Map();if(this.canAge())for(const key of selected){const e=entries.get(key);if(e?.kind==="ack"&&this.now()-Date.parse(e.acceptedAt)>=ACK_WINDOW){changes.set(key,{kind:"tombstone",record:{key:e.key,payloadHash:e.payloadHash,commitId:e.commitId,resultHash:e.resultHash,acceptedAt:e.acceptedAt}});if(++changed>=16)break;}}
   return {ledgerChanges:changes,result:{compacted:changed,keysBefore:entries.size,keysAfter:entries.size}};
  });
 }
 // History compaction. The horizon is the oldest generation any retained root
 // still selects: the recovery points, named checkpoints, pins, active backups
 // and selected CURRENT publication evidence. A Locator row survives while a
 // retained registry (or a pin's history reference) needs it or its delta
 // chain; a membership and its Ledger tombstone survive while they are at or
 // above the horizon, inside the ACK window, or their journal still exists.
 // A retry of a forgotten request cannot apply twice: every committed change
 // moved its Document's revision, so it fails the expectedRevision check.
 async prune({budget=96}={}){
  const s=this.owner.current,ret=s.indices.retention,loc=s.indices.locator,pages=new PageStore(this.files);
  let horizon=s.root.generation;const registries=new Set([s.root.roots.registry]),refs=[];
  for(const [k,v]of ret){
   if(k.startsWith("registry:"))registries.add(v.registryRootHash);
   if(k.startsWith("recovery:"))horizon=Math.min(horizon,v.envelope.generation);
   if(k.startsWith("checkpoint:")&&v){registries.add(v.registryRootHash);horizon=Math.min(horizon,v.envelope.generation);}
   if(k.startsWith("backup:")&&v.state==="copying")horizon=Math.min(horizon,v.source.generation);
   if(k.startsWith("temporary:")&&v.publication){const e=v.publication.envelope;horizon=Math.min(horizon,e.generation);registries.add(parseCommitRoot(await pages.hashed(e.rootHash,"visual-registry/roots",64*1024)).roots.registry);}
  }
  for(const session of this.pins.sessions.values()){const d=session.snapshot;horizon=Math.min(horizon,d.generation??d.envelope?.generation??0);if(d.registryRootHash)registries.add(d.registryRootHash);for(const ref of d.historyRefs??[])refs.push(hashJson(ref));}
  const needed=new Set(),want=key=>{while(key&&!needed.has(key)){needed.add(key);const row=loc.get(key);key=row?.kind==="delta"?hashJson(row.base):null;}};
  for(const hash of registries){const registry=hash===s.root.roots.registry?s.indices.registry:await pages.read(hash,"registry");for(const [k,ref]of registry)if(k.startsWith("entity:"))want(hashJson(ref));}
  for(const key of refs)want(key);
  // Paths an active GC plan holds stay with that plan.
  const held=new Set();for(const [k,v]of ret)if(k.startsWith("gc:")&&!["complete","failed"].includes(v.state))for(const c of (await readGcPlan(this.files,v)).candidates)held.add(c.path);
  const owners=new Set();for(const [k,v]of ret)if(k.startsWith("temporary:"))owners.add(v.owner.id);
  const claimDir="visual-temporaries/claims";
  if(await this.files.exists(claimDir))for(const name of await readdir(this.files.path(claimDir)))if(/^[0-9a-f-]{36}\.json$/.test(name))owners.add((await readTemporaryClaim(this.files,name.slice(0,-5))).owner.id);
  const journalGone=async id=>{for(const name of ["intent.json","prepared.json","outcome.json"]){const path="visual-transactions/"+id.slice(3)+"/"+name;if(held.has(path)||await this.files.exists(path))return false;}return true;};
  const bucket=key=>hashJson(key).slice(0,2),touched={locator:new Set(),ledger:new Set(),commitIndex:new Set(),retention:new Set()};
  const fits=list=>{const extra=list.filter(([index,key])=>!touched[index].has(bucket(key))).length,used=Object.values(touched).reduce((n,t)=>n+t.size,0);if(used+extra>budget)return false;for(const [index,key]of list)touched[index].add(bucket(key));return true;};
  const locatorChanges=new Map(),ledgerChanges=new Map(),commitIndexChanges=new Map(),retentionChanges=new Map(),folders=new Set(),quarantines=new Set();let full=false;
  const ledgerAfter=new Set(s.indices.ledger.keys());
  for(const [id,m]of s.indices.commitIndex){
   if(m.generation>=horizon||id===s.root.commitId||owners.has(id.slice(3)))continue;
   if(m.requestKeyDigest!==null&&s.indices.ledger.get(m.requestKeyDigest)?.kind!=="tombstone")continue;
   if(!await journalGone(id))continue;
   const list=[["commitIndex",id],["retention","journal-compacted:"+id],...(m.requestKeyDigest?[["ledger",m.requestKeyDigest],["retention","journal-key:"+m.requestKeyDigest]]:[])];
   if(!fits(list)){full=true;break;}
   commitIndexChanges.set(id,undefined);if(ret.has("journal-compacted:"+id))retentionChanges.set("journal-compacted:"+id,undefined);
   if(m.requestKeyDigest){ledgerChanges.set(m.requestKeyDigest,undefined);ledgerAfter.delete(m.requestKeyDigest);if(ret.has("journal-key:"+m.requestKeyDigest))retentionChanges.set("journal-key:"+m.requestKeyDigest,undefined);}
   folders.add(id.slice(3));
  }
  for(const [k,v]of ret){
   if(full)break;
   let drop=false;
   // An aborted transaction's proof, once its journal is gone, explains nothing.
   if(k.startsWith("journal-compacted:")&&v.outcome==="aborted"&&!s.indices.commitIndex.has(v.commitId)&&await journalGone(v.commitId)){drop=true;folders.add(v.commitId.slice(3));}
   if(k.startsWith("journal-key:")&&!ledgerAfter.has(k.slice(12)))drop=true;
   if(k.startsWith("gc:")&&v.state==="complete"&&(await readGcPlan(this.files,v)).sourceGeneration<horizon){drop=true;quarantines.add(k.slice(3));}
   if(!drop||retentionChanges.has(k))continue;
   if(!fits([["retention",k]])){full=true;break;}
   retentionChanges.set(k,undefined);
  }
  for(const [key,row]of loc){
   if(full)break;
   let next;
   if(!needed.has(key))next=undefined;
   else if(row.kind==="full"&&row.alternative&&!needed.has(hashJson(row.alternative.base))){const {alternative,...rest}=row;next=rest;}
   else continue;
   if(!fits([["locator",key]])){full=true;break;}
   locatorChanges.set(key,next);
  }
  const changes=locatorChanges.size+ledgerChanges.size+commitIndexChanges.size+retentionChanges.size;
  if(!changes)return {pruned:0,horizon,more:false};
  await this.publish("history-prune",async()=>({locatorChanges,ledgerChanges,commitIndexChanges,retentionChanges,result:{horizon,versions:locatorChanges.size,memberships:commitIndexChanges.size,retention:retentionChanges.size}}));
  // Journal folders are empty by now; an interrupted removal leaves an empty
  // folder that recovery skips and the next prune removes.
  let removed=0;for(const id of folders){try{await rmdir(this.files.path("visual-transactions/"+id));removed++;}catch(e){if(!["ENOENT","ENOTEMPTY","EEXIST"].includes(e.code))throw e;}}
  if(removed)await this.files.syncDirectory(this.files.path("visual-transactions"),"history-prune");
  for(const id of quarantines){try{await rmdir(this.files.path("gc-quarantine/"+id));}catch(e){if(!["ENOENT","ENOTEMPTY","EEXIST"].includes(e.code))throw e;}}
  return {pruned:changes,horizon,versions:locatorChanges.size,memberships:commitIndexChanges.size,folders:removed,more:full};
 }
 async expireAcks({limit=ACK_BATCH}={}){
  if(!this.canAge())return {compacted:0};
  const now=this.now(),selected=[...this.owner.current.indices.ledger].filter(([,e])=>e.kind==="ack"&&now-Date.parse(e.acceptedAt)>=ACK_WINDOW).slice(0,limit);
  if(!selected.length)return {compacted:0};
  return this.publish("ledger-compaction",async()=>({ledgerChanges:new Map(selected.map(([key,e])=>[key,{kind:"tombstone",record:{key:e.key,payloadHash:e.payloadHash,commitId:e.commitId,resultHash:e.resultHash,acceptedAt:e.acceptedAt}}])),result:{compacted:selected.length}})).then(r=>r.result);
 }
 // Compaction runs as small units on the writer queue, so a commit never waits
 // for more than one of them. Each unit is one bounded piece of work: a GC plan
 // step, one batch of ACK expiry, one prune publication, a page sweep, or one
 // new GC plan. `compactUnit` picks the first that is due and reports which.
 // Checks that found nothing are not repeated until enough content has been
 // committed to make new work likely (counted in content commits, not time).
 noteContent(){this.contentSeen=(this.contentSeen??0)+1;}
 async compactUnit(){
  const seen=this.contentSeen??0,steps=this.stepSeen??=new Map(),now=this.now(),since=key=>this.emptyAt?.[key]===undefined||seen-this.emptyAt[key]>=RECHECK[key];
  const empty=key=>{(this.emptyAt??={})[key]=seen;};
  // A plan is due when it has not been stepped by this writer, when it still
  // has work (planned, unlinking), when its grace has newly elapsed, or, if a
  // retained root held some of its candidates, after more content commits.
  for(const [k,v]of this.owner.current.indices.retention){
   if(!k.startsWith("gc:")||["complete","failed"].includes(v.state))continue;
   const id=k.slice(3),last=steps.get(id),graceAt=v.quarantinedAtMs===null?null:v.quarantinedAtMs+DAY;
   const due=!last||v.state==="planned"||v.state==="unlinking"||(graceAt!==null&&this.canAge()&&now>=graceAt&&last.at<graceAt)||(v.state==="quarantining"&&seen-last.seen>=RECHECK.held);
   if(!due)continue;
   const r=await this.gc.step(id);steps.set(id,{seen,at:now});
   if(r.state==="complete"){steps.delete(id);delete this.emptyAt?.prune;delete this.emptyAt?.plan;}
   return {unit:"gc-step",id,state:r.state,moved:r.moved,deleted:r.deleted};
  }
  // A check runs again early only when it filled its batch: every maintenance
  // publication itself leaves superseded pages behind, so "found something"
  // alone would never settle.
  if(since("acks")){const r=await this.expireAcks();if(r.compacted<ACK_BATCH)empty("acks");if(r.compacted){delete this.emptyAt?.prune;return {unit:"acks",...r};}}
  if(since("prune")){const r=await this.prune();if(!r.more)empty("prune");if(r.pruned){delete this.emptyAt?.plan;return {unit:"prune",...r};}}
  if(since("reclaim")){empty("reclaim");return {unit:"reclaim",...await reclaimIndexPages(this.owner)};}
  if(since("plan")){const r=await this.gc.plan({sweep:true,limit:GC_PLAN_UNIT});if(!r.planned||r.candidates<GC_PLAN_UNIT)empty("plan");if(r.planned)return {unit:"gc-plan",...r};}
  return {unit:null};
 }
 // Every unit until none has work (tests and the explicit maintenance action).
 async autoCompact({units=256}={}){
  this.emptyAt={};const report=[];
  for(let i=0;i<units;i++){const r=await this.compactUnit();if(!r.unit)break;report.push(r);}
  return {units:report.length,report:report.slice(-16)};
 }
 async pin(args={}){
  const current=this.owner.current,registry=args.registryRootHash??current.root.roots.registry,resolver=current.indices.retention.get("registry:"+registry);
  if(!resolver)fail("STALE_CURSOR","Historical registry is no longer resolvable");
  const locatorRoot=current.root.roots.locator; // append-only: resolves every retained registry
  const view=await readRegistrySnapshot(this.files,registry,locatorRoot,current.root.storeInstanceId,current.root.generation);
  const paths=new Set(view.files),pages=new PageStore(this.files);await pages.hashed(current.envelope.rootHash,"visual-registry/roots",64*1024);for(const [kind,hash]of Object.entries(current.root.roots))await pages.read(hash,kind);for(const path of pages.track)paths.add(path);
  const historyRefs=args.historyRefs??[];integrity(Array.isArray(historyRefs)&&historyRefs.length<=200,"History pin reference limit exceeded");
  for(const ref of historyRefs){integrity(view.locator.has(hashJson(ref)),"History reference is absent");await physicalVersionPaths(this.files,ref,view.locator,paths);}
  const descriptor={registryRootHash:registry,locatorRootHash:locatorRoot,storeInstanceId:current.root.storeInstanceId,generation:current.root.generation,envelope:current.envelope,historyRefs};
  return this.pins.acquire(descriptor,[...paths],this.now(),{ttlMs:args.ttlMs??10*60*1000});
 }
 async readPin(id){return this.pins.read(id,this.now(),async(s,io)=>(await readRegistrySnapshot(io,s.registryRootHash,s.locatorRootHash,s.storeInstanceId,s.generation)).documents);}
 async checkpoint(name,remove=false){
  integrity(typeof name==="string"&&name.length>0&&name.length<=80,"Invalid checkpoint name");const key=checkpointKey(name),current=this.owner.current;
  if(remove&&!current.indices.retention.has(key))fail("NOT_FOUND","Checkpoint is absent");if(!remove&&current.indices.retention.has(key))fail("CONFLICT","Checkpoint name already exists");
  return this.publish(remove?"checkpoint-release":"checkpoint-create",async()=>({retentionChanges:new Map([[key,remove?undefined:{schema:"estampes.named-checkpoint/1",name,registryRootHash:current.root.roots.registry,logicalClosureHash:current.indices.retention.get("registry:"+current.root.roots.registry).logicalClosureHash,resolverLocatorRootHash:current.root.roots.locator,createdAtMs:this.now(),envelope:current.envelope}]]),result:{name,removed:remove}}));
 }
 async run(action,args){
  try{
   if(action==="clock"){integrity(Number.isSafeInteger(args.nowMs)&&args.nowMs>=0,"Invalid test clock");this.clockMs=args.nowMs;return await this.publishPolicy("clock-observation",()=>{});}
   if(action==="compact")return await this.compactStep();
   if(action==="ledger")return await this.compactLedger();
   if(action==="prune")return await this.prune(args);
   if(action==="autoCompact")return await this.autoCompact(args);
   if(action==="compactUnit")return await this.compactUnit();
   if(action==="pin")return await this.pin(args);
   if(action==="readPin")return await this.readPin(args.id);
   if(action==="releasePin")return await this.pins.release(args.id);
   if(action==="renewPin")return await this.pins.renew(args.id,this.now(),args.ttlMs);
   if(action==="checkpoint")return await this.checkpoint(args.name);
   if(action==="dropCheckpoint")return await this.checkpoint(args.name,true);
   if(action==="gcPlan")return await this.gc.plan(args);
   if(action==="gcStep")return await this.gc.step(args.id);
   if(action==="reclaimPages")return await reclaimIndexPages(this.owner,args);
   if(action==="backupStart")return await this.backups.start(args);
   if(action==="backupStep")return await this.backups.step(args.id);
   if(action==="backupCancel")return await this.backups.cancel(args.id);
   if(action==="backupRenew")return await this.backups.renew(args.id);
   if(action==="history")return await this.pins.read(args.id,this.now(),async(s,io)=>{if(!s.historyRefs.some(ref=>hashJson(ref)===hashJson(args.ref)))fail("FORBIDDEN","History version was not included in this pin");return readVersion(io,args.ref,(await new PageStore(io).read(s.locatorRootHash,"locator")));});
   if(action==="verify")return {verified:true,files:(await protectedPaths(this.owner)).paths.size};
   if(action==="usage")return {...await this.files.usage(),pins:this.pins.status()};
   fail("INVALID_INPUT","Unknown lifecycle operation");
  }catch(e){if(e.barrier||e.details?.storageIntegrity||["INTEGRITY_ERROR","EIO","ENOENT"].includes(e.code)){this.owner.state="read-only-recovery";this.owner.problem={code:"RECOVERY_REQUIRED",cause:e.code??"IO_ERROR",message:String(e.message).slice(0,300)};throw new PersistenceError("RECOVERY_REQUIRED","Maintenance requires recovery",this.owner.problem);}throw e;}
 }
}
