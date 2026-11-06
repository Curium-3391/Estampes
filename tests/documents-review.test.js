import test from "node:test";
import assert from "node:assert/strict";
import { document, populated, embed, legacy, context, id } from "./fixtures/uva-pr1a.mjs";
import { validatePartialDocumentSnapshots, validateCompleteDocumentClosure, validateDocumentReferences } from "../src/documents/integrity.js";
import { hashJson } from "../src/documents/validation.js";
import { mapLegacyCanvas } from "../src/documents/legacy-shadow.js";

const declare = docs => ({ schema: "estampes.document-closure/1", storeInstanceId: id("doc",8).slice(4), generation: 1,
  documents: docs.map(d => ({ documentId:d.id, revision:d.revision, contentHash:hashJson(d) })) });
const code = expected => e => e.code === expected;

test("F-01 partial snapshots report a missing active external dependency without inventing a target", () => {
  const parent=embed(), r=validatePartialDocumentSnapshots([parent]);
  assert.equal(r.completeClosure,false);assert.equal(r.authorizationChecked,false);assert.equal(r.binaryAssetsChecked,false);
  assert.equal(r.missingDependencies.length,1);assert.equal(r.missingDependencies[0].required,true);
  assert.equal(r.missingDependencies[0].target.documentId,id("doc",2));assert.deepEqual(r.documents,[parent]);
  assert.throws(()=>validateDocumentReferences([parent]),code("UNRESOLVED_REFERENCE"));
});
test("F-01 a declared complete closure rejects missing active dependencies and accepts coherent provided children", () => {
  const docs=[embed(),document(2)];
  assert.throws(()=>validateCompleteDocumentClosure([docs[0]],declare([docs[0]])),code("UNRESOLVED_REFERENCE"));
  const r=validateCompleteDocumentClosure(docs,declare(docs));assert.equal(r.completeClosure,true);assert.deepEqual(r.missingDependencies,[]);
});
test("F-01 missing targets in supplied Documents remain errors even in partial mode", () => {
  const parent=embed(),child=document(2);child.scenes[0].id=id("scene",20);child.defaultSceneId=child.scenes[0].id;
  assert.throws(()=>validatePartialDocumentSnapshots([parent,child]),code("UNRESOLVED_REFERENCE"));
});
test("F-01 closure declarations are exact revision/hash sets, not caller assertions of validity", () => {
  const d=document();
  for (const change of [m=>m.documents[0].revision++,m=>m.documents[0].contentHash="b".repeat(64),m=>m.documents.push(m.documents[0]),m=>m.documents=[]]) {
    const m=declare([d]);change(m);assert.throws(()=>validateCompleteDocumentClosure([d],m),code("INTEGRITY_ERROR"));
  }
});
test("F-01 explicitly unresolved and historical references are preserved and reported in complete closure", () => {
  const d=embed();d.bindings[0].status="unresolved";
  const r=validateCompleteDocumentClosure([d],declare([d]));assert.equal(r.completeClosure,true);
  assert.equal(r.missingDependencies[0].required,false);assert.equal(r.missingDependencies[0].reason,"explicitly-unresolved");
  const p=populated();p.scenes[0].annotations[0].provenance.derivedFrom={documentId:id("doc",99),sceneId:id("scene",99),kind:"annotation",id:"history"};
  assert.equal(validateCompleteDocumentClosure([p],declare([p])).missingDependencies[0].reason,"historical");
  p.scenes[0].annotations[0].finding={claimContext:{claimId:id("event"),claimRevision:1,geometryHash:"a".repeat(64),anchorHash:"a".repeat(64),sourceRevisionVector:[{ref:p.scenes[0].annotations[0].provenance.derivedFrom,revision:1,semanticHash:"a".repeat(64)}]},verification:{historicalState:"user-confirmed",currentState:"user-confirmed",contextHash:"a".repeat(64)}};
  assert.throws(()=>validateCompleteDocumentClosure([p],declare([p])),code("UNRESOLVED_REFERENCE"));
  p.scenes[0].annotations[0].finding.verification.currentState="stale";
  assert.ok(validateCompleteDocumentClosure([p],declare([p])).missingDependencies.some(x=>x.reason==="historical-context"));
});
test("F-01 neither validation mode bypasses canonical bindings, ownership or embed cycle limits", () => {
  const a=embed(document(),document(2)),b=embed(document(2),document());
  assert.throws(()=>validatePartialDocumentSnapshots([a,b]),code("INTEGRITY_ERROR"));
  assert.throws(()=>validateCompleteDocumentClosure([a,b],declare([a,b])),code("INTEGRITY_ERROR"));
  const broken=embed();broken.bindings[0].child.sceneId=id("scene",99);
  assert.throws(()=>validatePartialDocumentSnapshots([broken]),code("INTEGRITY_ERROR"));
});
test("F-02 JSON record recovery never attests source-file bytes, assets or successful migration", () => {
  const source=legacy(),r=mapLegacyCanvas(source,context());
  assert.equal(r.report.rawRecoverable,true);assert.equal(r.report.mapped,true);assert.equal(r.status,"mapped");
  assert.equal(r.report.originalFileBytesVerified,false);assert.equal(r.report.binaryAssetsVerified,false);assert.equal(r.report.migrationCompleted,false);
  assert.equal(r.report.recoveryScope,"json-record-only");assert.equal(r.report.sourceHashKind,"canonical-json/sha256");
  assert.equal(r.report.sourceHash,hashJson(source));assert.deepEqual(r.sidecars[0].payload,source);
});
test("F-02 mapped, editableComplete and rawRecoverable are independent statements", () => {
  const source=legacy();source.unknown={v:1};source.userEdits=[{id:"ai",before:{x:0},after:{x:1}}];
  const r=mapLegacyCanvas(source,context());assert.equal(r.report.rawRecoverable,true);assert.equal(r.report.mapped,true);assert.equal(r.report.editableComplete,false);
  assert.deepEqual(r.sidecars[0].payload.userEdits,source.userEdits);assert.deepEqual(r.sidecars[0].payload.unknown,source.unknown);
  source.objects[0].type="unknown";const blocked=mapLegacyCanvas(source,context());
  assert.equal(blocked.status,"blocked");assert.equal(blocked.report.mapped,false);assert.equal(blocked.report.editableComplete,false);
  assert.equal(blocked.report.rawRecoverable,true);assert.equal(blocked.report.migrationCompleted,false);assert.equal(blocked.document,null);
});
