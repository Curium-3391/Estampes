// Versioned read models. Imported nowhere by existing tools or stores.
import { z } from "zod";
import { OBJECT_TYPES, COLOR_NAMES } from "../scene/objects.js";
import { compileExpression } from "../scene/expression.js";
import { DocumentIdSchema, SceneIdSchema, AnnotationIdSchema, ObjectIdSchema, LayerIdSchema, FrameIdSchema,
  BindingIdSchema, EventIdSchema, CommandIdSchema, TransactionIdSchema, AssetRefSchema, LegacySetKeySchema } from "./identity.js";
import { RefSchema, ObjectRefSchema } from "./references.js";
import { AnnotationProvenanceSchema, PrincipalSchema } from "./provenance.js";
import { AffineMatrixSchema, EmbeddedDocumentObjectSchema, EmbedBindingSchema } from "./embed-schema.js";
import { bounded, jsonSchema, RevisionSchema, TimestampSchema, ContentHashSchema, FiniteSchema as n, issue, parse, canonicalJson, DocumentValidationError } from "./validation.js";

export const ColorSchema = z.union([z.enum(Object.keys(COLOR_NAMES)), z.string().regex(/^#[0-9a-fA-F]{6}$/)]);
export const PointSchema = z.object({ x: n, y: n }).strict();
const box = { x: n, y: n, x2: n, y2: n };
export const GeometrySchemas = {
  point: PointSchema,
  rect: z.object(box).strict(), arrow: z.object(box).strict(),
  polyline: z.object({ points: z.array(PointSchema).min(2).max(128), smooth: z.boolean().optional(), closed: z.boolean().optional(),
    x: n.optional(), y: n.optional(), x2: n.optional(), y2: n.optional() }).strict()
    .refine(g => [g.x,g.y,g.x2,g.y2].filter(v => v !== undefined).length % 4 === 0, "Optional stroke bounds must be complete"),
};
export const AnnotationStyleSchema = z.object({ color: ColorSchema.optional(), size: z.enum(["fine","thin","medium","thick"]).optional(), pen: z.enum(["pen","highlighter"]).optional() }).strict();
export const AnchorSchema = z.discriminatedUnion("space", [
  z.object({ space: z.literal("document") }).strict(),
  z.object({ space: z.literal("image-normalized"), asset: AssetRefSchema, sourceToDocument: AffineMatrixSchema }).strict(),
  z.object({ space: z.literal("world"), frameRef: z.object({ documentId: DocumentIdSchema, sceneId: SceneIdSchema, kind: z.literal("frame"), id: FrameIdSchema }).strict() }).strict(),
  z.object({ space: z.literal("object"), objectRef: ObjectRefSchema,
    attachment: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("function-x"), x: n, offsetDu: PointSchema }).strict(),
      z.object({ kind: z.literal("local"), localToDocument: AffineMatrixSchema }).strict(),
    ]), onMissing: z.literal("retain-invalid"), lastResolved: z.object({ originDu: z.array(n).length(2), localToDocument: AffineMatrixSchema,
      geometryHash: ContentHashSchema, revision: RevisionSchema }).strict().optional(),
  }).strict(),
]);
export const EvidenceSchema = z.object({ observer: z.enum(["model","tool","user"]), kind: z.string().min(1).max(80), says: z.string().min(1).max(160),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("asset"), asset: AssetRefSchema, region: z.array(n.min(0).max(1)).length(4).optional() }).strict(),
    z.object({ kind: z.literal("document"), ref: RefSchema, revision: RevisionSchema, region: z.array(n).length(4).optional() }).strict(),
  ]), applicability: z.enum(["current","stale","historical"]).optional(), original: jsonSchema({ maxBytes: 4*1024*1024 }).optional(),
}).strict();
export const ClaimContextSchema = z.object({ claimId: EventIdSchema, claimRevision: RevisionSchema, geometryHash: ContentHashSchema, anchorHash: ContentHashSchema,
  sourceRevisionVector: z.array(z.object({ ref: RefSchema, revision: RevisionSchema, semanticHash: ContentHashSchema }).strict()).max(200) }).strict();
export const VerificationSchema = z.object({ historicalState: z.enum(["unverified","user-confirmed","user-rejected","independently-verified"]),
  currentState: z.enum(["unverified","user-confirmed","user-rejected","independently-verified","stale"]), reason: z.string().max(300).optional(), contextHash: ContentHashSchema }).strict();
export const FindingSchema = z.object({ note: z.string().max(500).optional(), status: z.string().max(80).optional(),
  confidence: z.enum(["high","medium","low"]).optional(), evidence: z.array(EvidenceSchema).max(6).optional(),
  ambiguities: z.array(z.string().max(120)).max(4).optional(), review: z.enum(["confirmed","rejected"]).optional(), reviewReason: z.string().max(300).optional(),
  previouslyRejected: jsonSchema({ maxBytes: 4*1024*1024 }).optional(), findingUpdatedAt: n.optional(), claimContext: ClaimContextSchema.optional(), verification: VerificationSchema.optional(),
}).strict();
const annotationBase = { id: AnnotationIdSchema, revision: RevisionSchema, layerId: LayerIdSchema,
  anchor: AnchorSchema, style: AnnotationStyleSchema, label: z.string().max(64).optional(), provenance: AnnotationProvenanceSchema,
  userEditGuard: z.object({ guardRevision: RevisionSchema, fields: z.array(z.string().min(1).max(100)).min(1).max(64), contextHash: ContentHashSchema }).strict().optional(),
  finding: FindingSchema.optional(), stroke: z.object({ order: z.number().int().min(0).optional(), relativeStartMs: n.min(0).optional(), relativeEndMs: n.min(0).optional(), pointerType: z.enum(["mouse","pen","touch"]).optional() }).strict().optional(),
  intentEventIds: z.array(EventIdSchema).max(200),
};
export const AnnotationSchema = bounded(z.discriminatedUnion("type", Object.entries(GeometrySchemas).map(([type, geometry]) => z.object({ ...annotationBase, type: z.literal(type), geometry }).strict())))
  .superRefine((a, ctx) => {
    if (a.anchor.space === "image-normalized") {
      const points = a.type === "polyline" ? [...a.geometry.points, ...(a.geometry.x === undefined ? [] : [{x:a.geometry.x,y:a.geometry.y},{x:a.geometry.x2,y:a.geometry.y2}])] : [{ x: a.geometry.x, y: a.geometry.y }, ...(a.geometry.x2 === undefined ? [] : [{ x: a.geometry.x2, y: a.geometry.y2 }])];
      if (points.some(p => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) issue(ctx, "OUT_OF_BOUNDS", "Image-normalized geometry is outside the image");
    }
    if (a.provenance.sourceTrust === "imported-unverified" && a.finding?.verification && !["unverified","stale"].includes(a.finding.verification.currentState)) issue(ctx, "FORBIDDEN", "Imported evidence cannot be active verification");
    if (a.provenance.lastUserEditRevision > a.revision || a.userEditGuard?.guardRevision > a.revision) issue(ctx, "INTEGRITY_ERROR", "Annotation audit revision is in the future");
  });

// Scene Objects keep their pre-existing tool-evidence domain as well as
// typed visual Evidence. A module name is historical source data, not a grant.
export const SceneObjectEvidenceSchema = z.union([EvidenceSchema, z.object({ says: z.string().min(1).max(160),
  region: z.array(n.min(0).max(1)).length(4).optional(), observer: z.enum(["tool","user","assistant"]), source: z.string().min(1).max(160).optional(),
}).strict()]);
const objectBase = { id: ObjectIdSchema, revision: RevisionSchema, layerId: LayerIdSchema, label: z.string().max(64).optional(),
  visibility: z.enum(["public","scratch"]), provenance: AnnotationProvenanceSchema, evidence: z.array(SceneObjectEvidenceSchema).max(6).optional(), coordinateFrameId: FrameIdSchema.optional() };
// Reuse strict existing semantic props, never call mutating operations or the
// label-normalizing legacy validateProps helper on read records.
const objectVariants = Object.entries(OBJECT_TYPES).map(([type, spec]) => z.object({ ...objectBase, type: z.literal(type),
  props: type === "image" ? z.object({ asset: AssetRefSchema, region: spec.props.shape.region, source: z.string().max(100).optional() }).strict() : spec.props,
}).strict());
export const SceneObjectSchema = bounded(z.union([...objectVariants, EmbeddedDocumentObjectSchema])).superRefine((o, ctx) => {
  if (o.type === "function-plot") {
    try { compileExpression(o.props.expression); } catch { issue(ctx, "INVALID_INPUT", "Invalid function expression", ["props","expression"]); }
  }
});
export const CoordinateFrameSchema = z.discriminatedUnion("kind", [
  z.object({ id: FrameIdSchema, kind: z.literal("axes"), ownerObjectId: ObjectIdSchema }).strict(),
  z.object({ id: FrameIdSchema, kind: z.literal("affine"), parentFrameId: z.string().min(1).max(80), localToParent: AffineMatrixSchema }).strict(),
]);
// A default name the server made up, kept as a catalog key and its parameters
// next to the literal `name` (RFC docs/rfc/i18n T5, D6). The literal stays the
// name of record; these only let a viewer say it in their own language. The
// schema bounds the shape; which keys exist is the i18n catalog's business.
const NameKeySchema = z.string().regex(/^name\.[A-Za-z0-9.]{1,60}$/);
const NameParamKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,23}$/);
const NameScalarSchema = z.union([z.string().max(120), n]);
const NameParamsSchema = z.record(NameParamKeySchema, z.union([NameScalarSchema,
  z.object({ name: z.string().max(120), nameKey: NameKeySchema.optional(), nameParams: z.record(NameParamKeySchema, NameScalarSchema).optional() }).strict()]));
export const LayerSchema = z.object({ id: LayerIdSchema, author: z.enum(["user","assistant","module","unknown"]), name: z.string().min(1).max(40).refine(s => s === s.trim(), "Layer name must be trimmed"),
  nameKey: NameKeySchema.optional(), nameParams: NameParamsSchema.optional(),
  module: z.string().min(1).max(160).optional(), opacity: n.min(0).max(1), visible: z.boolean(), locked: z.boolean(),
  content: z.array(z.discriminatedUnion("kind", [z.object({ kind: z.literal("object"), id: ObjectIdSchema }).strict(), z.object({ kind: z.literal("annotation"), id: AnnotationIdSchema }).strict()])),
}).strict();
export const RelationBindingSchema = z.object({ id: BindingIdSchema, kind: z.literal("relation"), from: RefSchema, to: RefSchema,
  label: z.string().max(64).optional(), finding: FindingSchema.optional(), original: jsonSchema({ maxBytes: 4*1024*1024 }).optional(),
  status: z.enum(["fresh","unresolved","unavailable","removed"]).optional(),
}).strict();
export const CasPlotBindingSchema = z.object({ id: BindingIdSchema, kind: z.literal("cas-plot"), source: z.object({ notebookId: z.string().regex(/^nb:[0-9a-f]{12}$/), cellId: z.string().regex(/^cell:[0-9a-f]{12}$/), resultId: z.string().min(1).max(80), cellRevision: RevisionSchema, environmentHash: ContentHashSchema }).strict(),
  target: ObjectRefSchema, lastApplied: z.object({ objectRevision: RevisionSchema, expressionHash: ContentHashSchema, domainHash: ContentHashSchema, resultId: z.string().min(1).max(80) }).strict(),
  policy: z.literal("pause-on-user-edit"), state: z.enum(["fresh","stale","recomputing","conflict","removed","unavailable","unresolved","error"]), reason: z.string().max(300).optional(),
}).strict();
export const ReferenceBindingSchema = z.union([RelationBindingSchema, CasPlotBindingSchema, EmbedBindingSchema]);
const HistoryEntrySchema = z.object({ commandId: CommandIdSchema, actor: PrincipalSchema, affectedRefs: z.array(RefSchema).max(5200),
  beforeAfterHashes: z.array(z.object({ ref: RefSchema, before: ContentHashSchema.nullable(), after: ContentHashSchema.nullable() }).strict()).max(5200),
  inverse: jsonSchema(), forward: jsonSchema(), baseRevision: RevisionSchema, appliedRevision: RevisionSchema,
}).strict();
export const SceneSchema = bounded(z.object({ id: SceneIdSchema, documentId: DocumentIdSchema, revision: RevisionSchema,
  extent: z.object({ width: n.positive().max(1e9), height: n.positive().max(1e9), unit: z.literal("du") }).strict(),
  background: z.discriminatedUnion("kind", [z.object({ kind: z.literal("transparent") }).strict(), z.object({ kind: z.literal("solid"), color: ColorSchema }).strict(), z.object({ kind: z.literal("asset"), asset: AssetRefSchema, sourceToDocument: AffineMatrixSchema }).strict()]),
  layers: z.array(LayerSchema), objects: z.array(SceneObjectSchema).max(200), annotations: z.array(AnnotationSchema).max(5000), frames: z.array(CoordinateFrameSchema),
  gestureDecisions: z.array(z.object({ id: z.string().min(1).max(80), memberRefs: z.array(RefSchema).min(2).max(8), verdict: z.enum(["user-confirmed","user-rejected"]), sourceEventId: EventIdSchema.optional(), original: jsonSchema().optional() }).strict()),
  rejections: z.array(jsonSchema()).max(200), interactionEvents: z.array(z.object({ eventId: EventIdSchema, schema: z.literal("estampes.interaction/1"), payloadHash: ContentHashSchema }).strict()),
  undo: z.object({ entries: z.array(HistoryEntrySchema).max(60), legacyArchive: z.string().min(1).max(512).optional() }).strict(),
  tombstones: z.array(z.object({ ref: RefSchema, deletedAt: TimestampSchema, deletedInCommit: TransactionIdSchema, priorRevision: RevisionSchema, reason: z.string().max(300) }).strict()),
}).strict()).superRefine(validateScene);

function validateScene(s, ctx) {
  const maps = Object.fromEntries([['layer',s.layers],['object',s.objects],['annotation',s.annotations],['frame',s.frames]].map(([kind, list]) => {
    const map = new Map();
    for (const e of list) { if (map.has(e.id)) issue(ctx, "INTEGRITY_ERROR", "Duplicate " + kind + " identity"); map.set(e.id, e); }
    return [kind, map];
  }));
  const removed = new Set();
  for (const t of s.tombstones) {
    const r=t.ref,key=canonicalJson(r);
    if (r.documentId !== s.documentId || r.sceneId !== s.id || maps[r.kind].has(r.id) || removed.has(key)) issue(ctx,"INTEGRITY_ERROR","Tombstone conflicts with its Scene or active entity");
    removed.add(key);
  }
  const seen = new Set();
  for (const l of s.layers) for (const r of l.content) {
    const key = r.kind + ":" + r.id, entity = maps[r.kind].get(r.id);
    if (!entity || entity.layerId !== l.id || seen.has(key)) issue(ctx, "INTEGRITY_ERROR", "Layer membership differs from its content");
    seen.add(key);
  }
  for (const kind of ["object","annotation"]) for (const e of maps[kind].values()) if (!seen.has(kind+":"+e.id)) issue(ctx, "INTEGRITY_ERROR", "Entity has no unique layer membership");
  const localRef = (ref, expected) => {
    if (ref.documentId !== s.documentId || ref.sceneId !== s.id || (expected && ref.kind !== expected)) { issue(ctx, "INTEGRITY_ERROR", "Anchor or gesture reference is outside its Scene or kind"); return null; }
    const target = maps[ref.kind].get(ref.id);
    if (!target && removed.has(canonicalJson(ref))) return { removed:true };
    if (!target) issue(ctx, "UNRESOLVED_REFERENCE", "Missing local reference target");
    return target;
  };
  for (const o of s.objects) {
    if (o.type === "embedded-document") {
      if (o.parent.documentId !== s.documentId || o.parent.sceneId !== s.id) issue(ctx, "INTEGRITY_ERROR", "Embed has a different parent owner");
      continue;
    }
    if (o.coordinateFrameId && !maps.frame.has(o.coordinateFrameId)) issue(ctx, "UNRESOLVED_REFERENCE", "Missing object coordinate frame");
    if (o.type === "function-plot" || (o.type === "shape" && o.props.space === "frame")) {
      if (maps.object.get(o.props.frame)?.type !== "axes-2d") issue(ctx, "UNRESOLVED_REFERENCE", "Object frame must be local axes");
      const descriptor=maps.frame.get(o.coordinateFrameId);
      if (descriptor && (descriptor.kind !== "axes" || descriptor.ownerObjectId !== o.props.frame)) issue(ctx,"INTEGRITY_ERROR","Object frame envelope differs from canonical axes association");
    }
  }
  for (const f of s.frames) {
    if (f.kind === "axes" && maps.object.get(f.ownerObjectId)?.type !== "axes-2d") issue(ctx, "UNRESOLVED_REFERENCE", "Axes frame owner is missing or has the wrong type");
    if (f.kind === "affine" && f.parentFrameId !== "document" && !maps.frame.has(f.parentFrameId)) issue(ctx, "UNRESOLVED_REFERENCE", "Missing parent frame");
  }
  const complete = new Set();
  for (const f of s.frames) {
    let cursor = f.id; const path = new Set();
    while (cursor !== "document" && maps.frame.has(cursor) && !complete.has(cursor)) {
      if (path.has(cursor)) { issue(ctx, "INTEGRITY_ERROR", "Cyclic coordinate frames"); break; }
      path.add(cursor); const next = maps.frame.get(cursor); cursor = next.kind === "affine" ? next.parentFrameId : "document";
    }
    for (const id of path) complete.add(id);
  }
  for (const a of s.annotations) {
    if (a.anchor.space === "world") { const f=localRef(a.anchor.frameRef,"frame");if (f && !f.removed && f.kind !== "axes") issue(ctx,"UNRESOLVED_REFERENCE","World annotation needs an axes frame"); }
    if (a.anchor.space === "object") {
      const target = localRef(a.anchor.objectRef, "object");
      if (a.anchor.attachment.kind === "function-x" && target && !target.removed && target.type !== "function-plot") issue(ctx, "UNRESOLVED_REFERENCE", "Function attachment needs a function plot");
    }
  }
  const events=new Set(),gestures=new Set();
  for (const e of s.interactionEvents) { if(events.has(e.eventId)) issue(ctx,"INTEGRITY_ERROR","Duplicate interaction event identity");events.add(e.eventId); }
  for (const a of s.annotations) {
    if(new Set(a.intentEventIds).size !== a.intentEventIds.length) issue(ctx,"INTEGRITY_ERROR","Duplicate annotation intent reference");
    for(const eventId of a.intentEventIds) if(!events.has(eventId)) issue(ctx,"UNRESOLVED_REFERENCE","Missing interaction event");
  }
  for (const g of s.gestureDecisions) {
    if(gestures.has(g.id)) issue(ctx,"INTEGRITY_ERROR","Duplicate gesture decision identity");gestures.add(g.id);
    if(g.sourceEventId && !events.has(g.sourceEventId)) issue(ctx,"UNRESOLVED_REFERENCE","Missing gesture source event");
    const members = new Set();
    for (const r of g.memberRefs) { localRef(r, "annotation"); const key = canonicalJson(r); if (members.has(key)) issue(ctx, "INTEGRITY_ERROR", "Duplicate gesture member"); members.add(key); }
  }
}

const ExtensionsSchema = z.record(z.string().regex(/^[a-z][a-z0-9.-]*:[A-Za-z0-9._-]+$/), jsonSchema());
export const VisualDocumentSchema = bounded(z.object({ schema: z.literal("estampes.document/1"), id: DocumentIdSchema,
  kind: z.enum(["image","graph"]), title: z.string().max(80), revision: RevisionSchema, state: z.enum(["active","archived"]), persistence: z.enum(["memory","durable"]),
  createdAt: TimestampSchema, updatedAt: TimestampSchema, defaultSceneId: SceneIdSchema, scenes: z.array(SceneSchema).min(1).max(24),
  bindings: z.array(ReferenceBindingSchema), annotationSupport: z.literal("shared-v1"), provenance: z.object({ createdBy: z.enum(["user","assistant","import","migration"]), legacySetKey: LegacySetKeySchema.optional(), importedFrom: z.string().max(160).optional() }).strict(),
  extensions: ExtensionsSchema.optional(),
}).strict()).superRefine((d, ctx) => {
  const scenes = new Set(); let objects = 0, annotations = 0, explicitPoints = 0;
  for (const s of d.scenes) {
    if (scenes.has(s.id) || s.documentId !== d.id) issue(ctx, "INTEGRITY_ERROR", "Scene must have one unique Document owner");
    scenes.add(s.id); objects += s.objects.length; annotations += s.annotations.length;
    explicitPoints += s.objects.reduce((sum,o) => sum + (o.type === "shape" ? o.props.points?.length ?? 0 : 0), 0);
  }
  if (!scenes.has(d.defaultSceneId)) issue(ctx, "UNRESOLVED_REFERENCE", "Default Scene is missing");
  if (objects > 200 || annotations > 5000 || explicitPoints > 60000) issue(ctx, "LIMIT", "Document aggregate content limit exceeded");
  const bindings = new Set();
  for (const b of d.bindings) { if (bindings.has(b.id)) issue(ctx, "INTEGRITY_ERROR", "Duplicate binding identity"); bindings.add(b.id); }
  for (const s of d.scenes) for (const o of s.objects) if (o.type === "embedded-document") {
    const b = d.bindings.find(b => b.id === o.props.bindingId);
    if (!b || b.kind !== "embed" || b.parentObject.documentId !== d.id || b.parentObject.sceneId !== s.id || b.parentObject.id !== o.id || b.child.documentId !== o.props.child.documentId || b.child.sceneId !== o.props.child.sceneId || b.mode !== o.props.mode || b.sourceRevision !== o.props.sourceRevision) issue(ctx, "INTEGRITY_ERROR", "Canonical embed binding differs from object");
  }
});
export const parseVisualDocument = value => parse(VisualDocumentSchema, value);
export function parseDocumentJson(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 64*1024*1024) throw new DocumentValidationError("LIMIT", "Document JSON byte limit exceeded");
  let value; try { value = JSON.parse(text); } catch { throw new DocumentValidationError("INVALID_INPUT", "Malformed document JSON"); }
  return parseVisualDocument(value);
}
