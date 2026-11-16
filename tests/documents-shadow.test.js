import test from "node:test";
import assert from "node:assert/strict";
import { legacy, context, id, HASH, TIME } from "./fixtures/uva-pr1a.mjs";
import { mapLegacyCanvas } from "../src/documents/legacy-shadow.js";
import { parseVisualDocument, parseDocumentJson } from "../src/documents/schema.js";
import { hashJson, canonicalJson, DocumentValidationError } from "../src/documents/validation.js";
import { serializeCanvas, restoreCanvas } from "../src/storage.js";
import { editCanvas } from "../src/canvas-state.js";

const rereadRejection = result => result.sidecars[0].payload.rejections[0].from.text;
const freeze = value => { if(value && typeof value==="object"){Object.freeze(value);for(const x of Object.values(value))freeze(x);}return value; };
const issueCode = (r,code) => assert.ok(r.report.issues.some(i=>i.code===code),JSON.stringify(r.report.issues));

test("PR-1A / UVA-24: legacy shadow is pure, deterministic and round-trips geometry, layers and rich claims", () => {
  const source=freeze(legacy()),ctx=freeze(context()),before=canonicalJson(source),a=mapLegacyCanvas(source,ctx),b=mapLegacyCanvas(source,ctx);
  assert.equal(a.status,"mapped");assert.deepEqual(a,b);assert.equal(canonicalJson(source),before);assert.equal(a.report.writesPerformed,false);assert.equal(a.report.authoritative,false);
  assert.deepEqual(a.sidecars[0].payload,source);assert.equal(hashJson(a.sidecars[0].payload),a.sidecars[0].payloadHash);
  assert.deepEqual(a.document,parseDocumentJson(canonicalJson(a.document)));
  const s=a.document.scenes[0],mark=s.annotations[0];
  assert.deepEqual(mark.geometry.points,source.marks[0].points);assert.equal(mark.geometry.smooth,true);assert.equal(mark.geometry.closed,false);
  assert.deepEqual(mark.stroke,{order:2,relativeStartMs:10,relativeEndMs:20,pointerType:"pen"});
  assert.equal(s.layers[0].opacity,0);assert.equal(s.layers[0].locked,true);assert.equal(s.layers[1].content.length,0);
  assert.deepEqual(s.objects[0].props,source.objects[0].props);assert.equal(s.objects[0].revision,3);assert.deepEqual(s.objects[0].evidence,source.objects[0].evidence);
  assert.deepEqual(mark.finding.evidence[0].original,source.marks[0].evidence[0]);assert.equal(mark.finding.verification.currentState,"user-confirmed");
  assert.deepEqual(s.rejections,source.rejections);assert.deepEqual(s.gestureDecisions[0].original,source.gestureDecisions[0]);
  const rawRejection=rereadRejection(a);s.rejections[0].from.text="changed projection";assert.equal(rereadRejection(a),rawRejection);
  assert.deepEqual(s.layers[0].content,[{kind:"object",id:"o1"},{kind:"annotation",id:"ai"},{kind:"annotation",id:"user-ink"}]);
});
test("legacy creators do not borrow layer.module or fabricate actor identities/timestamps", () => {
  const source=legacy();source.marks[1].layer="L2";const r=mapLegacyCanvas(source,context()),s=r.document.scenes[0];
  assert.equal(s.annotations[1].provenance.author,"assistant");assert.equal(s.annotations[1].provenance.createdBy.kind,"assistant");
  assert.equal(s.annotations[1].provenance.createdAt,null);assert.equal(s.annotations[1].provenance.lastEditedBy.kind,"legacy-unknown");
  assert.equal(s.objects[0].provenance.author,"module");assert.equal(s.objects[0].provenance.createdBy.publisherFingerprint,null);assert.equal(s.objects[0].provenance.ownership.kind,"unclaimed-module");
  delete source.marks[1].author;const unknown=mapLegacyCanvas(source,context());assert.equal(unknown.document.scenes[0].annotations[1].provenance.author,"unknown");issueCode(unknown,"UNKNOWN_AUTHOR");
});
test("external import keeps full original claims but cannot activate local module owners or verification", () => {
  const r=mapLegacyCanvas(legacy(),{...context(),sourceTrust:"imported-unverified"});assert.equal(r.status,"mapped");
  for(const entity of [...r.document.scenes[0].objects,...r.document.scenes[0].annotations]) {
    assert.equal(entity.provenance.author,"unknown");assert.equal(entity.provenance.createdBy.kind,"import");assert.notEqual(entity.provenance.ownership.kind,"module");assert.ok(entity.provenance.original);
  }
  const f=r.document.scenes[0].annotations[0].finding;assert.equal(f.verification.historicalState,"user-confirmed");assert.equal(f.verification.currentState,"unverified");assert.equal(f.evidence[0].applicability,"historical");assert.equal(f.review,"confirmed");
});
test("legacy edited geometry conservatively stales current Evidence without erasing review", () => {
  const source=legacy();source.marks[0].edited=true;const r=mapLegacyCanvas(source,context()),a=r.document.scenes[0].annotations[0];
  assert.equal(a.finding.verification.currentState,"stale");assert.equal(a.finding.verification.historicalState,"user-confirmed");assert.equal(a.finding.review,"confirmed");assert.equal(a.finding.evidence[0].applicability,"stale");assert.equal(a.provenance.editedByUser,true);
});
test("unknown fields at each level remain recoverable with an explicit archive report", () => {
  const source=legacy();source.future={algorithm:"unknown",values:[1,2,3]};source.marks[0].future={v:2};source.layers[0].future="layer";source.objects[0].future="object";
  const r=mapLegacyCanvas(source,context());assert.equal(r.status,"mapped");assert.equal(r.report.editableComplete,false);assert.equal(r.report.rawRecoverable,true);
  assert.deepEqual(r.sidecars[0].payload,source);assert.equal(r.report.archivedPaths.length,4);issueCode(r,"ARCHIVED_LEGACY_FIELD");assert.equal(Object.hasOwn(r.document,"future"),false);
});
test("historical intent, rejected claims, old undo and unsupported gestures are archived, not invented", () => {
  const source=legacy();source.marks[0].role="context";source.marks[0].object="hint";source.userEdits=[{kind:"move-mark",id:"user-ink"}];source.deletedObjectBatches=[[source.objects[0]]];source.gestureDecisions.push({memberIds:["user-ink"],verdict:"user-confirmed"});
  const r=mapLegacyCanvas(source,context());assert.equal(r.status,"mapped");assert.equal(r.document.scenes[0].gestureDecisions.length,1);assert.deepEqual(r.document.scenes[0].interactionEvents,[]);assert.equal(r.report.editableComplete,false);assert.deepEqual(r.sidecars[0].payload,source);
});
test("unlayered fallback is an explicit allocated identity; bad references are not auto-repaired", () => {
  const source=legacy();delete source.marks[0].layer;
  const blocked=mapLegacyCanvas(source,context());assert.equal(blocked.status,"blocked");assert.equal(blocked.document,null);issueCode(blocked,"AMBIGUOUS_TARGET");
  const mapped=mapLegacyCanvas(source,{...context(),unlayeredLayerId:id("layer",9)});assert.equal(mapped.status,"mapped");assert.equal(mapped.document.scenes[0].layers.at(-1).name,"legacy-unlayered");
  source.marks[0].layer="L99";const missing=mapLegacyCanvas(source,{...context(),unlayeredLayerId:id("layer",9)});assert.equal(missing.document,null);issueCode(missing,"UNRESOLVED_REFERENCE");
});
test("duplicate domain IDs, missing axes and unsupported objects block without dropping source entities", () => {
  for(const mutate of [s=>s.marks.push(structuredClone(s.marks[0])),s=>s.layers.push(structuredClone(s.layers[0])),s=>s.objects.push(structuredClone(s.objects[0]))]) {const source=legacy();mutate(source);const r=mapLegacyCanvas(source,context());assert.equal(r.status,"blocked");assert.equal(r.document,null);assert.deepEqual(r.sidecars[0].payload,source);issueCode(r,"INTEGRITY_ERROR");}
  const source=legacy();source.objects[0].type="future-3d";const r=mapLegacyCanvas(source,context());assert.equal(r.status,"blocked");issueCode(r,"UNSUPPORTED_SCHEMA");
});
test("legacy raster objects require verified asset intake instead of fake conversion or flattening", () => {
  const source=legacy();source.objects[0].type="image";source.objects[0].props={png:"data:image/png;base64,raw",region:{x:0,y:0,x2:1,y2:1}};source.baseAsObject=true;
  const r=mapLegacyCanvas(source,context());assert.equal(r.status,"blocked");assert.equal(r.document,null);issueCode(r,"BLOCKED_DEPENDENCY");assert.equal(r.sidecars[0].payload.objects[0].props.png,source.objects[0].props.png);
});
test("explicit link mappings preserve direction and claim source; external targets stay unresolved", () => {
  const source=legacy(),other="img:"+"b".repeat(16);source.links={[other]:[{id:"k1",left:"user-ink",right:"remote",confidence:"low",review:"rejected",note:"related"}]};
  assert.equal(mapLegacyCanvas(source,context()).status,"blocked");
  const ctx={...context(),relationBindings:[{otherSetKey:other,legacyId:"k1",bindingId:id("bind"),target:{documentId:id("doc",2),sceneId:id("scene",2),kind:"annotation",id:"remote"}}]};
  const r=mapLegacyCanvas(source,ctx);assert.equal(r.status,"mapped");const b=r.document.bindings[0];assert.equal(b.from.id,"user-ink");assert.equal(b.to.id,"remote");assert.equal(b.status,"unresolved");assert.equal(b.finding.verification.currentState,"stale");assert.equal(b.finding.verification.historicalState,"user-rejected");assert.deepEqual(b.original,source.links[other][0]);assert.equal(r.report.editableComplete,false);issueCode(r,"UNRESOLVED_REFERENCE");
});
test("derivedFrom is remapped only through the explicit namespaced allocation table", () => {
  const source=legacy();source.marks[0].derivedFrom={set:source.imageId,mark:"original"};
  const absent=mapLegacyCanvas(source,context());assert.equal(absent.document.scenes[0].annotations[0].provenance.derivedFrom,undefined);assert.equal(absent.report.editableComplete,false);
  const target={documentId:id("doc",9),sceneId:id("scene",9),kind:"annotation",id:"original"};
  const ctx={...context(),identityMapping:{namespace:{kind:"local-migration",storeInstanceId:context().sourceStoreId},entries:[{source:{schema:"canvas.json/version:1",legacyKey:source.imageId,kind:"annotation",id:"original"},target}]}};
  assert.deepEqual(mapLegacyCanvas(source,ctx).document.scenes[0].annotations[0].provenance.derivedFrom,target);
});
test("missing observer/source never becomes fabricated tool evidence", () => {
  const source=legacy();delete source.marks[0].evidence[0].observer;const r=mapLegacyCanvas(source,context()),f=r.document.scenes[0].annotations[0].finding;
  assert.deepEqual(f.evidence,[]);assert.equal(f.verification.currentState,"stale");assert.equal(f.verification.historicalState,"user-confirmed");assert.equal(r.report.editableComplete,false);assert.deepEqual(r.sidecars[0].payload.marks[0].evidence,source.marks[0].evidence);
});
test("invalid coordinates, schemas and malformed records fail explicitly, never clamp or discard", () => {
  for(const mutate of [s=>s.marks[0].points[0].x=2,s=>s.layers[0].opacity=-1,s=>s.version=99,s=>s.marks[0]=null,s=>s.layers=null]) {const source=legacy();mutate(source);const r=mapLegacyCanvas(source,context());assert.equal(r.status,"blocked");assert.equal(r.document,null);assert.deepEqual(r.sidecars[0].payload,source);assert.ok(r.report.issues.some(i=>i.blocking));}
  const x=legacy();x.loop=x;assert.throws(()=>mapLegacyCanvas(x,context()),e=>e instanceof DocumentValidationError && e.code==="INVALID_INPUT");
});
test("fork identity and coordinate transforms use caller context, not image pixels as Document identity", () => {
  const source=legacy(),a=mapLegacyCanvas(source,context());source.setId="c12345678";
  const b=mapLegacyCanvas(source,{...context(),documentId:id("doc",2),sceneId:id("scene",2)});
  assert.equal(b.status,"mapped");assert.notEqual(a.document.id,b.document.id);assert.equal(a.document.scenes[0].background.asset.assetId,b.document.scenes[0].background.asset.assetId);
  assert.equal(b.document.provenance.legacySetKey,source.imageId+"#c12345678");assert.equal(b.document.persistence,"memory");assert.deepEqual(b.document.scenes[0].background.sourceToDocument,context().sourceToDocument);
});
test("UVA-27 subset: actual legacy serialization and legacy AI editing restrictions remain unchanged", () => {
  const original=legacy(),entry={imageId:original.imageId,width:1600,height:1000,marks:new Map(),objects:new Map(),layers:[]};restoreCanvas(entry,original);
  const first=serializeCanvas(entry);first.savedAt=TIME;const before=canonicalJson(first),r=mapLegacyCanvas(first,context());assert.equal(r.status,"mapped");
  const after=serializeCanvas(entry);after.savedAt=TIME;assert.equal(canonicalJson(after),before);
  const ai=entry.marks.get("ai");assert.throws(()=>editCanvas(entry,{marks:[{id:"ai",color:"red"}],resolveUser:m=>m}),/its color stays as the AI wrote it/);assert.deepEqual(entry.marks.get("ai"),ai);
  assert.ok(parseVisualDocument(r.document));
});
test("mapping contexts cannot accidentally resolve a local source in another store namespace", () => {
  const ctx={...context(),identityMapping:{namespace:{kind:"local-migration",storeInstanceId:id("doc",99).slice(4)},entries:[]}};
  assert.throws(()=>mapLegacyCanvas(legacy(),ctx),e=>e instanceof DocumentValidationError && e.code==="INTEGRITY_ERROR");
});
test("malformed optional containers and null link entries produce reports instead of TypeErrors", () => {
  for(const mutate of [s=>s.links=null,s=>s.gestureDecisions=null,s=>s.rejections={},s=>s.baseAsObject="true",s=>s.links={other:[null]}]) {const x=legacy();mutate(x);const r=mapLegacyCanvas(x,context());assert.equal(r.status,"blocked");issueCode(r,"INVALID_INPUT");}
  const x=legacy();x.gestureDecisions.push(null);const r=mapLegacyCanvas(x,context());assert.equal(r.status,"mapped");assert.equal(r.report.editableComplete,false);assert.deepEqual(r.sidecars[0].payload,x);
});

test("unsupported provenance metadata and malformed historical times are explicitly archived", () => {
  const source=legacy();source.objects[0].provenance.createdAt="not-a-date";source.objects[0].provenance.moduleVersion=42;source.objects[0].provenance.effectiveGrants=["annotation.write.owned"];
  const r=mapLegacyCanvas(source,context());assert.equal(r.status,"mapped");assert.equal(r.report.editableComplete,false);
  assert.equal(r.document.scenes[0].objects[0].provenance.createdAt,null);assert.equal(r.document.scenes[0].objects[0].provenance.createdBy.version,null);
  assert.equal(r.document.scenes[0].objects[0].provenance.ownership.kind,"unclaimed-module");assert.deepEqual(r.sidecars[0].payload,source);issueCode(r,"ARCHIVED_LEGACY_FIELD");
});

test("same short alias with different full hashes blocks instead of last-wins asset substitution", () => {
  const ctx=context();ctx.evidenceAssets=[{assetId:"asset:sha256:"+HASH.slice(0,16)+"b".repeat(48),legacyImageId:ctx.asset.legacyImageId}];
  const r=mapLegacyCanvas(legacy(),ctx);assert.equal(r.status,"blocked");assert.equal(r.document,null);issueCode(r,"INTEGRITY_ERROR");assert.deepEqual(r.sidecars[0].payload,legacy());
});
