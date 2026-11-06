import { createHash } from 'node:crypto';
import { z } from 'zod';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { RequestIdSchema, DocumentIdSchema, SceneIdSchema } from '../documents/identity.js';
// One versioned command contract for GPT and the user's Workbench. The actor
// is selected by registration, never by a caller-provided provenance field.
export const UvaInput=z.object({action:z.enum(['status','list','open','prepare','commit','render','modules','export','read_chunk']),documentId:DocumentIdSchema.optional(),sceneId:SceneIdSchema.optional(),requestId:RequestIdSchema.optional(),expectedRevision:z.number().int().positive().optional(),operation:z.record(z.string(),z.unknown()).optional(),prepared:z.record(z.string(),z.unknown()).optional(),transportId:z.string().regex(/^[0-9a-f]{64}$/).optional(),offset:z.number().int().min(0).max(16*1024**2).optional()}).strict();
// Read-only transport snapshots are bounded and never become writer authority.
const chunks=new Map();let chunkBytes=0;
function remember(value){
 const data=JSON.stringify(value),id=createHash('sha256').update(data).digest('hex');
 if(data.length>16*1024**2)throw Error('Transport snapshot exceeds bounded cache');
 for(const [key,v]of chunks)if(Date.now()-v.at>600000){chunkBytes-=v.data.length;chunks.delete(key);}
 if(!chunks.has(id)){chunks.set(id,{data,at:Date.now()});chunkBytes+=data.length;}
 while(chunks.size>8||chunkBytes>16*1024**2){const key=chunks.keys().next().value;chunkBytes-=chunks.get(key).data.length;chunks.delete(key);}
 return id;
}
function chunk(id,offset,maxChars){
 const snapshot=chunks.get(id);if(!snapshot||Date.now()-snapshot.at>600000)throw Error('Read snapshot expired; open/prepare again before committing');
 if(offset>snapshot.data.length)throw Error('Transport offset is outside the snapshot');
 let size=Math.min(60000,snapshot.data.length-offset),r,result;
 do{
  r={kind:'estampes.uva/1',transport:{id,offset,total:snapshot.data.length,data:snapshot.data.slice(offset,offset+size),next:offset+size}};
  result={content:[{type:'text',text:JSON.stringify(r)}],structuredContent:r};
  if(!(maxChars>0)||JSON.stringify(result).length<=maxChars)return result;
  size=Math.floor(size/2);
 }while(size>=256);
 throw Error('Configured Host result budget is too small for transport metadata');
}
export function registerUvaTools(server,{service,visualUri,exportLink,maxResultChars=145000}){
  if(!service?.enabled)return;
  const run=author=>async input=>{
    try{
      if(input.action==='read_chunk')return chunk(input.transportId,input.offset??0,maxResultChars);
      const r=await service.dispatch(input,author);
      if(r.exportId)r.url=exportLink(r.exportId);
      if(r.image&&author==='assistant'){
        const state={kind:r.kind,documentId:r.documentId,sceneId:r.sceneId,revision:r.revision,coordinateSystem:'normalized-top-left',message:'Image delivery may be resized. Use normalized image coordinates for edits.'};
        return {content:[{type:'text',text:JSON.stringify(state)},{type:'image',...(r.preview??r.image)}],structuredContent:state};
      }
      const value=r.image?{...r,image:r.editorImage??r.image,preview:undefined,editorImage:undefined}:r;
      const result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
      if(maxResultChars>0&&JSON.stringify(result).length>maxResultChars)return chunk(remember(value),0,maxResultChars);
      return result;
    }catch(e){return {isError:true,content:[{type:'text',text:e.code+': '+e.message}],structuredContent:{kind:'estampes.uva/1',code:e.code??'INVALID_INPUT',message:e.message,details:e.details??{}}};}
  };
  registerAppTool(server,'experimental_workspace',{
    title:'UVA Experimental Beta workspace',
    description:'Opt-in persistent editable workspace, separate from legacy ws/img workspaces. Use list/open to read the authoritative document and revision. To create/import: prepare with requestId req:<UUIDv4> and operation {type:"create",imageIds:["img:..."]} or {type:"import",sourceRef:"ws:..."}. Add visual items with operation {type:"item.add",imageIds:["img:..."]}. For edits supply documentId, expectedRevision, requestId and operation: rename {title}; layer.create {name,sceneId}; layer.update {id,patch:{visible,opacity,name},sceneId}; annotation.add {sceneId,annotation:{type,geometry,layerId,label,style}}; annotation.update {sceneId,id,annotation:{geometry,label,style}}; annotation.remove {sceneId,id}; module {sceneId,module,capability,params}. PREPARE DOES NOT WRITE. Commit by passing the exact returned prepared value to action commit. Retry that same value unchanged after interruptions; Ledger returns the same ACK. Stale revisions require refresh and review, never automatic rebase. render returns actual image pixels and Graph SVG; annotations remain editable in document. modules discovers enabled synchronous visual modules and their input schemas. export saves an editable logical archive with assets and returns a download URL. Large results use an immutable transport snapshot: read each remaining segment with action read_chunk, transportId and offset=transport.next, concatenate transport.data and parse JSON before using the document/prepared command. These are read snapshots, not a second writer. No production durability qualification.',
    inputSchema:UvaInput,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:visualUri}},
  },run('assistant'));
  registerAppTool(server,'uva_user_command',{title:'Edit experimental workspace in Workbench',description:'Private Workbench command adapter.',inputSchema:UvaInput,_meta:{ui:{visibility:['app']}}},run('user'));
}
