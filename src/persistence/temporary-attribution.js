import { readdir, lstat } from "node:fs/promises";
import { relative, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { bounded, ContentHashSchema, parse, canonicalJson, hashJson } from "../documents/validation.js";
import { integrity, fail } from "./errors.js";
import { TransactionIdSchema } from "../documents/identity.js";
import { CurrentEnvelopeSchema, parseCommitRoot, assertCurrentEnvelope } from "./commit-root-schema.js";
import { PageStore } from "./pages.js";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TemporaryOwnerSchema=z.object({kind:z.enum(["transaction","bootstrap","backup","restore"]),id:z.string().regex(uuid)}).strict();
export const TemporaryClaimSchema=bounded(z.object({schema:z.literal("estampes.temporary-claim/1"),claimId:z.string().regex(uuid),owner:TemporaryOwnerSchema,
  finalPath:z.string().min(1).max(512),temporaryPath:z.string().min(1).max(560),hash:ContentHashSchema,bytes:z.number().int().min(0),label:z.string().min(1).max(80)}).strict());
export const TemporaryRecoverySchema=z.object({schema:z.literal("estampes.temporary-recovery/1"),claimId:z.string().regex(uuid),owner:TemporaryOwnerSchema,
  finalPath:z.string().min(1).max(512),temporaryPath:z.string().min(1).max(560),hash:ContentHashSchema,bytes:z.number().int().min(0),outcome:z.enum(["completed","aborted"]),classifiedGeneration:z.number().int().positive()}).strict();
export const temporaryClaimPath=id=>"visual-temporaries/claims/"+parse(z.string().regex(uuid),id)+".json";
const hashBytes=bytes=>createHash("sha256").update(bytes).digest("hex");
const PreparedSchema=z.object({schema:z.literal("estampes.prepared/1"),commitId:TransactionIdSchema,generation:z.number().int().positive(),rootHash:ContentHashSchema}).strict();

export async function registerTemporary(files,finalPath,bytes,label,ownerInput){
  const owner=parse(TemporaryOwnerSchema,ownerInput),claimId=randomUUID(),claim={schema:"estampes.temporary-claim/1",claimId,owner,finalPath,
    temporaryPath:finalPath+".tmp-"+claimId,hash:hashBytes(bytes),bytes:bytes.length,label};
  files.path(finalPath);files.path(claim.temporaryPath);parse(TemporaryClaimSchema,claim);
  await files.durableCreate(temporaryClaimPath(claimId),Buffer.from(canonicalJson(claim)),"temporary-claim");return claim;
}

async function inventory(files,gcOwnedPaths=new Set()){
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
  for(const path of found)if(!claims.has(path)&&!gcOwnedPaths.has(path))fail("INTEGRITY_ERROR","Unattributed atomic temporary file",{storageIntegrity:true,path});
  return claims;
}

async function verifyCandidateLocation(files,candidate,record,index){
  const source=await files.exists(candidate.path),quarantine=await files.exists(candidate.quarantine);
  integrity(!(source&&quarantine),"GC temporary candidate exists in two locations");
  if(source||quarantine){const digest=await files.digest(source?candidate.path:candidate.quarantine);integrity(digest.hash===candidate.hash&&digest.bytes===candidate.bytes,"GC temporary disposition bytes changed");return;}
  integrity(record.deleted.includes(index)||(record.unlinking??[]).includes(index),"GC temporary disposition lost an owned file");
}

async function gcTemporaryOwnership(files,snapshot){
  const dispositions=new Map(),ownedPaths=new Set();
  for(const [key,record]of snapshot.indices.retention){
    if(!key.startsWith("gc:"))continue;
    const {readGcPlan}=await import("./gc.js"),plan=await readGcPlan(files,record);
    for(const disposition of plan.temporaryDispositions??[]){
      const recovery=parse(TemporaryRecoverySchema,disposition.recovery),claimPath=temporaryClaimPath(recovery.claimId);
      integrity(!dispositions.has(recovery.claimId),"Temporary claim has multiple GC dispositions");
      const claimCandidate=plan.candidates[disposition.claimCandidate];
      integrity(claimCandidate?.path===claimPath&&claimCandidate.class==="G2","GC disposition has an invalid claim candidate");
      await verifyCandidateLocation(files,claimCandidate,record,disposition.claimCandidate);ownedPaths.add(claimPath);
      if(disposition.temporaryCandidate!==null){const temporaryCandidate=plan.candidates[disposition.temporaryCandidate];
        integrity(temporaryCandidate?.path===recovery.temporaryPath&&temporaryCandidate.class==="G2"&&temporaryCandidate.hash===recovery.hash&&temporaryCandidate.bytes===recovery.bytes,"GC disposition has an invalid temporary candidate");
        await verifyCandidateLocation(files,temporaryCandidate,record,disposition.temporaryCandidate);ownedPaths.add(recovery.temporaryPath);
      }
      dispositions.set(recovery.claimId,recovery);
    }
  }
  return {dispositions,ownedPaths};
}

async function provesHistoricalCurrentPublication(files,snapshot,claim,member){
  if(claim.finalPath!=="visual-registry/CURRENT.json"||claim.label!=="current")return false;
  const commitId="tx:"+claim.owner.id,path="visual-transactions/"+claim.owner.id+"/prepared.json";
  if(!await files.exists(path))return false;
  const prepared=parse(PreparedSchema,await files.json(path,4096));
  if(prepared.commitId!==commitId||prepared.generation!==member.generation)return false;
  const pages=new PageStore(files),root=parseCommitRoot(await pages.hashed(prepared.rootHash,"visual-registry/roots",64*1024));
  const head={generation:prepared.generation,rootHash:prepared.rootHash,commitId},envelope=parse(CurrentEnvelopeSchema,{...head,checksum:hashJson(head)});
  assertCurrentEnvelope(root,envelope);
  return root.roots.registry===member.registryRootHash&&root.commitId===member.commitId&&hashBytes(Buffer.from(canonicalJson(envelope)))===claim.hash&&Buffer.byteLength(canonicalJson(envelope))===claim.bytes;
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
  const gcOwned=await gcTemporaryOwnership(files,snapshot),claims=await inventory(files,gcOwned.ownedPaths),changes=new Map(),outcomes=[],finalOwners=new Map();
  for(const claim of claims.values()){
    integrity(claim.owner.kind==="transaction","Unexpected temporary owner in active Document store");
    const disposition=gcOwned.dispositions.get(claim.claimId);
    if(disposition){integrity(canonicalJson(disposition)===canonicalJson(parse(TemporaryRecoverySchema,{...disposition})),"Invalid GC temporary disposition");
      integrity(canonicalJson(disposition.owner)===canonicalJson(claim.owner)&&disposition.finalPath===claim.finalPath&&disposition.temporaryPath===claim.temporaryPath&&disposition.hash===claim.hash&&disposition.bytes===claim.bytes,"GC disposition differs from temporary claim");
      outcomes.push({claimId:claim.claimId,owner:"tx:"+claim.owner.id,outcome:"gc-owned",temporary:await files.exists(claim.temporaryPath),final:false});continue;}
    integrity(!finalOwners.has(claim.finalPath),"Atomic target has conflicting temporary owners");finalOwners.set(claim.finalPath,claim.owner);
    const tx="tx:"+claim.owner.id,member=snapshot.indices.commitIndex.get(tx),temporary=await files.exists(claim.temporaryPath),final=await files.exists(claim.finalPath);
    if(temporary){const digest=await files.digest(claim.temporaryPath);integrity(digest.hash===claim.hash&&digest.bytes===claim.bytes,"Attributed temporary hash mismatch");}
    let finalMatches=false;if(final){const digest=await files.digest(claim.finalPath);finalMatches=digest.hash===claim.hash&&digest.bytes===claim.bytes;}
    const historical=member&&!finalMatches&&await provesHistoricalCurrentPublication(files,snapshot,claim,member);
    if(member)integrity(finalMatches||historical,"Committed transaction has an incomplete attributed atomic file");
    const outcome=finalMatches||historical?"completed":"aborted";
    changes.set("temporary:"+claim.claimId,parse(TemporaryRecoverySchema,{schema:"estampes.temporary-recovery/1",claimId:claim.claimId,owner:claim.owner,
      finalPath:claim.finalPath,temporaryPath:claim.temporaryPath,hash:claim.hash,bytes:claim.bytes,outcome,classifiedGeneration:snapshot.root.generation}));
    outcomes.push({claimId:claim.claimId,owner:tx,outcome,temporary,final:finalMatches});
  }
  return {changes,outcomes};
}

export async function readTemporaryClaim(files,id){
  const claim=parse(TemporaryClaimSchema,await files.json(temporaryClaimPath(id),16*1024));integrity(claim.claimId===id,"Temporary claim key mismatch");return claim;
}
