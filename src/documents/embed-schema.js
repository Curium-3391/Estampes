import { z } from "zod";
import { ObjectIdSchema, BindingIdSchema, LayerIdSchema } from "./identity.js";
import { SceneRefSchema, ObjectRefSchema } from "./references.js";
import { AnnotationProvenanceSchema } from "./provenance.js";
import { FiniteSchema as n, bounded, RevisionSchema, ContentHashSchema, issue, parse, DocumentValidationError } from "./validation.js";

export const AffineMatrixSchema = z.array(n).length(9).superRefine((m, ctx) => {
  if (m.length !== 9) return;
  const [a,b,tx,d,e,ty] = m, det = a*e-b*d;
  if (m[6] !== 0 || m[7] !== 0 || m[8] !== 1 || det === 0 || !Number.isFinite(det)) {
    issue(ctx, "NON_INVERTIBLE", "Expected an invertible affine matrix"); return;
  }
  const inverse = [e/det,-b/det,(b*ty-e*tx)/det,-d/det,a/det,(d*tx-a*ty)/det,0,0,1];
  const norm = v => Math.max(...[0,3,6].map(i => Math.abs(v[i])+Math.abs(v[i+1])+Math.abs(v[i+2])));
  const condition = norm(m)*norm(inverse);
  if (!inverse.every(Number.isFinite) || !Number.isFinite(condition) || condition > 1e12) issue(ctx, "NON_INVERTIBLE", "Matrix condition exceeds 1e12");
});
export const ClipRegionSchema = z.object({ space: z.literal("child-document"), x: n.min(0), y: n.min(0), x2: n, y2: n }).strict()
  .refine(r => r.x2 > r.x && r.y2 > r.y, "Clip must have positive area");
export const EmbedBindingSchema = z.object({ id: BindingIdSchema, kind: z.literal("embed"), parentObject: ObjectRefSchema,
  child: SceneRefSchema, mode: z.enum(["live", "snapshot"]), sourceRevision: RevisionSchema,
  status: z.enum(["fresh", "unresolved", "unavailable", "archived", "denied"]) }).strict();
export const EmbeddedDocumentObjectSchema = bounded(z.object({ type: z.literal("embedded-document"), id: ObjectIdSchema,
  revision: RevisionSchema, parent: SceneRefSchema, layerId: LayerIdSchema, visibility: z.enum(["public", "scratch"]), locked: z.boolean(),
  provenance: AnnotationProvenanceSchema, props: z.object({ bindingId: BindingIdSchema, child: SceneRefSchema,
    mode: z.enum(["live", "snapshot"]), sourceRevision: RevisionSchema,
    snapshotOrigin: SceneRefSchema.extend({ revision: RevisionSchema, contentHash: ContentHashSchema }).strict().optional(),
    localToDocument: AffineMatrixSchema, clipRegion: ClipRegionSchema, missingTargetPolicy: z.literal("placeholder"), defaultEditTarget: z.literal("parent"),
  }).strict(),
}).strict().superRefine((o, ctx) => {
  if (o.parent.documentId === o.props.child.documentId) issue(ctx, "INTEGRITY_ERROR", "An embed cannot target its owning Document");
  if (o.props.mode === "snapshot" && (!o.props.snapshotOrigin || o.props.child.documentId === o.props.snapshotOrigin.documentId)) {
    issue(ctx, "INTEGRITY_ERROR", "Snapshot requires an independent editable child and captured origin");
  }
  if (o.props.mode === "snapshot" && o.props.snapshotOrigin && o.props.snapshotOrigin.revision !== o.props.sourceRevision) issue(ctx,"INTEGRITY_ERROR","Snapshot origin and capture revisions differ");
}));
export function assertEmbedBinding(object, binding) {
  const o = parse(EmbeddedDocumentObjectSchema, object), b = parse(EmbedBindingSchema, binding);
  const parent = b.parentObject;
  if (parent.documentId !== o.parent.documentId || parent.sceneId !== o.parent.sceneId || parent.id !== o.id || b.id !== o.props.bindingId ||
    b.child.documentId !== o.props.child.documentId || b.child.sceneId !== o.props.child.sceneId || b.mode !== o.props.mode || b.sourceRevision !== o.props.sourceRevision) {
    throw new DocumentValidationError("INTEGRITY_ERROR", "Embed object and canonical binding differ");
  }
  return o;
}
export const SnapshotEligibilitySchema = bounded(z.object({ supported: z.boolean(), reason: z.literal("NESTED_SNAPSHOT_UNSUPPORTED").optional(),
  source: SceneRefSchema, sourceRevision: RevisionSchema, sourceContentHash: ContentHashSchema.optional(), bindingGraphHash: ContentHashSchema,
  blockers: z.array(ObjectRefSchema).max(200), redactedBlockerCount: z.number().int().min(0).max(200),
  alternatives: z.array(z.enum(["live", "open-source", "link-source", "explicit-source-edit", "editable-bundle"])).min(1).max(5),
}).strict().superRefine((v, ctx) => {
  if ((v.supported && !v.sourceContentHash) || (v.redactedBlockerCount && v.sourceContentHash)) issue(ctx, "FORBIDDEN", "Incorrectly exposed or missing source hash");
  if (v.blockers.some(b => b.documentId !== v.source.documentId || b.sceneId !== v.source.sceneId)) issue(ctx, "INTEGRITY_ERROR", "Blocker outside the source Scene");
  if (v.supported ? (v.reason !== undefined || v.blockers.length+v.redactedBlockerCount !== 0) : (v.reason !== "NESTED_SNAPSHOT_UNSUPPORTED" || v.blockers.length+v.redactedBlockerCount === 0)) issue(ctx, "INTEGRITY_ERROR", "Inconsistent snapshot eligibility");
}));
export const SnapshotRefusalSchema = bounded(z.object({ isError: z.literal(true), structuredContent: z.object({ kind: z.literal("estampes.document_error"),
  code: z.literal("BLOCKED_DEPENDENCY"), message: z.string().min(1).max(300), retryable: z.literal(false),
  details: z.object({ reason: z.literal("NESTED_SNAPSHOT_UNSUPPORTED"), operation: z.enum(["embed.create.snapshot", "embed.detach", "embed.freeze", "parent.deep-copy", "graph-separation.snapshot"]), snapshotEligibility: SnapshotEligibilitySchema }).strict(),
}).strict() }).strict().refine(e => !e.structuredContent.details.snapshotEligibility.supported, "Refusal cannot report supported"));
