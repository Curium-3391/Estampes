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
import { createRouter } from '../modules/router.js';
import { restoreObjects, renderedObjects } from '../scene/scene-ops.js';
import { markSvg } from '../mark-render.js';
import { primitivesSvg } from '../scene/objects.js';
import { zipFiles, unzipFiles } from '../zip.js';

export const BETA_LIMITS = Object.freeze({ workspaces:4, items:4, revisions:25, annotations:128, objects:64, documentBytes:1024**2, assetBytes:8*1024**2, allAssetBytes:64*1024**2, allExportBytes:128*1024**2 });
const OWNER='owner:uva-beta-instance', KIND='estampes.uva/1';
const hash=b=>createHash('sha256').update(b).digest('hex');
const now=()=>new Date().toISOString();
const matrix=(w,h)=>[w,0,0,0,h,0,0,0,1];
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
function checkLimits(d){
  if(d.scenes.length>BETA_LIMITS.items||d.revision>BETA_LIMITS.revisions||d.scenes.reduce((n,s)=>n+s.annotations.length,0)>BETA_LIMITS.annotations||d.scenes.reduce((n,s)=>n+s.objects.length,0)>BETA_LIMITS.objects||Buffer.byteLength(canonicalJson(d))>BETA_LIMITS.documentBytes)fail('LIMIT','Experimental workload limit reached; export and start a new copy');
  parseVisualDocument(d);
}
export async function createUvaService({enabled=false,directory:root='',profile='',legacyDirectory='',legacyItems,moduleHost}={}){
  if(!enabled)return {enabled:false,async dispatch(){fail('UNSUPPORTED_TARGET','UVA Experimental Beta is disabled; legacy remains available');},async close(){}};
  if(!root||!['linux-process-crash-test','linux-local-durable'].includes(profile))fail('UNSUPPORTED_STORAGE','Set ESTAMPES_UVA_BETA_DIR and an explicit ESTAMPES_UVA_BETA_PROFILE (linux-process-crash-test is NOT durable)');
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
  const store=await openIsolatedStore(storeRoot,{profile,purpose:'isolated-pr1c-testing',quotaBytes:256*1024**2,lifecycle:{enabled:true,autoMaintenance:false}});
  if(!names.length){
    if(store.status.state!=='ready'){await store.close();fail('RECOVERY_REQUIRED','Fresh store did not initialize safely');}
    await immutable(join(root,'beta-format.json'),Buffer.from(JSON.stringify(format)));
  }
  const signingKey=Buffer.from(format.planKey,'hex');let queue=Promise.resolve();
  const serial=fn=>{const p=queue.then(fn,fn);queue=p.catch(()=>{});return p;};
  const diagnostics=async()=>{
    const d=await store.diagnostics();
    return {enabled:true,experimental:true,production:'NOT QUALIFIED',durability:d.platform.durability,profile,state:d.state,problem:d.problem,limits:BETA_LIMITS,contentCommits:d.contentCommits,maintenance:d.lifecycle,assetCommitBoundary:'verified immutable assets are installed before document publication; no cross-store transaction or asset GC',qualification:'process restart only; filesystem and power-loss qualification remains open'};
  };
  async function assetBytes(asset){
    if(!/^asset:sha256:[0-9a-f]{64}$/.test(asset.assetId))fail('INVALID_INPUT','Invalid asset identity');
    const digest=asset.assetId.slice(13),b=await bytesAt(join(assetRoot,digest),BETA_LIMITS.assetBytes).catch(e=>{fail('STORAGE_UNAVAILABLE','Missing/unreadable Beta image asset; restore a saved export',{cause:e.code});});
    if(hash(b)!==digest)fail('INTEGRITY_ERROR','Beta asset content hash differs');return b;
  }
  async function putAsset(bytes){
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>BETA_LIMITS.assetBytes)fail('LIMIT','Image asset must be 1..8 MiB');
    const digest=hash(bytes),asset={assetId:'asset:sha256:'+digest,legacyImageId:'img:'+digest.slice(0,16)},path=join(assetRoot,digest);
    try{await lstat(path);await assetBytes(asset);return asset;}catch(e){if(e.code!=='ENOENT')throw e;}
    let total=0;for(const f of await readdir(assetRoot))total+=(await lstat(join(assetRoot,f))).size;
    if(total+bytes.length>BETA_LIMITS.allAssetBytes)fail('LIMIT','Beta assets exceed 64 MiB; export before operator cleanup');
    await immutable(path,bytes);await assetBytes(asset);return asset;
  }
  async function verifyAssets(d){
    for(const s of d.scenes){
      if(s.background.kind!=='asset')fail('UNSUPPORTED_TARGET','Beta scenes require an image background');
      await assetBytes(s.background.asset);
      for(const a of s.annotations)if(a.anchor.space!=='image-normalized'||!same(a.anchor.asset,s.background.asset)||!same(a.anchor.sourceToDocument,matrix(s.extent.width,s.extent.height)))fail('UNSUPPORTED_TARGET','Beta editor supports only explicit image-normalized annotations');
      // Rich legacy image objects need a separate intake mapping; block rather
      // than omit their bytes. Other existing semantic objects are preserved.
      if(s.objects.some(o=>o.type==='image'||o.type==='embedded-document'))fail('UNSUPPORTED_TARGET','Image/embedded objects need explicit asset/binding intake; source is unchanged');
    }
  }
  async function snapshot(){return store.snapshot();}
  async function document(id){DocumentIdSchema.parse(id);const s=await snapshot(),d=s.documents.find(d=>d.id===id);if(!d)fail('NOT_FOUND','Unknown experimental workspace');return d;}
  async function view(id){
    const d=await document(id);const assets=[];
    for(const s of d.scenes){try{await assetBytes(s.background.asset);}catch(e){assets.push({sceneId:s.id,code:e.code,message:e.message});}}
    return {kind:KIND,document:d,revision:d.revision,diagnostics:await diagnostics(),assetErrors:assets};
  }
  function legacyEntry(s){
    const entry={imageId:s.background.asset.legacyImageId,width:s.extent.width,height:s.extent.height,sceneRevision:s.revision,objectSeq:0,layers:s.layers.map(l=>({id:l.id,name:l.name,author:l.author,opacity:l.opacity,visible:l.visible,locked:l.locked})),marks:new Map(s.annotations.map(a=>[a.id,{id:a.id,type:a.type,...a.geometry,...a.style,label:a.label,author:a.provenance.author,layer:a.layerId}])),baseAsObject:false};
    restoreObjects(entry,s.objects.map(o=>({id:o.id,type:o.type,revision:o.revision,props:o.props,layer:o.layerId,label:o.label,visibility:o.visibility,provenance:{author:o.provenance.author,module:o.provenance.createdBy.moduleId,moduleVersion:o.provenance.createdBy.version}})));
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
      if(s.documents.length>=BETA_LIMITS.workspaces)fail('LIMIT','Beta supports at most four workspaces');
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
    checkLimits(d);await verifyAssets(d);
    const command={requestId,changes:[{expectedRevision:prior?.revision??null,document:d}]};
    const plan={schema:'estampes.uva-plan/1',author,requirements,command};
    const token=createHmac('sha256',signingKey).update(canonicalJson(plan)).digest('hex');
    return {kind:KIND,prepared:{plan,token},document:d,diagnostics:await diagnostics(),message:'Prepared only. Commit this exact prepared value; retry it unchanged after interruption.'};
  }
  async function commit(prepared,author){
    const {plan,token}=prepared??{};
    if(!plan||plan.author!==author||plan.schema!=='estampes.uva-plan/1'||!/^[0-9a-f]{64}$/.test(token??''))fail('FORBIDDEN','Invalid prepared command');
    const expected=createHmac('sha256',signingKey).update(canonicalJson(plan)).digest();if(!timingSafeEqual(expected,Buffer.from(token,'hex')))fail('FORBIDDEN','Prepared command was changed');
    const d=plan.command.changes[0].document;checkLimits(d);await verifyAssets(d);
    const s=await snapshot();
    if(!s.documents.some(x=>x.id===d.id)&&s.documents.length>=BETA_LIMITS.workspaces)fail('LIMIT','Workspace limit reached');
    for(const r of plan.requirements){const m=moduleHost?.registry.get(r.module);if(!m||m.record.state!=='enabled'||m.manifest.version!==r.version||!same(m.record.granted,r.granted))fail('FORBIDDEN','Module grant/version changed; prepare again');}
    const actor={principal:principal(author),authenticatedOwnerId:OWNER,origin:author==='user'?'app-user':'model-tool',effectiveGrants:[],targetScope:[],grantRevision:1,executionId:createId('exec')};
    const result=await store.commit(plan.command,actor,s.authority.epoch);
    return {...await view(d.id),ack:result.ack,replayed:result.replayed};
  }
  async function render(documentId,sceneId){
    const d=await document(documentId),s=d.scenes.find(s=>s.id===sceneId)??(!sceneId?d.scenes[0]:null);if(!s)fail('NOT_FOUND','Unknown visual item');
    const b=await assetBytes(s.background.asset),entry=legacyEntry(s),hidden=new Set(s.layers.filter(l=>!l.visible).map(l=>l.id));
    const svg=renderedObjects(entry).filter(r=>r.object.visibility==='public'&&!hidden.has(r.object.layer)).map(r=>`<g opacity="${s.layers.find(l=>l.id===r.object.layer)?.opacity??1}">${primitivesSvg(r.primitives,s.extent.width,s.extent.height)}</g>`).join('');
    const bg=await sharp(b,{limitInputPixels:50_000_000}).rotate().resize(Math.min(1000,s.extent.width),Math.round(Math.min(1000,s.extent.width)*s.extent.height/s.extent.width),{fit:'fill'}).png().toBuffer();
    const annotationSvg=s.layers.filter(l=>l.visible).map(l=>`<g opacity="${l.opacity}">`+s.annotations.filter(a=>a.layerId===l.id).map(a=>markSvg({type:a.type,...a.geometry,...a.style},(x,y)=>[x*s.extent.width,y*s.extent.height],s.extent.width/1000)).join('')+'</g>').join('');
    const overlay=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.min(1000,s.extent.width)}" height="${Math.round(Math.min(1000,s.extent.width)*s.extent.height/s.extent.width)}" viewBox="0 0 ${s.extent.width} ${s.extent.height}">${svg}${annotationSvg}</svg>`);
    const preview=await sharp(bg).composite([{input:overlay}]).png().toBuffer();
    return {kind:KIND,documentId,sceneId:s.id,revision:d.revision,preview:{mimeType:'image/png',data:preview.toString('base64')},image:{mimeType:'image/png',data:bg.toString('base64')},objectsSvg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s.extent.width} ${s.extent.height}">${svg}</svg>`};
  }
  async function exportDocument(id){
    const d=await document(id),files=[{name:'document.json',data:Buffer.from(canonicalJson(d))}],seen=new Set();
    for(const s of d.scenes){const a=s.background.asset;if(!seen.has(a.assetId)){seen.add(a.assetId);files.push({name:'assets/'+a.assetId.slice(13),data:await assetBytes(a),store:true});}}
    files.push({name:'manifest.json',data:Buffer.from(JSON.stringify({schema:'estampes.uva-export/1',production:'NOT QUALIFIED',profile,documentHash:hashJson(d),files:files.map(f=>({name:f.name,hash:hash(f.data)}))}))});
    const bytes=zipFiles(files),digest=hash(bytes);let total=0;for(const name of await readdir(exportRoot))if(name!==digest+'.zip')total+=(await lstat(join(exportRoot,name))).size;if(total+bytes.length>BETA_LIMITS.allExportBytes)fail('LIMIT','Saved exports exceed 128 MiB; copy artifacts off-server before operator cleanup');await immutable(join(exportRoot,digest+'.zip'),bytes);
    return {kind:KIND,exportId:digest,bytes:bytes.length,documentId:id,message:'Saved editable document + original assets. This is a portable logical export, not a Ledger/history backup.'};
  }
  async function importExport(op,requestId,author){
    // Importing arbitrary external provenance needs the full remapping boundary.
    // Beta offers verified recovery of a locally saved artifact, retaining IDs
    // only in a new store where they cannot collide.
    const bytes=await service.readExport(op.exportId),files=unzipFiles(bytes,{maxEntries:8,maxTotal:40*1024**2,maxEntry:8*1024**2});
    const m=JSON.parse(files.get('manifest.json')),d=parseVisualDocument(JSON.parse(files.get('document.json')));
    if(m.schema!=='estampes.uva-export/1'||m.documentHash!==hashJson(d)||!m.files.every(f=>files.has(f.name)&&hash(files.get(f.name))===f.hash))fail('INTEGRITY_ERROR','Export hashes differ');
    const snap=await snapshot();if(snap.documents.some(x=>x.id===d.id))fail('CONFLICT','Recovery requires a separate empty Beta store; existing document is never overwritten');
    for(const s of d.scenes)await putAsset(files.get('assets/'+s.background.asset.assetId.slice(13)));
    const original=structuredClone(d);d.extensions={...d.extensions,'estampes.beta:recoveredSource':{documentHash:hashJson(original),document:original}};
    d.revision=1;for(const s of d.scenes){s.revision=1;s.undo.entries=[];for(const e of [...s.objects,...s.annotations]){e.revision=1;if(e.provenance.lastUserEditRevision)e.provenance.lastUserEditRevision=1;if(e.userEditGuard)e.userEditGuard.guardRevision=1;}}
    // New store history starts at one. The exact original revisions and audit
    // records remain in the recoverable source archive, never reinterpreted.
    checkLimits(d);await verifyAssets(d);
    const plan={schema:'estampes.uva-plan/1',author,requirements:[],command:{requestId,changes:[{expectedRevision:null,document:d}]}};
    return {kind:KIND,prepared:{plan,token:createHmac('sha256',signingKey).update(canonicalJson(plan)).digest('hex')},document:d};
  }
  const service={enabled:true,store,root,diagnostics,async stageRecovery(bytes){if(bytes.length>40*1024**2)fail('LIMIT','Recovery artifact exceeds limit');const id=hash(bytes);await immutable(join(exportRoot,id+'.zip'),bytes);return id;},async close(){await queue;await store.close();},async readExport(id){if(!/^[0-9a-f]{64}$/.test(id))fail('INVALID_INPUT','Invalid export identity');const b=await bytesAt(join(exportRoot,id+'.zip'),40*1024**2);if(hash(b)!==id)fail('INTEGRITY_ERROR','Saved export hash differs');return b;},
    async dispatch(input,author='assistant'){
      if(!['user','assistant'].includes(author))fail('FORBIDDEN','Unknown actor');
      const {action,documentId,sceneId}=input;
      if(action==='status')return {kind:KIND,diagnostics:await diagnostics()};
      if(action==='list')return {kind:KIND,workspaces:(await snapshot()).documents.map(d=>({id:d.id,title:d.title,revision:d.revision,items:d.scenes.length,experimental:true})),diagnostics:await diagnostics()};
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
