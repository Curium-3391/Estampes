import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RequestIdSchema, DocumentIdSchema, SceneIdSchema } from '../documents/identity.js';
// The store's internal command contract (src/uva/service.js dispatch).
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
// The store's read-only view, always there when UVA is on.
export const UvaStoreInput=z.object({action:z.enum(['status','list','open','render','export','read_chunk']),documentId:DocumentIdSchema.optional(),sceneId:SceneIdSchema.optional(),transportId:z.string().regex(/^[0-9a-f]{64}$/).optional(),offset:z.number().int().min(0).max(16*1024**2).optional()}).strict();
export function registerUvaTools(server,{service,exportLink,maxResultChars=145000}){
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
  server.registerTool('uva_store',{
    title:'Estampes UVA store',
    description:'Read-only view of the UVA store where canvases, workspaces, panel layouts and calculator notebooks are committed. status: store health, commit counts, and per canvas/record whether the legacy file matches, the durable pending seq and the committed seq (diagnostics.mirror). list: the canvas documents. open {documentId}: one document and its revision. render {documentId,sceneId?}: its pixels. export {documentId}: an editable logical archive with its images, as a download URL. Large results: read the rest with read_chunk {transportId, offset: transport.next}. Edit canvases with the canvas tools, never here.',
    inputSchema:UvaStoreInput,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },run('assistant'));
}
