import { readdir, lstat } from "node:fs/promises";
import { relative, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { bounded, ContentHashSchema, parse, canonicalJson } from "../documents/validation.js";
import { integrity, fail } from "./errors.js";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TemporaryOwnerSchema=z.object({kind:z.enum(["transaction","bootstrap","backup","restore"]),id:z.string().regex(uuid)}).strict();
export const TemporaryClaimSchema=bounded(z.object({schema:z.literal("estampes.temporary-claim/1"),claimId:z.string().regex(uuid),owner:TemporaryOwnerSchema,
  finalPath:z.string().min(1).max(512),temporaryPath:z.string().min(1).max(560),hash:ContentHashSchema,bytes:z.number().int().min(0),label:z.string().min(1).max(80)}).strict());
export const TemporaryRecoverySchema=z.object({schema:z.literal("estampes.temporary-recovery/1"),claimId:z.string().regex(uuid),owner:TemporaryOwnerSchema,
  finalPath:z.string().min(1).max(512),temporaryPath:z.string().min(1).max(560),hash:ContentHashSchema,bytes:z.number().int().min(0),outcome:z.enum(["completed","aborted"]),classifiedGeneration:z.number().int().positive()}).strict();
export const temporaryClaimPath=id=>"visual-temporaries/claims/"+parse(z.string().regex(uuid),id)+".json";
const hashBytes=bytes=>createHash("sha256").update(bytes).digest("hex");

export async function registerTemporary(files,finalPath,bytes,label,ownerInput){
  const owner=parse(TemporaryOwnerSchema,ownerInput),claimId=randomUUID(),claim={schema:"estampes.temporary-claim/1",claimId,owner,finalPath,
    temporaryPath:finalPath+".tmp-"+claimId,hash:hashBytes(bytes),bytes:bytes.length,label};
  files.path(finalPath);files.path(claim.temporaryPath);parse(TemporaryClaimSchema,claim);
  await files.durableCreate(temporaryClaimPath(claimId),Buffer.from(canonicalJson(claim)),"temporary-claim");return claim;
}

async function inventory(files){
  const claims=new Map(),claimDir="visual-temporaries/claims";
  if(await files.exists(claimDir))for(const name of await readdir(files.path(claimDir))){
    if(!/^[0-9a-f-]{36}\.json$/.test(name))fail("INTEGRITY_ERROR","Unknown temporary claim filename",{storageIntegrity:true});
    const claim=parse(TemporaryClaimSchema,await files.json(claimDir+"/"+name,16*1024));
    integrity(name===claim.claimId+".json"&&claim.temporaryPath===claim.finalPath+".tmp-"+claim.claimId,"Temporary claim identity mismatch");
    integrity(!claims.has(claim.temporaryPath),"Temporary path has conflicting owners");claims.set(claim.temporaryPath,claim);
  }
  const found=[];
  const walk=async absolute=>{for(const entry of await readdir(absolute,{withFileTypes:true})){
    const path=join(absolute,entry.name),name=relative(files.root,path);
    const st=await lstat(path);integrity(!st.isSymbolicLink()&&(st.isDirectory()||st.isFile()),"Unsafe entry during temporary inventory");
    if(st.isDirectory())await walk(path);else if(/\.tmp-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(name))found.push(name);
  }};await walk(files.root);
  for(const path of found)if(!claims.has(path))fail("INTEGRITY_ERROR","Unattributed atomic temporary file",{storageIntegrity:true,path});
  return claims;
}

export async function recoverBootstrapTemporary(files){
  const claims=await inventory(files),bootstrap=[...claims.values()].filter(claim=>claim.owner.kind==="bootstrap");if(!bootstrap.length)return;
  integrity(bootstrap.length===1,"Store bootstrap has ambiguous temporary owners");const claim=bootstrap[0];
  integrity(claim.finalPath==="storage-format.json","Store bootstrap temporary has an invalid target");
  if(await files.exists(claim.finalPath)){
    const digest=await files.digest(claim.finalPath);integrity(digest.hash===claim.hash&&digest.bytes===claim.bytes,"Completed bootstrap target differs from its claim");
  }else if(await files.exists(claim.temporaryPath)){
    const digest=await files.digest(claim.temporaryPath);integrity(digest.hash===claim.hash&&digest.bytes===claim.bytes,"Bootstrap temporary hash mismatch");
    await files.move(claim.temporaryPath,claim.finalPath,"bootstrap-recovery");
  }
  await files.remove(temporaryClaimPath(claim.claimId),"temporary-claim");
}

export async function classifyTemporaryClaims(files,snapshot){
  const claims=await inventory(files),changes=new Map(),outcomes=[],finalOwners=new Map();
  for(const claim of claims.values()){
    integrity(claim.owner.kind==="transaction","Unexpected temporary owner in active Document store");
    integrity(!finalOwners.has(claim.finalPath),"Atomic target has conflicting temporary owners");finalOwners.set(claim.finalPath,claim.owner);
    const tx="tx:"+claim.owner.id,member=snapshot.indices.commitIndex.get(tx),temporary=await files.exists(claim.temporaryPath),final=await files.exists(claim.finalPath);
    if(temporary){const digest=await files.digest(claim.temporaryPath);integrity(digest.hash===claim.hash&&digest.bytes===claim.bytes,"Attributed temporary hash mismatch");}
    let finalMatches=false;if(final){const digest=await files.digest(claim.finalPath);finalMatches=digest.hash===claim.hash&&digest.bytes===claim.bytes;}
    if(member)integrity(finalMatches,"Committed transaction has an incomplete attributed atomic file");
    const outcome=finalMatches?"completed":"aborted";
    changes.set("temporary:"+claim.claimId,parse(TemporaryRecoverySchema,{schema:"estampes.temporary-recovery/1",claimId:claim.claimId,owner:claim.owner,
      finalPath:claim.finalPath,temporaryPath:claim.temporaryPath,hash:claim.hash,bytes:claim.bytes,outcome,classifiedGeneration:snapshot.root.generation}));
    outcomes.push({claimId:claim.claimId,owner:tx,outcome,temporary,final:finalMatches});
  }
  return {changes,outcomes};
}

export async function readTemporaryClaim(files,id){
  const claim=parse(TemporaryClaimSchema,await files.json(temporaryClaimPath(id),16*1024));integrity(claim.claimId===id,"Temporary claim key mismatch");return claim;
}
