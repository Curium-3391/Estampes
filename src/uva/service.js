// PR-1B boundary: legacy is read-only input; only the existing leased worker
// publishes UVA documents. Prepared commands are signed, restart-safe values.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { openIsolatedStore } from '../persistence/lease.js';
import { privateDirectory, privateFile, privateAncestry } from '../persistence/ownership.js';
import { fail } from '../persistence/errors.js';
import { parseVisualDocument, GeometrySchemas, AnnotationStyleSchema } from '../documents/schema.js';
import { createId, RequestIdSchema, DocumentIdSchema } from '../documents/identity.js';
import { canonicalJson, hashJson } from '../documents/validation.js';
import { mapLegacyCanvas } from '../documents/legacy-shadow.js';
import { projectCanvas, diffJson, applyPatch } from './canvas-projection.js';
import { createRouter } from '../modules/router.js';
import { restoreObjects, renderedObjects } from '../scene/scene-ops.js';
import { markSvg } from '../mark-render.js';
import { primitivesSvg } from '../scene/objects.js';
import { zipFiles, unzipFiles } from '../zip.js';

export const BETA_LIMITS = Object.freeze({ workspaces:4, items:4, revisions:25, annotations:128, objects:64, documentBytes:1024**2, assetBytes:8*1024**2, allAssetBytes:64*1024**2, allExportBytes:128*1024**2 });
const OWNER='owner:uva-beta-instance', KIND='estampes.uva/1', MIRROR_KEY='estampes.beta:mirror', RECORD_KEY='estampes.beta:record';
const hash=b=>createHash('sha256').update(b).digest('hex');
const now=()=>new Date().toISOString();
const matrix=(w,h)=>[w,0,0,0,h,0,0,0,1];
const PNG_URI='data:image/png;base64,';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const allocated=(kind,requestId,index=0)=>kind+':'+createHash('sha256').update(requestId+':'+index).digest('hex').replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/,'$1-$2-4$3-8$4-$5');
const principal=author=>({kind:author,principalId:OWNER});
const provenance=(author,time)=>({author,createdBy:principal(author),createdAt:time,lastEditedBy:principal(author),lastEditedAt:time,ownership:{kind:'instance',ownerId:OWNER},grounding:author==='user'?'user-pointer':'unverified',editedByUser:false,sourceTrust:'local'});
async function directory(path) {
  try { await mkdir(path,{mode:0o700}); } catch(e) { if(e.code!=='EEXIST')throw e; }
  privateDirectory(await lstat(path));
  if(await realpath(path)!==path)fail('UNSUPPORTED_STORAGE','Beta paths must not contain symlinks');
  await privateAncestry(path);
}
async function syncDir(path){const fd=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}}
async function bytesAt(path,max){
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const st=await fd.stat();privateFile(st);if(st.size>max)fail('LIMIT','Beta file exceeds byte limit');return await fd.readFile();}finally{await fd.close();}
}
async function immutable(path,bytes){
  const temp=path+'.'+randomUUID()+'.tmp';const fd=await open(temp,'wx',0o600);
  try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
  try{await rename(temp,path);await syncDir(resolve(path,'..'));}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
function checkLimits(d,limits=BETA_LIMITS){
  if(d.scenes.length>limits.items||d.revision>limits.revisions||d.scenes.reduce((n,s)=>n+s.annotations.length,0)>limits.annotations||d.scenes.reduce((n,s)=>n+s.objects.length,0)>limits.objects||Buffer.byteLength(canonicalJson(d))>limits.documentBytes)fail('LIMIT','Experimental workload limit reached; export and start a new copy');
  parseVisualDocument(d);
}
// mirror: the legacy canvas stays the writer; checkpoints of it are copied into
// UVA documents (see syncCanvas). Mirror documents are read-only through UVA.
export const MIRROR_LIMITS = Object.freeze({ ...BETA_LIMITS, workspaces:64, revisions:1_000_000, annotations:512 });
// canvasStore: the UVA document is the canvas's committed record (see
// src/uva/canvas-store.js). Base images and image-object PNGs are verified assets
// here; legacy storage still keeps its own copies, so the asset caps only bound
// this store's copies.
export const STORE_LIMITS = Object.freeze({ ...MIRROR_LIMITS, workspaces:512, assetBytes:32*1024**2, allAssetBytes:1024**3 });
export async function createUvaService({enabled=false,directory:root='',profile='',legacyDirectory='',legacyItems,moduleHost,mirror=false,mirrorMaxCommits=10000,canvasStore=false,assetCapBytes,compactionIdleMs}={}){
  if(!enabled)return {enabled:false,async dispatch(){fail('UNSUPPORTED_TARGET','UVA Experimental Beta is disabled; legacy remains available');},async close(){}};
  if(!root||!['linux-process-crash-test','linux-local-durable'].includes(profile))fail('UNSUPPORTED_STORAGE','Set ESTAMPES_UVA_BETA_DIR and an explicit ESTAMPES_UVA_BETA_PROFILE (linux-process-crash-test is NOT durable)');
  if(canvasStore)mirror=true;
  const limits=canvasStore?{...STORE_LIMITS,...(assetCapBytes?{allAssetBytes:assetCapBytes}:{})}:mirror?MIRROR_LIMITS:BETA_LIMITS;
  const authority=canvasStore?'uva':'legacy-canvas';
  root=resolve(root);const legacy=legacyDirectory&&resolve(legacyDirectory);
  if(legacy&&(root===legacy||root.startsWith(legacy+'/')||legacy.startsWith(root+'/')))fail('UNSUPPORTED_STORAGE','Beta and legacy directories must be separate, without nesting');
  // Creation is deliberately non-recursive: the operator selects an existing,
  // trusted parent. Never chmod or adopt an existing public directory.
  await directory(root);
  const names=await readdir(root);
  if(names.length&&!names.includes('beta-format.json'))fail('UNSUPPORTED_STORAGE','Unrecognized Beta directory; select a new empty private directory');
  const storeRoot=join(root,'estampes-pr1c-beta'),assetRoot=join(root,'assets'),exportRoot=join(root,'exports');
  let format;
  if(!names.length){
    format={schema:'estampes.uva-beta/1',profile,planKey:randomBytes(32).toString('hex')};

  }else format=JSON.parse((await bytesAt(join(root,'beta-format.json'),4096)).toString());
  if(format.schema!=='estampes.uva-beta/1'||format.profile!==profile||!/^[0-9a-f]{64}$/.test(format.planKey))fail('UNSUPPORTED_STORAGE','Incompatible Beta format/profile; never promote a test store to durable');
  if(names.length){
    for(const p of [storeRoot,assetRoot,exportRoot]){privateDirectory(await lstat(p));if(await realpath(p)!==p)fail('UNSUPPORTED_STORAGE','Beta child path was replaced');}
    await lstat(join(storeRoot,'storage-format.json'));await lstat(join(storeRoot,'visual-registry/CURRENT.json'));
  }else for(const p of [storeRoot,assetRoot,exportRoot])await directory(p);
  const store=await openIsolatedStore(storeRoot,{profile,purpose:'isolated-pr1c-testing',quotaBytes:256*1024**2,lifecycle:{enabled:true,autoMaintenance:false,autoCompaction:Boolean(mirror)},...(compactionIdleMs!==undefined?{compactionIdleMs}:{})});
  if(!names.length){
    if(store.status.state!=='ready'){await store.close();fail('RECOVERY_REQUIRED','Fresh store did not initialize safely');}
    await immutable(join(root,'beta-format.json'),Buffer.from(JSON.stringify(format)));
  }
  const signingKey=Buffer.from(format.planKey,'hex');let queue=Promise.resolve();
  let mirrorState=null;const mirrorStatus=()=>mirror?{enabled:true,mode:canvasStore?'canvas-store':'mirror',authority,...(mirrorState??{})}:{enabled:false};
  const serial=fn=>{const p=queue.then(fn,fn);queue=p.catch(()=>{});return p;};
  const diagnostics=async()=>{
    const d=await store.diagnostics();
    return {enabled:true,experimental:true,production:'NOT QUALIFIED',durability:d.platform.durability,profile,state:d.state,problem:d.problem,limits,mirror:mirrorStatus(),contentCommits:d.contentCommits,maintenance:d.lifecycle,assetCommitBoundary:'verified immutable assets are installed before document publication; no cross-store transaction or asset GC',qualification:'process restart only; filesystem and power-loss qualification remains open'};
  };
  async function assetBytes(asset){
    if(!/^asset:sha256:[0-9a-f]{64}$/.test(asset.assetId))fail('INVALID_INPUT','Invalid asset identity');
    const digest=asset.assetId.slice(13),b=await bytesAt(join(assetRoot,digest),limits.assetBytes).catch(e=>{fail('STORAGE_UNAVAILABLE','Missing/unreadable Beta image asset; restore a saved export',{cause:e.code});});
    if(hash(b)!==digest)fail('INTEGRITY_ERROR','Beta asset content hash differs');return b;
  }
  async function putAsset(bytes){
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>limits.assetBytes)fail('LIMIT','Image asset must be 1..'+(limits.assetBytes/1024**2)+' MiB');
    const digest=hash(bytes),asset={assetId:'asset:sha256:'+digest,legacyImageId:'img:'+digest.slice(0,16)},path=join(assetRoot,digest);
    try{await lstat(path);await assetBytes(asset);return asset;}catch(e){if(e.code!=='ENOENT')throw e;}
    let total=0;for(const f of await readdir(assetRoot))total+=(await lstat(join(assetRoot,f))).size;
    if(total+bytes.length>limits.allAssetBytes)fail('LIMIT','Beta assets exceed '+Math.round(limits.allAssetBytes/1024**2)+' MiB; export before operator cleanup');
    await immutable(path,bytes);await assetBytes(asset);return asset;
  }
  async function verifyAssets(d){
    // A canvas document may have a transparent background: its base image was
    // promoted into an image object (add_image_layer). Its marks stay anchored
    // to the source image, which must still verify.
    const canvasDoc=Boolean(d.extensions?.[MIRROR_KEY]);
    // A record document (workspace, surface, notebook) has one empty transparent scene.
    if(d.extensions?.[RECORD_KEY]){if(d.scenes.some(s=>s.background.kind!=='transparent'||s.annotations.length||s.objects.length))fail('INTEGRITY_ERROR','A record document holds no visual content');return;}
    for(const s of d.scenes){
      if(s.background.kind!=='asset'&&!(canvasDoc&&s.background.kind==='transparent'))fail('UNSUPPORTED_TARGET','Beta scenes require an image background');
      const anchor=s.background.kind==='asset'?s.background.asset:s.annotations[0]?.anchor.asset;
      if(s.background.kind!=='asset'&&anchor&&anchor.legacyImageId!==d.provenance.legacySetKey.split('#')[0])fail('INTEGRITY_ERROR','Marks of a canvas are anchored to another image');
      if(s.background.kind==='asset')await assetBytes(s.background.asset);
      for(const a of s.annotations)if(a.anchor.space!=='image-normalized'||!same(a.anchor.asset,anchor)||!same(a.anchor.sourceToDocument,matrix(s.extent.width,s.extent.height)))fail('UNSUPPORTED_TARGET','Beta editor supports only explicit image-normalized annotations');
      if(s.background.kind!=='asset'&&s.annotations.length)await assetBytes(anchor);
      // Image objects reference verified assets (canvas documents only); embedded documents need binding intake.
      if(s.objects.some(o=>o.type==='embedded-document'||(o.type==='image'&&!canvasDoc)))fail('UNSUPPORTED_TARGET','Image/embedded objects need explicit asset/binding intake; source is unchanged');
      for(const o of s.objects)if(o.type==='image')await assetBytes(o.props.asset);
    }
  }
  async function snapshot(){return store.snapshot();}
  async function document(id){DocumentIdSchema.parse(id);const s=await snapshot(),d=s.documents.find(d=>d.id===id);if(!d)fail('NOT_FOUND','Unknown experimental workspace');return d;}
  async function view(id){
    const d=await document(id);const assets=[];
    for(const s of d.scenes){try{await assetBytes(s.background.asset);}catch(e){assets.push({sceneId:s.id,code:e.code,message:e.message});}}
    return {kind:KIND,document:d,revision:d.revision,diagnostics:await diagnostics(),assetErrors:assets};
  }
  // Every image a document references: scene backgrounds, mark anchors and image objects.
  function documentAssets(d){
    const out=[];
    for(const s of d.scenes){
      if(s.background.kind==='asset')out.push(s.background.asset);
      for(const a of s.annotations)if(a.anchor.asset)out.push(a.anchor.asset);
      for(const o of s.objects)if(o.type==='image')out.push(o.props.asset);
    }
    return [...new Map(out.map(a=>[a.assetId,a])).values()];
  }
  function legacyEntry(s,images=new Map(),imageId=s.background.asset?.legacyImageId){
    const entry={imageId,width:s.extent.width,height:s.extent.height,sceneRevision:s.revision,objectSeq:0,layers:s.layers.map(l=>({id:l.id,name:l.name,author:l.author,opacity:l.opacity,visible:l.visible,locked:l.locked})),marks:new Map(s.annotations.map(a=>[a.id,{id:a.id,type:a.type,...a.geometry,...a.style,label:a.label,author:a.provenance.author,layer:a.layerId}])),baseAsObject:false};
    restoreObjects(entry,s.objects.map(o=>({id:o.id,type:o.type,revision:o.revision,props:o.type==='image'&&images.has(o.props.asset.assetId)?{png:PNG_URI+images.get(o.props.asset.assetId),region:o.props.region,...(o.props.source===undefined?{}:{source:o.props.source})}:o.props,layer:o.layerId,label:o.label,visibility:o.visibility,provenance:{author:o.provenance.author,module:o.provenance.createdBy.moduleId,moduleVersion:o.provenance.createdBy.version}})));
    if(entry.objects.size!==s.objects.length)fail('UNSUPPORTED_TARGET','Scene object cannot be projected into the existing module runtime without loss');
    entry.objectSeq=Math.max(0,...s.objects.map(o=>Number(o.id.slice(1))||0));return entry;
  }
  function modules(){return moduleHost?.registry.list().filter(m=>m.manifest.capabilities.some(c=>c.target!=='none'&&!c.async)).map(m=>({id:m.manifest.id,name:m.manifest.name,state:m.record.state,ui:'shared-scene-commands/1',dataTypes:['estampes.document/1'],capabilities:m.manifest.capabilities.filter(c=>c.target!=='none'&&!c.async).map(c=>({id:c.id,inputSchema:c.inputSchema,target:c.target})),permissions:m.record.granted,workspaceAssociation:'documentId + sceneId',persistence:'CommitRoot scene objects'}))??[];}
  async function prepare(input,author){
    const {requestId,operation:op,documentId,expectedRevision}=input;RequestIdSchema.parse(requestId);
    if(!op||typeof op.type!=='string')fail('INVALID_INPUT','A typed operation is required');
    const time=now(),s=await snapshot();if(s.state!=='ready')fail('RECOVERY_REQUIRED','Writer is read-only; export verified state and inspect diagnostics');
    let d,prior=null,requirements=[];
    if(['create','import'].includes(op.type)){
      if(s.documents.length>=limits.workspaces)fail('LIMIT','Beta supports at most '+limits.workspaces+' workspaces');
      const id=allocated('doc',requestId),items=await legacyItems(op);
      if(!items.length||items.length>BETA_LIMITS.items)fail('LIMIT','Provide one to four real image items');
      const scenes=[],archives=[];
      for(let i=0;i<items.length;i++){
        const {canvas,bytes}=items[i],asset=await putAsset(bytes),sid=allocated('scene',requestId,i);
        // Preserve the actual legacy asset alias and original source hash.
        if(canvas.imageId!==asset.legacyImageId)fail('INTEGRITY_ERROR','Legacy source bytes and image identity disagree');
        const mapped=mapLegacyCanvas(canvas,{documentId:id,sceneId:sid,sourceStoreId:s.root.storeInstanceId,asset,sourceToDocument:matrix(canvas.width,canvas.height),ownerId:OWNER,title:op.title??'Experimental workspace',projectedAt:time,sourceTrust:'migrated-local',unlayeredLayerId:createId('layer')});
        if(!mapped.document)fail('UNSUPPORTED_TARGET','Legacy import blocked; original remains intact',{report:mapped.report});
        scenes.push(mapped.document.scenes[0]);archives.push(...mapped.sidecars);
      }
      d={schema:'estampes.document/1',id,kind:'image',title:op.title??'Experimental workspace',revision:1,state:'active',persistence:profile==='linux-local-durable'?'durable':'memory',createdAt:time,updatedAt:time,defaultSceneId:scenes[0].id,scenes,bindings:[],annotationSupport:'shared-v1',provenance:{createdBy:'migration'},extensions:{'estampes.beta:legacyArchives':archives}};
    }else{
      prior=s.documents.find(d=>d.id===documentId);if(!prior)fail('NOT_FOUND','Unknown experimental workspace');
      if(expectedRevision!==prior.revision)fail('STALE_REVISION','Workspace changed; refresh and review before retrying',{revision:prior.revision});
      if(prior.extensions?.[RECORD_KEY])fail('UNSUPPORTED_TARGET','This document is the stored record of '+prior.extensions[RECORD_KEY].key+'; it changes through its own tools.');
      if(prior.extensions?.[MIRROR_KEY]&&author!=='mirror')fail('UNSUPPORTED_TARGET','This workspace mirrors the canvas of '+prior.provenance.legacySetKey+'; edit it with the canvas tools. Mirrors are read-only here.');
      d=structuredClone(prior);
      const scene=d.scenes.find(s=>s.id===op.sceneId)??(!op.sceneId?d.scenes[0]:null);
      if(!scene)fail('NOT_FOUND','Unknown visual item');
      const layer=id=>{const l=scene.layers.find(l=>l.id===id);if(!l)fail('NOT_FOUND','Unknown layer');return l;};
      const editable=id=>{if(layer(id).locked)fail('FORBIDDEN','Layer is locked; unlock it explicitly before editing');};
      if(op.type==='item.add'){
        const items=await legacyItems(op);
        if(!items.length||d.scenes.length+items.length>BETA_LIMITS.items)fail('LIMIT','A workspace supports one to four visual items');
        for(let i=0;i<items.length;i++){
          const {canvas,bytes}=items[i],asset=await putAsset(bytes),sid=allocated('scene',requestId,i);
          if(canvas.imageId!==asset.legacyImageId)fail('INTEGRITY_ERROR','Legacy source bytes and image identity disagree');
          const mapped=mapLegacyCanvas(canvas,{documentId:d.id,sceneId:sid,sourceStoreId:s.root.storeInstanceId,asset,sourceToDocument:matrix(canvas.width,canvas.height),ownerId:OWNER,title:d.title,projectedAt:time,sourceTrust:'migrated-local',unlayeredLayerId:createId('layer')});
          if(!mapped.document)fail('UNSUPPORTED_TARGET','Visual item import blocked; source remains intact',{report:mapped.report});
          d.scenes.push(mapped.document.scenes[0]);d.extensions['estampes.beta:legacyArchives'].push(...mapped.sidecars);
        }
      }else if(op.type==='rename')d.title=z.string().trim().min(1).max(80).parse(op.title);
      else if(op.type==='layer.create')scene.layers.push({id:allocated('layer',requestId),name:z.string().trim().min(1).max(40).parse(op.name),author,opacity:1,visible:true,locked:false,content:[]});
      else if(op.type==='layer.update'){
        const l=layer(op.id),patch=z.object({name:z.string().trim().min(1).max(40).optional(),visible:z.boolean().optional(),locked:z.boolean().optional(),opacity:z.number().min(0).max(1).optional()}).strict().parse(op.patch);
        if(author!=='user'&&(l.locked||patch.locked===false))fail('FORBIDDEN','Only the user can unlock a layer');Object.assign(l,patch);
      }else if(['annotation.add','annotation.update','annotation.remove'].includes(op.type)){
        let a=scene.annotations.find(a=>a.id===op.id);
        if(op.type!=='annotation.add'&&!a)fail('NOT_FOUND','Unknown annotation');
        if(a){editable(a.layerId);if(author==='assistant'&&a.provenance.editedByUser)fail('FORBIDDEN','This annotation was edited by the user; ask them to edit it or create a separate annotation');}
        if(op.type==='annotation.remove'){
          scene.annotations=scene.annotations.filter(a=>a.id!==op.id);for(const l of scene.layers)l.content=l.content.filter(r=>r.kind!=='annotation'||r.id!==op.id);
          if(scene.gestureDecisions.some(g=>g.memberRefs.some(r=>r.id===op.id))||d.bindings.some(b=>b.from?.id===op.id||b.to?.id===op.id))fail('UNSUPPORTED_TARGET','Referenced annotation must retain its binding/gesture; deletion is blocked');
        }else{
          const patch=z.object({type:z.enum(['point','rect','arrow','polyline']).optional(),geometry:z.record(z.string(),z.unknown()).optional(),label:z.string().max(64).optional(),style:AnnotationStyleSchema.optional(),layerId:z.string().optional()}).strict().parse(op.annotation);
          if(!a){if(!patch.type||!patch.geometry||!patch.layerId)fail('INVALID_INPUT','New annotation needs type, geometry and layerId');editable(patch.layerId);a={id:allocated('ann',requestId),revision:1,type:patch.type,geometry:patch.geometry,layerId:patch.layerId,style:patch.style??{},anchor:{space:'image-normalized',asset:scene.background.asset,sourceToDocument:matrix(scene.extent.width,scene.extent.height)},provenance:provenance(author,time),intentEventIds:[]};scene.annotations.push(a);}
          const original=structuredClone(a);Object.assign(a,patch);GeometrySchemas[a.type].parse(a.geometry);editable(a.layerId);
          if(op.type==='annotation.update'&&!same(original,a)){
            a.revision++;a.provenance.lastEditedBy=principal(author);a.provenance.lastEditedAt=time;
            if(author==='user'){a.provenance.editedByUser=true;a.provenance.lastUserEditRevision=a.revision;}
            if(a.finding){a.finding.verification={historicalState:a.finding.verification?.historicalState??'unverified',currentState:'stale',reason:'Geometry/style/label edited in Beta',contextHash:hashJson(a.geometry)};for(const e of a.finding.evidence??[])e.applicability='stale';}
          }
          for(const l of scene.layers)l.content=l.content.filter(r=>r.kind!=='annotation'||r.id!==a.id);layer(a.layerId).content.push({kind:'annotation',id:a.id});
        }
      }else if(op.type==='module'){
        if(!moduleHost)fail('UNSUPPORTED_TARGET','Module host unavailable');
        const mod=moduleHost.registry.get(op.module),cap=mod?.manifest.capabilities.find(c=>c.id===op.capability);
        if(!cap||cap.async||cap.target==='none')fail('UNSUPPORTED_TARGET','Beta supports synchronous visual module capabilities only');
        if(scene.annotations.some(a=>a.anchor.space!=='image-normalized'))fail('UNSUPPORTED_TARGET','Unsupported annotation space');
        const entry=legacyEntry(scene),router=createRouter({registry:moduleHost.registry,audit:moduleHost.audit,runtimes:moduleHost.runtimes,canvases:{ensure:async()=>entry,save:async()=>{}}});
        const result=await router.execute({module:op.module,capability:op.capability,params:op.params??{},canvas:entry.imageId,expectedRevision:scene.revision});
        const raw=JSON.parse(JSON.stringify({version:1,imageId:entry.imageId,width:entry.width,height:entry.height,marks:[],layers:entry.layers,objects:[...entry.objects.values()],links:{},savedAt:time}));
        const mapped=mapLegacyCanvas(raw,{documentId:d.id,sceneId:scene.id,sourceStoreId:s.root.storeInstanceId,asset:scene.background.asset,sourceToDocument:matrix(scene.extent.width,scene.extent.height),ownerId:OWNER,title:d.title,projectedAt:time,sourceTrust:'migrated-local'});
        if(!mapped.document)fail('UNSUPPORTED_TARGET','Module output cannot be mapped safely',{report:mapped.report});
        const out=mapped.document.scenes[0];
        for(const l of out.layers){const old=scene.layers.find(x=>x.id===l.id);if(old)l.content.push(...old.content.filter(r=>r.kind==='annotation'));}
        for(const o of out.objects){const old=scene.objects.find(x=>x.id===o.id);if(old){o.provenance=old.provenance;if(!same({...o,revision:old.revision},old)){o.provenance={...old.provenance,lastEditedBy:principal(author),lastEditedAt:time};}else o.revision=old.revision;}}
        scene.layers=out.layers;scene.objects=out.objects;scene.frames=out.frames;
        requirements=[{module:op.module,capability:op.capability,version:mod.manifest.version,granted:mod.record.granted}];
        if(!result.scene.created.length&&!result.scene.updated.length&&!result.scene.deleted.length)fail('INVALID_INPUT','Module returned no visual changes');
      }else fail('UNSUPPORTED_TARGET','Unsupported experimental operation: '+op.type);
      for(const sc of d.scenes){const before=prior.scenes.find(s=>s.id===sc.id);if(before&&!same(sc,before))sc.revision=before.revision+1;}
      if(!same(d,prior)){d.revision++;d.updatedAt=time;}else fail('INVALID_INPUT','Nothing changed; no-op requests do not consume the Beta command budget');
    }
    checkLimits(d,limits);await verifyAssets(d);
    const command={requestId,changes:[{expectedRevision:prior?.revision??null,document:d}]};
    const plan={schema:'estampes.uva-plan/1',author,requirements,command};
    const token=createHmac('sha256',signingKey).update(canonicalJson(plan)).digest('hex');
    return {kind:KIND,prepared:{plan,token},document:d,diagnostics:await diagnostics(),message:'Prepared only. Commit this exact prepared value; retry it unchanged after interruption.'};
  }
  async function commit(prepared,author){
    const {plan,token}=prepared??{};
    if(!plan||plan.author!==author||plan.schema!=='estampes.uva-plan/1'||!/^[0-9a-f]{64}$/.test(token??''))fail('FORBIDDEN','Invalid prepared command');
    const expected=createHmac('sha256',signingKey).update(canonicalJson(plan)).digest();if(!timingSafeEqual(expected,Buffer.from(token,'hex')))fail('FORBIDDEN','Prepared command was changed');
    const change=plan.command.changes[0],d=change.document;checkLimits(d,limits);
    const s=await snapshot(),current=s.documents.find(x=>x.id===d.id);
    // If the observed revision has advanced, this exact command can only
    // replay or conflict inside the Ledger authority; it cannot publish a new
    // effect. Do not make an already accepted ACK depend on later module grants
    // or image availability. The returned view separately reports asset errors.
    const replayOnly=Boolean(current&&current.revision!==change.expectedRevision);
    if(!replayOnly)await verifyAssets(d);
    if(!s.documents.some(x=>x.id===d.id)&&s.documents.length>=limits.workspaces)fail('LIMIT','Workspace limit reached');
    for(const r of replayOnly?[]:plan.requirements){const m=moduleHost?.registry.get(r.module);if(!m||m.record.state!=='enabled'||m.manifest.version!==r.version||!same(m.record.granted,r.granted))fail('FORBIDDEN','Module grant/version changed; prepare again');}
    const actor={principal:principal(author),authenticatedOwnerId:OWNER,origin:author==='user'?'app-user':'model-tool',effectiveGrants:[],targetScope:[],grantRevision:1,executionId:createId('exec')};
    const result=await store.commit(plan.command,actor,s.authority.epoch);
    return {...await view(d.id),ack:result.ack,replayed:result.replayed};
  }
  async function render(documentId,sceneId){
    const d=await document(documentId),s=d.scenes.find(s=>s.id===sceneId)??(!sceneId?d.scenes[0]:null);if(!s)fail('NOT_FOUND','Unknown visual item');
    // A transparent background (base image promoted to an image object) renders on white.
    const b=s.background.kind==='asset'?await assetBytes(s.background.asset):await sharp({create:{width:Math.round(s.extent.width),height:Math.round(s.extent.height),channels:4,background:{r:255,g:255,b:255,alpha:1}}}).png().toBuffer();
    const entry=legacyEntry(s,await imageData(s),s.background.asset?.legacyImageId??d.provenance.legacySetKey),hidden=new Set(s.layers.filter(l=>!l.visible).map(l=>l.id));
    const svg=renderedObjects(entry).filter(r=>r.object.visibility==='public'&&!hidden.has(r.object.layer)).map(r=>`<g opacity="${s.layers.find(l=>l.id===r.object.layer)?.opacity??1}">${primitivesSvg(r.primitives,s.extent.width,s.extent.height)}</g>`).join('');
    const factor=Math.min(1,1000/Math.max(s.extent.width,s.extent.height)),width=Math.max(1,Math.round(s.extent.width*factor)),height=Math.max(1,Math.round(s.extent.height*factor));
    const bg=await sharp(b,{limitInputPixels:50_000_000}).rotate().resize(width,height,{fit:'fill'}).png().toBuffer();
    const editorImage={mimeType:'image/jpeg',data:(await sharp(bg).flatten({background:'#ffffff'}).jpeg({quality:75}).toBuffer()).toString('base64')};
    const annotationSvg=s.layers.filter(l=>l.visible).map(l=>`<g opacity="${l.opacity}">`+s.annotations.filter(a=>a.layerId===l.id).map(a=>markSvg({type:a.type,...a.geometry,...a.style},(x,y)=>[x*s.extent.width,y*s.extent.height],s.extent.width/1000)).join('')+'</g>').join('');
    const overlay=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${s.extent.width} ${s.extent.height}">${svg}${annotationSvg}</svg>`);
    const preview=await sharp(bg).composite([{input:overlay}]).png().toBuffer();
    return {kind:KIND,documentId,sceneId:s.id,revision:d.revision,editorImage,preview:{mimeType:'image/png',data:preview.toString('base64')},image:{mimeType:'image/png',data:bg.toString('base64')},objectsSvg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s.extent.width} ${s.extent.height}">${svg}</svg>`};
  }
  async function exportDocument(id){
    const d=await document(id),files=[{name:'document.json',data:Buffer.from(canonicalJson(d))}],seen=new Set();
    for(const a of documentAssets(d))if(!seen.has(a.assetId)){seen.add(a.assetId);files.push({name:'assets/'+a.assetId.slice(13),data:await assetBytes(a),store:true});}
    files.push({name:'manifest.json',data:Buffer.from(JSON.stringify({schema:'estampes.uva-export/1',production:'NOT QUALIFIED',profile,documentHash:hashJson(d),files:files.map(f=>({name:f.name,hash:hash(f.data)}))}))});
    const bytes=zipFiles(files),digest=hash(bytes);let total=0;for(const name of await readdir(exportRoot))if(name!==digest+'.zip')total+=(await lstat(join(exportRoot,name))).size;if(total+bytes.length>BETA_LIMITS.allExportBytes)fail('LIMIT','Saved exports exceed 128 MiB; copy artifacts off-server before operator cleanup');await immutable(join(exportRoot,digest+'.zip'),bytes);
    return {kind:KIND,exportId:digest,bytes:bytes.length,documentId:id,message:'Saved editable document + original assets. This is a portable logical export, not a Ledger/history backup.'};
  }
  async function importExport(op,requestId,author){
    // Importing arbitrary external provenance needs the full remapping boundary.
    // Beta offers verified recovery of a locally saved artifact, retaining IDs
    // only in a new store where they cannot collide.
    const bytes=await service.readExport(op.exportId),files=unzipFiles(bytes,{maxEntries:2+BETA_LIMITS.items*(1+BETA_LIMITS.objects),maxTotal:40*1024**2,maxEntry:8*1024**2});
    const m=JSON.parse(files.get('manifest.json')),d=parseVisualDocument(JSON.parse(files.get('document.json')));
    if(m.schema!=='estampes.uva-export/1'||m.documentHash!==hashJson(d)||!m.files.every(f=>files.has(f.name)&&hash(files.get(f.name))===f.hash))fail('INTEGRITY_ERROR','Export hashes differ');
    const snap=await snapshot();if(snap.documents.some(x=>x.id===d.id))fail('CONFLICT','Recovery requires a separate empty Beta store; existing document is never overwritten');
    for(const a of documentAssets(d)){const f=files.get('assets/'+a.assetId.slice(13));if(!f)fail('INTEGRITY_ERROR','Export is missing an image asset');await putAsset(f);}
    const original=structuredClone(d);d.extensions={...d.extensions,'estampes.beta:recoveredSource':{documentHash:hashJson(original),document:original}};
    d.revision=1;for(const s of d.scenes){s.revision=1;s.undo.entries=[];for(const e of [...s.objects,...s.annotations]){e.revision=1;if(e.provenance.lastUserEditRevision)e.provenance.lastUserEditRevision=1;if(e.userEditGuard)e.userEditGuard.guardRevision=1;}}
    // New store history starts at one. The exact original revisions and audit
    // records remain in the recoverable source archive, never reinterpreted.
    checkLimits(d,limits);await verifyAssets(d);
    const plan={schema:'estampes.uva-plan/1',author,requirements:[],command:{requestId,changes:[{expectedRevision:null,document:d}]}};
    return {kind:KIND,prepared:{plan,token:createHmac('sha256',signingKey).update(canonicalJson(plan)).digest('hex')},document:d};
  }

  // Verified intake of a canvas's image objects. Each PNG data URI must decode
  // to a PNG and re-encode to exactly the same text, so the canvas comes back
  // byte for byte from the asset. The returned source has each image object
  // replaced by a placeholder the legacy mapping accepts; restoreImageObjects
  // turns those back into image objects that reference their asset.
  async function intakeImageObjects(source){
    const images=[];
    if(!Array.isArray(source.objects)||!source.objects.some(o=>o?.type==='image'))return {source,images};
    const objects=[];
    for(const [i,o] of source.objects.entries()){
      if(o?.type!=='image'){objects.push(o);continue;}
      const png=o.props?.png,where='Image object '+JSON.stringify(o.id)+': ';
      if(typeof png!=='string'||!png.startsWith(PNG_URI))return {blocked:where+'not a PNG data URI'};
      const base64=png.slice(PNG_URI.length),bytes=Buffer.from(base64,'base64');
      if(!bytes.length||bytes.toString('base64')!==base64)return {blocked:where+'PNG data is not canonical base64'};
      if(bytes.length>limits.assetBytes)return {blocked:where+'PNG exceeds '+(limits.assetBytes/1024**2)+' MiB'};
      try{if((await sharp(bytes,{limitInputPixels:50_000_000}).metadata()).format!=='png')throw new Error('not png');}catch{return {blocked:where+'PNG data does not decode'};}
      const {png:_,...rest}=o.props??{},props=Object.keys(rest).filter(k=>!['region','source'].includes(k));
      if(props.length)return {blocked:where+'unknown props '+props.join(', ')};
      images.push({id:o.id,index:i,bytes,base64,asset:{assetId:'asset:sha256:'+hash(bytes)},region:o.props.region,source:o.props.source});
      objects.push({...o,type:'info-card',props:{title:'image',rows:[{label:'image',value:'asset'}]}});
    }
    return {source:{...source,objects},images};
  }
  function restoreImageObjects(d,images){
    const byId=new Map(images.map(i=>[i.id,i]));
    for(const o of d.scenes[0].objects){
      const i=byId.get(o.id);if(!i)continue;
      o.type='image';o.props={asset:i.asset,region:structuredClone(i.region),...(i.source===undefined?{}:{source:i.source})};
    }
  }
  // assetId -> base64 PNG of every image object in a scene, read and verified.
  async function imageData(scene){
    const out=new Map();
    for(const o of scene.objects)if(o.type==='image'&&!out.has(o.props.asset.assetId))out.set(o.props.asset.assetId,(await assetBytes(o.props.asset)).toString('base64'));
    return out;
  }
  // One checkpoint of a legacy canvas into its mirror document. Idempotent: an
  // unchanged canvas (ignoring the save time) writes nothing.
  async function syncCanvas({canvas,bytes,seq=null,legacyHash=null}){
    if(!mirror)fail('UNSUPPORTED_TARGET','Mirror is not enabled');
    // The in-memory canvas (mirror mode) can hold undefined fields; compare and map its JSON form.
    const {savedAt,...source}=JSON.parse(JSON.stringify(canvas)),sourceHash=hashJson(source),key=source.imageId+(source.setId?'#'+source.setId:'');
    const s=await snapshot();if(s.state!=='ready')fail('RECOVERY_REQUIRED','Writer is read-only; mirror paused');
    const prior=s.documents.find(d=>d.provenance?.legacySetKey===key&&d.extensions?.[MIRROR_KEY]);
    if(prior?.extensions[MIRROR_KEY].sourceHash===sourceHash&&(prior.extensions[MIRROR_KEY].authority??'legacy-canvas')===authority)return {status:'unchanged',documentId:prior.id,revision:prior.revision,sourceHash,seq:prior.extensions[MIRROR_KEY].sourceSeq??null};
    // History compaction retires what no recovery point needs, so the store
    // keeps about the last 7 days of commits (the ACK replay window). This cap
    // is a safety net for an unusual burst inside that window, not a lifetime limit.
    const commits=(await store.diagnostics()).contentCommits;
    if(commits>=mirrorMaxCommits){mirrorState={...mirrorState,budgetExhausted:true,commits};fail('LIMIT','Commit budget reached ('+commits+'/'+mirrorMaxCommits+' commits retained in the 7-day replay window). Saves stay pending and the canvas is unaffected; they resume as older commits age out.');}
    // The asset is identified before it is written, so a canvas that cannot be
    // mapped never copies its image into the store.
    const time=now(),digest=Buffer.isBuffer(bytes)?hash(bytes):'',asset={assetId:'asset:sha256:'+digest,legacyImageId:'img:'+digest.slice(0,16)};
    if(source.imageId!==asset.legacyImageId)fail('INTEGRITY_ERROR','Legacy source bytes and image identity disagree');
    const docId=prior?.id??allocated('doc','mirror:'+key),sceneId=prior?.scenes[0].id??allocated('scene','mirror:'+key),layerId=allocated('layer','mirror:'+key);
    const blocked=(message)=>{mirrorState={...mirrorState,blocked:{...(mirrorState?.blocked),[key]:message}};return {status:'blocked',issues:[{message}],sourceHash};};
    // Image objects (add_image_layer, the promoted base image) carry their PNG
    // inline. Their bytes become verified assets; the document keeps a reference.
    const intake=await intakeImageObjects(source);
    if(intake.blocked)return blocked(intake.blocked);
    // Links to marks on other canvases become relation bindings. Their far end is
    // typed by the deterministic mirror identity of the other canvas; it stays
    // unresolved here (this projection holds one canvas), and the link record is
    // kept verbatim so the canvas comes back exactly.
    const relationBindings=[],linkKeys={};
    if(source.links&&typeof source.links==='object'&&!Array.isArray(source.links))for(const [otherKey,links] of Object.entries(source.links)){
      if(!Array.isArray(links)||!otherKey||otherKey.length>160)continue;
      for(const link of links){
        if(!link||typeof link.id!=='string'||typeof link.right!=='string'||!link.id||link.id.length>80||!link.right||link.right.length>64)continue;
        const bindingId=allocated('bind','mirror-link:'+key+'\0'+otherKey+'\0'+link.id);
        relationBindings.push({otherSetKey:otherKey,legacyId:link.id,bindingId,target:{documentId:allocated('doc','mirror:'+otherKey),sceneId:allocated('scene','mirror:'+otherKey),kind:'annotation',id:link.right}});
        linkKeys[bindingId]=otherKey;
      }
    }
    const mapped=mapLegacyCanvas(intake.source,{relationBindings,documentId:docId,sceneId,sourceStoreId:s.root.storeInstanceId,asset,sourceToDocument:matrix(source.width,source.height),ownerId:OWNER,title:prior?.title??('Canvas '+key),projectedAt:time,sourceTrust:'migrated-local',unlayeredLayerId:layerId});
    if(mapped.document)restoreImageObjects(mapped.document,intake.images);
    if(!mapped.document)return blocked(mapped.report.issues.filter(i=>i.blocking).map(i=>i.message).join('; '));
    if(mapped.document.scenes[0].annotations.length>limits.annotations||mapped.document.scenes[0].objects.length>limits.objects)return blocked('Canvas exceeds '+limits.annotations+' marks or '+limits.objects+' objects');
    if(!prior&&s.documents.length>=limits.workspaces)return blocked('Store holds the maximum of '+limits.workspaces+' canvases');
    await putAsset(bytes);
    for(const image of intake.images)await putAsset(image.bytes);
    if(mirrorState?.blocked?.[key]){const {[key]:_,...rest}=mirrorState.blocked;mirrorState={...mirrorState,blocked:rest};}
    const scene=mapped.document.scenes[0];
    // A re-projection must not rewrite who created an entity or when: carry the
    // immutable provenance of entities that already exist, and never let the user-edit audit move back.
    if(prior)for(const kind of ['annotations','objects']){
      const before=new Map(prior.scenes[0][kind].map(e=>[e.id,e.provenance]));
      for(const e of scene[kind]){
        const old=before.get(e.id);if(!old)continue;
        const next={...e.provenance};
        for(const f of ['createdBy','createdAt','original','sourceTrust'])if(old[f]!==undefined)next[f]=old[f];else delete next[f];
        next.editedByUser=Boolean(old.editedByUser||next.editedByUser);
        if(old.lastUserEditRevision!==undefined)next.lastUserEditRevision=Math.max(old.lastUserEditRevision,next.lastUserEditRevision??0);
        e.provenance=next;
      }
      // Entity revisions must equal the real change: untouched entities stay as they were.
      const prev=new Map(prior.scenes[0][kind].map(e=>[e.id,e])),strip=e=>canonicalJson({...e,revision:0,provenance:{...e.provenance,lastEditedAt:null,lastEditedBy:null}});
      scene[kind]=scene[kind].map(e=>{const old=prev.get(e.id);if(!old)return e;return strip(old)===strip(e)?old:{...e,revision:old.revision+1};});
    }
    let ext={[MIRROR_KEY]:{sourceHash,syncedAt:time,authority:'legacy-canvas'},'estampes.beta:legacyArchives':mapped.sidecars};
    let d,expected=null;
    if(prior){d=structuredClone(prior);scene.revision=prior.scenes[0].revision+1;d.scenes[0]=scene;d.bindings=mapped.document.bindings;d.revision++;d.updatedAt=time;d.extensions=ext;expected=prior.revision;}
    else d={schema:'estampes.document/1',id:docId,kind:'image',title:'Canvas '+key,revision:1,state:'active',persistence:profile==='linux-local-durable'?'durable':'memory',createdAt:time,updatedAt:time,defaultSceneId:scene.id,scenes:[scene],bindings:mapped.document.bindings,annotationSupport:'shared-v1',provenance:{createdBy:'migration',legacySetKey:key},extensions:ext};
    let residualBytes=0;
    if(canvasStore){
      // The document is the record: keep only what its structure does not carry,
      // and prove the canvas comes back exactly before committing.
      const projected=projectCanvas(d,{unlayeredLayerId:layerId,linkKeys,images:new Map(intake.images.map(i=>[i.asset.assetId,i.base64]))}),residual=diffJson(projected,source)??null;
      if(hashJson(applyPatch(projected,residual))!==sourceHash)fail('INTEGRITY_ERROR','Canvas does not round-trip through its UVA document; it stays in legacy storage');
      residualBytes=residual?Buffer.byteLength(JSON.stringify(residual)):0;
      // sourceSeq orders this record against the pending copies (src/uva/canvas-store.js).
      d.extensions={[MIRROR_KEY]:{sourceHash,syncedAt:time,sourceSavedAt:typeof savedAt==='string'?savedAt:null,sourceSeq:Number.isSafeInteger(seq)?seq:null,legacyHash:typeof legacyHash==='string'?legacyHash:null,authority,residual,...(Object.keys(linkKeys).length?{linkKeys}:{})}};
    }
    checkLimits(d,limits);await verifyAssets(d);
    const command={requestId:'req:'+randomUUID(),changes:[{expectedRevision:expected,document:d}]};
    const actor={principal:principal('user'),authenticatedOwnerId:OWNER,origin:'app-user',effectiveGrants:[],targetScope:[],grantRevision:1,executionId:createId('exec')};
    const started=performance.now(),result=await store.commit(command,actor,s.authority.epoch);
    mirrorState={...mirrorState,syncs:(mirrorState?.syncs??0)+1,lastSyncMs:Math.round(performance.now()-started),lastSyncAt:time,...(canvasStore?{lastResidualBytes:residualBytes}:{})};
    return {status:prior?'updated':'created',documentId:d.id,revision:d.revision,ack:result.ack,sourceHash,residualBytes,seq};
  }
  // The committed canvas of an image, rebuilt from its UVA document, or null
  // when the store does not hold it as the record (no document, or a read-only mirror).
  async function canvasState(imageId){
    const d=(await snapshot()).documents.find(d=>d.provenance?.legacySetKey===imageId&&d.extensions?.[MIRROR_KEY]);
    const ext=d?.extensions[MIRROR_KEY];if(!ext||ext.authority!=='uva')return null;
    const canvas=applyPatch(projectCanvas(d,{unlayeredLayerId:allocated('layer','mirror:'+imageId),linkKeys:ext.linkKeys??{},images:await imageData(d.scenes[0])}),ext.residual);
    if(hashJson(canvas)!==ext.sourceHash)fail('INTEGRITY_ERROR','UVA canvas document does not reproduce its recorded canvas hash');
    return {canvas:{...canvas,...(ext.sourceSavedAt?{savedAt:ext.sourceSavedAt}:{})},sourceHash:ext.sourceHash,seq:ext.sourceSeq??0,legacyHash:ext.legacyHash??null,documentId:d.id,revision:d.revision};
  }
  // Images whose canvas this store holds as the record.
  async function canvasImages(){return (await snapshot()).documents.filter(d=>d.extensions?.[MIRROR_KEY]?.authority==='uva').map(d=>d.provenance.legacySetKey);}
  // Records besides canvases (canvas store only): a workspace, a panel surface or
  // a calculator notebook, keyed "<kind>/<id>". Each is one document whose
  // extension holds the record's JSON with its hash and seq, so it shares the
  // store's history, recovery points, compaction and export with the canvases.
  async function syncRecord({key,value,seq=null,legacyHash=null}){
    if(!canvasStore)fail('UNSUPPORTED_TARGET','Records need the canvas store');
    if(typeof key!=='string'||!/^[a-z]+\/[a-z]{2}:[0-9a-f]{12,16}$/.test(key))fail('INVALID_INPUT','Invalid record key');
    const record=JSON.parse(JSON.stringify(value)),valueHash=hashJson(record);
    const s=await snapshot();if(s.state!=='ready')fail('RECOVERY_REQUIRED','Writer is read-only; records stay pending');
    const prior=s.documents.find(d=>d.extensions?.[RECORD_KEY]?.key===key);
    if(prior?.extensions[RECORD_KEY].valueHash===valueHash)return {status:'unchanged',documentId:prior.id,revision:prior.revision,sourceHash:valueHash,seq:prior.extensions[RECORD_KEY].seq??null};
    const commits=(await store.diagnostics()).contentCommits;
    if(commits>=mirrorMaxCommits){mirrorState={...mirrorState,budgetExhausted:true,commits};fail('LIMIT','Commit budget reached ('+commits+'/'+mirrorMaxCommits+'); records stay pending');}
    if(!prior&&s.documents.length>=limits.workspaces)return {status:'blocked',issues:[{message:'Store holds the maximum of '+limits.workspaces+' documents'}],sourceHash:valueHash};
    const time=now(),docId=prior?.id??allocated('doc','record:'+key),sceneId=prior?.scenes[0].id??allocated('scene','record:'+key);
    const scene={id:sceneId,documentId:docId,revision:1,extent:{width:1,height:1,unit:'du'},background:{kind:'transparent'},layers:[],objects:[],annotations:[],frames:[],gestureDecisions:[],rejections:[],interactionEvents:[],undo:{entries:[]},tombstones:[]};
    const ext={[RECORD_KEY]:{key,valueHash,seq:Number.isSafeInteger(seq)?seq:null,legacyHash:typeof legacyHash==='string'?legacyHash:null,syncedAt:time,value:record}};
    // Only the extension changes: the empty scene keeps its revision.
    const d=prior?{...structuredClone(prior),revision:prior.revision+1,updatedAt:time,extensions:ext}
      :{schema:'estampes.document/1',id:docId,kind:'graph',title:('Record '+key).slice(0,80),revision:1,state:'active',persistence:profile==='linux-local-durable'?'durable':'memory',createdAt:time,updatedAt:time,defaultSceneId:sceneId,scenes:[scene],bindings:[],annotationSupport:'shared-v1',provenance:{createdBy:'migration'},extensions:ext};
    try{checkLimits(d,limits);}catch(error){if(error.code==='LIMIT')return {status:'blocked',issues:[{message:'Record exceeds the document limits ('+error.message+')'}],sourceHash:valueHash};throw error;}
    await verifyAssets(d);
    if(hashJson(parseVisualDocument(d).extensions[RECORD_KEY].value)!==valueHash)fail('INTEGRITY_ERROR','Record does not round-trip through its UVA document');
    const command={requestId:'req:'+randomUUID(),changes:[{expectedRevision:prior?.revision??null,document:d}]};
    const actor={principal:principal('user'),authenticatedOwnerId:OWNER,origin:'app-user',effectiveGrants:[],targetScope:[],grantRevision:1,executionId:createId('exec')};
    const result=await store.commit(command,actor,s.authority.epoch);
    mirrorState={...mirrorState,recordSyncs:(mirrorState?.recordSyncs??0)+1};
    return {status:prior?'updated':'created',documentId:d.id,revision:d.revision,ack:result.ack,sourceHash:valueHash,seq};
  }
  async function recordState(key){
    const d=(await snapshot()).documents.find(d=>d.extensions?.[RECORD_KEY]?.key===key);if(!d)return null;
    const ext=d.extensions[RECORD_KEY];
    if(hashJson(ext.value)!==ext.valueHash)fail('INTEGRITY_ERROR','UVA record document does not reproduce its recorded hash');
    return {value:ext.value,valueHash:ext.valueHash,seq:ext.seq??0,legacyHash:ext.legacyHash??null,documentId:d.id,revision:d.revision};
  }
  async function recordKeys(){return (await snapshot()).documents.map(d=>d.extensions?.[RECORD_KEY]?.key).filter(Boolean);}
  const service={enabled:true,store,root,diagnostics,canvasStore,canvasState,canvasImages,syncCanvas:(input)=>serial(()=>syncCanvas(input)),recordState,recordKeys,syncRecord:(input)=>serial(()=>syncRecord(input)),noteMirror(patch){mirrorState={...mirrorState,...patch};},async stageRecovery(bytes){if(bytes.length>40*1024**2)fail('LIMIT','Recovery artifact exceeds limit');const id=hash(bytes);await immutable(join(exportRoot,id+'.zip'),bytes);return id;},async close(){await queue;await store.close();},async readExport(id){if(!/^[0-9a-f]{64}$/.test(id))fail('INVALID_INPUT','Invalid export identity');const b=await bytesAt(join(exportRoot,id+'.zip'),40*1024**2);if(hash(b)!==id)fail('INTEGRITY_ERROR','Saved export hash differs');return b;},
    async dispatch(input,author='assistant'){
      if(!['user','assistant'].includes(author))fail('FORBIDDEN','Unknown actor');
      const {action,documentId,sceneId}=input;
      if(action==='status')return {kind:KIND,diagnostics:await diagnostics()};
      if(action==='list')return {kind:KIND,workspaces:(await snapshot()).documents.filter(d=>!d.extensions?.[RECORD_KEY]).map(d=>({id:d.id,title:d.title,revision:d.revision,items:d.scenes.length,experimental:true})),diagnostics:await diagnostics()};
      if(action==='open')return view(documentId);
      if(action==='render')return render(documentId,sceneId);
      if(action==='modules')return {kind:KIND,modules:modules()};
      if(action==='prepare')return serial(()=>input.operation?.type==='recover'?importExport(input.operation,input.requestId,author):prepare(input,author));
      if(action==='commit')return serial(()=>commit(input.prepared,author));
      if(action==='export')return serial(()=>exportDocument(documentId));
      fail('UNSUPPORTED_TARGET','Unknown experimental action');
    }};
  return service;
}
