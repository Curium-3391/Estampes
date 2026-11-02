import { z } from "zod";
import { DocumentIdSchema, RequestIdSchema, UUIDSchema, BindingIdSchema, TransactionIdSchema, EventIdSchema } from "../documents/identity.js";
import { VisualDocumentSchema, parseVisualDocument, ReferenceBindingSchema } from "../documents/schema.js";
import { LogicalRevisionRefSchema } from "../documents/references.js";
import { bounded, parse, ContentHashSchema, RevisionSchema, TimestampSchema, hashJson, canonicalJson } from "../documents/validation.js";
import { CurrentEnvelopeSchema, parseCommitRoot, assertCurrentEnvelope, CommitIndexEntrySchema, CommandLedgerKeySchema, CommandTombstoneSchema, RecoveryResolverSchema } from "./commit-root-schema.js";
import { validateCompleteDocumentClosure } from "../documents/integrity.js";
import { PageStore } from "./pages.js";
import { integrity, fail } from "./errors.js";
import { PhysicalLocatorSchema, readVersion } from "./archive.js";
import { LifecycleOptionsSchema, policyOf, validateRetentionEntry } from "./lifecycle-state.js";

export const CommitCommandSchema=bounded(z.object({requestId:RequestIdSchema,
  changes:z.array(z.object({expectedRevision:RevisionSchema.nullable(),document:VisualDocumentSchema}).strict()).min(1).max(64),
  readSet:z.array(z.object({documentId:DocumentIdSchema,revision:RevisionSchema,contentHash:ContentHashSchema}).strict()).max(100).optional(),
}).strict());
export const FormatSchema=z.object({schema:z.literal("estampes.isolated-store/1"),storeInstanceId:UUIDSchema,
  purpose:z.literal("isolated-pr1c-testing"),profile:z.enum(["linux-local-durable","linux-process-crash-test"]),
  quotaBytes:z.number().int().min(128*1024*1024).max(10*1024**3),maxContentCommits:z.number().int().min(1).max(1000),lifecycle:LifecycleOptionsSchema.optional()}).strict();
export const AuthoritySchema=z.object({schema:z.literal("estampes.isolated-authority/1"),storeInstanceId:UUIDSchema,
  epoch:RevisionSchema,mode:z.literal("isolated-testing"),profile:FormatSchema.shape.profile}).strict();
export const AckSchema=bounded(z.object({schema:z.literal("estampes.commit-ack/1"),commitId:TransactionIdSchema,
  resultId:EventIdSchema,durability:z.enum(["durable","process-crash-test"]),noChange:z.boolean(),
  revisionVector:z.array(LogicalRevisionRefSchema).max(64)}).strict(),{maxBytes:64*1024});
export const LedgerEntrySchema=z.object({kind:z.literal("ack"),key:CommandLedgerKeySchema,payloadHash:ContentHashSchema,
  commitId:TransactionIdSchema,resultHash:ContentHashSchema,acceptedAt:TimestampSchema,ack:AckSchema}).strict();
// Full ACKs and permanent command tombstones share the authoritative Ledger.
export const LedgerValueSchema=z.union([LedgerEntrySchema,z.object({kind:z.literal("tombstone"),record:CommandTombstoneSchema}).strict()]);
export const ledgerRecord=value=>value.kind==="tombstone"?value.record:value;
export function replayLedgerEntry(value,payloadHash){
  const parsed=parse(LedgerValueSchema,value),record=ledgerRecord(parsed);
  if(record.payloadHash!==payloadHash)fail("IDEMPOTENCY_MISMATCH","Request key is already bound to another payload");
  if(parsed.kind==="tombstone")fail("RETRY_WINDOW_EXPIRED","Full ACK was compacted; command effect must not be replayed",{commitId:record.commitId});
  return {ack:structuredClone(parsed.ack),replayed:true};
}
export const StoredDocumentSchema=bounded(z.object({schema:z.literal("estampes.document-record/1"),document:z.record(z.string(),z.unknown()),
  bindingIds:z.array(BindingIdSchema).max(100000)}).strict());
export function storeDocument(document){const {bindings,...content}=parseVisualDocument(document);return {schema:"estampes.document-record/1",document:content,bindingIds:bindings.map(b=>b.id)};}
export const versionPath=ref=>"visual-documents/"+ref.entityId.slice(4)+"/generations/"+ref.revision+"-"+ref.contentHash+".json";
export const LocatorSchema=PhysicalLocatorSchema;
export function closure(documents,storeInstanceId,generation){return validateCompleteDocumentClosure(documents,{schema:"estampes.document-closure/1",storeInstanceId,generation,
  documents:documents.map(d=>({documentId:d.id,revision:d.revision,contentHash:hashJson(d)}))});}
export const logicalClosureHash=registry=>hashJson([...registry].filter(([key])=>key.startsWith("entity:")).map(([,value])=>value).sort((a,b)=>a.entityId<b.entityId?-1:a.entityId>b.entityId?1:0));

async function loadSnapshot(files,envelopeInput){
  const envelope=parse(CurrentEnvelopeSchema,envelopeInput);
  const pages=new PageStore(files),root=parseCommitRoot(await pages.hashed(envelope.rootHash,"visual-registry/roots",64*1024));assertCurrentEnvelope(root,envelope);
  const indices={};for(const [kind,hash]of Object.entries(root.roots))indices[kind]=await pages.read(hash,kind);
  const authority=parse(AuthoritySchema,indices.authority.get("store"));integrity(indices.authority.size===1&&authority.storeInstanceId===root.storeInstanceId,"Invalid authority identity");
  const lifecycle=policyOf(indices.retention);
  for(const [key,value]of indices.retention){
    validateRetentionEntry(key,value);
    if(key.startsWith("gc:")){const {readGcPlan,gcPlanPath}=await import("./gc.js");await readGcPlan(files,value);pages.track.add(gcPlanPath(value.planHash));}
    if(key.startsWith("backup:")){const {readBackupList}=await import("./backup.js");const list=await readBackupList(files,value.filesHash);for(const path of list.paths)pages.track.add(path);}
    if((key.startsWith("recovery:")||key.startsWith("checkpoint:"))&&value.envelope){const old=parseCommitRoot(await pages.hashed(value.envelope.rootHash,"visual-registry/roots",64*1024));assertCurrentEnvelope(old,value.envelope);}
  }
  for(const h of lifecycle?.maintenance.pending?.writtenChunks??[]){const path="visual-history/chunks/"+h+".bin",bytes=await files.bytes(path,4*1024**2);integrity((await import("./archive.js")).hashBytes(bytes)===h,"Pending archive chunk hash mismatch");pages.track.add(path);}
  for(const [key,raw]of indices.locator){
    const value=parse(LocatorSchema,raw),ref=value.logical;parse(DocumentIdSchema,ref.entityId);
    integrity(key===hashJson(ref)&&ref.storeInstanceId===root.storeInstanceId,"Locator identity mismatch");
    parse(StoredDocumentSchema,await readVersion(files,ref,indices.locator,pages.track));
    if(value.kind==="full"&&value.alternative)await readVersion(files,ref,indices.locator,pages.track,value.alternative);
  }
  const materialize=async(registry,locator=indices.locator)=>{
    const documents=[],bindings=new Map();
    for(const [key,value]of registry)if(key.startsWith("binding:")){const b=parse(ReferenceBindingSchema,value);integrity(key==="binding:"+b.id,"Canonical binding key mismatch");bindings.set(b.id,b);}
    for(const [key,value]of registry){
      if(key.startsWith("entity:")){
        const ref=parse(LogicalRevisionRefSchema,value);integrity(key==="entity:"+ref.entityId&&ref.storeInstanceId===root.storeInstanceId,"Registry identity mismatch");
        integrity(locator.has(hashJson(ref)),"Registry has missing locator coverage");
        const record=parse(StoredDocumentSchema,await readVersion(files,ref,locator,pages.track));
        integrity(new Set(record.bindingIds).size===record.bindingIds.length,"Duplicate stored binding ID");
        const ownBindings=record.bindingIds.map(id=>{integrity(bindings.has(id),"Missing canonical binding record");return bindings.get(id);});
        documents.push(parseVisualDocument({...record.document,bindings:ownBindings}));
      }else integrity(key.startsWith("binding:"),"Unknown registry namespace in isolated store");
    }
    closure(documents,root.storeInstanceId,root.generation);return documents;
  };
  const documents=await materialize(indices.registry);
  let currentCatalog=false;
  for(const [key,raw]of indices.retention){
    if(!key.startsWith("registry:"))continue;
    const resolver=parse(RecoveryResolverSchema,raw);integrity(key==="registry:"+resolver.registryRootHash,"Recovery catalog key mismatch");
    const registry=await pages.read(resolver.registryRootHash,"registry"),locator=resolver.resolverLocatorRootHash===root.roots.locator?indices.locator:await pages.read(resolver.resolverLocatorRootHash,"locator");
    integrity(logicalClosureHash(registry)===resolver.logicalClosureHash,"Recovery logical closure hash mismatch");
    for(const [k,value]of registry)if(k.startsWith("entity:"))integrity(locator.has(hashJson(value))&&canonicalJson(locator.get(hashJson(value)))===canonicalJson(indices.locator.get(hashJson(value))),"Recovery resolver lacks matching retained version");
    // Materialize one historical snapshot at a time, never an N*S version map.
    await materialize(registry,locator);
    if(resolver.registryRootHash===root.roots.registry){integrity(resolver.resolverLocatorRootHash===root.roots.locator,"Current recovery resolver is split");currentCatalog=true;}
  }
  integrity(currentCatalog,"Current registry lacks recovery catalog entry");
  const memberships=new Map(),generations=new Set();
  for(const [key,value]of indices.commitIndex){const entry=parse(CommitIndexEntrySchema,value);
    integrity(key===entry.commitId&&entry.generation<=root.generation&&!generations.has(entry.generation)&&indices.retention.has("registry:"+entry.registryRootHash),"Invalid commit membership");
    memberships.set(key,entry);generations.add(entry.generation);
  }
  const current=memberships.get(root.commitId);integrity(current?.generation===root.generation&&current.registryRootHash===root.roots.registry,"Current commit membership is inconsistent");
  const keys=new Set();
  for(const [key,raw]of indices.ledger){
    const value=parse(LedgerValueSchema,raw),entry=ledgerRecord(value),member=memberships.get(entry.commitId);keys.add(key);
    integrity(key===hashJson(entry.key)&&entry.key.storeInstanceId===root.storeInstanceId&&(value.kind==="tombstone"||(entry.ack.commitId===entry.commitId&&hashJson(entry.ack)===entry.resultHash)),
      "Ledger key/result identity mismatch");
    integrity(member?.requestKeyDigest===key&&member.payloadHash===entry.payloadHash&&member.resultHash===entry.resultHash,"Ledger outcome split from content membership");
    if(value.kind==="tombstone")continue;
    integrity(entry.ack.durability===(authority.profile==="linux-local-durable"?"durable":"process-crash-test"),"Ledger durability/profile mismatch");
    const registry=await pages.read(member.registryRootHash,"registry");
    for(const ref of entry.ack.revisionVector)integrity(canonicalJson(registry.get("entity:"+ref.entityId))===canonicalJson(ref),"ACK revision vector differs from committed registry");
  }
  for(const member of memberships.values())if(member.requestKeyDigest!==null)integrity(keys.has(member.requestKeyDigest),"Committed effect is missing its ledger outcome");
  return {root,envelope,indices,documents,authority,lifecycle,files:[...pages.track,"visual-registry/CURRENT.json"]};
}

export const loadCommitted=async files=>loadSnapshot(files,await files.json("visual-registry/CURRENT.json",64*1024));
// This is candidate verification only. It cannot select or publish authority.
export const verifyPreparedClosure=(files,envelope)=>loadSnapshot(files,envelope);

// Read a selected, already-pinned pair; this is not an authority-selection API.
export async function readRegistrySnapshot(files,registryHash,locatorHash,storeInstanceId,generation){
 const track=new Set(),pages=new PageStore(files,null,track),registry=await pages.read(registryHash,"registry"),locator=await pages.read(locatorHash,"locator"),documents=[];
 const bindings=new Map([...registry].filter(([k])=>k.startsWith("binding:")).map(([,v])=>[v.id,parse(ReferenceBindingSchema,v)]));
 for(const [key,ref]of registry)if(key.startsWith("entity:")){
  const record=parse(StoredDocumentSchema,await readVersion(files,ref,locator,track));
  const own=record.bindingIds.map(id=>{integrity(bindings.has(id),"Historical binding is absent from its own Registry");return bindings.get(id);});
  documents.push(parseVisualDocument({...record.document,bindings:own}));
 }
 closure(documents,storeInstanceId,generation);return {documents,registry,locator,files:[...track]};
}
