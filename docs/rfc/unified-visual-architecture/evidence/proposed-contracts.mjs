// DOCUMENTATION ONLY. Proposed schemas; no production imports or API registration.
import { z } from 'zod';
export const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const typed = p => z.string().regex(new RegExp('^' + p + ':' + uuid + '$'));
export const ids = Object.fromEntries(['doc','scene','vp','panel','cmd','req','tx','bind','event','obj','ann','layer','lineage','exec'].map(p => [p, typed(p)]));
export const ModuleId = z.string().regex(/^[a-z][a-z0-9-]{0,30}(\.[a-z0-9][a-z0-9-]{0,30}){2,5}$/);
export const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const n = z.number().finite();
export const SceneRef = z.object({ documentId:ids.doc, sceneId:ids.scene }).strict();
const local = {object:z.union([ids.obj,z.string().regex(/^o[1-9][0-9]{0,5}$/)]),annotation:z.union([ids.ann,z.string().min(1).max(64)]),layer:z.union([ids.layer,z.string().regex(/^L[1-9][0-9]{0,5}$/)]),frame:z.string().min(1).max(80)};
export const Ref = z.discriminatedUnion('kind',Object.entries(local).map(([kind,id]) => SceneRef.extend({kind:z.literal(kind),id}).strict()));
export const ObjectRef = SceneRef.extend({kind:z.literal('object'),id:local.object}).strict();
export const AnnotationRef = SceneRef.extend({kind:z.literal('annotation'),id:local.annotation}).strict();
export const Principal = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('user'),principalId:z.string().min(1).max(160)}).strict(),
  z.object({kind:z.literal('assistant'),principalId:z.string().min(1).max(160)}).strict(),
  z.object({kind:z.literal('module'),moduleId:ModuleId,publisherFingerprint:hash.nullable(),ownershipLineageId:ids.lineage.nullable(),version:z.string().regex(/^\d+\.\d+\.\d+$/).nullable(),packageDigest:hash.nullable()}).strict(),
  z.object({kind:z.enum(['legacy-unknown','import']),sourceId:z.string().min(1).max(160)}).strict()
]);
export const Ownership = z.discriminatedUnion('kind',[
 z.object({kind:z.literal('instance'),ownerId:z.string().min(1).max(160)}).strict(),
 z.object({kind:z.literal('module'),moduleId:ModuleId,publisherFingerprint:hash,ownershipLineageId:ids.lineage,adoptionEventId:ids.event.optional()}).strict(),
 z.object({kind:z.literal('unclaimed-module'),moduleId:ModuleId,historicalSourceHash:hash}).strict()
]);
export const Provenance = z.object({author:z.enum(['user','assistant','module','unknown']),createdBy:Principal,createdAt:z.string().datetime().nullable(),lastEditedBy:Principal,lastEditedAt:z.string().datetime().nullable(),ownership:Ownership,grounding:z.string().min(1),editedByUser:z.boolean(),lastUserEditRevision:revision.optional(),sourceTrust:z.enum(['local','migrated-local','imported-unverified']),original:z.object({sourceSchema:z.string(),payloadHash:hash,archiveRef:z.string()}).strict().optional(),derivedFrom:Ref.optional()}).strict().superRefine((p,c)=>{
 const expected=['user','assistant','module'].includes(p.createdBy.kind)?p.createdBy.kind:'unknown';
 if(p.author!==expected)c.addIssue({code:'custom',message:'author must be derived from createdBy'});
 if(p.author==='module' && p.sourceTrust==='local' && p.ownership.kind!=='module')c.addIssue({code:'custom',message:'local module creation requires explicit module ownership'});
 if(p.author==='module' && p.sourceTrust==='local' && ['publisherFingerprint','ownershipLineageId','version','packageDigest'].some(k=>p.createdBy[k]===null))c.addIssue({code:'custom',message:'local module actor must have verified registry identity'});
 if(p.author==='module' && (p.createdBy.publisherFingerprint===null||p.createdBy.ownershipLineageId===null) && p.ownership.kind!=='unclaimed-module' && !p.ownership.adoptionEventId)c.addIssue({code:'custom',message:'unknown historical lineage needs unclaimed owner or explicit adoption event'});
 if(p.author==='module' && p.ownership.kind==='module' && (p.ownership.moduleId!==p.createdBy.moduleId||(['publisherFingerprint','ownershipLineageId'].some(k=>p.ownership[k]!==p.createdBy[k])&&!p.ownership.adoptionEventId)))c.addIssue({code:'custom',message:'module owner lineage mismatch without explicit adoption event'});
 if(p.sourceTrust==='local' && (!p.createdAt||!p.lastEditedAt))c.addIssue({code:'custom',message:'local provenance requires server timestamps'});
 if(p.sourceTrust==='imported-unverified' && (p.createdBy.kind!=='import'||p.author!=='unknown'||p.ownership.kind==='module'||!p.original))c.addIssue({code:'custom',message:'external import needs unknown active creator, archived original and no module ownership'});
});
export const Matrix = z.array(n).length(9).superRefine((m,c)=>{
 if(m.length!==9)return;
 const [a,b,tx,d,e,ty]=m,det=a*e-b*d;
 if(m[6]!==0||m[7]!==0||m[8]!==1||det===0||!Number.isFinite(det)){
  c.addIssue({code:'custom',message:'non-invertible or non-affine matrix'});return;
 }
 const inv=[e/det,-b/det,(b*ty-e*tx)/det,-d/det,a/det,(d*tx-a*ty)/det,0,0,1];
 const norm=v=>Math.max(...[0,3,6].map(i=>Math.abs(v[i])+Math.abs(v[i+1])+Math.abs(v[i+2])));
 const condition=norm(m)*norm(inv);
 if(!inv.every(Number.isFinite)||!Number.isFinite(condition)||condition>1e12)c.addIssue({code:'custom',message:'matrix infinity-norm condition exceeds 1e12'});
});
export const Clip = z.object({space:z.literal('child-document'),x:n,y:n,x2:n,y2:n}).strict().refine(r=>r.x>=0&&r.y>=0&&r.x2>r.x&&r.y2>r.y,'positive child clip required');
export const EmbeddedObject = z.object({type:z.literal('embedded-document'),id:local.object,revision,parent:SceneRef,layerId:local.layer,visibility:z.enum(['public','scratch']),locked:z.boolean(),provenance:Provenance,props:z.object({bindingId:ids.bind,child:SceneRef,mode:z.enum(['live','snapshot']),sourceRevision:revision,snapshotOrigin:SceneRef.extend({revision,contentHash:hash}).strict().optional(),localToDocument:Matrix,clipRegion:Clip,missingTargetPolicy:z.literal('placeholder'),defaultEditTarget:z.literal('parent')}).strict()}).strict().superRefine((e,c)=>{if(e.props.mode==='snapshot'&&(!e.props.snapshotOrigin||e.props.child.documentId===e.props.snapshotOrigin.documentId))c.addIssue({code:'custom',message:'snapshot requires independent clone and origin'});});
export const permissions = ['document.read.target','scene.write.owned','document.create.graph','document.create.image','document.reference.read','annotation.write.owned','asset.read.selected','cas.compute'];
// Internal proposed read/persistence projections only; not new callable APIs.
export const CommitRoot = z.object({schema:z.literal('estampes.commit-root/1'),storeInstanceId:z.string().regex(new RegExp('^'+uuid+'$')),generation:revision,commitId:ids.tx,parentCommitHash:hash.nullable(),roots:z.object({registry:hash,locator:hash,ledger:hash,commitIndex:hash,retention:hash,authority:hash}).strict()}).strict().refine(r=>r.generation===1?r.parentCommitHash===null:r.parentCommitHash!==null,'only initial commit root has null parent');
export const CommitIndexEntry = z.object({commitId:ids.tx,generation:revision,registryRootHash:hash,requestKeyDigest:hash.nullable(),payloadHash:hash,resultHash:hash,outcome:z.literal('committed')}).strict();
export const RecoveryResolver = z.object({registryRootHash:hash,logicalClosureHash:hash,resolverLocatorRootHash:hash}).strict();
export const SnapshotEligibility = z.object({supported:z.boolean(),reason:z.literal('NESTED_SNAPSHOT_UNSUPPORTED').optional(),source:SceneRef,sourceRevision:revision,sourceContentHash:hash.optional(),bindingGraphHash:hash,blockers:z.array(ObjectRef).max(200),redactedBlockerCount:z.number().int().nonnegative().max(200),alternatives:z.array(z.enum(['live','open-source','link-source','explicit-source-edit','editable-bundle'])).min(1).max(5)}).strict().superRefine((v,c)=>{
 if((v.supported&&!v.sourceContentHash)||(v.redactedBlockerCount>0&&v.sourceContentHash!==undefined))c.addIssue({code:'custom',message:'source hash must be present for supported clone and omitted when redacted'});
 if(v.blockers.some(b=>b.documentId!==v.source.documentId||b.sceneId!==v.source.sceneId))c.addIssue({code:'custom',message:'blockers must refer to source scene objects'});
 if(v.supported ? (v.reason!==undefined||v.blockers.length!==0||v.redactedBlockerCount!==0) : (v.reason!=='NESTED_SNAPSHOT_UNSUPPORTED'||v.blockers.length+v.redactedBlockerCount===0))c.addIssue({code:'custom',message:'eligibility reason/blockers inconsistent'});
});
export const NestedSnapshotError = z.object({isError:z.literal(true),structuredContent:z.object({kind:z.literal('estampes.document_error'),code:z.literal('BLOCKED_DEPENDENCY'),message:z.string().min(1).max(300),retryable:z.literal(false),details:z.object({reason:z.literal('NESTED_SNAPSHOT_UNSUPPORTED'),operation:z.enum(['embed.create.snapshot','embed.detach','embed.freeze','parent.deep-copy','graph-separation.snapshot']),snapshotEligibility:SnapshotEligibility}).strict()}).strict()}).strict().refine(e=>!e.structuredContent.details.snapshotEligibility.supported,'blocked snapshot cannot claim supported');
const Range=z.tuple([n,n]).refine(r=>r[1]>r[0]&&r[1]-r[0]<1e12);
const Point=z.object({x:n,y:n}).strict();
const style=z.object({pen:z.enum(['pen','highlighter']).optional(),color:z.enum(['gold','blue','red','green','yellow','magenta','cyan','white','black']).optional(),size:z.enum(['fine','thin','medium','thick']).optional()}).strict();
const Anchor=z.discriminatedUnion('space',[
 z.object({space:z.literal('document')}).strict(),
 z.object({space:z.literal('world'),frameRef:SceneRef.extend({kind:z.literal('frame'),id:local.frame}).strict()}).strict(),
 z.object({space:z.literal('image-normalized'),asset:z.object({assetId:z.string().regex(/^asset:sha256:[0-9a-f]{64}$/)}).strict(),sourceToDocument:Matrix}).strict(),
 z.object({space:z.literal('object'),objectRef:ObjectRef,attachment:z.object({kind:z.literal('function-x'),x:n,offsetDu:Point}).strict(),onMissing:z.literal('retain-invalid')}).strict()
]);
const geometryFor=t=>t==='polyline'?z.object({points:z.array(Point).min(2).max(128),smooth:z.boolean().optional(),closed:z.boolean().optional()}).strict():t==='point'?z.object({x:n,y:n}).strict():z.object({x:n,y:n,x2:n,y2:n}).strict();
const annotationCreates=['point','rect','arrow','polyline'].map(type=>z.object({op:z.literal('annotation.create'),sceneId:ids.scene,type:z.literal(type),geometry:geometryFor(type),anchor:Anchor,layerId:local.layer.optional(),layer:z.object({name:z.string().trim().min(1).max(40)}).strict().optional(),style:style.optional(),label:z.string().max(64).optional()}).strict().refine(o=>Boolean(o.layerId)!==Boolean(o.layer),'exactly one layerId or layer object'));
export const AnnotationCreate=z.union(annotationCreates);
const Add=z.object({op:z.literal('annotation.update'),sceneId:ids.scene,id:local.annotation,expectedAnnotationRevision:revision,patch:z.object({geometry:z.union(['point','rect','arrow','polyline'].map(geometryFor)).optional(),anchor:Anchor.optional(),style:style.optional(),label:z.string().max(64).optional()}).strict().refine(p=>Object.keys(p).length>0),previewHash:hash.optional()}).strict().refine(o=>!o.patch.anchor||Boolean(o.previewHash),'anchor change requires previewHash');
export const EditOperation=z.union([AnnotationCreate,Add]);
const request={requestId:ids.req};
const common={resultId:ids.event,commitId:ids.tx,replayed:z.boolean()};
const targetRev={documentId:ids.doc,sceneId:ids.scene,revision};
const dep=z.array(SceneRef.extend({revision,contentHash:hash}).strict()).max(12);
const created=Ref;
const graphFunction=z.object({expression:z.string().min(1).max(256),frame:local.object.optional(),newAxes:z.object({xRange:Range,yRange:Range}).strict().optional(),domain:Range.optional(),color:z.enum(['blue','red','green','gold','magenta','cyan','black','gray']).optional()}).strict().refine(p=>Boolean(p.frame)!==Boolean(p.newAxes),'frame or explicit newAxes required');
const graphUpdate=z.object({object:local.object,expression:z.string().min(1).max(256)}).strict();
const notebook=z.string().regex(/^nb:[0-9a-f]{12}$/),cell=z.string().regex(/^cell:[0-9a-f]{12}$/);
const casPlot=z.object({notebook,cell,frame:local.object,linkPolicy:z.literal('pause-on-user-edit')}).strict();
const execBase={...request,target:SceneRef,expectedDocumentRevision:revision};
const execResponse=z.object({...common,...targetRev,created:z.array(created),updated:z.array(Ref),bindingId:ids.bind.optional(),notebookRevision:revision.optional(),refs:z.record(z.string(),Ref)}).strict();
export const api={
 create_visual_document:{input:z.object({...request,kind:z.enum(['graph','image']),title:z.string().max(80),extent:z.object({width:n.positive().max(1e9),height:n.positive().max(1e9)}).strict()}).strict(),output:z.object({...common,...targetRev,assetCount:z.number().int().nonnegative()}).strict()},
 open_visual_panel:{input:z.object({...request,surfaceId:z.string().regex(/^sf:[0-9a-f]{16}$/),target:SceneRef,viewerKind:z.enum(['graph','image']),newViewport:z.boolean(),expectedSurfaceRevision:revision}).strict(),output:z.object({...common,panelId:ids.panel,viewportId:ids.vp,surfaceRevision:revision,target:SceneRef}).strict()},
 execute_module:{input:z.union([
 z.object({...execBase,module:z.literal('org.estampes.graph'),capability:z.literal('plot_function'),params:graphFunction}).strict(),
 z.object({...execBase,module:z.literal('org.estampes.graph'),capability:z.literal('update_plot'),params:graphUpdate}).strict(),
 z.object({...execBase,module:z.literal('org.estampes.cas'),capability:z.literal('plot_result'),expectedNotebookRevision:revision,params:casPlot}).strict()
 ]),output:execResponse},
 edit_visual_document:{input:z.object({...request,documentId:ids.doc,expectedRevision:revision,operations:z.array(EditOperation).min(1).max(64)}).strict(),output:z.object({...common,...targetRev,created:z.array(AnnotationRef),updated:z.array(AnnotationRef)}).strict()},
 embed_visual_document:{input:z.object({...request,parent:SceneRef,source:SceneRef,mode:z.enum(['live','snapshot']),layer:z.object({name:z.string().min(1).max(40)}).strict(),localToDocument:Matrix,clipRegion:Clip,expectedParentRevision:revision,expectedSourceRevision:revision}).strict(),output:z.object({...common,parent:SceneRef.extend({revision}).strict(),child:SceneRef.extend({revision}).strict(),embedRef:ObjectRef,bindingId:ids.bind,dependencyRevisionVector:dep,sharedEditing:z.boolean()}).strict()},
 read_visual_document:{input:z.object({documentId:ids.doc,sceneId:ids.scene,expectedRevision:revision,include:z.literal('summary-and-render'),hiddenLayerIds:z.array(local.layer).max(200)}).strict(),output:z.object({resultId:ids.event,...targetRev,objects:z.array(z.object({ref:ObjectRef,type:z.enum(['axes-2d','function-plot']),expression:z.string().optional()}).strict()),annotations:z.array(z.object({ref:AnnotationRef,anchor:Anchor,verification:z.enum(['unverified','stale','user-confirmed','user-rejected','independently-verified'])}).strict()),render:z.object({revision,contentHash:hash,included:z.object({objects:z.array(ObjectRef),annotations:z.array(AnnotationRef)}).strict(),dependencyRevisionVector:dep}).strict(),bindingStates:z.array(z.object({bindingId:ids.bind,status:z.enum(['fresh','stale','conflict','removed','unavailable','unresolved'])}).strict()),truncated:z.boolean()}).strict()},
 export_visual_document:{input:z.object({...request,documentId:ids.doc,format:z.literal('estampes.bundle/2'),expectedRevision:revision,includeEditable:z.literal(true)}).strict(),output:z.object({...common,documentId:ids.doc,revision,downloadUrl:z.string().url(),format:z.literal('estampes.bundle/2'),counts:z.object({documents:z.number().int().nonnegative(),scenes:z.number().int().nonnegative(),objects:z.number().int().nonnegative(),annotations:z.number().int().nonnegative()}).strict(),lossReport:z.array(z.string())}).strict()}
};
export function normalizeRequestId(id){ ids.req.parse(id);return 'cmd:'+id.slice(4); }
export function validateExample(example){
 const spec=api[example.tool]; if(!spec)throw Error('unsupported proposed example tool');
 spec.input.parse(example.arguments);spec.output.parse(example.response);
 if(example.arguments.requestId) normalizeRequestId(example.arguments.requestId);
 if(example.tool==='execute_module' && example.arguments.params.notebook && !example.response.bindingId)throw Error('CAS response bindingId required');
 if(example.response.documentId && example.arguments.documentId && example.response.documentId!==example.arguments.documentId)throw Error('response document mismatch');
 if(example.response.documentId && example.arguments.target && example.response.documentId!==example.arguments.target.documentId)throw Error('response target mismatch');
 if(example.response.sceneId && example.arguments.target && example.response.sceneId!==example.arguments.target.sceneId)throw Error('response scene mismatch');
 for(const r of [...(example.response.created??[]),...(example.response.updated??[]),...Object.values(example.response.refs??{})])if(example.arguments.target && (r.documentId!==example.arguments.target.documentId||r.sceneId!==example.arguments.target.sceneId))throw Error('returned ref outside target');
 const a=example.arguments,r=example.response;
 if(example.tool==='create_visual_document' && (r.revision!==1||(a.kind==='graph'&&r.assetCount!==0)))throw Error('new graph identity requires revision 1 and no assets');
 if(example.tool==='execute_module' && r.revision!==a.expectedDocumentRevision+1)throw Error('example content change revision axis mismatch');
 if(example.tool==='edit_visual_document' && (r.revision!==a.expectedRevision+1||[...r.created,...r.updated].some(x=>x.documentId!==a.documentId||x.sceneId!==r.sceneId)))throw Error('edit revision/ref mismatch');
 if(example.tool==='open_visual_panel' && (r.surfaceRevision!==a.expectedSurfaceRevision+1||r.target.documentId!==a.target.documentId||r.target.sceneId!==a.target.sceneId))throw Error('panel binding/surface revision mismatch');
 if(example.tool==='embed_visual_document' && (r.parent.documentId!==a.parent.documentId||r.parent.sceneId!==a.parent.sceneId||r.parent.revision!==a.expectedParentRevision+1||r.embedRef.documentId!==a.parent.documentId||r.embedRef.sceneId!==a.parent.sceneId||(a.mode==='live'&&(r.child.documentId!==a.source.documentId||r.child.sceneId!==a.source.sceneId||r.child.revision!==a.expectedSourceRevision))))throw Error('embed identity/revision mismatch');
 if(example.tool==='embed_visual_document' && (r.sharedEditing!==(a.mode==='live')||(a.mode==='snapshot'&&(r.child.documentId===a.source.documentId||r.child.revision!==1))))throw Error('embed snapshot must be an independent new document');
 if(example.tool==='read_visual_document' && (r.sceneId!==a.sceneId||r.revision!==a.expectedRevision||r.render.revision!==r.revision))throw Error('read snapshot mismatch');
 if(example.tool==='export_visual_document' && r.revision!==a.expectedRevision)throw Error('export revision mismatch');
 return true;
}
