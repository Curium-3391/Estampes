import { z } from 'zod';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { RequestIdSchema, DocumentIdSchema, SceneIdSchema } from '../documents/identity.js';
// One versioned command contract for GPT and the user's Workbench. The actor
// is selected by registration, never by a caller-provided provenance field.
export const UvaInput=z.object({action:z.enum(['status','list','open','prepare','commit','render','modules','export']),documentId:DocumentIdSchema.optional(),sceneId:SceneIdSchema.optional(),requestId:RequestIdSchema.optional(),expectedRevision:z.number().int().positive().optional(),operation:z.record(z.string(),z.unknown()).optional(),prepared:z.record(z.string(),z.unknown()).optional()}).strict();
export function registerUvaTools(server,{service,visualUri,exportLink}){
  if(!service?.enabled)return;
  const run=author=>async input=>{
    try{
      const r=await service.dispatch(input,author);
      if(r.exportId)r.url=exportLink(r.exportId);
      const content=[{type:'text',text:JSON.stringify(r)}];
      if(r.image){content[0].text=JSON.stringify({...r,image:{mimeType:r.image.mimeType,delivery:'image-content'},preview:undefined});content.push({type:'image',...(r.preview??r.image)});}
      return {content,structuredContent:r};
    }catch(e){return {isError:true,content:[{type:'text',text:e.code+': '+e.message}],structuredContent:{kind:'estampes.uva/1',code:e.code??'INVALID_INPUT',message:e.message,details:e.details??{}}};}
  };
  registerAppTool(server,'experimental_workspace',{
    title:'UVA Experimental Beta workspace',
    description:'Opt-in persistent editable workspace, separate from legacy ws/img workspaces. Use list/open to read the authoritative document and revision. To create/import: prepare with requestId req:<UUIDv4> and operation {type:"create",imageIds:["img:..."]} or {type:"import",sourceRef:"ws:..."}. Add visual items with operation {type:"item.add",imageIds:["img:..."]}. For edits supply documentId, expectedRevision, requestId and operation: rename {title}; layer.create {name,sceneId}; layer.update {id,patch:{visible,opacity,name},sceneId}; annotation.add {sceneId,annotation:{type,geometry,layerId,label,style}}; annotation.update {sceneId,id,annotation:{geometry,label,style}}; annotation.remove {sceneId,id}; module {sceneId,module,capability,params}. PREPARE DOES NOT WRITE. Commit by passing the exact returned prepared value to action commit. Retry that same value unchanged after interruptions; Ledger returns the same ACK. Stale revisions require refresh and review, never automatic rebase. render returns actual image pixels and Graph SVG; annotations remain editable in document. modules discovers enabled synchronous visual modules and their input schemas. export saves an editable logical archive with assets and returns a download URL. No production durability qualification.',
    inputSchema:UvaInput,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:visualUri}},
  },run('assistant'));
  registerAppTool(server,'uva_user_command',{title:'Edit experimental workspace in Workbench',description:'Private Workbench command adapter.',inputSchema:UvaInput,_meta:{ui:{visibility:['app']}}},run('user'));
}
