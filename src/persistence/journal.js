import { readdir } from "node:fs/promises";
import { z } from "zod";
import { TransactionIdSchema, UUIDSchema } from "../documents/identity.js";
import { LogicalRevisionRefSchema } from "../documents/references.js";
import { bounded, ContentHashSchema, RevisionSchema, TimestampSchema, parse, canonicalJson } from "../documents/validation.js";
import { integrity } from "./errors.js";
export const IntentSchema=bounded(z.object({schema:z.literal("estampes.transaction-intent/1"),commitId:TransactionIdSchema,storeInstanceId:UUIDSchema,
  mode:z.enum(["content","genesis","recovery-epoch","maintenance"]),baseRootHash:ContentHashSchema.nullable(),baseGeneration:z.number().int().min(0),
  requestKeyDigest:ContentHashSchema.nullable(),payloadHash:ContentHashSchema,acceptedAt:TimestampSchema,after:z.array(LogicalRevisionRefSchema).max(64),stagedFiles:z.array(z.object({path:z.string().max(512),hash:ContentHashSchema,bytes:z.number().int().min(0)}).strict()).max(4096).optional()}).strict());
const preparedSchema=z.object({schema:z.literal("estampes.prepared/1"),commitId:TransactionIdSchema,generation:RevisionSchema,rootHash:ContentHashSchema}).strict();
const outcomeSchema=z.object({schema:z.literal("estampes.transaction-outcome/1"),commitId:TransactionIdSchema,outcome:z.enum(["committed","aborted"]),
  membership:z.object({generation:RevisionSchema,registryRootHash:ContentHashSchema,resultHash:ContentHashSchema}).strict().optional()}).strict();
export const transactionPath=id=>"visual-transactions/"+parse(TransactionIdSchema,id).slice(3);
export class IntentJournal {
  constructor(files){this.files=files;}
  async intent(value){parse(IntentSchema,value);await this.files.atomic(transactionPath(value.commitId)+"/intent.json",Buffer.from(canonicalJson(value)),"intent",{immutable:true,owner:{kind:"transaction",id:value.commitId.slice(3)}});}
  async prepare(value){parse(preparedSchema,value);await this.files.atomic(transactionPath(value.commitId)+"/prepared.json",Buffer.from(canonicalJson(value)),"prepared",{immutable:true,owner:{kind:"transaction",id:value.commitId.slice(3)}});}
  async outcome(commitId,member){
    const value={schema:"estampes.transaction-outcome/1",commitId,outcome:member?"committed":"aborted",...(member?{membership:{generation:member.generation,registryRootHash:member.registryRootHash,resultHash:member.resultHash}}:{})};
    await this.files.atomic(transactionPath(commitId)+"/outcome.json",Buffer.from(canonicalJson(value)),"outcome",{immutable:true,owner:{kind:"transaction",id:commitId.slice(3)}});
  }
  // Transactions at or after `settledBefore` (the recent window) are always fully
  // re-checked; older committed ones with a matching durable outcome are not.
  async recover(snapshot,{settledBefore=0}={}){
    const seen=new Map(),outcomes=[];
    for(const name of await readdir(this.files.path("visual-transactions"))){
      if(!UUIDSchema.safeParse(name).success){integrity(false,"Unknown transaction directory");}
      const id="tx:"+name,path=transactionPath(id),member=snapshot.indices.commitIndex.get(id);
      // A committed transaction whose outcome is durable was checked against its
      // intent and Ledger entry when that outcome was written; its request key is
      // in the commit index. Re-reading every settled intent made open O(history).
      if(member&&member.generation<settledBefore){
        const old=await this.files.exists(path+"/outcome.json")?parse(outcomeSchema,await this.files.json(path+"/outcome.json")):null;
        if(old&&old.commitId===id&&old.outcome==="committed"&&old.membership?.generation===member.generation&&old.membership.registryRootHash===member.registryRootHash&&old.membership.resultHash===member.resultHash){
          if(member.requestKeyDigest!==null){integrity(!seen.has(member.requestKeyDigest)||seen.get(member.requestKeyDigest)===member.payloadHash,"Conflicting durable request intents");seen.set(member.requestKeyDigest,member.payloadHash);}
          outcomes.push({commitId:id,outcome:"committed"});continue;
        }
      }
      if(!await this.files.exists(path+"/intent.json")){const proof=snapshot.indices.retention.get("journal-compacted:"+id);integrity(!member||(proof?.commitId===id&&proof.outcome==="committed"&&proof.payloadHash===member.payloadHash),"Committed transaction is missing its durable intent or matching compaction proof");outcomes.push({commitId:id,outcome:"incomplete-intent"});continue;}
      const intent=parse(IntentSchema,await this.files.json(path+"/intent.json"));
      integrity(intent.commitId===id&&intent.storeInstanceId===snapshot.root.storeInstanceId,"Journal namespace mismatch");
      if(intent.requestKeyDigest!==null){
        integrity(!seen.has(intent.requestKeyDigest)||seen.get(intent.requestKeyDigest)===intent.payloadHash,"Conflicting durable request intents");seen.set(intent.requestKeyDigest,intent.payloadHash);
      }
      if(member){
        integrity(member.payloadHash===intent.payloadHash&&member.requestKeyDigest===intent.requestKeyDigest,"Intent differs from committed membership");
        if(intent.requestKeyDigest!==null){const ledger=snapshot.indices.ledger.get(intent.requestKeyDigest);
          integrity(ledger&&(ledger.kind==="tombstone"||canonicalJson(ledger.ack.revisionVector)===canonicalJson(intent.after))&&(ledger.kind==="tombstone"?ledger.record.acceptedAt:ledger.acceptedAt)===intent.acceptedAt,"Intent after-state differs from committed ACK");}
      }
      if(await this.files.exists(path+"/outcome.json")){
        const old=parse(outcomeSchema,await this.files.json(path+"/outcome.json"));integrity(old.commitId===id&&old.outcome===(member?"committed":"aborted"),"Outcome contradicts selected committed root; refusing rollback");
        if(member)integrity(old.membership?.generation===member.generation&&old.membership.registryRootHash===member.registryRootHash&&old.membership.resultHash===member.resultHash,"Outcome membership mismatch");
        // A matching outcome is only ever made visible by an atomic write (fsync,
        // rename, directory fsync) after its intent: this transaction is settled.
        // Re-syncing every settled transaction made each open O(history) fsyncs.
        outcomes.push({commitId:id,outcome:member?"committed":"aborted"});continue;
      }
      await this.files.resync(path+"/intent.json");
      await this.files.point("recovery.before-outcome",{commitId:id});await this.outcome(id,member);
      outcomes.push({commitId:id,outcome:member?"committed":"aborted"});
    }
    for(const [key,value]of snapshot.indices.retention)if(key.startsWith("journal-key:")){const digest=key.slice(12);integrity(!seen.has(digest)||seen.get(digest)===value.payloadHash,"Compacted request proof conflicts with a durable intent");seen.set(digest,value.payloadHash);}
    return {seen,outcomes};
  }
}
