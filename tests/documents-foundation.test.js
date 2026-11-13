import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { document, populated, embed, provenance, asset, id, HASH, TIME } from "./fixtures/uva-pr1a.mjs";
import { parseId, createId, parseAssetRef, normalizeRequestId, AnnotationIdSchema } from "../src/documents/identity.js";
import { parseRef, IdentityMappingSchema, lookupIdentity, LogicalRevisionRefSchema } from "../src/documents/references.js";
import { DocumentValidationError, parse, assertJson, canonicalJson, hashJson, cloneJson } from "../src/documents/validation.js";
import { AnnotationProvenanceSchema, ImportedProvenanceSchema, ActorContextSchema, assertCreatorUnchanged, intersectGrants } from "../src/documents/provenance.js";
import { VisualDocumentSchema, AnnotationSchema, parseVisualDocument, parseDocumentJson } from "../src/documents/schema.js";
import { AffineMatrixSchema, ClipRegionSchema, SnapshotEligibilitySchema, SnapshotRefusalSchema, assertEmbedBinding } from "../src/documents/embed-schema.js";
import { parseEditDocumentInput, parseAnnotationPatch } from "../src/documents/input-schema.js";
import { validateDocumentReferences, resolveReference } from "../src/documents/integrity.js";
import { CommitRootSchema, CommitIndexEntrySchema, RecoveryResolverSchema, RecoveryCatalogSchema, LegacyAliasRegistrySchema, CommandTombstoneSchema, assertCurrentEnvelope, assertCommitIndexEntry } from "../src/persistence/commit-root-schema.js";
const fail = (fn, code) => assert.throws(fn, e => e instanceof DocumentValidationError && (!code || e.code === code));
const examples = JSON.parse(readFileSync(new URL("../docs/rfc/unified-visual-architecture/evidence/contract-examples.json", import.meta.url),"utf8"));
const example = id => structuredClone(examples.find(e => e.id === id));
const root = () => ({ schema:"estampes.commit-root/1",storeInstanceId:id("doc").slice(4),generation:1,commitId:id("tx"),parentCommitHash:null,
  roots:Object.fromEntries(["registry","locator","ledger","commitIndex","retention","authority"].map((k,i) => [k,String(i).repeat(64)])) });

test("PR-1A / UVA-01: UUIDv4 generators and typed parsers keep identity namespaces separate", () => {
  for (const kind of ["doc","scene","vp","panel","obj","ann","layer","bind","req","cmd","tx","event","lineage","exec"]) {
    const values = Array.from({length:32},() => createId(kind));
    assert.equal(new Set(values).size,32);
    for (const value of values) assert.equal(parseId(kind,value),value);
  }
  for (const value of ["d1","doc:short",id("scene"),id("doc").toUpperCase(),id("doc").replace("4000","5000"),id("doc").replace("8000","7000")," "+id("doc")]) fail(() => parseId("doc",value),"INVALID_INPUT");
  fail(() => createId("__proto__"),"INVALID_INPUT");
  assert.equal(normalizeRequestId(id("req")),id("cmd"));
  fail(() => normalizeRequestId(id("cmd")),"INVALID_INPUT");
});
test("asset aliases validate full SHA and cannot become Document identities", () => {
  assert.deepEqual(parseAssetRef(asset()),asset());
  for (const a of [{assetId:asset().legacyImageId},{...asset(),legacyImageId:"img:"+"b".repeat(16)},{assetId:"asset:sha256:"+"A".repeat(64)}]) fail(() => parseAssetRef(a),"INVALID_INPUT");
  fail(() => parseId("doc",asset().assetId),"INVALID_INPUT");
});
test("legacy local IDs retain explicit kind and Scene scope, including opaque historical spelling", () => {
  const base={documentId:id("doc"),sceneId:id("scene")};
  for (const [kind,localId] of [["object","o1"],["layer","L999999"],["annotation","o1"],["annotation",id("doc")],["frame","axes:o1"]]) assert.equal(parseRef({...base,kind,id:localId}).id,localId);
  for(const localId of ["o0","o1000000",id("ann")]) fail(() => parseRef({...base,kind:"object",id:localId}),"INVALID_INPUT");
  assert.equal(AnnotationIdSchema.safeParse("x".repeat(65)).success,false);
  fail(() => parseRef({...base,id:"o1"}),"INVALID_INPUT");
});
test("import identity tables reject source/target collisions without conflating different domains", () => {
  const source={schema:"canvas.json/version:1",legacyKey:asset().legacyImageId,kind:"object",id:"o1"};
  const target={documentId:id("doc"),sceneId:id("scene"),kind:"object",id:"o1"};
  const table={namespace:{kind:"external-import",bundleHash:HASH},entries:[{source,target}]};
  assert.deepEqual(lookupIdentity(table,source),target);
  fail(() => parse(IdentityMappingSchema,{...table,entries:[...table.entries,...table.entries]}),"INTEGRITY_ERROR");
  fail(() => parse(IdentityMappingSchema,{...table,entries:[...table.entries,{source:{...source,id:"o2"},target}]}),"INTEGRITY_ERROR");
  assert.ok(IdentityMappingSchema.safeParse({...table,entries:[...table.entries,{source:{...source,kind:"annotation"},target:{...target,kind:"annotation"}}]}).success);
  assert.deepEqual(table.entries[0].source,source);
  fail(() => lookupIdentity(table,{...source,id:"missing"}),"UNRESOLVED_REFERENCE");
});
test("graph read model is asset-free and round-trips exact metadata with stable canonical serialization", () => {
  const d=document();assert.deepEqual(parseVisualDocument(d),d);
  assert.deepEqual(parseDocumentJson(canonicalJson(d)),d);
  assert.equal(hashJson({z:1,a:[true,null]}),hashJson({a:[true,null],z:1}));
  assert.equal(Object.hasOwn(d.scenes[0].background,"asset"),false);
  assert.deepEqual(parseVisualDocument(populated()),populated());
});
test("scene identities have one owner and a valid default; aggregate caps do not reset per Scene", () => {
  for(const mutate of [d=>d.scenes[0].documentId=id("doc",8),d=>d.scenes.push(structuredClone(d.scenes[0])),d=>d.defaultSceneId=id("scene",8)]) {const d=document();mutate(d);assert.equal(VisualDocumentSchema.safeParse(d).success,false);}
  const a=document(),b=document(2);b.scenes[0].id=a.scenes[0].id;b.defaultSceneId=a.defaultSceneId;
  fail(() => validateDocumentReferences([a,b]),"INTEGRITY_ERROR");
  const d=populated();d.scenes[0].objects=Array.from({length:200},(_,i)=>({...structuredClone(d.scenes[0].objects[0]),id:"o"+(i+1)}));
  d.scenes[0].layers[0].content=[...d.scenes[0].objects.map(o=>({kind:"object",id:o.id})),{kind:"annotation",id:id("ann")}];
  const extra=structuredClone(d.scenes[0]);extra.id=id("scene",2);extra.objects=[extra.objects[0]];extra.annotations=[];extra.layers[0].content=[{kind:"object",id:"o1"}];d.scenes.push(extra);
  fail(()=>parseVisualDocument(d),"LIMIT");
});
test("strict read records preserve opacity zero, precision, locking and reject unknown fields", () => {
  const d=populated();d.scenes[0].layers[0].opacity=.0731;assert.equal(parseVisualDocument(d).scenes[0].layers[0].opacity,.0731);
  for(const mutate of [d=>d.random=true,d=>d.scenes[0].random=true,d=>d.scenes[0].annotations[0].random=true,d=>d.scenes[0].objects[0].props.random=true,d=>d.scenes[0].layers[0].opacity=1.01]) {const x=populated();mutate(x);assert.equal(VisualDocumentSchema.safeParse(x).success,false);}
  d.extensions={"org.estampes:inspection":{note:"retained"}};assert.deepEqual(parseVisualDocument(d).extensions,d.extensions);
  d.extensions={plain:{}};assert.equal(VisualDocumentSchema.safeParse(d).success,false);
});
test("duplicates and all layer membership inconsistencies are rejected", () => {
  for(const mutate of [s=>s.layers.push(structuredClone(s.layers[0])),s=>s.objects.push(structuredClone(s.objects[0])),s=>s.annotations.push(structuredClone(s.annotations[0])),s=>s.layers[0].content.pop(),s=>s.layers[0].content.push(s.layers[0].content[0]),s=>s.annotations[0].layerId="L2",s=>s.layers[0].content[0].id="o9"]) {const d=populated();mutate(d.scenes[0]);fail(()=>parseVisualDocument(d),"INTEGRITY_ERROR");}
  const d=populated();d.scenes[0].annotations[0].id="o1";d.scenes[0].layers[0].content[1].id="o1";assert.ok(VisualDocumentSchema.safeParse(d).success,"kind-tagged legacy names can coincide");
});
test("frames resolve local axes, reject cycles and cannot borrow another Scene's frame", () => {
  for(const mutate of [s=>s.frames[0].ownerObjectId="o8",s=>s.frames.push({id:"f",kind:"affine",parentFrameId:"missing",localToParent:[1,0,0,0,1,0,0,0,1]}),s=>s.frames.push({id:"f",kind:"affine",parentFrameId:"f",localToParent:[1,0,0,0,1,0,0,0,1]})]) {const d=populated();mutate(d.scenes[0]);assert.equal(VisualDocumentSchema.safeParse(d).success,false);}
  const d=populated();d.scenes[0].annotations[0].anchor={space:"world",frameRef:{documentId:d.id,sceneId:d.defaultSceneId,kind:"frame",id:"axes:o1"}};
  assert.ok(VisualDocumentSchema.safeParse(d).success);d.scenes[0].annotations[0].anchor.frameRef.sceneId=id("scene",2);fail(()=>parseVisualDocument(d),"INTEGRITY_ERROR");
});
test("finite geometry and normalized bounds reject invalid coordinates without clamping", () => {
  for(const value of [NaN,Infinity]) {const d=populated();d.scenes[0].annotations[0].geometry.x=value;assert.equal(VisualDocumentSchema.safeParse(d).success,false);}
  const a=populated().scenes[0].annotations[0];a.anchor={space:"image-normalized",asset:asset(),sourceToDocument:[1600,0,0,0,1000,0,0,0,1]};
  fail(()=>parse(AnnotationSchema,a),"OUT_OF_BOUNDS");a.geometry={x:.5,y:.5};assert.ok(AnnotationSchema.safeParse(a).success);
});
test("imported authors remain unknown with complete original source, never active module owners", () => {
  const p=provenance("module");p.sourceTrust="imported-unverified";
  assert.equal(AnnotationProvenanceSchema.safeParse(p).success,false);
  p.author="unknown";p.createdBy={kind:"import",sourceId:HASH};p.original={sourceSchema:"canvas.json/version:1",payloadHash:HASH,archiveRef:"shadow:"+HASH};
  assert.equal(AnnotationProvenanceSchema.safeParse(p).success,false);
  p.ownership={kind:"unclaimed-module",moduleId:"org.estampes.graph",historicalSourceHash:HASH};assert.ok(AnnotationProvenanceSchema.safeParse(p).success);
});
test("unknown historical lineage remains unclaimed until an adoption reference; module ID is insufficient", () => {
  const p=provenance("module");p.sourceTrust="migrated-local";p.createdBy.publisherFingerprint=null;p.createdBy.ownershipLineageId=null;
  assert.equal(AnnotationProvenanceSchema.safeParse(p).success,false);
  p.ownership={kind:"unclaimed-module",moduleId:p.createdBy.moduleId,historicalSourceHash:HASH};assert.ok(AnnotationProvenanceSchema.safeParse(p).success);
  p.sourceTrust="local";assert.equal(AnnotationProvenanceSchema.safeParse(p).success,false);
  const adopted=provenance("module");adopted.sourceTrust="migrated-local";adopted.createdBy.publisherFingerprint=null;adopted.ownership.adoptionEventId=id("event");assert.ok(AnnotationProvenanceSchema.safeParse(adopted).success);
});
test("creator/source history and sticky user audit cannot be overwritten", () => {
  const p=provenance("assistant"), edited={...structuredClone(p),lastEditedBy:{kind:"user",principalId:"owner:local"},editedByUser:true,lastUserEditRevision:2};
  assert.deepEqual(assertCreatorUnchanged(p,edited),edited);
  for(const mutate of [q=>q.createdBy.principalId="another",q=>q.createdAt="2026-11-02T00:00:00Z"]) {const q=structuredClone(edited);mutate(q);fail(()=>assertCreatorUnchanged(p,q),"FORBIDDEN");}
  const cleared=structuredClone(edited);cleared.editedByUser=false;delete cleared.lastUserEditRevision;fail(()=>assertCreatorUnchanged(edited,cleared),"FORBIDDEN");
});
test("trusted actor shape and grant intersection are not caller-granted permissions", () => {
  const p=provenance("module").createdBy;
  const actor={principal:p,authenticatedOwnerId:"owner:local",origin:"module-runtime",effectiveGrants:["annotation.write.owned"],targetScope:[],grantRevision:1,executionId:id("exec")};
  assert.ok(ActorContextSchema.safeParse(actor).success);assert.equal(ActorContextSchema.safeParse({...actor,origin:"app-user"}).success,false);
  assert.deepEqual(intersectGrants(["annotation.write.owned","document.read.target"],["document.read.target"],["document.read.target"]),["document.read.target"]);
  assert.deepEqual(intersectGrants(["annotation.write.owned"],[],["annotation.write.owned"]),[]);
});
test("production wire schemas accept formal EX-04 but reject forged actor fields at every level", () => {
  const args=example("EX-04").arguments;assert.deepEqual(parseEditDocumentInput(args),args);
  for(const field of ["actor","author","ownership","createdBy","effectiveGrants","commandId"]) {
    for(const insert of [x=>x[field]="user",x=>x.operations[0][field]="user",x=>x.operations[0].geometry[field]="user"]) {const x=structuredClone(args);insert(x);fail(()=>parseEditDocumentInput(x),"INVALID_INPUT");}
  }
  const x=structuredClone(args);x.operations[0].layer="new-user";fail(()=>parseEditDocumentInput(x),"INVALID_INPUT");
});
test("existing-annotation input uses entity OCC and validates geometry against stored type", () => {
  const update={op:"annotation.update",sceneId:id("scene"),id:id("ann"),expectedAnnotationRevision:1,patch:{geometry:{x:2,y:3}}};
  assert.deepEqual(parseAnnotationPatch(update,"point"),update);fail(()=>parseAnnotationPatch(update,"arrow"),"INVALID_INPUT");
  const reanchor={...update,patch:{anchor:{space:"document"}}};fail(()=>parseAnnotationPatch(reanchor,"point"),"INVALID_INPUT");
  reanchor.previewHash=HASH;assert.ok(parseAnnotationPatch(reanchor,"point"));
});
test("Phase0.1 matrix counterexamples are fixed without adding a determinant epsilon", () => {
  assert.ok(AffineMatrixSchema.safeParse([1e-7,0,0,0,1e-7,0,0,0,1]).success);
  for(const m of [[1e10,0,0,0,1e-4,0,0,0,1],[0,0,0,0,0,0,0,0,1],[1,0,0,0,1,0,0,1,1],[1,0,1e7,0,1,1e7,0,0,1]]) fail(()=>parse(AffineMatrixSchema,m),"NON_INVERTIBLE");
  const e=example("EX-06").arguments;assert.ok(AffineMatrixSchema.safeParse(e.localToDocument).success);assert.ok(ClipRegionSchema.safeParse(e.clipRegion).success);
});
test("embed object and canonical binding agree, child is authoritative and independently identified", () => {
  const child=document(2),parent=embed(document(),child),o=parent.scenes[0].objects[0],b=parent.bindings[0];
  assert.deepEqual(assertEmbedBinding(o,b),o);assert.equal(validateDocumentReferences([parent,child]).length,2);
  for(const mutate of [d=>d.bindings[0].mode="snapshot",d=>d.bindings[0].child.sceneId=id("scene",8),d=>d.scenes[0].objects[0].parent.documentId=id("doc",8)]) {const d=structuredClone(parent);mutate(d);fail(()=>parseVisualDocument(d),"INTEGRITY_ERROR");}
  const migrated=structuredClone(parent);migrated.scenes[0].objects[0].id="o9";migrated.scenes[0].layers[0].content[0].id="o9";migrated.bindings[0].parentObject.id="o9";assert.ok(VisualDocumentSchema.safeParse(migrated).success);
  const snapshot=embed(document(),child,"snapshot");assert.ok(VisualDocumentSchema.safeParse(snapshot).success);snapshot.scenes[0].objects[0].props.snapshotOrigin.documentId=child.id;assert.equal(VisualDocumentSchema.safeParse(snapshot).success,false);
});
test("fresh cross-document targets must exist; unresolved materialized status never grants access", () => {
  const child=document(2),parent=embed(document(),child);
  assert.ok(VisualDocumentSchema.safeParse(parent).success,"structural parse is not external reference resolution");
  fail(()=>validateDocumentReferences([parent]),"UNRESOLVED_REFERENCE");
  parent.bindings[0].status="unresolved";assert.equal(validateDocumentReferences([parent]).length,1);
  const d=populated();assert.equal(resolveReference([d],{documentId:d.id,sceneId:d.defaultSceneId,kind:"object",id:"o1"}).type,"axes-2d");
  fail(()=>resolveReference([d],{documentId:d.id,sceneId:d.defaultSceneId,kind:"annotation",id:"o1"}),"UNRESOLVED_REFERENCE");
});
test("embed cycles and depth are checked on supplied after-state snapshots", () => {
  const a=embed(document(1),document(2)),b=embed(document(2),document(1));fail(()=>validateDocumentReferences([a,b]),"INTEGRITY_ERROR");
  const chain=Array.from({length:10},(_,i)=>i===9?document(i+1):embed(document(i+1),document(i+2)));
  fail(()=>validateDocumentReferences(chain),"LIMIT");
});
test("snapshot refusal uses closed redacted projections and cannot imply raster success", () => {
  const eligibility={supported:false,reason:"NESTED_SNAPSHOT_UNSUPPORTED",source:{documentId:id("doc"),sceneId:id("scene")},sourceRevision:1,bindingGraphHash:HASH,blockers:[],redactedBlockerCount:1,alternatives:["live","editable-bundle"]};
  assert.ok(SnapshotEligibilitySchema.safeParse(eligibility).success);
  assert.equal(SnapshotEligibilitySchema.safeParse({...eligibility,sourceContentHash:HASH}).success,false);
  const error={isError:true,structuredContent:{kind:"estampes.document_error",code:"BLOCKED_DEPENDENCY",message:"Unsupported nested source",retryable:false,details:{reason:"NESTED_SNAPSHOT_UNSUPPORTED",operation:"embed.detach",snapshotEligibility:eligibility}}};
  assert.ok(SnapshotRefusalSchema.safeParse(error).success);assert.equal(SnapshotEligibilitySchema.safeParse({...eligibility,alternatives:["rasterize"]}).success,false);
});
test("six-root CommitRoot cannot use missing/extra/self-referential descriptors", () => {
  assert.ok(CommitRootSchema.safeParse(root()).success);
  for(const key of Object.keys(root().roots)) {const r=root();delete r.roots[key];assert.equal(CommitRootSchema.safeParse(r).success,false);}
  assert.equal(CommitRootSchema.safeParse({...root(),locatorCurrent:HASH}).success,false);
  assert.equal(CommitRootSchema.safeParse({...root(),generation:2}).success,false);
  const entry={commitId:id("tx"),generation:1,registryRootHash:root().roots.registry,requestKeyDigest:null,payloadHash:HASH,resultHash:HASH,outcome:"committed"};
  assert.deepEqual(assertCommitIndexEntry(root(),entry),entry);
  assert.equal(CommitIndexEntrySchema.safeParse({...entry,commitRootHash:HASH}).success,false);
  fail(()=>assertCommitIndexEntry(root(),{...entry,generation:2}),"INTEGRITY_ERROR");
  assert.equal(RecoveryResolverSchema.safeParse({registryRootHash:HASH,logicalClosureHash:HASH,resolverCommitHash:HASH}).success,false);
});
test("CURRENT checksum is canonical, excludes itself and matches exactly one root", () => {
  const r=root(),body={generation:r.generation,commitId:r.commitId,rootHash:hashJson(r)},envelope={...body,checksum:hashJson(body)};
  assert.deepEqual(assertCurrentEnvelope(r,envelope),r);
  fail(()=>assertCurrentEnvelope(r,{...envelope,checksum:"f".repeat(64)}),"INTEGRITY_ERROR");
  fail(()=>assertCurrentEnvelope({...r,roots:{...r.roots,locator:HASH}},envelope),"INTEGRITY_ERROR");
});
test("recovery, legacy aliases, ledger keys and logical revisions are structurally strict", () => {
  const pair={registryRootHash:HASH,logicalClosureHash:HASH,resolverLocatorRootHash:HASH};assert.ok(RecoveryCatalogSchema.safeParse([pair]).success);fail(()=>parse(RecoveryCatalogSchema,[pair,pair]),"INTEGRITY_ERROR");
  const alias={sourceStoreId:id("doc").slice(4),setKey:asset().legacyImageId,documentId:id("doc"),sourceSealHash:HASH,authorityEpoch:1,mode:"A4"};assert.ok(LegacyAliasRegistrySchema.safeParse([alias]).success);assert.equal(LegacyAliasRegistrySchema.safeParse([alias,{...alias,setKey:alias.setKey+"#c12345678"}]).success,false);
  assert.ok(CommandTombstoneSchema.safeParse({key:{storeInstanceId:id("doc").slice(4),principalDigest:HASH,commandId:id("cmd")},payloadHash:HASH,commitId:id("tx"),resultHash:HASH,acceptedAt:TIME}).success);
  assert.ok(LogicalRevisionRefSchema.safeParse({storeInstanceId:id("doc").slice(4),entityId:id("doc"),revision:1,contentHash:HASH}).success);
});
test("adversarial JSON fails boundedly: cycles, accessors, proxies, symbols, prototypes and depth", () => {
  const cycle={};cycle.self=cycle;fail(()=>assertJson(cycle),"INVALID_INPUT");assert.equal(VisualDocumentSchema.safeParse(cycle).success,false);
  let invoked=0;const getter={};Object.defineProperty(getter,"payload",{get(){invoked++;throw Error("executed");},enumerable:true});assert.equal(VisualDocumentSchema.safeParse(getter).success,false);assert.equal(invoked,0);
  const proxy=new Proxy({}, {getPrototypeOf(){throw Error("executed");}});assert.equal(VisualDocumentSchema.safeParse(proxy).success,false);
  for(const input of [new Date(),new Map(),{x:undefined},{x:()=>0},{[Symbol("x")]:1},[,1]]) fail(()=>assertJson(input),"INVALID_INPUT");
  let deep={};for(let i=0;i<40;i++) deep={child:deep};fail(()=>assertJson(deep),"LIMIT");
  fail(()=>assertJson([1,2,3],{maxNodes:2}),"LIMIT");
});
test("JSON byte budgets include escaping and UTF-8; canonical raw fields cannot pollute prototypes", () => {
  for(const value of ["繁體中文","\n\u0000\ud800",{q:'"\\',emoji:"😀"}]) {const size=Buffer.byteLength(canonicalJson(value));assertJson(value,{maxBytes:size});fail(()=>assertJson(value,{maxBytes:size-1}),"LIMIT");}
  const raw=JSON.parse('{"__proto__":{"polluted":true},"constructor":"history"}');assert.deepEqual(cloneJson(raw),raw);assert.equal({}.polluted,undefined);
  fail(()=>parseDocumentJson("{broken"),"INVALID_INPUT");
  fail(()=>parseDocumentJson(" ".repeat(64*1024*1024+1)),"LIMIT");
  fail(()=>parse(CommitRootSchema,{...root(),extra:"x".repeat(65536)}),"LIMIT");
});
// The original isolation seal is preserved in source-index.json. PR-1B
// authorizes product integration and must preserve newer main, so protect its
// untouched files and explicitly enumerate the allowed integration seams.
test("PR-1B preserves newer main outside declared integration seams and the exact non-Optimization-B runtime", () => {
  const base=new URL("../docs/rfc/unified-visual-architecture/evidence/",import.meta.url);
  const legacy=JSON.parse(readFileSync(new URL("pr1b-legacy-source-index.json",base),"utf8"));
  const runtime=JSON.parse(readFileSync(new URL("pr1b-runtime-source-index.json",base),"utf8"));
  // These two workflows changed after PR #92. Verify the original bytes at
  // that merge while retaining the worktree checks for all other sealed files.
  const historicalWorkflows = new Set([".github/workflows/docker.yml", ".github/workflows/docs.yml"]);
  const integrationMerge = "7c10965dd66b7b2aa58dc792e3a4b703d2c7fcd4";
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const f of [...legacy.files.filter(f => !legacy.authorizedIntegrationSeams.includes(f.path)), ...runtime.files]) {
    const bytes = historicalWorkflows.has(f.path)
      ? execFileSync("git", ["show", `${integrationMerge}:${f.path}`], { cwd: root })
      : readFileSync(new URL("../" + f.path, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), f.sha256, f.path);
  }
});
test("removed annotation anchors retain invalid references only with explicit matching tombstones", () => {
  const d=populated(),s=d.scenes[0],a=s.annotations[0];a.anchor={space:"world",frameRef:{documentId:d.id,sceneId:s.id,kind:"frame",id:"removed-frame"}};
  fail(()=>parseVisualDocument(d),"UNRESOLVED_REFERENCE");
  s.tombstones.push({ref:a.anchor.frameRef,deletedAt:TIME,deletedInCommit:id("tx"),priorRevision:1,reason:"removed"});assert.ok(VisualDocumentSchema.safeParse(d).success);
  s.tombstones[0].ref={documentId:d.id,sceneId:s.id,kind:"object",id:"o1"};fail(()=>parseVisualDocument(d),"INTEGRITY_ERROR");
});
test("interaction/gesture references and canonical axes associations are checked", () => {
  const d=populated(),s=d.scenes[0];s.annotations[0].intentEventIds=[id("event")];fail(()=>parseVisualDocument(d),"UNRESOLVED_REFERENCE");
  s.interactionEvents.push({eventId:id("event"),schema:"estampes.interaction/1",payloadHash:HASH});assert.ok(VisualDocumentSchema.safeParse(d).success);
  s.objects.push({id:"o2",type:"function-plot",revision:1,layerId:"L1",visibility:"public",provenance:provenance("module"),props:{frame:"o1",expression:"sin(x)"},coordinateFrameId:"affine"});
  s.layers[0].content.push({kind:"object",id:"o2"});s.frames.push({id:"affine",kind:"affine",parentFrameId:"document",localToParent:[1,0,0,0,1,0,0,0,1]});fail(()=>parseVisualDocument(d),"INTEGRITY_ERROR");
});
test("binding UUID collisions across parent Documents cannot create two canonical records", () => {
  const child=document(3),a=embed(document(1),child),b=embed(document(2),child);
  b.bindings[0].id=a.bindings[0].id;b.scenes[0].objects[0].props.bindingId=a.bindings[0].id;
  fail(()=>validateDocumentReferences([a,b,child]),"INTEGRITY_ERROR");
});
test("repeated embed edges cannot amplify bounded traversal exponentially", () => {
  const child=document(2),parent=embed(document(1),child),s=parent.scenes[0];
  for(let i=0;i<100;i++) {
    const object=structuredClone(s.objects[0]),binding=structuredClone(parent.bindings[0]);
    object.id=id("obj",i+1000);object.props.bindingId=id("bind",i+1000);binding.id=object.props.bindingId;binding.parentObject.id=object.id;
    s.objects.push(object);s.layers[0].content.push({kind:"object",id:object.id});parent.bindings.push(binding);
  }
  assert.equal(validateDocumentReferences([parent,child]).length,2);
});

test("external provenance profile cannot be self-promoted and import evidence never becomes current verification", () => {
  assert.equal(ImportedProvenanceSchema.safeParse(provenance("module")).success,false);
  const a=populated().scenes[0].annotations[0];a.provenance={...a.provenance,author:"unknown",createdBy:{kind:"import",sourceId:HASH},sourceTrust:"imported-unverified",original:{sourceSchema:"canvas.json/version:1",payloadHash:HASH,archiveRef:"shadow:"+HASH}};
  a.finding={verification:{historicalState:"user-confirmed",currentState:"user-confirmed",contextHash:HASH}};assert.equal(AnnotationSchema.safeParse(a).success,false);
  a.finding.verification.currentState="unverified";assert.ok(AnnotationSchema.safeParse(a).success);
});
test("mutation inputs cannot forge a renderer-resolved anchor pose or verification shortcut", () => {
  const args=example("EX-04").arguments;
  args.operations[0].anchor={space:"object",objectRef:{documentId:id("doc"),sceneId:id("scene"),kind:"object",id:"o1"},attachment:{kind:"function-x",x:2,offsetDu:{x:0,y:0}},onMissing:"retain-invalid",lastResolved:{originDu:[0,0],localToDocument:[1,0,0,0,1,0,0,0,1],geometryHash:HASH,revision:1}};
  fail(()=>parseEditDocumentInput(args),"INVALID_INPUT");
  args.operations[0].anchor={space:"document"};args.operations[0].finding={note:"claim",verification:"independently-verified"};fail(()=>parseEditDocumentInput(args),"INVALID_INPUT");
});

test("arbitrary JSON metadata in parsed records is detached from its input snapshot", () => {
 const d=document();d.extensions={"org.estampes:data":{nested:[{value:1}]}};
 const parsed=parseVisualDocument(d);parsed.extensions["org.estampes:data"].nested[0].value=2;
 assert.equal(d.extensions["org.estampes:data"].nested[0].value,1);
});
