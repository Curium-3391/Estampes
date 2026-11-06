// Structural contracts ONLY. No writer, journal, locks, GC or publication.
import { z } from "zod";
import { UUIDSchema, DocumentIdSchema, TransactionIdSchema, CommandIdSchema, LegacySetKeySchema } from "../documents/identity.js";
import { bounded, ContentHashSchema, RevisionSchema, TimestampSchema, parse, hashJson, issue, DocumentValidationError } from "../documents/validation.js";

export const RegistryRootReferenceSchema = ContentHashSchema;
export const LocatorRootReferenceSchema = ContentHashSchema;
export const LedgerRootReferenceSchema = ContentHashSchema;
export const RetentionRootReferenceSchema = ContentHashSchema;
export const AuthorityEpochSchema = RevisionSchema;
export const CommitRootSchema = bounded(z.object({ schema: z.literal("estampes.commit-root/1"), storeInstanceId: UUIDSchema,
  generation: RevisionSchema, commitId: TransactionIdSchema, parentCommitHash: ContentHashSchema.nullable(),
  roots: z.object({ registry: RegistryRootReferenceSchema, locator: LocatorRootReferenceSchema, ledger: LedgerRootReferenceSchema,
    commitIndex: ContentHashSchema, retention: RetentionRootReferenceSchema, authority: ContentHashSchema }).strict(),
}).strict().refine(r => r.generation === 1 ? r.parentCommitHash === null : r.parentCommitHash !== null, "Only the initial root has a null parent"), { maxBytes: 64*1024 });
export const CommitIndexEntrySchema = z.object({ commitId: TransactionIdSchema, generation: RevisionSchema,
  registryRootHash: RegistryRootReferenceSchema, requestKeyDigest: ContentHashSchema.nullable(), payloadHash: ContentHashSchema,
  resultHash: ContentHashSchema, outcome: z.literal("committed") }).strict();
export const RecoveryResolverSchema = z.object({ registryRootHash: RegistryRootReferenceSchema, logicalClosureHash: ContentHashSchema,
  resolverLocatorRootHash: LocatorRootReferenceSchema }).strict();
export const RecoveryCatalogSchema = bounded(z.array(RecoveryResolverSchema).superRefine((list, ctx) => {
  const seen = new Set();
  for (const r of list) { if (seen.has(r.registryRootHash)) issue(ctx, "INTEGRITY_ERROR", "Duplicate recovery registry root"); seen.add(r.registryRootHash); }
}));
export const LegacyAliasRecordSchema = z.object({ sourceStoreId: UUIDSchema, setKey: LegacySetKeySchema, documentId: DocumentIdSchema,
  sourceSealHash: ContentHashSchema, authorityEpoch: AuthorityEpochSchema, mode: z.enum(["A0","A1","A2","A3","A4","A5","A6","A7"]) }).strict();
export const LegacyAliasRegistrySchema = bounded(z.array(LegacyAliasRecordSchema).superRefine((list, ctx) => {
  const sources = new Set(), targets = new Set();
  for (const r of list) {
    const source = r.sourceStoreId + ":" + r.setKey;
    if (sources.has(source) || targets.has(r.documentId)) issue(ctx, "INTEGRITY_ERROR", "Legacy sets must map to distinct Document identities");
    sources.add(source); targets.add(r.documentId);
  }
}));
export const CommandLedgerKeySchema = z.object({ storeInstanceId: UUIDSchema, principalDigest: ContentHashSchema, commandId: CommandIdSchema }).strict();
export const CommandTombstoneSchema = bounded(z.object({ key: CommandLedgerKeySchema, payloadHash: ContentHashSchema, commitId: TransactionIdSchema,
  resultHash: ContentHashSchema, acceptedAt: TimestampSchema }).strict(), { maxBytes: 1024 });
export const CurrentEnvelopeSchema = z.object({ generation: RevisionSchema, rootHash: ContentHashSchema, commitId: TransactionIdSchema, checksum: ContentHashSchema }).strict();
export const parseCommitRoot = value => parse(CommitRootSchema, value);
export function assertCurrentEnvelope(rootInput, envelopeInput) {
  const root = parseCommitRoot(rootInput), envelope = parse(CurrentEnvelopeSchema, envelopeInput);
  const { generation, rootHash, commitId } = envelope;
  if (generation !== root.generation || commitId !== root.commitId || rootHash !== hashJson(root) || envelope.checksum !== hashJson({ generation, rootHash, commitId })) {
    throw new DocumentValidationError("INTEGRITY_ERROR", "CURRENT envelope differs from its root or checksum");
  }
  return root;
}
export function assertCommitIndexEntry(rootInput, entryInput) {
  const root = parseCommitRoot(rootInput), entry = parse(CommitIndexEntrySchema, entryInput);
  if (entry.commitId !== root.commitId || entry.generation !== root.generation || entry.registryRootHash !== root.roots.registry) throw new DocumentValidationError("INTEGRITY_ERROR", "Commit membership belongs to a different root");
  return entry;
}
