// Scene operations (estampes.scene-ops/1): the only way a module, the
// user's canvas or any other source changes the objects on a canvas.
// A batch is validated as a whole and applied all or nothing; the Core
// assigns object ids, checks who may touch what, bumps the canvas's scene
// revision (optimistic concurrency) and re-renders through the trusted
// renderer in objects.js. Modules never write canvas state themselves.
import { z } from "zod";
import { OBJECT_TYPES, OBJECT_TYPE_NAMES, validateProps, renderObject } from "./objects.js";
import { moduleLayer } from "../canvas-state.js";
import { defaultName } from "../i18n/names.js";

export const SCENE_OPS_PROTOCOL = "estampes.scene-ops/1";
export const OP_KINDS = ["object.create", "object.update", "object.delete", "object.publish", "object.restore"];
export const VISIBILITY = ["public", "scratch"];
export const MAX_OPS = 64, MAX_OBJECTS = 200, MAX_POINTS_PER_CANVAS = 60000;

const Ref = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/);
const IdOrRef = z.string().regex(/^(o\d{1,6}|\$[A-Za-z][A-Za-z0-9_-]{0,31})$/, "an object id like o3, or $ref of an object created earlier in this batch");
const EvidenceItem = z.object({
  says: z.string().min(1).max(160),
  region: z.array(z.number().min(0).max(1)).length(4).optional(),
}).strict();
const OpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("object.create"), ref: Ref.optional(), type: z.enum(OBJECT_TYPE_NAMES),
    props: z.record(z.string(), z.unknown()), label: z.string().max(64).optional(),
    visibility: z.enum(VISIBILITY).optional(), evidence: z.array(EvidenceItem).max(6).optional(),
  }).strict(),
  z.object({
    op: z.literal("object.update"), id: IdOrRef, props: z.record(z.string(), z.unknown()).optional(),
    label: z.string().max(64).optional(),
  }).strict(),
  z.object({ op: z.literal("object.delete"), id: IdOrRef, cascade: z.boolean().optional() }).strict(),
  z.object({ op: z.literal("object.publish"), id: IdOrRef }).strict(),
  z.object({ op: z.literal("object.restore") }).strict(),
]);
export const OperationsSchema = z.array(OpSchema).max(MAX_OPS);

// Fields of props that name another object; "$ref" there means an object
// created earlier in the same batch.
const REF_FIELDS = ["frame"];

const objectsOf = (entry) => (entry.objects ??= new Map());
export const canvasObjects = (entry) => [...objectsOf(entry).values()];
export const sceneRevision = (entry) => entry.sceneRevision ?? 0;

function nextId(entry) {
  const n = Math.max(entry.objectSeq ?? 0, ...[...objectsOf(entry).keys()].map((id) => +id.slice(1) || 0)) + 1;
  entry.objectSeq = n;
  return "o" + n;
}
const layerById = (entry, id) => (entry.layers ?? []).find((l) => l.id === id);

// The canvas's objects as they are rendered right now (cached per scene
// revision). Unknown or broken objects render nothing and carry a note.
export function renderedObjects(entry) {
  const rev = sceneRevision(entry);
  if (entry.objectRender?.rev === rev && entry.objectRender.count === objectsOf(entry).size) return entry.objectRender.list;
  const map = objectsOf(entry), aspect = entry.height / entry.width;
  const list = [...map.values()].map((o) => ({ object: o, ...renderObject(o, { lookup: (id) => map.get(id), aspect }) }));
  entry.objectRender = { rev, count: map.size, list };
  return list;
}

export class SceneOpsError extends Error {
  constructor(message, { code = "invalid", index } = {}) {
    super((index === undefined ? "" : "operations[" + index + "]: ") + message);
    this.code = code;
  }
}

// source: { author: "module"|"user"|"assistant", module?, moduleVersion?, capability?, method? }
// options: { expectedRevision, visibility (default for creates), layer (layer name), now }
export function applySceneOps(entry, operations, source, { expectedRevision, visibility = "public", layer: layerName, now = new Date().toISOString() } = {}) {
  const parsed = OperationsSchema.safeParse(operations);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SceneOpsError((issue.path.length ? "operations." + issue.path.join(".") + ": " : "") + issue.message +
      (issue.path.length === 2 && issue.path[1] === "op" ? " (known operations: " + OP_KINDS.join(", ") + ")" : ""));
  }
  const ops = parsed.data;
  if (expectedRevision !== undefined && expectedRevision !== sceneRevision(entry)) {
    throw new SceneOpsError("the canvas changed since revision " + expectedRevision + " (now " + sceneRevision(entry) +
      "); read it again and retry", { code: "conflict" });
  }
  const map = objectsOf(entry);
  const saved = { objects: new Map(map), layers: (entry.layers ?? []).map((l) => ({ ...l })), seq: entry.objectSeq, rev: entry.sceneRevision, deleted: entry.deletedObjectBatches };
  const restore = () => { entry.objects = saved.objects; entry.layers = saved.layers; entry.objectSeq = saved.seq; entry.sceneRevision = saved.rev; entry.deletedObjectBatches = saved.deleted; };
  const refs = new Map(), result = { created: [], updated: [], deleted: [], published: [], refs: {} };
  let intoLayer = null;
  const resolveId = (id, i) => {
    if (id.startsWith("$")) {
      const real = refs.get(id.slice(1));
      if (!real) throw new SceneOpsError("unknown reference " + id + " (create it earlier in this batch with ref)", { index: i });
      return real;
    }
    return id;
  };
  const withRefs = (props, i) => {
    const out = { ...props };
    for (const f of REF_FIELDS) if (typeof out[f] === "string" && out[f].startsWith("$")) out[f] = resolveId(out[f], i);
    return out;
  };
  // Who may change an existing object: the user anything (it is their
  // canvas), a module only what it made itself; nobody touches a locked layer.
  const mayTouch = (obj, i, verb) => {
    if (!obj) throw new SceneOpsError("no such object", { index: i, code: "not-found" });
    if (obj.layer && layerById(entry, obj.layer)?.locked) throw new SceneOpsError("object " + obj.id + " is in a layer the user locked; cannot " + verb + " it", { index: i, code: "locked" });
    if (source.author === "user") return;
    if (source.author === "module" && obj.provenance?.module === source.module) return;
    throw new SceneOpsError("object " + obj.id + " was made by " + (obj.provenance?.module ?? obj.provenance?.author ?? "someone else") +
      "; " + (source.module ?? source.author) + " may only " + verb + " its own objects", { index: i, code: "forbidden" });
  };
  const checkRefs = (type, props, i) => {
    const deps = OBJECT_TYPES[type].dependsOn?.(props) ?? [];
    for (const id of deps) {
      const target = map.get(id);
      if (!target) throw new SceneOpsError("props.frame " + JSON.stringify(id) + " is not an object on this canvas", { index: i });
      if (target.type !== "axes-2d") throw new SceneOpsError("props.frame must be an axes-2d object, " + id + " is " + target.type, { index: i });
    }
  };
  try {
    ops.forEach((op, i) => {
      if (op.op === "object.create") {
        if (map.size >= MAX_OBJECTS) throw new SceneOpsError("a canvas holds at most " + MAX_OBJECTS + " objects", { index: i, code: "limit" });
        if (op.ref && refs.has(op.ref)) throw new SceneOpsError("ref " + op.ref + " is used twice", { index: i });
        let props;
        try { props = validateProps(op.type, withRefs({ ...OBJECT_TYPES[op.type].defaults, ...op.props }, i)); }
        catch (error) { throw error instanceof SceneOpsError ? error : new SceneOpsError(error.message, { index: i }); }
        checkRefs(op.type, props, i);
        const id = nextId(entry);
        intoLayer ??= moduleLayer(entry, layerName || source.layerName || defaultName("name.layer.module"), source.module);
        map.set(id, {
          id, type: op.type, props, layer: intoLayer.id, visibility: op.visibility ?? visibility,
          ...(op.label ? { label: op.label } : {}),
          provenance: {
            author: source.author, ...(source.module ? { module: source.module, moduleVersion: source.moduleVersion } : {}),
            ...(source.capability ? { capability: source.capability } : {}), ...(source.method ? { method: source.method } : {}),
            createdAt: now, updatedAt: now,
          },
          ...(op.evidence?.length ? { evidence: op.evidence.map((e) => ({ ...e, observer: source.author === "module" ? "tool" : source.author, source: source.module })) } : {}),
          revision: 1,
        });
        if (op.ref) { refs.set(op.ref, id); result.refs[op.ref] = id; }
        result.created.push(id);
      } else if (op.op === "object.update") {
        const id = resolveId(op.id, i), old = map.get(id);
        mayTouch(old, i, "update");
        let props = old.props;
        if (op.props) {
          const merged = { ...old.props, ...op.props };
          // Setting a label selects custom unless the caller explicitly requests auto.
          // This policy belongs to Core: widget edits run without module code.
          if (old.type === "function-plot" && op.props.label !== undefined && op.props.labelMode === undefined) merged.labelMode = "custom";
          try { props = validateProps(old.type, withRefs(merged, i)); }
          catch (error) { throw error instanceof SceneOpsError ? error : new SceneOpsError(error.message, { index: i }); }
          checkRefs(old.type, props, i);
        }
        const next = { ...old, props, revision: old.revision + 1, provenance: { ...old.provenance, updatedAt: now,
          ...(source.author === "user" ? { editedByUser: true } : {}) } };
        if (op.label !== undefined) { if (op.label) next.label = op.label; else delete next.label; }
        map.set(id, next);
        result.updated.push(id);
      } else if (op.op === "object.delete") {
        const id = resolveId(op.id, i), old = map.get(id);
        mayTouch(old, i, "delete");
        const dependents = [...map.values()].filter((o) => (OBJECT_TYPES[o.type].dependsOn?.(o.props) ?? []).includes(id));
        if (dependents.length && !op.cascade) {
          throw new SceneOpsError(id + " is the frame of " + dependents.map((o) => o.id).join(", ") + "; delete those first or pass cascade:true", { index: i, code: "in-use" });
        }
        for (const d of dependents) { mayTouch(d, i, "delete"); map.delete(d.id); result.deleted.push(d.id); }
        map.delete(id);
        result.deleted.push(id);
      } else if (op.op === "object.restore") {
        if (source.author !== "user") throw new SceneOpsError("only the user can restore deleted objects", { code: "forbidden" });
        const batch = entry.deletedObjectBatches?.at(-1);
        if (!batch?.length) throw new SceneOpsError("no deleted objects to restore");
        if (map.size + batch.length > MAX_OBJECTS) throw new SceneOpsError("too many objects to restore", { code: "limit" });
        for (const obj of batch) {
          if (map.has(obj.id)) throw new SceneOpsError("object id already exists: " + obj.id);
          mayTouch(obj, i, "restore");
          map.set(obj.id, { ...obj, props: validateProps(obj.type, obj.props), revision: obj.revision + 1 });
          result.created.push(obj.id);
        }
        for (const obj of batch) checkRefs(obj.type, obj.props, i);
        const ordered = [...map].sort((a, b) => +a[0].slice(1) - +b[0].slice(1));
        map.clear(); for (const [id, obj] of ordered) map.set(id, obj);
        entry.deletedObjectBatches = entry.deletedObjectBatches.slice(0, -1);
      } else if (op.op === "object.publish") {
        const id = resolveId(op.id, i), old = map.get(id);
        mayTouch(old, i, "publish");
        if (old.visibility !== "public") { map.set(id, { ...old, visibility: "public", revision: old.revision + 1 }); result.published.push(id); }
      }
    });
    if (result.deleted.length) {
      const batch = [...saved.objects.values()].filter(obj => result.deleted.includes(obj.id));
      if (batch.length) entry.deletedObjectBatches = [...(entry.deletedObjectBatches ?? []), batch].slice(-10);
    }
    entry.sceneRevision = sceneRevision(entry) + 1;
    const rendered = renderedObjects(entry);
    const points = rendered.reduce((n, r) => n + r.primitives.reduce((m, p) => m + (p.pts?.length ?? 1), 0), 0);
    if (points > MAX_POINTS_PER_CANVAS) throw new SceneOpsError("the canvas would hold more than " + MAX_POINTS_PER_CANVAS + " drawn points", { code: "limit" });
    result.revision = entry.sceneRevision;
    result.notes = rendered.filter((r) => [...result.created, ...result.updated].includes(r.object.id) && r.info.note)
      .map((r) => ({ id: r.object.id, note: r.info.note }));
    return result;
  } catch (error) {
    restore();
    entry.objectRender = null;
    throw error;
  }
}

// ---- Views of the objects ---------------------------------------------------
// The props worth telling the model, without long point lists.
function compactProps(o) {
  const { points, png, ...rest } = o.props;
  return points ? { ...rest, points: points.length + " points" } : rest;
}
export function compactObject(r) {
  const o = r.object;
  return {
    id: o.id, type: o.type, layer: o.layer, ...(o.visibility !== "public" ? { visibility: o.visibility } : {}),
    ...(o.label ? { label: o.label } : {}), props: compactProps(o),
    source: o.provenance?.module ?? o.provenance?.author, ...(o.provenance?.editedByUser ? { editedByUser: true } : {}),
    ...(r.info.segments !== undefined ? { segments: r.info.segments } : {}), ...(r.info.note ? { note: r.info.note } : {}),
  };
}

// What the canvas widget draws: public objects only. Scratch objects are
// the model's working notes; they are not shown or exported until published.
const EDITABLE = {
  image: p => ({ region: p.region }),
  shape: p => p.kind === "text" && (p.space ?? "canvas") === "canvas" ? { ...p } : null,
  "function-plot": (p) => ({ expression: p.expression, domain: p.domain ?? null, labelMode: p.labelMode ?? (p.label === undefined ? "auto" : "custom"), label: p.label ?? "" }),
  "axes-2d": (p) => ({ xRange: p.xRange, yRange: p.yRange, title: p.title ?? "" }),
};
export function widgetObjects(entry) {
  return renderedObjects(entry).filter((r) => r.object.visibility === "public").map((r) => ({
    id: r.object.id, type: r.object.type, layer: r.object.layer, ...(r.object.label ? { label: r.object.label } : {}),
    module: r.object.provenance?.module ?? null, primitives: r.primitives,
    ...(r.object.type === "info-card" ? { card: r.object.props } : {}),
    ...(EDITABLE[r.object.type] ? { editable: EDITABLE[r.object.type](r.object.props) } : {}),
    locked: !!(r.object.layer && layerById(entry, r.object.layer)?.locked),
  }));
}

// Stored form (canvas.json): no rendered primitives, they are re-computed.
export const serializeObjects = (entry) => canvasObjects(entry);
export function restoreObjects(entry, list) {
  entry.objects = new Map();
  for (const o of Array.isArray(list) ? list : []) {
    if (!o || !/^o\d{1,6}$/.test(o.id) || !OBJECT_TYPES[o.type]) continue;
    try { entry.objects.set(o.id, { ...o, props: validateProps(o.type, o.props) }); } catch { /* drop what no longer validates */ }
  }
  entry.objectRender = null;
  return entry;
}
