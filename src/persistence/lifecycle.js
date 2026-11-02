import { parse, hashJson, canonicalJson } from "../documents/validation.js";
import { ReaderPins } from "./pins.js";
import { CapacityManager } from "./capacity.js";
import { GarbageCollector, recoverQuarantine, protectedPaths } from "./gc.js";
import { BackupManager } from "./backup.js";
import { readVersion, physicalVersionPaths, stageDelta, MIB } from "./archive.js";
import { readRegistrySnapshot } from "./records.js";
import { policyOf, initialPolicy, LifecycleOptionsSchema, checkpointKey, ACK_WINDOW } from "./lifecycle-state.js";
import { integrity, fail } from "./errors.js";
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
 async pin(args={}){
  const current=this.owner.current,registry=args.registryRootHash??current.root.roots.registry,resolver=current.indices.retention.get("registry:"+registry);
  if(!resolver)fail("STALE_CURSOR","Historical registry is no longer resolvable");
  const view=await readRegistrySnapshot(this.files,registry,resolver.resolverLocatorRootHash,current.root.storeInstanceId,current.root.generation);
  const paths=new Set(view.files),pages=new PageStore(this.files);await pages.hashed(current.envelope.rootHash,"visual-registry/roots",64*1024);for(const [kind,hash]of Object.entries(current.root.roots))await pages.read(hash,kind);for(const path of pages.track)paths.add(path);
  const historyRefs=args.historyRefs??[];integrity(Array.isArray(historyRefs)&&historyRefs.length<=200,"History pin reference limit exceeded");
  for(const ref of historyRefs){integrity(view.locator.has(hashJson(ref)),"History reference is absent");await physicalVersionPaths(this.files,ref,view.locator,paths);}
  const descriptor={registryRootHash:registry,locatorRootHash:resolver.resolverLocatorRootHash,storeInstanceId:current.root.storeInstanceId,generation:current.root.generation,envelope:current.envelope,historyRefs};
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
   if(action==="pin")return await this.pin(args);
   if(action==="readPin")return await this.readPin(args.id);
   if(action==="releasePin")return await this.pins.release(args.id);
   if(action==="renewPin")return await this.pins.renew(args.id,this.now(),args.ttlMs);
   if(action==="checkpoint")return await this.checkpoint(args.name);
   if(action==="dropCheckpoint")return await this.checkpoint(args.name,true);
   if(action==="gcPlan")return await this.gc.plan(args);
   if(action==="gcStep")return await this.gc.step(args.id);
   if(action==="backupStart")return await this.backups.start(args);
   if(action==="backupStep")return await this.backups.step(args.id);
   if(action==="backupCancel")return await this.backups.cancel(args.id);
   if(action==="backupRenew")return await this.backups.renew(args.id);
   if(action==="history")return await this.pins.read(args.id,this.now(),async(s,io)=>{if(!s.historyRefs.some(ref=>hashJson(ref)===hashJson(args.ref)))fail("FORBIDDEN","History version was not included in this pin");return readVersion(io,args.ref,(await new PageStore(io).read(s.locatorRootHash,"locator")));});
   if(action==="verify")return {verified:true,files:(await protectedPaths(this.owner)).paths.size};
   if(action==="usage")return {...await this.files.usage(),pins:this.pins.status()};
   fail("INVALID_INPUT","Unknown lifecycle operation");
  }catch(e){if(e.barrier||e.details?.storageIntegrity||["INTEGRITY_ERROR","EIO","ENOENT"].includes(e.code)){this.owner.state="read-only-recovery";this.owner.problem={code:"RECOVERY_REQUIRED",cause:e.code??"IO_ERROR",message:String(e.message).slice(0,300)};}throw e;}
 }
}
