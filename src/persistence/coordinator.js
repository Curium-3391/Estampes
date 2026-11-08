// Internal storage coordinator. Accepts already-domain-validated snapshots;
// never registers a tool, authorizes a host action or mutates the legacy store.
import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readdir } from "node:fs/promises";
import { parse, canonicalJson, hashJson, RevisionSchema } from "../documents/validation.js";
import { createId, normalizeRequestId } from "../documents/identity.js";
import { ActorContextSchema, assertCreatorUnchanged } from "../documents/provenance.js";
import { parseCommitRoot } from "./commit-root-schema.js";
import { ManagedFiles, StagingPlan } from "./filesystem.js";
import { PageStore } from "./pages.js";
import { IntentJournal, transactionPath } from "./journal.js";
import { CommitCommandSchema, FormatSchema, AckSchema, LedgerEntrySchema, VerificationCache, replayLedgerEntry, loadCommitted, verifyPreparedClosure, versionPath, closure, logicalClosureHash } from "./records.js";
import { assertOwnedWriterLease, inspectPlatform } from "./platform.js";
import { LifecycleManager } from "./lifecycle.js";
import { initialPolicy, policyOf, DAY } from "./lifecycle-state.js";
import { stageDelta } from "./archive.js";
import { fail, integrity, PersistenceError } from "./errors.js";
import { recoverBootstrapTemporary, classifyTemporaryClaims } from "./temporary-attribution.js";

// Whole-store recovery points kept besides named checkpoints (owner decision 2026-11-06).
export const RECOVERY_POINTS=20;
export const ANCHOR_SPAN=32;
export const RECLAIM_EVERY=32;
const stablePrincipal = actor => {
  const p=actor.principal;
  if(p.kind==="user"||p.kind==="assistant")return {owner:actor.authenticatedOwnerId,kind:p.kind,principalId:p.principalId};
  if(p.kind==="module")return {owner:actor.authenticatedOwnerId,kind:p.kind,moduleId:p.moduleId,ownershipLineageId:p.ownershipLineageId};
  fail("FORBIDDEN","Historical/import principals are not authenticated command initiators");
};
// These values are already strict, finite JSON from command/committed closure
// validation. Equality matches canonical JSON, including object key order and -0.
const sameData=(a,b)=>{
  if(a===b)return true;
  if(a===null||b===null||typeof a!=="object"||typeof b!=="object"||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&sameData(a[key],b[key]));
};
const storedValidatedDocument=d=>{const {bindings,...document}=d;return {schema:"estampes.document-record/1",document,bindingIds:bindings.map(b=>b.id)};};
function checkRevisions(before,after){
  if(!before){integrity(after.revision===1&&after.scenes.every(s=>s.revision===1),"New Document/Scenes must start at revision one");return;}
  integrity(before.kind===after.kind&&before.createdAt===after.createdAt&&canonicalJson(before.provenance)===canonicalJson(after.provenance),"Immutable Document identity/provenance changed");
  const omit=(v,keys)=>Object.fromEntries(Object.entries(v).filter(([k])=>!keys.includes(k)));
  const changed=!sameData(omit(before,["revision","updatedAt"]),omit(after,["revision","updatedAt"]));
  integrity(after.revision===before.revision+(changed?1:0),"Document revision must change exactly once for a content change");
  for(const scene of after.scenes){
    const old=before.scenes.find(s=>s.id===scene.id);
    integrity(scene.revision===(old?old.revision+(sameData(omit(old,["revision"]),omit(scene,["revision"]))?0:1):1),"Scene revision differs from actual content change");
    for(const field of ["objects","annotations"])for(const entity of scene[field]){
      const prior=old?.[field].find(e=>e.id===entity.id);
      if(!prior){integrity(entity.revision===1,"New entity must start at revision one");continue;}
      assertCreatorUnchanged(prior.provenance,entity.provenance);
      integrity(entity.revision===prior.revision+(sameData(omit(prior,["revision"]),omit(entity,["revision"]))?0:1),"Entity revision differs from actual change");
    }
  }
}
export class CommitCoordinator {
  constructor(files,platform){this.files=files;this.platform=platform;this.journal=new IntentJournal(files);this.state="opening";this.current=null;this.queue=Promise.resolve();this.seen=new Map();this.recoveryReport=[];this.lifecycle=null;this.verification=new VerificationCache();this.performance={open:null,transactions:[]};}
  async open(options){
    if(this.state!=="opening")fail("INVALID_INPUT","Coordinator can only be opened once");
    this.platform=await inspectPlatform(this.files.root,this.platform.profile,this.platform.purpose);
    await assertOwnedWriterLease(this.files.root);
    try{
      await this.files.auditBoundary();
      const scan={};await recoverBootstrapTemporary(this.files,scan);
      const hasFormat=await this.files.exists("storage-format.json"),hasCurrent=await this.files.exists("visual-registry/CURRENT.json");
      if(!hasFormat){
        this.format=parse(FormatSchema,{schema:"estampes.isolated-store/1",storeInstanceId:randomUUID(),purpose:"isolated-pr1c-testing",profile:this.platform.profile,
          quotaBytes:options.quotaBytes??(options.lifecycle?10*1024**3:256*1024*1024),maxContentCommits:options.maxContentCommits??100,...(options.lifecycle?{lifecycle:options.lifecycle}:{})});
        await this.files.atomic("storage-format.json",Buffer.from(canonicalJson(this.format)),"bootstrap",{owner:{kind:"bootstrap",id:randomUUID()}});
      }else this.format=parse(FormatSchema,await this.files.json("storage-format.json",4096));
      integrity(this.format.profile===this.platform.profile,"Stored profile differs; test stores cannot be promoted to durable");
      if(!hasCurrent){
        // A format rename can survive while genesis has not started. Resume only
        // when no transaction exists; a missing CURRENT from any established
        // store remains an integrity failure rather than an implicit reset.
        if(await this.files.exists("visual-transactions"))integrity((await readdir(this.files.path("visual-transactions"))).length===0,"CURRENT is missing from a non-pristine store");
        await this.files.ensureDirectory("visual-transactions");
        if(this.format.lifecycle)this.installLifecycle(this.format.lifecycle,options.testClockMs);
        await this.#publish(null,null,"genesis");
      }else{
        // A copied, restricted backup has no physical deletion authority in
        // this tree. Verify its logical closure without replaying source GC.
        const restricted=await this.files.exists("restore-restriction.json");
        if(!restricted)await LifecycleManager.recoverPhysical(this.files);
        const verifyStarted=performance.now();
        this.current=await loadCommitted(this.files,{cache:this.verification,metrics:this.performance,history:false});
        this.performance.open={verifyCommittedMs:performance.now()-verifyStarted};
        integrity(this.current.root.storeInstanceId===this.format.storeInstanceId,"Store namespace differs from CURRENT");
        if(this.current.lifecycle||options.lifecycle||this.format.lifecycle)this.installLifecycle(this.current.lifecycle?.options??options.lifecycle??this.format.lifecycle,options.testClockMs);
        if(restricted){this.state="read-only-recovery";this.problem={code:"RECOVERY_REQUIRED",cause:"RESTORED_BACKUP_REQUIRES_CONTINUATION_PROOF"};return this;}
        // Re-establish all file/directory barriers after an interrupted publish.
        // A transaction's files are durable before its CURRENT is published, and its
        // outcome is written only after that publication is durable. So only a
        // selected root whose outcome is missing can have unsettled barriers.
        const settled=await this.files.exists(transactionPath(this.current.root.commitId)+"/outcome.json");
        for(const path of settled?["visual-registry/CURRENT.json"]:this.current.files)await this.files.resync(path);
        await this.files.resync("storage-format.json");
        const report=await this.journal.recover(this.current,{settledBefore:this.current.root.generation-RECOVERY_POINTS});const temporaries=await classifyTemporaryClaims(this.files,this.current,scan);this.seen=report.seen;this.recoveryReport=[...report.outcomes,...temporaries.outcomes];
        await this.#publish(null,null,"recovery-epoch",{name:"temporary-recovery",mutate:async()=>({retentionChanges:temporaries.changes,result:{temporaries:temporaries.outcomes.length}})});
      }
      this.state="ready";
      if(this.lifecycle)await this.lifecycle.onOpen();
    }catch(e){this.state="read-only-recovery";this.problem={code:"RECOVERY_REQUIRED",cause:e.code??"IO_ERROR",message:String(e.message).slice(0,300)};}
    return this;
  }
  installLifecycle(options,clockMs){this.lifecycle=new LifecycleManager(this,options,(name,mutate,metadata)=>this.#publish(null,null,"maintenance",{name,mutate,metadata}),clockMs);}
  async maintenance(action,args={}){
    if(action==="readPin"&&this.lifecycle)return this.lifecycle.readPin(args.id);
    const run=async()=>{if(this.state!=="ready")fail("RECOVERY_REQUIRED","Writer is not ready");if(!this.lifecycle)fail("UNSUPPORTED_TARGET","Lifecycle requires explicit isolated opt-in");return this.lifecycle.run(action,args);};
    const result=this.queue.then(run);this.queue=result.catch(()=>{});return result;
  }
  snapshot(){if(!this.current)fail("RECOVERY_REQUIRED","No verified committed snapshot is available");return structuredClone({root:this.current.root,envelope:this.current.envelope,documents:this.current.documents,authority:this.current.authority,state:this.state});}
  diagnostics(){return {state:this.state,problem:this.problem??null,platform:this.platform,filesystemTrust:this.files.trust??null,recovery:this.recoveryReport,trace:[...this.files.trace],contentCommits:this.current?.indices.ledger.size??0,lifecycle:this.lifecycle?.status()??null,reclaim:this.reclaim??null,performance:structuredClone(this.performance)};}
  commit(input,actorInput,expectedEpoch){
    // Parse/copy immediately, before queueing; caller changes cannot alter a pending command.
    const command=parse(CommitCommandSchema,input),actor=parse(ActorContextSchema,actorInput);parse(RevisionSchema,expectedEpoch);
    const run=async()=>{
      if(this.state!=="ready")fail("RECOVERY_REQUIRED","Writer is not ready",this.problem);
      const key={storeInstanceId:this.format.storeInstanceId,principalDigest:hashJson(stablePrincipal(actor)),commandId:normalizeRequestId(command.requestId)},digest=hashJson(key);
      const payloadHash=hashJson({route:"isolated.document.commit/1",command}),prior=this.current.indices.ledger.get(digest);
      if(prior){if(this.lifecycle&&prior.kind==="ack"&&this.lifecycle.canAge()&&this.lifecycle.now()-Date.parse(prior.acceptedAt)>=7*DAY)await this.lifecycle.compactLedger([digest]);return replayLedgerEntry(this.current.indices.ledger.get(digest),payloadHash);}
      if(this.seen.has(digest)&&this.seen.get(digest)!==payloadHash)fail("IDEMPOTENCY_MISMATCH","Durable intent is bound to another payload");
      if(expectedEpoch!==this.current.authority.epoch)fail("STALE_AUTHORITY","Execution lease belongs to a previous writer epoch");
      if(this.lifecycle)await this.lifecycle.admit();
      if(!this.lifecycle&&this.current.indices.ledger.size>=this.format.maxContentCommits)fail("STORAGE_UNAVAILABLE","Isolated commit budget reached; PR-1D maintenance is not enabled");
      return this.#publish(command,{key,digest,payloadHash},"content");
    };
    const result=this.queue.then(run);this.queue=result.catch(()=>{});
    // Unreachable index pages are reclaimed on the same serialized queue, after
    // the ACK is returned, every RECLAIM_EVERY commit requests. Only an integrity
    // failure fences the writer (inside the sweep); anything else is reported in
    // diagnostics and retried at the next interval, never failing the commit.
    if(this.lifecycle)this.queue=this.queue.then(async()=>{
      this.sinceReclaim=(this.sinceReclaim??0)+1;if(this.state!=="ready"||this.sinceReclaim<RECLAIM_EVERY)return;this.sinceReclaim=0;
      try{this.reclaim=await this.lifecycle.run("reclaimPages",{});}catch(e){this.reclaim={error:e.code??"IO_ERROR",message:String(e.message).slice(0,200)};}
    });
    return result;
  }
  async #publish(command,request,mode,maintenance=null){
    const transactionStarted=performance.now(),timings={mode};let stageStarted=transactionStarted;
    const before=this.current,generation=(before?.root.generation??0)+1,commitId=createId("tx"),acceptedAt=new Date(this.lifecycle?this.lifecycle.acceptedTime():Date.now()).toISOString(),plan=new StagingPlan(this.files),pages=new PageStore(this.files,plan);
    const registry=new Map(before?.indices.registry??[]),documentMap=new Map((before?.documents??[]).map(d=>[d.id,d])),registryChanges=new Map(),locatorChanges=new Map(),after=[],unchangedDocuments=new Set();
    let intentWritten=false,publicationAttempted=false,reservation=null;
    let maintenanceResult=null,overrides={};
    try{
      await this.files.auditBoundary();
      if(before&&canonicalJson(await this.files.json("visual-registry/CURRENT.json",64*1024))!==canonicalJson(before.envelope))fail("INTEGRITY_ERROR","CURRENT drift outside writer coordinator",{storageIntegrity:true});
      if(command){
        const touched=new Set();
        for(const change of command.changes){const d=change.document,old=documentMap.get(d.id);
          integrity(!touched.has(d.id),"Duplicate Document in transaction");touched.add(d.id);
          if(change.expectedRevision!== (old?.revision??null))fail("CONFLICT","Document revision changed",{documentId:d.id,currentRevision:old?.revision??null});
          integrity(d.persistence===(this.platform.durability==="durable"?"durable":"memory"),"Document persistence is deployment-derived");
          checkRevisions(old,d);documentMap.set(d.id,d);
        }
        for(const expected of command.readSet??[]){const old=before.documents.find(d=>d.id===expected.documentId);
          if(!old||old.revision!==expected.revision||hashJson(old)!==expected.contentHash)fail("CONFLICT","Read dependency revision/hash changed");}
        closure([...documentMap.values()],this.format.storeInstanceId,generation);
        // Registry is the only writable binding authority. Repeated materialized
        // projections must be identical; domain resolvers may not persist denied projections.
        const canonicalBindings=new Map();
        for(const d of documentMap.values())for(const binding of d.bindings){
          if(canonicalBindings.has(binding.id))integrity(canonicalJson(canonicalBindings.get(binding.id))===canonicalJson(binding),"Conflicting binding projections");
          canonicalBindings.set(binding.id,binding);registryChanges.set("binding:"+binding.id,binding);
        }
        for(const key of registry.keys())if(key.startsWith("binding:")&&!canonicalBindings.has(key.slice(8)))registryChanges.set(key,undefined);
        for(const change of command.changes){const d=change.document,record=storedValidatedDocument(d),encoded=Buffer.from(canonicalJson(record)),ref={storeInstanceId:this.format.storeInstanceId,entityId:d.id,revision:d.revision,contentHash:hashJsonBytes(encoded)};
          const oldRef=before?.indices.registry.get("entity:"+d.id),oldLocator=oldRef?before.indices.locator.get(hashJson(oldRef)):null;
          let delta=null;
          if(this.lifecycle&&oldRef&&hashJson(oldRef)!==hashJson(ref))delta=stageDelta(plan,storedValidatedDocument(before.documents.find(v=>v.id===d.id)),record,oldRef,ref,oldLocator,encoded.length);
          const unchanged=oldRef&&hashJson(oldRef)===hashJson(ref);
          if(unchanged&&sameData(d.bindings,before.documents.find(v=>v.id===d.id).bindings))unchangedDocuments.add(d.id);
          // A full operational copy every ANCHOR_SPAN revisions bounds the delta chain a
          // reader has to apply; the lossless delta stays recorded beside it.
          const operational=this.lifecycle&&d.revision%ANCHOR_SPAN===0;
          if(!unchanged&&(!delta||operational)){integrity(encoded.length<=64*1024*1024,"Document record exceeds byte limit");plan.addBytes(versionPath(ref),encoded);}
          registryChanges.set("entity:"+d.id,ref);after.push(ref);
          locatorChanges.set(hashJson(ref),unchanged?oldLocator:delta&&!operational?delta:{logical:ref,kind:"full",relativePath:versionPath(ref),bytes:encoded.length,...(delta?{alternative:delta}:{})});
        }
      }
      if(maintenance){overrides=await maintenance.mutate({before,plan,pages,commitId,generation});maintenanceResult=overrides.result??{};for(const [key,value]of overrides.locatorChanges??[])locatorChanges.set(key,value);}
      for(const [key,value]of registryChanges)if(value===undefined)registry.delete(key);else registry.set(key,value);
      const roots={};
      roots.registry=await pages.update(before?.root.roots.registry,"registry",registryChanges,before?.indices.registry);
      roots.locator=await pages.update(before?.root.roots.locator,"locator",locatorChanges,before?.indices.locator);
      const epoch=(before?.authority.epoch??0)+(["content","maintenance"].includes(mode)?0:1);
      const authority={schema:"estampes.isolated-authority/1",storeInstanceId:this.format.storeInstanceId,epoch,mode:"isolated-testing",profile:this.platform.profile};
      roots.authority=await pages.update(before?.root.roots.authority,"authority",new Map([["store",authority]]),before?.indices.authority);
      const ack=command?parse(AckSchema,{schema:"estampes.commit-ack/1",commitId,resultId:createId("event"),durability:this.platform.durability,
        noChange:command.changes.every(c=>unchangedDocuments.has(c.document.id)),revisionVector:after}):null;
      const resultHash=hashJson(ack??{mode,epoch,result:maintenanceResult}),payloadHash=request?.payloadHash??hashJson({mode,epoch,maintenance:maintenance?.name??null,metadata:maintenance?.metadata??null});
      const member={commitId,generation,registryRootHash:roots.registry,requestKeyDigest:request?.digest??null,payloadHash,resultHash,outcome:"committed"};
      const ledgerChange=new Map();
      if(request)ledgerChange.set(request.digest,parse(LedgerEntrySchema,{kind:"ack",key:request.key,payloadHash,commitId,resultHash,acceptedAt,ack}));
      for(const [key,value]of overrides.ledgerChanges??[])ledgerChange.set(key,value);
      roots.ledger=await pages.update(before?.root.roots.ledger,"ledger",ledgerChange,before?.indices.ledger);
      roots.commitIndex=await pages.update(before?.root.roots.commitIndex,"commitIndex",new Map([[commitId,member]]),before?.indices.commitIndex);
      const retentionChanges=new Map(overrides.retentionChanges??[]),neededRegistries=new Set([roots.registry]);
      if(this.lifecycle){
        const now=this.lifecycle.now(),prior=policyOf(before?.indices.retention),policy=retentionChanges.get("lifecycle")??structuredClone(prior??initialPolicy(this.lifecycle.options,this.lifecycle.acceptedTime()));
        policy.highWaterMs=Math.max(policy.highWaterMs,prior?.highWaterMs??0,now);policy.committedAtMs=Math.max(policy.highWaterMs,now);
        if(mode==="content")policy.contentSinceMaintenance++;
        if(policy.contentSinceMaintenance>=100&&policy.maintenance.state==="idle")policy.maintenance.state="scheduled";
        retentionChanges.set("lifecycle",policy);
        if(before){retentionChanges.set("recovery:"+before.root.generation,{schema:"estampes.recovery-root/1",envelope:before.envelope,committedAtMs:prior?.committedAtMs??now});}
        // Store-wide recovery points are bounded: the newest RECOVERY_POINTS plus
        // named checkpoints. Each Document's own history stays lossless in the
        // locator/archive; only whole-store roll-back targets are bounded, so open
        // time and per-commit index writes no longer grow with every commit.
        const merged=new Map([...(before?.indices.retention??[]),...retentionChanges]);
        const recoveries=[...merged].filter(([key,value])=>key.startsWith("recovery:")&&value!==undefined).sort((a,b)=>b[1].envelope.generation-a[1].envelope.generation);
        for(const [i,[key]]of recoveries.entries())if(i>=RECOVERY_POINTS)retentionChanges.set(key,undefined);
        const reader=new PageStore(this.files);
        for(const [,value]of recoveries.slice(0,RECOVERY_POINTS))neededRegistries.add(parseCommitRoot(await reader.hashed(value.envelope.rootHash,"visual-registry/roots",64*1024)).roots.registry);
        for(const [key,value]of merged)if(key.startsWith("checkpoint:")&&value)neededRegistries.add(value.registryRootHash);
        for(const [key,value]of before?.indices.retention??[])
          if(key.startsWith("checkpoint:")&&!retentionChanges.has(key))retentionChanges.set(key,{...value,resolverLocatorRootHash:roots.locator});
      }
      // A resolver row is written once, while its registry is current. The Locator
      // only ever gains rows (compaction swaps a row's representation, never its
      // logical version), so the current Locator resolves every retained registry
      // and rows are no longer rewritten on each commit: that rewrite made most
      // of each commit's new index pages.
      for(const [key,value]of before?.indices.retention??[])
        if(key.startsWith("registry:")&&!retentionChanges.has(key)&&!neededRegistries.has(value.registryRootHash))retentionChanges.set(key,undefined);
      retentionChanges.set("registry:"+roots.registry,{registryRootHash:roots.registry,logicalClosureHash:logicalClosureHash(registry),resolverLocatorRootHash:roots.locator});
      roots.retention=await pages.update(before?.root.roots.retention,"retention",retentionChanges,before?.indices.retention);
      const root=parseCommitRoot({schema:"estampes.commit-root/1",storeInstanceId:this.format.storeInstanceId,generation,commitId,parentCommitHash:before?.envelope.rootHash??null,roots});
      const rootHash=plan.blob(root,{folder:"visual-registry/roots",limit:64*1024,label:"root"}),head={generation,rootHash,commitId},envelope={...head,checksum:hashJson(head)};
      const intent={schema:"estampes.transaction-intent/1",commitId,storeInstanceId:this.format.storeInstanceId,mode,baseRootHash:before?.envelope.rootHash??null,baseGeneration:before?.root.generation??0,
        requestKeyDigest:request?.digest??null,payloadHash,acceptedAt,after,...(this.lifecycle?{stagedFiles:[...plan.records].map(([path,r])=>({path,hash:hashJsonBytes(r.bytes),bytes:r.bytes.length}))}:{})};
      if(this.lifecycle){
        if(mode==="maintenance")integrity(plan.bytes<=32*1024**2&&plan.records.size<=128,"Maintenance batch exceeds bounded work budget");
        reservation=await this.lifecycle.reserve(commitId,plan.allocationEstimate()+Buffer.byteLength(canonicalJson(intent))+128*1024,mode!=="content",retentionChanges);
      }else await this.files.preflight(plan.bytes+Buffer.byteLength(canonicalJson(intent))+128*1024,this.format.quotaBytes,Math.max(64*1024*1024,Math.ceil(this.format.quotaBytes*0.01)));
      timings.buildAndPreflightMs=performance.now()-stageStarted;stageStarted=performance.now();
      await this.files.point("before-intent");await this.journal.intent(intent);intentWritten=true;
      if(request)this.seen.set(request.digest,payloadHash);
      await this.files.point("after-intent-durable");
      const temporaryOwner={kind:"transaction",id:commitId.slice(3)};
      await plan.flush(record=>record.label!=="root",temporaryOwner);await this.files.point("after-staged-writes");
      await plan.flush(record=>record.label==="root",temporaryOwner);await this.journal.prepare({schema:"estampes.prepared/1",commitId,generation,rootHash});
      timings.stageAndPrepareMs=performance.now()-stageStarted;stageStarted=performance.now();
      await this.files.point("after-prepared");
      const prepared=await verifyPreparedClosure(this.files,envelope,{cache:this.verification,metrics:this.performance,history:false});
      timings.candidateVerificationMs=performance.now()-stageStarted;stageStarted=performance.now();
      if(before&&canonicalJson(await this.files.json("visual-registry/CURRENT.json",64*1024))!==canonicalJson(before.envelope))fail("INTEGRITY_ERROR","CURRENT changed during preparation",{storageIntegrity:true});
      publicationAttempted=true;await this.files.atomic("visual-registry/CURRENT.json",Buffer.from(canonicalJson(envelope)),"current",{owner:temporaryOwner,beforeRename:()=>prepared.verifyObservation()});
      await this.files.point("after-publication-durable");
      timings.currentPublicationMs=performance.now()-stageStarted;stageStarted=performance.now();
      const selected=await this.files.json("visual-registry/CURRENT.json",64*1024);
      integrity(canonicalJson(selected)===canonicalJson(envelope),"Published CURRENT differs from prepared envelope");
      // Candidate closure verification already covered every reachable file. Re-read
      // the newly staged inventory after CURRENT publication to detect replacement
      // between verification and selection without reconstructing all old versions.
      for(const [path,record]of plan.records){const digest=await this.files.digest(path);integrity(digest.bytes===record.bytes.length&&digest.hash===hashJsonBytes(record.bytes),"Published staged file changed after candidate verification");}
      integrity(prepared.envelope.rootHash===rootHash,"Published root changed under writer lease");
      await this.journal.outcome(commitId,member);
      await this.files.point("before-ack");
      await prepared.verifyObservation();this.current=prepared;
      timings.postPublicationMs=performance.now()-stageStarted;timings.totalMs=performance.now()-transactionStarted;
      this.performance.transactions.push(timings);if(this.performance.transactions.length>64)this.performance.transactions.shift();
      return {ack,replayed:false,...(maintenance?{result:maintenanceResult,envelope:prepared.envelope}:{})};
    }catch(e){
      if(publicationAttempted||e.barrier||e.details?.storageIntegrity||["EIO","EROFS","EACCES"].includes(e.code)){
        this.state="read-only-recovery";this.problem={code:"RECOVERY_REQUIRED",cause:e.code??"IO_ERROR",message:String(e.message).slice(0,300)};
        throw new PersistenceError("RECOVERY_REQUIRED","Commit outcome requires recovery; no durable ACK emitted",this.problem);
      }
      if(intentWritten){try{await this.journal.outcome(commitId,null);}catch(outcomeError){this.state="read-only-recovery";this.problem={code:"RECOVERY_REQUIRED",cause:outcomeError.code??"IO_ERROR"};}}
      if(e.code==="ENOSPC")throw new PersistenceError("STORAGE_UNAVAILABLE","No space during preparation; no commit ACK emitted");
      throw e;
    }finally{if(reservation)this.lifecycle.capacity.release(commitId);}
  }
}
export const readCommittedSnapshot=async root=>{
  const snapshot=await loadCommitted(new ManagedFiles(root));return structuredClone({root:snapshot.root,envelope:snapshot.envelope,documents:snapshot.documents,authority:snapshot.authority});
};

const hashJsonBytes=bytes=>createHash("sha256").update(bytes).digest("hex");
