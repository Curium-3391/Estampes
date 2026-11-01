// Internal storage coordinator. Accepts already-domain-validated snapshots;
// never registers a tool, authorizes a host action or mutates the legacy store.
import { randomUUID } from "node:crypto";
import { parse, canonicalJson, hashJson, RevisionSchema } from "../documents/validation.js";
import { createId, normalizeRequestId } from "../documents/identity.js";
import { ActorContextSchema, assertCreatorUnchanged } from "../documents/provenance.js";
import { parseCommitRoot } from "./commit-root-schema.js";
import { ManagedFiles, StagingPlan } from "./filesystem.js";
import { PageStore } from "./pages.js";
import { IntentJournal } from "./journal.js";
import { CommitCommandSchema, FormatSchema, AckSchema, LedgerEntrySchema, replayLedgerEntry, loadCommitted, verifyPreparedClosure, storeDocument, versionPath, closure, logicalClosureHash } from "./records.js";
import { assertOwnedWriterLease, inspectPlatform } from "./platform.js";
import { fail, integrity, PersistenceError } from "./errors.js";

const stablePrincipal = actor => {
  const p=actor.principal;
  if(p.kind==="user"||p.kind==="assistant")return {owner:actor.authenticatedOwnerId,kind:p.kind,principalId:p.principalId};
  if(p.kind==="module")return {owner:actor.authenticatedOwnerId,kind:p.kind,moduleId:p.moduleId,ownershipLineageId:p.ownershipLineageId};
  fail("FORBIDDEN","Historical/import principals are not authenticated command initiators");
};
function checkRevisions(before,after){
  if(!before){integrity(after.revision===1&&after.scenes.every(s=>s.revision===1),"New Document/Scenes must start at revision one");return;}
  integrity(before.kind===after.kind&&before.createdAt===after.createdAt&&canonicalJson(before.provenance)===canonicalJson(after.provenance),"Immutable Document identity/provenance changed");
  const omit=(v,keys)=>Object.fromEntries(Object.entries(v).filter(([k])=>!keys.includes(k)));
  const changed=canonicalJson(omit(before,["revision","updatedAt"]))!==canonicalJson(omit(after,["revision","updatedAt"]));
  integrity(after.revision===before.revision+(changed?1:0),"Document revision must change exactly once for a content change");
  for(const scene of after.scenes){
    const old=before.scenes.find(s=>s.id===scene.id);
    integrity(scene.revision===(old?old.revision+(canonicalJson(omit(old,["revision"]))===canonicalJson(omit(scene,["revision"]))?0:1):1),"Scene revision differs from actual content change");
    for(const field of ["objects","annotations"])for(const entity of scene[field]){
      const prior=old?.[field].find(e=>e.id===entity.id);
      if(!prior){integrity(entity.revision===1,"New entity must start at revision one");continue;}
      assertCreatorUnchanged(prior.provenance,entity.provenance);
      integrity(entity.revision===prior.revision+(canonicalJson(omit(prior,["revision"]))===canonicalJson(omit(entity,["revision"]))?0:1),"Entity revision differs from actual change");
    }
  }
}
export class CommitCoordinator {
  constructor(files,platform){this.files=files;this.platform=platform;this.journal=new IntentJournal(files);this.state="opening";this.current=null;this.queue=Promise.resolve();this.seen=new Map();this.recoveryReport=[];}
  async open(options){
    if(this.state!=="opening")fail("INVALID_INPUT","Coordinator can only be opened once");
    this.platform=await inspectPlatform(this.files.root,this.platform.profile,this.platform.purpose);
    await assertOwnedWriterLease(this.files.root);
    try{
      if(!await this.files.exists("storage-format.json")){
        this.format=parse(FormatSchema,{schema:"estampes.isolated-store/1",storeInstanceId:randomUUID(),purpose:"isolated-pr1c-testing",profile:this.platform.profile,
          quotaBytes:options.quotaBytes??256*1024*1024,maxContentCommits:options.maxContentCommits??100});
        await this.files.atomic("storage-format.json",Buffer.from(canonicalJson(this.format)),"bootstrap");
        await this.files.ensureDirectory("visual-transactions");
        await this.#publish(null,null,"genesis");
      }else{
        this.format=parse(FormatSchema,await this.files.json("storage-format.json",4096));
        integrity(this.format.profile===this.platform.profile,"Stored profile differs; test stores cannot be promoted to durable");
        this.current=await loadCommitted(this.files);integrity(this.current.root.storeInstanceId===this.format.storeInstanceId,"Store namespace differs from CURRENT");
        // Re-establish all file/directory barriers after an interrupted publish.
        for(const path of this.current.files)await this.files.resync(path);
        await this.files.resync("storage-format.json");
        const report=await this.journal.recover(this.current);this.seen=report.seen;this.recoveryReport=report.outcomes;
        await this.#publish(null,null,"recovery-epoch");
      }
      this.state="ready";
    }catch(e){this.state="read-only-recovery";this.problem={code:"RECOVERY_REQUIRED",cause:e.code??"IO_ERROR",message:String(e.message).slice(0,300)};}
    return this;
  }
  snapshot(){if(!this.current)fail("RECOVERY_REQUIRED","No verified committed snapshot is available");return structuredClone({root:this.current.root,envelope:this.current.envelope,documents:this.current.documents,authority:this.current.authority,state:this.state});}
  diagnostics(){return {state:this.state,problem:this.problem??null,platform:this.platform,recovery:this.recoveryReport,trace:[...this.files.trace],contentCommits:this.current?.indices.ledger.size??0};}
  commit(input,actorInput,expectedEpoch){
    // Parse/copy immediately, before queueing; caller changes cannot alter a pending command.
    const command=parse(CommitCommandSchema,input),actor=parse(ActorContextSchema,actorInput);parse(RevisionSchema,expectedEpoch);
    const run=async()=>{
      if(this.state!=="ready")fail("RECOVERY_REQUIRED","Writer is not ready",this.problem);
      const key={storeInstanceId:this.format.storeInstanceId,principalDigest:hashJson(stablePrincipal(actor)),commandId:normalizeRequestId(command.requestId)},digest=hashJson(key);
      const payloadHash=hashJson({route:"isolated.document.commit/1",command}),prior=this.current.indices.ledger.get(digest);
      if(prior)return replayLedgerEntry(prior,payloadHash);
      if(this.seen.has(digest)&&this.seen.get(digest)!==payloadHash)fail("IDEMPOTENCY_MISMATCH","Durable intent is bound to another payload");
      if(expectedEpoch!==this.current.authority.epoch)fail("STALE_AUTHORITY","Execution lease belongs to a previous writer epoch");
      if(this.current.indices.ledger.size>=this.format.maxContentCommits)fail("STORAGE_UNAVAILABLE","Isolated commit budget reached; PR-1D maintenance is not enabled");
      return this.#publish(command,{key,digest,payloadHash},"content");
    };
    const result=this.queue.then(run);this.queue=result.catch(()=>{});return result;
  }
  async #publish(command,request,mode){
    const before=this.current,generation=(before?.root.generation??0)+1,commitId=createId("tx"),acceptedAt=new Date().toISOString(),plan=new StagingPlan(this.files),pages=new PageStore(this.files,plan);
    const registry=new Map(before?.indices.registry??[]),documentMap=new Map((before?.documents??[]).map(d=>[d.id,d])),registryChanges=new Map(),locatorChanges=new Map(),after=[];
    let intentWritten=false,publicationAttempted=false;
    try{
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
        for(const change of command.changes){const d=change.document,record=storeDocument(d),ref={storeInstanceId:this.format.storeInstanceId,entityId:d.id,revision:d.revision,contentHash:hashJson(record)};
          plan.add(versionPath(ref),record,64*1024*1024);registryChanges.set("entity:"+d.id,ref);after.push(ref);
          locatorChanges.set(hashJson(ref),{logical:ref,kind:"full",relativePath:versionPath(ref),bytes:Buffer.byteLength(canonicalJson(record))});
        }
      }
      for(const [key,value]of registryChanges)if(value===undefined)registry.delete(key);else registry.set(key,value);
      const roots={};
      roots.registry=await pages.update(before?.root.roots.registry,"registry",registryChanges);
      roots.locator=await pages.update(before?.root.roots.locator,"locator",locatorChanges);
      const epoch=(before?.authority.epoch??0)+(mode==="content"?0:1);
      const authority={schema:"estampes.isolated-authority/1",storeInstanceId:this.format.storeInstanceId,epoch,mode:"isolated-testing",profile:this.platform.profile};
      roots.authority=await pages.update(before?.root.roots.authority,"authority",new Map([["store",authority]]));
      const ack=command?parse(AckSchema,{schema:"estampes.commit-ack/1",commitId,resultId:createId("event"),durability:this.platform.durability,
        noChange:command.changes.every(c=>before.documents.some(d=>d.id===c.document.id&&canonicalJson(d)===canonicalJson(c.document))),revisionVector:after}):null;
      const resultHash=hashJson(ack??{mode,epoch}),payloadHash=request?.payloadHash??hashJson({mode,epoch});
      const member={commitId,generation,registryRootHash:roots.registry,requestKeyDigest:request?.digest??null,payloadHash,resultHash,outcome:"committed"};
      const ledgerChange=new Map();
      if(request)ledgerChange.set(request.digest,parse(LedgerEntrySchema,{kind:"ack",key:request.key,payloadHash,commitId,resultHash,acceptedAt,ack}));
      roots.ledger=await pages.update(before?.root.roots.ledger,"ledger",ledgerChange);
      roots.commitIndex=await pages.update(before?.root.roots.commitIndex,"commitIndex",new Map([[commitId,member]]));
      roots.retention=await pages.update(before?.root.roots.retention,"retention",new Map([["registry:"+roots.registry,{registryRootHash:roots.registry,logicalClosureHash:logicalClosureHash(registry),resolverLocatorRootHash:roots.locator}]]));
      const root=parseCommitRoot({schema:"estampes.commit-root/1",storeInstanceId:this.format.storeInstanceId,generation,commitId,parentCommitHash:before?.envelope.rootHash??null,roots});
      const rootHash=plan.blob(root,{folder:"visual-registry/roots",limit:64*1024,label:"root"}),head={generation,rootHash,commitId},envelope={...head,checksum:hashJson(head)};
      const intent={schema:"estampes.transaction-intent/1",commitId,storeInstanceId:this.format.storeInstanceId,mode,baseRootHash:before?.envelope.rootHash??null,baseGeneration:before?.root.generation??0,
        requestKeyDigest:request?.digest??null,payloadHash,acceptedAt,after};
      await this.files.preflight(plan.bytes+Buffer.byteLength(canonicalJson(intent))+128*1024,this.format.quotaBytes,Math.max(64*1024*1024,Math.ceil(this.format.quotaBytes*0.01)));
      await this.files.point("before-intent");await this.journal.intent(intent);intentWritten=true;
      if(request)this.seen.set(request.digest,payloadHash);
      await this.files.point("after-intent-durable");
      await plan.flush(record=>record.label!=="root");await this.files.point("after-staged-writes");
      await plan.flush(record=>record.label==="root");await this.journal.prepare({schema:"estampes.prepared/1",commitId,generation,rootHash});
      await this.files.point("after-prepared");
      await verifyPreparedClosure(this.files,envelope);
      publicationAttempted=true;await this.files.atomic("visual-registry/CURRENT.json",Buffer.from(canonicalJson(envelope)),"current");
      await this.files.point("after-publication-durable");
      const committed=await loadCommitted(this.files);integrity(committed.envelope.rootHash===rootHash,"Published root changed under writer lease");
      await this.journal.outcome(commitId,member);this.current=committed;
      await this.files.point("before-ack");
      return {ack,replayed:false};
    }catch(e){
      if(publicationAttempted||e.barrier||e.details?.storageIntegrity||["EIO","EROFS","EACCES"].includes(e.code)){
        this.state="read-only-recovery";this.problem={code:"RECOVERY_REQUIRED",cause:e.code??"IO_ERROR",message:String(e.message).slice(0,300)};
        throw new PersistenceError("RECOVERY_REQUIRED","Commit outcome requires recovery; no durable ACK emitted",this.problem);
      }
      if(intentWritten){try{await this.journal.outcome(commitId,null);}catch(outcomeError){this.state="read-only-recovery";this.problem={code:"RECOVERY_REQUIRED",cause:outcomeError.code??"IO_ERROR"};}}
      if(e.code==="ENOSPC")throw new PersistenceError("STORAGE_UNAVAILABLE","No space during preparation; no commit ACK emitted");
      throw e;
    }
  }
}
export const readCommittedSnapshot=async root=>{
  const snapshot=await loadCommitted(new ManagedFiles(root));return structuredClone({root:snapshot.root,envelope:snapshot.envelope,documents:snapshot.documents,authority:snapshot.authority});
};
