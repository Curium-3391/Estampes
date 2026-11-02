import { z } from "zod";
import { bounded, parse, ContentHashSchema, hashJson } from "../documents/validation.js";
import { CurrentEnvelopeSchema, RecoveryResolverSchema } from "./commit-root-schema.js";
import { fail } from "./errors.js";
export const DAY=24*60*60*1000, ACK_WINDOW=7*DAY;
export const LifecycleOptionsSchema=z.object({enabled:z.literal(true),autoMaintenance:z.boolean().default(true),
 pinSessions:z.number().int().min(1).max(1024).default(64),pinBytes:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1024**3)}).strict();
export const PolicySchema=bounded(z.object({schema:z.literal("estampes.lifecycle/1"),options:LifecycleOptionsSchema,
 highWaterMs:z.number().int().min(0),committedAtMs:z.number().int().min(0),contentSinceMaintenance:z.number().int().min(0),
 maintenance:z.object({state:z.enum(["idle","scheduled","compacting","gc","waiting-grace","blocked","failed"]),
  cursor:z.string().nullable(),conflicts:z.number().int().min(0),steps:z.number().int().min(0),reason:z.string().max(300).optional(),pending:z.object({key:ContentHashSchema,sourceRowHash:ContentHashSchema,manifestHash:ContentHashSchema,writtenChunks:z.array(ContentHashSchema).max(16)}).strict().optional()}).strict(),
}).strict());
export const RecoveryRootSchema=z.object({schema:z.literal("estampes.recovery-root/1"),envelope:CurrentEnvelopeSchema,committedAtMs:z.number().int().min(0)}).strict();
export const CheckpointSchema=z.object({schema:z.literal("estampes.named-checkpoint/1"),name:z.string().min(1).max(80),
 registryRootHash:ContentHashSchema,logicalClosureHash:ContentHashSchema,resolverLocatorRootHash:ContentHashSchema,createdAtMs:z.number().int().min(0),envelope:CurrentEnvelopeSchema}).strict();
export const GcRecordSchema=z.object({schema:z.literal("estampes.gc-state/1"),planHash:ContentHashSchema,state:z.enum(["planned","quarantining","waiting-grace","unlinking","complete","failed"]),
 quarantinedAtMs:z.number().int().min(0).nullable(),moved:z.array(z.number().int().min(0).max(127)),deleted:z.array(z.number().int().min(0).max(127)),reason:z.string().max(300).optional()}).strict();
export const BackupJobSchema=z.object({schema:z.literal("estampes.backup-job/1"),id:z.string().uuid(),destination:z.string().min(1).max(4096),
 destinationToken:ContentHashSchema,source:CurrentEnvelopeSchema,filesHash:ContentHashSchema,state:z.enum(["copying","complete","cancelled","failed"]),
 fileIndex:z.number().int().min(0),offset:z.number().int().min(0),remainingBytes:z.number().int().min(0),deadlineMs:z.number().int().min(0),reason:z.string().max(300).optional()}).strict();
export const JournalProofSchema=z.object({schema:z.literal("estampes.compacted-journal/1"),commitId:z.string(),payloadHash:ContentHashSchema,outcome:z.enum(["committed","aborted"]),atMs:z.number().int().min(0)}).strict();
export function policyOf(retention){return retention?.has("lifecycle")?parse(PolicySchema,retention.get("lifecycle")):null;}
export function initialPolicy(options,now){return parse(PolicySchema,{schema:"estampes.lifecycle/1",options:parse(LifecycleOptionsSchema,options),highWaterMs:now,committedAtMs:now,contentSinceMaintenance:0,maintenance:{state:"idle",cursor:null,conflicts:0,steps:0}});}
export function validateRetentionEntry(key,value){
 if(key.startsWith("registry:"))return parse(RecoveryResolverSchema,value);
 if(key==="lifecycle")return parse(PolicySchema,value);
 if(key.startsWith("recovery:"))return parse(RecoveryRootSchema,value);
 if(key.startsWith("checkpoint:"))return parse(CheckpointSchema,value);
 if(key.startsWith("gc:"))return parse(GcRecordSchema,value);
 if(key.startsWith("backup:"))return parse(BackupJobSchema,value);
 if(key.startsWith("journal-compacted:"))return parse(JournalProofSchema,value);
 if(key.startsWith("journal-key:")){const out=parse(z.object({payloadHash:ContentHashSchema}).strict(),value);return out;}
 fail("INTEGRITY_ERROR","Unknown retention record namespace");
}
export const checkpointKey=name=>"checkpoint:"+hashJson(name);
