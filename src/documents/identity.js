import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parse, ContentHashSchema, DocumentValidationError } from "./validation.js";

export const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const UUIDSchema = z.string().regex(new RegExp("^" + UUID_PATTERN + "$"));
const typed = prefix => z.string().regex(new RegExp("^" + prefix + ":" + UUID_PATTERN + "$"));
export const DocumentIdSchema = typed("doc"), SceneIdSchema = typed("scene");
export const ViewportIdSchema = typed("vp"), PanelIdSchema = typed("panel");
export const BindingIdSchema = typed("bind"), RequestIdSchema = typed("req"), CommandIdSchema = typed("cmd");
export const TransactionIdSchema = typed("tx"), EventIdSchema = typed("event");
export const LineageIdSchema = typed("lineage"), ExecutionIdSchema = typed("exec");
export const NewObjectIdSchema = typed("obj"), NewAnnotationIdSchema = typed("ann"), NewLayerIdSchema = typed("layer");
export const LegacyObjectIdSchema = z.string().regex(/^o[1-9][0-9]{0,5}$/);
export const LegacyLayerIdSchema = z.string().regex(/^L[1-9][0-9]{0,5}$/);
// Legacy marks are opaque local identities; Ref.kind and Scene scope keep
// them separate even when their spelling resembles another entity type.
export const LegacyAnnotationIdSchema = z.string().min(1).max(64);
export const ObjectIdSchema = z.union([NewObjectIdSchema, LegacyObjectIdSchema]);
export const AnnotationIdSchema = z.union([NewAnnotationIdSchema, LegacyAnnotationIdSchema]);
export const LayerIdSchema = z.union([NewLayerIdSchema, LegacyLayerIdSchema]);
// Frames were descriptors, not globally allocated entities in Phase 0.2.
export const FrameIdSchema = z.string().min(1).max(80).refine(s => s !== "document", "The document frame name is reserved");
export const LegacyImageIdSchema = z.string().regex(/^img:[0-9a-f]{16}$/);
export const LegacySetKeySchema = z.string().regex(/^img:[0-9a-f]{16}(?:#c[0-9a-f]{8,16})?$/);
export const AssetIdSchema = z.string().regex(/^asset:sha256:[0-9a-f]{64}$/);
export const AssetRefSchema = z.object({ assetId: AssetIdSchema, legacyImageId: LegacyImageIdSchema.optional() }).strict()
  .refine(a => !a.legacyImageId || a.legacyImageId.slice(4) === a.assetId.slice(13, 29), "Legacy alias must match the full asset hash prefix");

const schemas = Object.freeze({ doc: DocumentIdSchema, scene: SceneIdSchema, vp: ViewportIdSchema, panel: PanelIdSchema,
  obj: NewObjectIdSchema, ann: NewAnnotationIdSchema, layer: NewLayerIdSchema, bind: BindingIdSchema,
  req: RequestIdSchema, cmd: CommandIdSchema, tx: TransactionIdSchema, event: EventIdSchema, lineage: LineageIdSchema, exec: ExecutionIdSchema });
export function createId(kind) {
  if (typeof kind !== "string" || !Object.hasOwn(schemas, kind)) throw new DocumentValidationError("INVALID_INPUT", "Unknown identity namespace");
  return kind + ":" + randomUUID();
}
export function parseId(kind, value) {
  if (typeof kind !== "string" || !Object.hasOwn(schemas, kind)) throw new DocumentValidationError("INVALID_INPUT", "Unknown identity namespace");
  return parse(schemas[kind], value);
}
export const parseAssetRef = value => parse(AssetRefSchema, value);
export const normalizeRequestId = value => "cmd:" + parse(RequestIdSchema, value).slice(4);
export { ContentHashSchema };

// Existing non-document store identities are references only, with no new integration.
export const StoredEntityIdSchema = z.union([DocumentIdSchema, z.string().regex(/^nb:[0-9a-f]{12}$/), z.string().regex(/^(?:sf|ws):[0-9a-f]{16}$/)]);
