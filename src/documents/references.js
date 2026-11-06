import { z } from "zod";
import { DocumentIdSchema, SceneIdSchema, ObjectIdSchema, AnnotationIdSchema, LayerIdSchema, FrameIdSchema, UUIDSchema, StoredEntityIdSchema } from "./identity.js";
import { bounded, ContentHashSchema, RevisionSchema, parse, canonicalJson, DocumentValidationError, issue } from "./validation.js";

export const SceneRefSchema = z.object({ documentId: DocumentIdSchema, sceneId: SceneIdSchema }).strict();
const shape = { documentId: DocumentIdSchema, sceneId: SceneIdSchema };
const types = { object: ObjectIdSchema, annotation: AnnotationIdSchema, layer: LayerIdSchema, frame: FrameIdSchema };
export const RefSchema = z.discriminatedUnion("kind", Object.entries(types).map(([kind, id]) => z.object({ ...shape, kind: z.literal(kind), id }).strict()));
export const ObjectRefSchema = z.object({ ...shape, kind: z.literal("object"), id: ObjectIdSchema }).strict();
export const AnnotationRefSchema = z.object({ ...shape, kind: z.literal("annotation"), id: AnnotationIdSchema }).strict();
export const LogicalRevisionRefSchema = z.object({ storeInstanceId: UUIDSchema, entityId: StoredEntityIdSchema,
  revision: RevisionSchema, contentHash: ContentHashSchema }).strict();
export const refKey = ref => canonicalJson(parse(RefSchema, ref));
export const parseRef = value => parse(RefSchema, value);

// An allocation table, not an allocator or registry. UUIDs come from the
// caller's plan, so pure shadow/import mapping cannot draw new identities.
export const IdentityMappingSchema = bounded(z.object({
  namespace: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local-migration"), storeInstanceId: UUIDSchema }).strict(),
    z.object({ kind: z.literal("external-import"), bundleHash: ContentHashSchema }).strict(),
  ]),
  entries: z.array(z.object({ source: z.object({ schema: z.string().min(1).max(80), legacyKey: z.string().min(1).max(160),
    kind: z.enum(["object", "annotation", "layer", "frame"]), id: z.string().min(1).max(80) }).strict(), target: RefSchema }).strict()).max(15000),
}).strict().superRefine((m, ctx) => {
  const sources = new Set(), targets = new Set();
  for (const [i, e] of m.entries.entries()) {
    const source = canonicalJson(e.source), target = refKey(e.target);
    if (e.source.kind !== e.target.kind) issue(ctx, "INTEGRITY_ERROR", "Mapping kind changed", ["entries", i]);
    if (sources.has(source) || targets.has(target)) issue(ctx, "INTEGRITY_ERROR", "Duplicate source or target mapping", ["entries", i]);
    sources.add(source); targets.add(target);
  }
}));
export function lookupIdentity(mapping, source) {
  const table = parse(IdentityMappingSchema, mapping), key = canonicalJson(source);
  const found = table.entries.find(e => canonicalJson(e.source) === key);
  if (!found) throw new DocumentValidationError("UNRESOLVED_REFERENCE", "No explicit identity mapping");
  return structuredClone(found.target);
}
