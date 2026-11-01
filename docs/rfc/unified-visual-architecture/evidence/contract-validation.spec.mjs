// Non-production documentation tests. Explicitly run via node --test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePackage } from './validate-contract-examples.mjs';
import { validateExample, normalizeRequestId, Provenance, EmbeddedObject, Matrix, CommitRoot, CommitIndexEntry, RecoveryResolver, SnapshotEligibility, NestedSnapshotError, api } from './proposed-contracts.mjs';
const examples=JSON.parse(readFileSync(new URL('./contract-examples.json',import.meta.url),'utf8'));
const copy=id=>structuredClone(examples.find(e=>e.id===id));
const uid=(p,n=1)=>p+':'+String(n).padStart(8,'0')+'-0000-4000-8000-000000000001';
const principal={kind:'module',moduleId:'org.estampes.graph',publisherFingerprint:'a'.repeat(64),ownershipLineageId:uid('lineage'),version:'1.0.0',packageDigest:'b'.repeat(64)};
const provenance={author:'module',createdBy:principal,lastEditedBy:principal,createdAt:'2026-11-01T00:00:00Z',lastEditedAt:'2026-11-01T00:00:00Z',ownership:{kind:'module',moduleId:principal.moduleId,publisherFingerprint:principal.publisherFingerprint,ownershipLineageId:principal.ownershipLineageId},grounding:'tool-output',editedByUser:false,sourceTrust:'local'};
test('all nine proposed examples and classified Markdown fences match',()=>assert.deepEqual(validatePackage().errors,[]));
test('request ID normalization is deterministic and rejects short IDs',()=>{assert.equal(normalizeRequestId(uid('req')),uid('cmd'));assert.throws(()=>normalizeRequestId('create-a'));});
test('legacy/string layer example is rejected; layer object is valid',()=>{const e=copy('EX-04');e.arguments.operations[0].layer='new-user';assert.throws(()=>validateExample(e));assert.equal(validateExample(copy('EX-04')),true);});
test('missing required target revision is rejected',()=>{const e=copy('EX-03');delete e.arguments.expectedDocumentRevision;assert.throws(()=>validateExample(e));});
test('legacy/new revision axes cannot be mixed',()=>{const e=copy('EX-05');e.arguments.expectedRevision=3;assert.throws(()=>validateExample(e));});
test('short document and mismatched response reference are rejected',()=>{const e=copy('EX-03');e.arguments.target.documentId='d1';assert.throws(()=>validateExample(e));const f=copy('EX-03');f.response.created[0].documentId=uid('doc',9);assert.throws(()=>validateExample(f));});
test('caller cannot forge author, actor, ownership or commandId',()=>{for(const field of ['author','actor','ownership','commandId']){const e=copy('EX-04');e.arguments[field]='user';assert.throws(()=>validateExample(e));}});
test('module provenance requires consistent author and publisher lineage',()=>{assert.ok(Provenance.safeParse(provenance).success);const a=structuredClone(provenance);a.author='assistant';assert.equal(Provenance.safeParse(a).success,false);const b=structuredClone(provenance);b.ownership.moduleId='org.example.other';assert.equal(Provenance.safeParse(b).success,false);});
test('user editing preserves createdBy and records user as last editor',()=>{const p={...provenance,lastEditedBy:{kind:'user',principalId:'owner:local'},editedByUser:true,lastUserEditRevision:2};assert.ok(Provenance.safeParse(p).success);assert.equal(p.createdBy.kind,'module');});
test('embed requires affine inverse and explicit clip',()=>{const e=copy('EX-06');e.arguments.localToDocument=[0,0,0,0,0,0,0,0,1];assert.throws(()=>validateExample(e));const f=copy('EX-06');delete f.arguments.clipRegion;assert.throws(()=>validateExample(f));});
test('snapshot embed requires independently identified editable child and origin',()=>{const parent=copy('EX-06').arguments.parent,child=copy('EX-06').arguments.source;const e={type:'embedded-document',id:uid('obj',8),revision:1,parent,layerId:uid('layer'),visibility:'public',locked:false,provenance,props:{bindingId:uid('bind'),child,mode:'snapshot',sourceRevision:4,localToDocument:[1,0,0,0,1,0,0,0,1],clipRegion:{space:'child-document',x:0,y:0,x2:10,y2:10},missingTargetPolicy:'placeholder',defaultEditTarget:'parent'}};assert.equal(EmbeddedObject.safeParse(e).success,false);e.props.snapshotOrigin={...child,revision:4,contentHash:'c'.repeat(64)};assert.equal(EmbeddedObject.safeParse(e).success,false);e.props.child={documentId:uid('doc',9),sceneId:uid('scene',9)};assert.ok(EmbeddedObject.safeParse(e).success);});
test('CAS example creates owned plot without unsupported adoption input',()=>{const e=copy('EX-07');assert.equal(e.arguments.params.object,undefined);assert.equal(validateExample(e),true);e.arguments.params.object=uid('obj',2);assert.throws(()=>validateExample(e));});
test('invalid operation enum, anchor and unknown capability are rejected',()=>{for(const mutate of [e=>e.arguments.operations[0].op='annotations.create',e=>e.arguments.operations[0].anchor.space='guess']){const e=copy('EX-04');mutate(e);assert.throws(()=>validateExample(e));}const e=copy('EX-03');e.arguments.capability='install_js';assert.throws(()=>validateExample(e));});
test('input schemas are strict and do not default extra grants',()=>{const e=copy('EX-03');e.arguments.grants=['annotation.write.owned'];assert.equal(api.execute_module.input.safeParse(e.arguments).success,false);});
test('unknown historical module identity stays unclaimed without fabricating signer or lineage',()=>{
 const p=structuredClone(provenance);p.sourceTrust='migrated-local';
 Object.assign(p.createdBy,{publisherFingerprint:null,ownershipLineageId:null,version:null,packageDigest:null});
 p.ownership={kind:'unclaimed-module',moduleId:principal.moduleId,historicalSourceHash:'d'.repeat(64)};
 assert.ok(Provenance.safeParse(p).success);p.sourceTrust='local';assert.equal(Provenance.safeParse(p).success,false);
});
test('adoption can link a historical source without rewriting its creator',()=>{
 const p=structuredClone(provenance);p.sourceTrust='migrated-local';p.createdBy.publisherFingerprint=null;p.createdBy.ownershipLineageId=null;
 assert.equal(Provenance.safeParse(p).success,false);p.ownership.adoptionEventId=uid('event',9);assert.ok(Provenance.safeParse(p).success);
 assert.equal(p.createdBy.publisherFingerprint,null); // shape validates; actual event authorization remains a runtime gate
});
test('external import archives authorship without granting local module ownership',()=>{
 const p=structuredClone(provenance);p.sourceTrust='imported-unverified';
 assert.equal(Provenance.safeParse(p).success,false);
 p.original={sourceSchema:'estampes.document/1',payloadHash:'d'.repeat(64),archiveRef:'migration-raw/1'};
 p.createdBy={kind:'import',sourceId:'bundle:'+'c'.repeat(64)};p.author='unknown';
 assert.equal(Provenance.safeParse(p).success,false); // importing signer/lineage is still not a grant
 p.ownership={kind:'unclaimed-module',moduleId:principal.moduleId,historicalSourceHash:'d'.repeat(64)};
 assert.ok(Provenance.safeParse(p).success);
});
test('affine validation uses the specified condition rather than determinant magnitude',()=>{
 assert.ok(Matrix.safeParse([1e-7,0,0,0,1e-7,0,0,0,1]).success);
 assert.equal(Matrix.safeParse([1e10,0,0,0,1e-4,0,0,0,1]).success,false);
 assert.equal(Matrix.safeParse([1,0,1e7,0,1,1e7,0,0,1]).success,false);
 assert.ok(Matrix.safeParse([0,-2,10,2,0,20,0,0,1]).success);
});
test('commit root requires one closed registry/locator/ledger/authority root set',()=>{
 const roots=Object.fromEntries(['registry','locator','ledger','commitIndex','retention','authority'].map((k,i)=>[k,String(i).repeat(64)]));
 const root={schema:'estampes.commit-root/1',storeInstanceId:uid('doc').slice(4),generation:1,commitId:uid('tx'),parentCommitHash:null,roots};
 assert.ok(CommitRoot.safeParse(root).success);
 for(const key of Object.keys(roots)){const bad=structuredClone(root);delete bad.roots[key];assert.equal(CommitRoot.safeParse(bad).success,false);}
 assert.equal(CommitRoot.safeParse({...root,locatorCurrent:'another-pointer'}).success,false);
 assert.equal(CommitRoot.safeParse({...root,generation:2}).success,false);
 assert.ok(CommitRoot.safeParse({...root,generation:2,parentCommitHash:'a'.repeat(64)}).success);
 assert.equal(CommitRoot.safeParse({...root,roots:{...roots,locator:'unverified'}}).success,false);
});
test('nested snapshot refusal is typed and contains no child data or raster fallback',()=>{
 const source=copy('EX-06').arguments.source;
 const eligibility={supported:false,reason:'NESTED_SNAPSHOT_UNSUPPORTED',source,sourceRevision:4,sourceContentHash:'a'.repeat(64),bindingGraphHash:'b'.repeat(64),blockers:[{...source,kind:'object',id:uid('obj',7)}],redactedBlockerCount:0,alternatives:['live','editable-bundle']};
 assert.ok(SnapshotEligibility.safeParse(eligibility).success);
 const error={isError:true,structuredContent:{kind:'estampes.document_error',code:'BLOCKED_DEPENDENCY',message:'Nested source snapshot is unsupported in V1',retryable:false,details:{reason:'NESTED_SNAPSHOT_UNSUPPORTED',operation:'embed.freeze',snapshotEligibility:eligibility}}};
 assert.ok(NestedSnapshotError.safeParse(error).success);
 for(const patch of [{supported:true},{blockers:[]},{childTitle:'denied-title'},{alternatives:['rasterize']}])assert.equal(SnapshotEligibility.safeParse({...eligibility,...patch}).success,false);
 assert.equal(NestedSnapshotError.safeParse({...error,structuredContent:{...error.structuredContent,retryable:true}}).success,false);
 const supported={...eligibility,supported:true,blockers:[]};delete supported.reason;assert.ok(SnapshotEligibility.safeParse(supported).success);delete supported.sourceContentHash;assert.equal(SnapshotEligibility.safeParse(supported).success,false);
 const redacted={...eligibility,blockers:[],redactedBlockerCount:1};assert.equal(SnapshotEligibility.safeParse(redacted).success,false);delete redacted.sourceContentHash;assert.ok(SnapshotEligibility.safeParse(redacted).success);
});
test('commit membership does not self-reference its enclosing content-addressed root',()=>{
 const entry={commitId:uid('tx'),generation:1,registryRootHash:'a'.repeat(64),requestKeyDigest:null,payloadHash:'b'.repeat(64),resultHash:'c'.repeat(64),outcome:'committed'};
 assert.ok(CommitIndexEntry.safeParse(entry).success);
 assert.equal(CommitIndexEntry.safeParse({...entry,commitRootHash:'d'.repeat(64)}).success,false);
 const bad={...entry};delete bad.registryRootHash;assert.equal(CommitIndexEntry.safeParse(bad).success,false);
});
test('recovery pairing names the locator component without a self-referential commit hash',()=>{
 const pair={registryRootHash:'a'.repeat(64),logicalClosureHash:'b'.repeat(64),resolverLocatorRootHash:'c'.repeat(64)};
 assert.ok(RecoveryResolver.safeParse(pair).success);
 assert.equal(RecoveryResolver.safeParse({...pair,resolverCommitHash:'d'.repeat(64)}).success,false);
 const bad={...pair};delete bad.resolverLocatorRootHash;assert.equal(RecoveryResolver.safeParse(bad).success,false);
});
