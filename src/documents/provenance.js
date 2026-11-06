import { z } from "zod";
import { EventIdSchema, ExecutionIdSchema, LineageIdSchema } from "./identity.js";
import { RefSchema } from "./references.js";
import { bounded, ContentHashSchema, TimestampSchema, RevisionSchema, parse, issue, canonicalJson, DocumentValidationError } from "./validation.js";

export const ModuleIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,30}(\.[a-z0-9][a-z0-9-]{0,30}){2,5}$/);
const label = z.string().min(1).max(160);
const ModulePrincipal = z.object({ kind: z.literal("module"), moduleId: ModuleIdSchema,
  publisherFingerprint: ContentHashSchema.nullable(), ownershipLineageId: LineageIdSchema.nullable(),
  version: z.string().min(1).max(80).nullable(), packageDigest: ContentHashSchema.nullable() }).strict();
export const PrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), principalId: label }).strict(),
  z.object({ kind: z.literal("assistant"), principalId: label }).strict(), ModulePrincipal,
  z.object({ kind: z.literal("legacy-unknown"), sourceId: label }).strict(),
  z.object({ kind: z.literal("import"), sourceId: label }).strict(),
]);
export const OwnershipSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instance"), ownerId: label }).strict(),
  z.object({ kind: z.literal("module"), moduleId: ModuleIdSchema, publisherFingerprint: ContentHashSchema,
    ownershipLineageId: LineageIdSchema, adoptionEventId: EventIdSchema.optional() }).strict(),
  z.object({ kind: z.literal("unclaimed-module"), moduleId: ModuleIdSchema, historicalSourceHash: ContentHashSchema }).strict(),
]);
export const OriginalSourceSchema = z.object({ sourceSchema: z.string().min(1).max(80), payloadHash: ContentHashSchema,
  archiveRef: z.string().min(1).max(512) }).strict();
export const AnnotationProvenanceSchema = bounded(z.object({ author: z.enum(["user", "assistant", "module", "unknown"]),
  createdBy: PrincipalSchema, createdAt: TimestampSchema.nullable(), lastEditedBy: PrincipalSchema, lastEditedAt: TimestampSchema.nullable(),
  ownership: OwnershipSchema, grounding: z.string().min(1).max(80), editedByUser: z.boolean(),
  lastUserEditRevision: RevisionSchema.optional(), sourceTrust: z.enum(["local", "migrated-local", "imported-unverified"]),
  original: OriginalSourceSchema.optional(), derivedFrom: RefSchema.optional(),
}).strict().superRefine((p, ctx) => {
  const creator = p.createdBy, owner = p.ownership;
  const author = ["user", "assistant", "module"].includes(creator.kind) ? creator.kind : "unknown";
  if (p.author !== author) issue(ctx, "INTEGRITY_ERROR", "Author must be derived from immutable creator", ["author"]);
  if (p.sourceTrust === "local" && (p.createdAt === null || p.lastEditedAt === null)) issue(ctx, "INVALID_INPUT", "Local provenance needs server timestamps");
  if (p.sourceTrust === "imported-unverified" && (creator.kind !== "import" || owner.kind === "module" || !p.original)) {
    issue(ctx, "FORBIDDEN", "Imported data needs archived unknown authorship and cannot acquire active module ownership");
  }
  if (creator.kind === "module") {
    if (p.sourceTrust === "local" && (owner.kind !== "module" || [creator.publisherFingerprint, creator.ownershipLineageId, creator.version, creator.packageDigest].includes(null))) {
      issue(ctx, "INVALID_INPUT", "New module provenance needs complete lineage and ownership");
    }
    if (owner.kind === "module") {
      if (owner.moduleId !== creator.moduleId || ((!creator.publisherFingerprint || !creator.ownershipLineageId || owner.publisherFingerprint !== creator.publisherFingerprint || owner.ownershipLineageId !== creator.ownershipLineageId) && !owner.adoptionEventId)) {
        issue(ctx, "FORBIDDEN", "Module lineage differs without an explicit adoption reference");
      }
    } else if (owner.kind !== "unclaimed-module") issue(ctx, "FORBIDDEN", "Historical module requires an unclaimed or adopted module descriptor");
    if (owner.kind === "unclaimed-module" && owner.moduleId !== creator.moduleId) issue(ctx, "INTEGRITY_ERROR", "Unclaimed module identity differs");
  } else if (owner.kind === "module") issue(ctx, "FORBIDDEN", "Non-module creator cannot obtain active module ownership");
  if (p.lastUserEditRevision !== undefined && !p.editedByUser) issue(ctx, "INTEGRITY_ERROR", "User edit revision requires the sticky edit flag");
}));

export const GrantNameSchema = z.string().min(1).max(100).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);
const grants = z.array(GrantNameSchema).max(128).refine(g => new Set(g).size === g.length, "Duplicate grants");
// Trusted-record shape ONLY: parsing this never authenticates a caller.
export const ActorContextSchema = bounded(z.object({ principal: PrincipalSchema, authenticatedOwnerId: label,
  origin: z.enum(["app-user", "model-tool", "module-runtime", "migration"]), effectiveGrants: grants,
  targetScope: z.array(RefSchema).max(200), grantRevision: RevisionSchema, executionId: ExecutionIdSchema,
}).strict().superRefine((a, ctx) => {
  const expected = { "app-user": "user", "model-tool": "assistant", "module-runtime": "module" }[a.origin];
  if (expected && a.principal.kind !== expected) issue(ctx, "FORBIDDEN", "Origin and trusted principal differ");
  if (a.principal.kind === "module" && [a.principal.publisherFingerprint, a.principal.ownershipLineageId, a.principal.version, a.principal.packageDigest].includes(null)) {
    issue(ctx, "FORBIDDEN", "An executing module cannot have unknown historical lineage");
  }
}));
export const parseProvenance = value => parse(AnnotationProvenanceSchema, value);
export function intersectGrants(installation, capability, executionLease) {
  const [a, b, c] = [installation, capability, executionLease].map(v => parse(grants, v));
  return a.filter(g => b.includes(g) && c.includes(g)).sort();
}
export function assertCreatorUnchanged(before, after) {
  const a = parseProvenance(before), b = parseProvenance(after);
  for (const field of ["createdBy", "createdAt", "original", "sourceTrust"]) {
    if (canonicalJson(a[field] ?? null) !== canonicalJson(b[field] ?? null)) throw new DocumentValidationError("FORBIDDEN", "Immutable provenance changed", [field]);
  }
  if (a.editedByUser && !b.editedByUser) throw new DocumentValidationError("FORBIDDEN", "User edit audit cannot be cleared");
  if (a.lastUserEditRevision !== undefined && (b.lastUserEditRevision === undefined || b.lastUserEditRevision < a.lastUserEditRevision)) throw new DocumentValidationError("FORBIDDEN", "User edit audit revision cannot move backwards");
  return b;
}

// Boundary profile for already-demoted external records, never self-selected by wire input.
export const ImportedProvenanceSchema = AnnotationProvenanceSchema.refine(p => p.sourceTrust === "imported-unverified", "External records must use the imported trust profile");
