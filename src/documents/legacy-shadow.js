// Read-only JSON projection. No stores, writes, random IDs, clocks or renderers.
import { z } from "zod";
import { OBJECT_TYPE_NAMES } from "../scene/objects.js";
import { DocumentIdSchema, SceneIdSchema, UUIDSchema, AssetRefSchema, NewLayerIdSchema, BindingIdSchema } from "./identity.js";
import { AnnotationRefSchema, IdentityMappingSchema, lookupIdentity } from "./references.js";
import { ModuleIdSchema } from "./provenance.js";
import { AffineMatrixSchema } from "./embed-schema.js";
import { VisualDocumentSchema } from "./schema.js";
import { bounded, TimestampSchema, parse, assertJson, hashJson, cloneJson, DocumentValidationError, issue } from "./validation.js";

export const LegacyShadowContextSchema = bounded(z.object({ documentId: DocumentIdSchema, sceneId: SceneIdSchema, sourceStoreId: UUIDSchema,
  asset: AssetRefSchema, sourceToDocument: AffineMatrixSchema, ownerId: z.string().min(1).max(160), title: z.string().max(80), projectedAt: TimestampSchema,
  sourceTrust: z.enum(["migrated-local","imported-unverified"]), unlayeredLayerId: NewLayerIdSchema.optional(),
  evidenceAssets: z.array(AssetRefSchema).optional(), identityMapping: IdentityMappingSchema.optional(),
  relationBindings: z.array(z.object({ otherSetKey: z.string().min(1).max(160), legacyId: z.string().min(1).max(80), bindingId: BindingIdSchema, target: AnnotationRefSchema }).strict()).optional(),
  gestureIds: z.record(z.string(), z.string().min(1).max(80)).optional(),
}).strict().superRefine((c, refinement) => {
  const ns = c.identityMapping?.namespace;
  if (ns && (c.sourceTrust === "migrated-local" ? ns.kind !== "local-migration" || ns.storeInstanceId !== c.sourceStoreId : ns.kind !== "external-import")) {
    issue(refinement, "INTEGRITY_ERROR", "Identity mapping belongs to another source namespace");
  }
}));
const rootFields = new Set(["version","imageId","width","height","marks","layers","links","savedAt","setId","derivedFrom","baseAsObject","userEdits","rejections","gestureDecisions","objects","sceneRevision","objectSeq","deletedObjectBatches","layerHistory"]);
const markFields = new Set(["id","author","grounding","type","x","y","x2","y2","points","smooth","closed","layer","label","color","size","pen","note","status","confidence","evidence","ambiguities","review","reviewReason","previouslyRejected","findingUpdatedAt","strokeOrder","relativeStartMs","relativeEndMs","pointerType","role","edited","object","derivedFrom"]);
const objectFields = new Set(["id","type","props","layer","visibility","label","provenance","evidence","revision"]);
const layerFields = new Set(["id","author","name","module","opacity","visible","locked"]);
const findingFields = ["note","status","confidence","ambiguities","review","reviewReason","previouslyRejected","findingUpdatedAt"];
const present = (source, fields) => Object.fromEntries(fields.filter(k => Object.hasOwn(source, k)).map(k => [k, cloneJson(source[k])]));
const validTime = value => TimestampSchema.safeParse(value).success ? value : null;

export function mapLegacyCanvas(input, contextInput) {
  // Bad/cyclic/oversized JSON fails before traversal, not after a partial map.
  assertJson(input);
  const ctx = parse(LegacyShadowContextSchema, contextInput), source = cloneJson(input), sourceHash = hashJson(source);
  const archiveRef = "shadow:" + sourceHash, issues = [], archivedPaths = [];
  const add = (code, path, message, blocking = false) => { issues.push({ code, path, message, blocking }); };
  const archive = (path, message = "Historical field is preserved in the isolated source sidecar") => {
    archivedPaths.push(path); add("ARCHIVED_LEGACY_FIELD", path, message);
  };
  const unknown = (record, keys, prefix) => { for (const k of Object.keys(record)) if (!keys.has(k)) archive([...prefix, k]); };
  const finish = document => ({ status: document ? "mapped" : "blocked", document,
    sidecars: [{ archiveRef, sourceSchema: "canvas.json/version:1", payloadHash: sourceHash, payload: source }],
    report: { authoritative: false, writesPerformed: false, mapped: Boolean(document), migrationCompleted: false,
      recoveryScope: "json-record-only", originalFileBytesVerified: false, binaryAssetsVerified: false,
      sourceHash, sourceHashKind: "canonical-json/sha256",
      sourceStoreId: ctx.sourceStoreId, sourceCounts: { objects: Array.isArray(source?.objects) ? source.objects.length : 0,
        annotations: Array.isArray(source?.marks) ? source.marks.length : 0, layers: Array.isArray(source?.layers) ? source.layers.length : 0 },
      projectedCounts: document ? { objects: document.scenes[0].objects.length, annotations: document.scenes[0].annotations.length, layers: document.scenes[0].layers.length } : null,
      editableComplete: Boolean(document) && archivedPaths.length === 0 && issues.length === 0, rawRecoverable: true, archivedPaths, issues },
  });
  if (!source || Array.isArray(source) || source.version !== 1) { add("UNSUPPORTED_SCHEMA", [], "Expected canvas.json version 1", true); return finish(null); }
  if (!Array.isArray(source.marks) || !Array.isArray(source.layers) || (source.objects !== undefined && !Array.isArray(source.objects)) ||
    [...(source.marks ?? []), ...(source.layers ?? []), ...(source.objects ?? [])].some(v => !v || typeof v !== "object" || Array.isArray(v))) {
    add("INVALID_INPUT", [], "Legacy marks, layers and objects must be arrays", true); return finish(null);
  }
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0 ||
    source.imageId !== ctx.asset.legacyImageId) {
    add("INTEGRITY_ERROR", [], "Canvas dimensions or explicit asset alias differ", true); return finish(null);
  }
  if ((source.links !== undefined && (!source.links || typeof source.links !== "object" || Array.isArray(source.links))) ||
    ["gestureDecisions","rejections","userEdits","deletedObjectBatches"].some(k => source[k] !== undefined && !Array.isArray(source[k])) ||
    (source.baseAsObject !== undefined && typeof source.baseAsObject !== "boolean")) {
    add("INVALID_INPUT", [], "Malformed legacy metadata container", true); return finish(null);
  }
  unknown(source, rootFields, []);
  const setKey = source.imageId + (source.setId === undefined ? "" : "#" + source.setId);
  const assets = new Map();
  for (const a of [ctx.asset, ...(ctx.evidenceAssets ?? [])]) if (a.legacyImageId) {
    if (assets.has(a.legacyImageId) && assets.get(a.legacyImageId).assetId !== a.assetId) add("INTEGRITY_ERROR", [], "Conflicting full asset identities", true);
    assets.set(a.legacyImageId, a);
  }
  if (issues.some(i => i.blocking)) return finish(null);
  const provenance = (raw, path, objectDomain = false) => {
    const p = objectDomain ? raw.provenance ?? {} : raw, payloadHash = hashJson(raw);
    const provenancePath = objectDomain ? [...path,"provenance"] : path;
    if (objectDomain && p && typeof p === "object" && !Array.isArray(p)) unknown(p,new Set(["author","module","moduleVersion","capability","method","createdAt","updatedAt","editedByUser","grounding"]),provenancePath);
    for (const field of ["createdAt","updatedAt"]) if (p[field] !== undefined && validTime(p[field]) === null) archive([...provenancePath,field],"Malformed historical time is preserved, not invented as a valid timestamp");
    if (p.grounding !== undefined && (typeof p.grounding !== "string" || !p.grounding || p.grounding.length > 80)) archive([...provenancePath,"grounding"]);
    if (objectDomain && p.moduleVersion !== undefined && (typeof p.moduleVersion !== "string" || !p.moduleVersion || p.moduleVersion.length > 80)) archive([...provenancePath,"moduleVersion"]);

    let creator, author, ownership = { kind: "instance", ownerId: ctx.ownerId };
    if (ctx.sourceTrust === "imported-unverified") { creator = { kind: "import", sourceId: sourceHash }; author = "unknown"; }
    else if (objectDomain && ModuleIdSchema.safeParse(p.module).success) {
      creator = { kind: "module", moduleId: p.module, publisherFingerprint: null, ownershipLineageId: null,
        version: typeof p.moduleVersion === "string" && p.moduleVersion.length <= 80 && p.moduleVersion ? p.moduleVersion : null, packageDigest: null };
      author = "module"; ownership = { kind: "unclaimed-module", moduleId: p.module, historicalSourceHash: payloadHash };
    } else if (p.author === "user" || p.author === "assistant") { creator = { kind: p.author, principalId: "legacy:" + sourceHash }; author = p.author; }
    else { creator = { kind: "legacy-unknown", sourceId: sourceHash }; author = "unknown"; add("UNKNOWN_AUTHOR", path, "Missing creator is unknown, never inferred from a layer/module name"); }
    const out = { author, createdBy: creator, createdAt: validTime(p.createdAt), lastEditedBy: { kind: "legacy-unknown", sourceId: sourceHash },
      lastEditedAt: validTime(p.updatedAt), ownership, grounding: typeof p.grounding === "string" && p.grounding && p.grounding.length <= 80 ? p.grounding : "unverified",
      editedByUser: raw.edited === true || p.editedByUser === true, sourceTrust: ctx.sourceTrust,
      original: { sourceSchema: "canvas.json/version:1", payloadHash, archiveRef: archiveRef + "#/" + path.join("/") } };
    if (raw.derivedFrom !== undefined) {
      if (ctx.identityMapping && raw.derivedFrom?.set && raw.derivedFrom?.mark) {
        try { out.derivedFrom = lookupIdentity(ctx.identityMapping, { schema: "canvas.json/version:1", legacyKey: raw.derivedFrom.set, kind: "annotation", id: raw.derivedFrom.mark }); }
        catch { archive([...path,"derivedFrom"], "Unresolved historical derivation; no name or spatial guessing"); }
      } else archive([...path,"derivedFrom"]);
    }
    return out;
  };
  const evidence = (list, path) => (list ?? []).flatMap((e, i) => {
    if (!e || !["model","tool","user"].includes(e.observer) || typeof e.says !== "string" || !assets.has(e.image)) {
      archive([...path,i], "Evidence without an explicit observer/source asset remains historical and unverified"); return [];
    }
    return [{ observer: e.observer, kind: e.kind ?? "other", says: e.says,
      source: { kind: "asset", asset: assets.get(e.image), ...(e.region === undefined ? {} : { region: cloneJson(e.region) }) },
      applicability: ctx.sourceTrust === "imported-unverified" ? "historical" : "current", original: cloneJson(e) }];
  });
  const finding = (raw, path, changed = false) => {
    const out = present(raw, findingFields);
    if (raw.evidence !== undefined) {
      if (!Array.isArray(raw.evidence)) throw new DocumentValidationError("INVALID_INPUT", "Evidence must be an array", [...path,"evidence"]);
      out.evidence = evidence(raw.evidence, [...path,"evidence"]);
    }
    if (!Object.keys(out).length) return undefined;
    const historicalState = raw.review === "confirmed" ? "user-confirmed" : raw.review === "rejected" ? "user-rejected" :
      (raw.evidence ?? []).some(e => e?.observer === "tool") ? "independently-verified" : "unverified";
    const sourceIncomplete = (raw.evidence?.length ?? 0) !== (out.evidence?.length ?? 0);
    const currentState = ctx.sourceTrust === "imported-unverified" ? "unverified" : changed || sourceIncomplete ? "stale" : historicalState;
    if (currentState === "stale") for (const e of out.evidence ?? []) e.applicability = "stale";
    out.verification = { historicalState, currentState, contextHash: hashJson({ sourceHash, path }),
      ...(currentState === "stale" ? { reason: "Legacy geometry edit or unresolved evidence context" } : {}) };
    return out;
  };
  try {
    const layers = source.layers.map((l,i) => {
      unknown(l, layerFields, ["layers",i]);
      return { ...present(l,["id","name","module"]), author: ["user","assistant","module"].includes(l.author) ? l.author : "unknown",
        opacity: l.opacity ?? 1, visible: l.visible ?? true, locked: l.locked ?? false, content: [] };
    });
    const layerIds = new Set(layers.map(l => l.id));
    const layerFor = (raw, path) => {
      if (raw.layer !== undefined) {
        if (!layerIds.has(raw.layer)) throw new DocumentValidationError("UNRESOLVED_REFERENCE", "Entity names a missing layer", path);
        return raw.layer;
      }
      if (!ctx.unlayeredLayerId) throw new DocumentValidationError("AMBIGUOUS_TARGET", "Unlayered content needs an explicit allocated layer identity", path);
      if (!layerIds.has(ctx.unlayeredLayerId)) {
        layers.push({ id: ctx.unlayeredLayerId, name: "legacy-unlayered", author: "unknown", opacity: 1, visible: true, locked: false, content: [] });
        layerIds.add(ctx.unlayeredLayerId);
      } else if (source.layers.some(l => l.id === ctx.unlayeredLayerId)) throw new DocumentValidationError("INTEGRITY_ERROR", "Fallback layer identity collides with an existing layer");
      return ctx.unlayeredLayerId;
    };
    const objects = (source.objects ?? []).map((o,i) => {
      unknown(o, objectFields, ["objects",i]);
      if (!OBJECT_TYPE_NAMES.includes(o.type)) throw new DocumentValidationError("UNSUPPORTED_SCHEMA", "Unknown legacy Scene Object type", ["objects",i]);
      if (o.type === "image") throw new DocumentValidationError("BLOCKED_DEPENDENCY", "Legacy PNG object needs verified asset intake; raw bytes are preserved", ["objects",i]);
      const out = { ...present(o,["id","type","props","label"]), revision: o.revision ?? 1, layerId: layerFor(o,["objects",i]), visibility: o.visibility ?? "public",
        provenance: provenance(o,["objects",i],true) };
      if (o.evidence !== undefined) { if (!Array.isArray(o.evidence)) throw new DocumentValidationError("INVALID_INPUT", "Object evidence must be an array"); out.evidence = cloneJson(o.evidence); }
      return out;
    });
    const frames = objects.filter(o => o.type === "axes-2d").map(o => ({ id: "axes:"+o.id, kind: "axes", ownerObjectId: o.id }));
    const annotations = source.marks.map((m,i) => {
      unknown(m, markFields, ["marks",i]);
      const geomFields = m.type === "point" ? ["x","y"] : m.type === "polyline" ? ["points","smooth","closed","x","y","x2","y2"] : ["x","y","x2","y2"];
      const out = { id: m.id, revision: 1, type: m.type, layerId: layerFor(m,["marks",i]), geometry: present(m,geomFields),
        anchor: { space: "image-normalized", asset: ctx.asset, sourceToDocument: [source.width,0,0,0,source.height,0,0,0,1] },
        style: present(m,["color","size","pen"]), provenance: provenance(m,["marks",i]), intentEventIds: [] };
      if (m.label !== undefined) out.label = m.label;
      const f = finding(m,["marks",i],m.edited === true); if (f) out.finding = f;
      const stroke = present(m,["relativeStartMs","relativeEndMs","pointerType"]);
      if (m.strokeOrder !== undefined) stroke.order = m.strokeOrder;
      if (Object.keys(stroke).length) out.stroke = stroke;
      for (const field of ["role","object"]) if (m[field] !== undefined) archive(["marks",i,field], "Historical intent/object hint archived, not fabricated into a new interaction event or anchor");
      return out;
    });
    for (const entity of [...objects.map(o => ({kind:"object",id:o.id,layerId:o.layerId})),
      ...annotations.filter((_,i) => source.marks[i].author !== "user").map(a => ({kind:"annotation",id:a.id,layerId:a.layerId})),
      ...annotations.filter((_,i) => source.marks[i].author === "user").map(a => ({kind:"annotation",id:a.id,layerId:a.layerId}))]) {
      layers.find(l => l.id === entity.layerId).content.push({ kind: entity.kind, id: entity.id });
    }
    const bindings = [];
    const relationInputs = ctx.relationBindings ?? [];
    for (const [otherSetKey, links] of Object.entries(source.links ?? {})) {
      if (!Array.isArray(links)) throw new DocumentValidationError("INVALID_INPUT", "Link store must contain arrays");
      for (const link of links) {
        if (!link || typeof link !== "object" || Array.isArray(link)) throw new DocumentValidationError("INVALID_INPUT","Malformed legacy link",["links",otherSetKey]);
        const candidates = relationInputs.filter(r => r.otherSetKey === otherSetKey && r.legacyId === link.id);
        if (candidates.length !== 1 || candidates[0].target.id !== link.right || !annotations.some(a => a.id === link.left)) throw new DocumentValidationError("UNRESOLVED_REFERENCE", "Relation needs an explicit complete endpoint/binding mapping", ["links",otherSetKey]);
        const allocation = candidates[0];
        const b = { id: allocation.bindingId, kind: "relation", from: { documentId: ctx.documentId, sceneId: ctx.sceneId, kind: "annotation", id: link.left },
          to: allocation.target, status: "unresolved", original: cloneJson(link) };
        if (link.label !== undefined) b.label = link.label;
        const f = finding(link,["links",otherSetKey,link.id]);
        if (f) {
          // The allocation identifies an endpoint, but provides no current
          // geometry/source snapshot for the other Canvas. Preserve the old
          // verdict without claiming its applicability to an unresolved ref.
          f.verification.currentState = ctx.sourceTrust === "imported-unverified" ? "unverified" : "stale";
          f.verification.reason = "External relation endpoint has not been resolved";
          for (const e of f.evidence ?? []) e.applicability = ctx.sourceTrust === "imported-unverified" ? "historical" : "stale";
          b.finding = f;
        }
        bindings.push(b); add("UNRESOLVED_REFERENCE", ["links",otherSetKey,link.id], "External endpoint is explicitly typed but not resolved by this single-canvas projection");
      }
    }
    const gestureDecisions = [];
    for (const [i,g] of (source.gestureDecisions ?? []).entries()) {
      if (!g || typeof g !== "object" || Array.isArray(g)) { archive(["gestureDecisions",i],"Malformed historical gesture preserved in raw sidecar");continue; }
      const id = g.id ?? ctx.gestureIds?.[String(i)];
      if (!id || !Array.isArray(g.memberIds) || g.memberIds.length < 2 || g.memberIds.length > 8 || !g.memberIds.every(id => annotations.some(a => a.id === id))) {
        archive(["gestureDecisions",i], "Unsupported/incomplete historical gesture decision retained verbatim"); continue;
      }
      gestureDecisions.push({ id, memberRefs: g.memberIds.map(id => ({ documentId: ctx.documentId, sceneId: ctx.sceneId, kind: "annotation", id })), verdict: g.verdict, original: cloneJson(g) });
    }
    for (const key of ["layerHistory","userEdits","deletedObjectBatches","derivedFrom","sceneRevision","objectSeq"]) if (source[key] !== undefined) archive([key]);
    const document = { schema: "estampes.document/1", id: ctx.documentId, kind: "image", title: ctx.title, revision: 1, state: "active", persistence: "memory",
      createdAt: ctx.projectedAt, updatedAt: ctx.projectedAt, defaultSceneId: ctx.sceneId, annotationSupport: "shared-v1",
      provenance: { createdBy: ctx.sourceTrust === "imported-unverified" ? "import" : "migration", legacySetKey: setKey }, bindings,
      scenes: [{ id: ctx.sceneId, documentId: ctx.documentId, revision: 1, extent: { width: source.width, height: source.height, unit: "du" },
        background: source.baseAsObject === true ? { kind: "transparent" } : { kind: "asset", asset: ctx.asset, sourceToDocument: ctx.sourceToDocument },
        layers, objects, annotations, frames, gestureDecisions, rejections: source.rejections ?? [], interactionEvents: [],
        undo: { entries: [], legacyArchive: archiveRef }, tombstones: [] }],
    };
    return finish(parse(VisualDocumentSchema, document));
  } catch (e) {
    if (!(e instanceof DocumentValidationError)) throw e;
    add(e.code, e.path, e.message, true); return finish(null);
  }
}
