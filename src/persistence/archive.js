// Lossless forward deltas. Logical IDs/hashes do not depend on representations.
import { z } from "zod";
import { LogicalRevisionRefSchema as Ref } from "../documents/references.js";
import { parse, bounded, ContentHashSchema as Hash, canonicalJson, hashJson, cloneJson, assertJson } from "../documents/validation.js";
import { integrity, fail } from "./errors.js";
export const MIB=1024*1024, CHUNK_BYTES=4*MIB, ARCHIVE_BYTES=32*MIB;
export const DeltaLocatorSchema=z.object({logical:Ref,kind:z.literal("delta"),base:Ref,manifest:Hash,bytes:z.number().int().positive().max(64*MIB),
  span:z.number().int().min(1).max(100000),deltaBytes:z.number().int().min(1).max(ARCHIVE_BYTES)}).strict();
export const FullLocatorSchema=z.object({logical:Ref,kind:z.literal("full"),relativePath:z.string().max(256),bytes:z.number().int().positive().max(64*MIB),alternative:DeltaLocatorSchema.optional()}).strict();
export const PhysicalLocatorSchema=z.union([FullLocatorSchema,DeltaLocatorSchema]);
const manifestSchema=z.object({schema:z.literal("estampes.history-delta/1"),from:Ref,to:Ref,bytes:z.number().int().positive().max(64*MIB),payloadHash:Hash,chunks:z.array(Hash).min(1).max(16)}).strict();
const pathSchema=z.array(z.union([z.string().max(10000),z.number().int().min(0)])).max(32);
const operation=z.discriminatedUnion("op",[
 z.object({op:z.literal("put"),path:pathSchema,value:z.unknown()}).strict(),
 z.object({op:z.literal("remove"),path:pathSchema}).strict(),
 z.object({op:z.literal("splice"),path:pathSchema,start:z.number().int().min(0),remove:z.number().int().min(0),values:z.array(z.unknown())}).strict(),
]);
const patchSchema=bounded(z.object({schema:z.literal("estampes.lossless-patch/1"),from:Ref,to:Ref,operations:z.array(operation)}).strict());
export const chunkPath=hash=>"visual-history/chunks/"+parse(Hash,hash)+".bin";
export const deltaPath=hash=>"visual-history/deltas/"+parse(Hash,hash)+".json";
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
export function makePatch(before,after,from,to){
 assertJson(before);assertJson(after);
 // Inputs are finite plain JSON after the guards. Compare values directly;
 // unchanged multi-MiB strings need no temporary quoted serialization.
 const equal=(a,b)=>{
  if(a===b)return true;
  if(a===null||b===null||typeof a!=="object"||typeof b!=="object"||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key]));
 };
 const operations=[];
 const walk=(a,b,path)=>{
  if(equal(a,b))return;
  if(Array.isArray(a)&&Array.isArray(b)){
   if(a.length===b.length){for(let i=0;i<a.length;i++)walk(a[i],b[i],[...path,i]);return;}
   let first=0,last=0;while(first<Math.min(a.length,b.length)&&equal(a[first],b[first]))first++;
   while(last<Math.min(a.length,b.length)-first&&equal(a[a.length-1-last],b[b.length-1-last]))last++;
   operations.push({op:"splice",path,start:first,remove:a.length-first-last,values:b.slice(first,b.length-last)});return;
  }
  if(a&&b&&typeof a==="object"&&typeof b==="object"&&!Array.isArray(a)&&!Array.isArray(b)){
   for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
    if(!Object.hasOwn(b,key))operations.push({op:"remove",path:[...path,key]});
    else if(!Object.hasOwn(a,key))operations.push({op:"put",path:[...path,key],value:b[key]});
    else walk(a[key],b[key],[...path,key]);
   }return;
  }
  operations.push({op:"put",path,value:b});
 };
 walk(before,after,[]);return {schema:"estampes.lossless-patch/1",from,to,operations};
}
export function applyPatch(input,value){return applyVerifiedPatch(input,value,hashJson(input),false);}
function applyVerifiedPatch(input,value,fromHash,verified,identity=null){
 const patch=parse(patchSchema,value);integrity(fromHash===patch.from.contentHash,"Delta before hash mismatch");let data=verified?structuredClone(input):cloneJson(input);
 for(const op of patch.operations){
  if(op.path.length===0&&op.op==="put"){data=cloneJson(op.value);continue;}
  const parentPath=op.op==="splice"?op.path:op.path.slice(0,-1);let parent=data;
  for(const key of parentPath){integrity(parent!==null&&typeof parent==="object"&&Object.hasOwn(parent,key),"Delta path is absent");parent=parent[key];}
  if(op.op==="splice"){
   integrity(Array.isArray(parent)&&op.start<=parent.length&&op.start+op.remove<=parent.length,"Invalid delta splice");
   // Avoid function argument limits for large handwriting arrays.
   const next=parent.slice(0,op.start).concat(op.values,parent.slice(op.start+op.remove));parent.length=0;for(const item of next)parent.push(item);
  }else{
   integrity(parent!==null&&typeof parent==="object","Invalid delta parent");const key=op.path.at(-1);
   if(op.op==="remove"){integrity(Object.hasOwn(parent,key)&&!Array.isArray(parent),"Invalid delta removal");delete parent[key];}
   else Object.defineProperty(parent,key,{value:cloneJson(op.value),writable:true,enumerable:true,configurable:true});
  }
 }
 const encoded=canonicalJson(data),hash=hashBytes(encoded);
 integrity(hash===patch.to.contentHash,"Delta after hash mismatch");if(identity)Object.assign(identity,{hash,bytes:Buffer.byteLength(encoded)});return data;
}
export function stageDelta(plan,before,after,from,to,prior,afterBytes){
 const previous=prior.kind==="full"?prior.alternative:prior;
 const patch=makePatch(before,after,from,to);let bytes;try{bytes=Buffer.from(canonicalJson(patch));}catch(e){if(e.code==="LIMIT")return null;throw e;}const deltaBytes=(previous?.deltaBytes??0)+bytes.length;
 if(deltaBytes>=ARCHIVE_BYTES)return null; // required archive anchor, never truncate a large transition.
 const chunks=[];for(let offset=0;offset<bytes.length;offset+=CHUNK_BYTES){const part=bytes.subarray(offset,offset+CHUNK_BYTES),hash=hashBytes(part);plan.addBytes(chunkPath(hash),part,"archive");chunks.push(hash);}
 const manifest={schema:"estampes.history-delta/1",from,to,bytes:bytes.length,payloadHash:hashBytes(bytes),chunks},hash=hashJson(manifest);
 plan.add(deltaPath(hash),manifest,4*MIB,"archive");
 return {logical:to,kind:"delta",base:from,manifest:hash,bytes:afterBytes??Buffer.byteLength(canonicalJson(after)),span:(previous?.span??0)+1,deltaBytes};
}
import { createHash } from "node:crypto";
export const hashBytes=bytes=>createHash("sha256").update(bytes).digest("hex");
export async function readDelta(files,row,track){
 const path=deltaPath(row.manifest),raw=await files.json(path,4*MIB);integrity(hashJson(raw)===row.manifest,"Archive manifest content hash mismatch");const manifest=parse(manifestSchema,raw);track?.add(path);
 integrity(hashJson(manifest)===row.manifest&&same(manifest.from,row.base)&&same(manifest.to,row.logical),"Delta manifest identity mismatch");
 const parts=[];let length=0;
 for(const hash of manifest.chunks){const path=chunkPath(hash),bytes=await files.bytes(path,CHUNK_BYTES);track?.add(path);integrity(hashBytes(bytes)===hash,"Archive chunk hash mismatch");parts.push(bytes);length+=bytes.length;}
 integrity(length===manifest.bytes,"Archive chunk byte count mismatch");const payload=Buffer.concat(parts);integrity(hashBytes(payload)===manifest.payloadHash,"Delta payload hash mismatch");
 let value;try{value=JSON.parse(payload);}catch{fail("INTEGRITY_ERROR","Malformed archive delta");}
 integrity(same(value.from,row.base)&&same(value.to,row.logical),"Delta payload identities differ from manifest");return value;
}
export class VersionReadSession {
 constructor(locator,{recordBytes=24*MIB,proofBytes=4*MIB}={}){this.locator=locator;this.recordBytes=recordBytes;this.proofBytes=proofBytes;this.records=new Map();this.total=0;this.proofTotal=0;this.hits=0;this.deltaApplications=0;}
 key(row){return hashJson(row);}
 get(row){const key=this.key(row),hit=this.records.get(key);if(!hit)return null;this.records.delete(key);this.records.set(key,hit);this.hits++;return hit;}
 put(row,record,paths){
  const key=this.key(row);if(this.records.has(key))return;const bytes=row.bytes,proofBytes=[...paths].reduce((n,p)=>n+Buffer.byteLength(p)+16,64);
  if(bytes>this.recordBytes||proofBytes>this.proofBytes)return;
  this.records.set(key,{record,paths:[...paths],bytes,proofBytes});this.total+=bytes;this.proofTotal+=proofBytes;
  while(this.total>this.recordBytes||this.proofTotal>this.proofBytes){const first=this.records.keys().next().value,value=this.records.get(first);this.records.delete(first);this.total-=value.bytes;this.proofTotal-=value.proofBytes;}
 }
}
export async function readVersion(files,ref,locator,track=new Set(),override,session){
 integrity(!session||session.locator===locator,"Version verification session crossed Locator snapshots");
 let current=ref,row=override??locator.get(hashJson(ref)),record;const chain=[],seen=new Set(),paths=new Set();
 for(;;){
  row=parse(PhysicalLocatorSchema,row);integrity(same(row.logical,current),"Logical locator mismatch");const key=hashJson(current);
  integrity(!seen.has(key)&&seen.size<100000,"Cyclic or excessive history reconstruction");seen.add(key);
  const hit=session?.get(row);if(hit){record=hit.record;for(const path of hit.paths)paths.add(path);break;}
  if(row.kind==="full")break;
  integrity(row.base.entityId===current.entityId&&row.base.storeInstanceId===current.storeInstanceId&&row.base.revision<current.revision,"Delta base changes owner or does not precede target");
  chain.push(row);current=row.base;row=locator.get(hashJson(current));integrity(Boolean(row),"Missing archive base logical version");
 }
 if(!record){
  const expected="visual-documents/"+current.entityId.slice(4)+"/generations/"+current.revision+"-"+current.contentHash+".json";
  integrity(row.relativePath===expected,"Invalid full checkpoint path");record=await files.json(expected);paths.add(expected);
  const identity=files.jsonIdentities?.get(record)??{hash:hashJson(record),bytes:Buffer.byteLength(canonicalJson(record))};
  integrity(identity.bytes===row.bytes&&identity.hash===current.contentHash,"Full checkpoint integrity mismatch");session?.put(row,record,paths);
 }
 let verifiedHash=current.contentHash;
 for(const delta of chain.reverse()){
  const identity={};record=applyVerifiedPatch(record,await readDelta(files,delta,paths),verifiedHash,true,identity);verifiedHash=identity.hash;
  integrity(identity.bytes===delta.bytes,"Delta reconstructed byte length mismatch");
  if(session){session.deltaApplications++;session.put(delta,record,paths);}await new Promise(resolve=>setImmediate(resolve));
 }
 integrity(verifiedHash===ref.contentHash&&record.document.id===ref.entityId&&record.document.revision===ref.revision,"Reconstructed generation hash/identity mismatch");for(const path of paths)track.add(path);return record;
}
export async function physicalVersionPaths(files,ref,locator,paths=new Set(),seen=new Set()){
 const key=hashJson(ref);if(seen.has(key))return paths;seen.add(key);const row=parse(PhysicalLocatorSchema,locator.get(key));
 if(row.kind==="full"){paths.add(row.relativePath);if(row.alternative)await physicalDeltaPaths(files,row.alternative,locator,paths,seen);}
 else await physicalDeltaPaths(files,row,locator,paths,seen);return paths;
}
async function physicalDeltaPaths(files,row,locator,paths,seen){
 const path=deltaPath(row.manifest),raw=await files.json(path,4*MIB);integrity(hashJson(raw)===row.manifest,"Archive manifest hash mismatch");const m=parse(manifestSchema,raw);paths.add(path);for(const h of m.chunks)paths.add(chunkPath(h));
 await physicalVersionPaths(files,row.base,locator,paths,seen);
}
