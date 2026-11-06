// Inactive wire contracts. No command dispatcher or privilege activation.
import { z } from "zod";
import { DocumentIdSchema, SceneIdSchema, RequestIdSchema, LayerIdSchema, AnnotationIdSchema } from "./identity.js";
import { AnchorSchema, AnnotationStyleSchema, GeometrySchemas } from "./schema.js";
import { bounded, RevisionSchema, ContentHashSchema, parse } from "./validation.js";
export const AnchorInputSchema = z.discriminatedUnion("space", AnchorSchema.options.map(s => s.shape.space.value === "object" ? s.omit({lastResolved:true}) : s));
const findingInput = z.object({ note: z.string().max(500).optional(), status: z.enum(["inspected","uncertain"]).optional(),
  confidence: z.enum(["high","medium","low"]).optional(), ambiguities: z.array(z.string().max(120)).max(4).optional() }).strict();
const createVariants = Object.entries(GeometrySchemas).map(([type, geometry]) => z.object({ op: z.literal("annotation.create"), sceneId: SceneIdSchema,
  type: z.literal(type), geometry, anchor: AnchorInputSchema, layerId: LayerIdSchema.optional(), layer: z.object({ name: z.string().trim().min(1).max(40) }).strict().optional(),
  style: AnnotationStyleSchema.optional(), label: z.string().max(64).optional(), finding: findingInput.optional(),
}).strict().refine(o => Boolean(o.layerId) !== Boolean(o.layer), "Choose exactly one layerId or layer descriptor"));
export const AnnotationCreateInputSchema = bounded(z.union(createVariants));
export const AnnotationUpdateInputSchema = bounded(z.object({ op: z.literal("annotation.update"), sceneId: SceneIdSchema, id: AnnotationIdSchema,
  expectedAnnotationRevision: RevisionSchema, patch: z.object({ geometry: z.union(Object.values(GeometrySchemas)).optional(), anchor: AnchorInputSchema.optional(),
    style: AnnotationStyleSchema.optional(), label: z.string().max(64).optional(), finding: findingInput.optional() }).strict().refine(p => Object.keys(p).length > 0, "Empty patch"), previewHash: ContentHashSchema.optional(),
}).strict().refine(o => !o.patch.anchor || o.previewHash, "Reanchor requires a preview hash"));
export const EditDocumentInputSchema = bounded(z.object({ requestId: RequestIdSchema, documentId: DocumentIdSchema, expectedRevision: RevisionSchema,
  operations: z.array(z.union([AnnotationCreateInputSchema, AnnotationUpdateInputSchema,
    z.object({ op: z.literal("annotation.delete"), sceneId: SceneIdSchema, id: AnnotationIdSchema, expectedAnnotationRevision: RevisionSchema }).strict(),
  ])).min(1).max(64),
}).strict());
export const parseEditDocumentInput = value => parse(EditDocumentInputSchema, value);
export function parseAnnotationPatch(input, storedType) {
  const update = parse(AnnotationUpdateInputSchema, input);
  if (update.patch.geometry) parse(GeometrySchemas[storedType] ?? z.never(), update.patch.geometry);
  return update;
}
