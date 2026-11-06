// Explicit non-destructive recovery from a saved local logical export. Source
// is opened read-only; destination must be a fresh, separate Beta directory.
import { createUvaService } from '../src/uva/service.js';
import { readSavedExport } from '../src/uva/exports.js';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const [source,exportId,destination,profile]=process.argv.slice(2);
if(!source||!exportId||!destination||!profile)throw Error('Usage: node scripts/uva-recover.mjs SOURCE_DIR EXPORT_ID FRESH_DESTINATION PROFILE');
if(resolve(source)===resolve(destination))throw Error('Recovery must preserve the source in a separate directory');
try{if((await readdir(destination)).length)throw Error('Recovery destination must be empty');}catch(e){if(e.code!=='ENOENT')throw e;}
const bytes=await readSavedExport(source,exportId),service=await createUvaService({enabled:true,directory:destination,profile});
try{
 const id=await service.stageRecovery(bytes);
 const prepared=await service.dispatch({action:'prepare',requestId:'req:'+randomUUID(),operation:{type:'recover',exportId:id}},'user');
 const restored=await service.dispatch({action:'commit',prepared:prepared.prepared},'user');
 console.log(JSON.stringify({documentId:restored.document.id,revision:restored.revision,ack:restored.ack,sourcePreserved:true}));
}finally{await service.close();}
