// User text is the existing public, canvas-space shape/text object. This
// app-only route adds OCC and inverse history without a second text format.
import { z } from "zod";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { applySceneOps, widgetObjects, MAX_OBJECTS } from "../scene/scene-ops.js";
import { validateProps } from "../scene/objects.js";
import { canvasLayers } from "../canvas-state.js";
import { canvasRevision } from "../scene/canvas-render.js";

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])])) : value;
const signature = object => {
  if (!object) return "null";
  const copy = clone(object); delete copy.revision;
  if (copy.provenance) { delete copy.provenance.updatedAt; delete copy.provenance.editedByUser; }
  return JSON.stringify(canonical(copy));
};
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export const isCanvasText = o => o?.type === "shape" && o.props.kind === "text" && (o.props.space ?? "canvas") === "canvas" && o.visibility === "public";
export const textState = entry => ({ kind: "estampes.canvas_text", imageId: entry.imageId, ...(entry.setId ? { setId: entry.setId } : {}),
  revision: canvasRevision(entry), objects: widgetObjects(entry), layers: canvasLayers(entry),
  history: { canUndo: !!entry.textHistory?.past.length, canRedo: !!entry.textHistory?.future.length } });

export function editText(entry, { action, expectedRevision, id, props }) {
  if (expectedRevision !== canvasRevision(entry)) fail("STALE_CANVAS", "Canvas changed; refresh and review the text before editing.");
  const history = clone(entry.textHistory ?? { past: [], future: [] });
  const oldDeleted = entry.deletedObjectBatches;
  if (action === "undo" || action === "redo") {
    const fromStack = action === "undo" ? history.past : history.future, item = fromStack.at(-1);
    if (!item) fail("HISTORY_CONFLICT", "Nothing to " + action);
    const current = entry.objects?.get(item.id) ?? null;
    const from = action === "undo" ? item.after : item.before, to = action === "undo" ? item.before : item.after;
    if (signature(current) !== signature(from)) fail("HISTORY_CONFLICT", "Text changed since that step; it cannot be overwritten.");
    for (const obj of [current, to]) if (obj && entry.layers?.find(l => l.id === obj.layer)?.locked) fail("LAYER_LOCKED", "Text layer is locked.");
    if (to) {
      if (!isCanvasText(to) || to.id !== item.id) fail("HISTORY_CONFLICT", "Invalid text history target.");
      if (!entry.layers?.some(l => l.id === to.layer)) fail("HISTORY_CONFLICT", "The text layer no longer exists.");
      if (!current && (entry.objects?.size ?? 0) >= MAX_OBJECTS) fail("LIMIT", "The canvas is full.");
      const restored = clone(to); restored.props = validateProps("shape", restored.props);
      restored.revision = (current?.revision ?? to.revision) + 1;
      restored.provenance = { ...restored.provenance, editedByUser: true, updatedAt: new Date().toISOString() };
      entry.objects.set(item.id, restored);
      entry.objects = new Map([...entry.objects].sort((a,b) => +a[0].slice(1) - +b[0].slice(1)));
    } else entry.objects.delete(item.id);
    entry.sceneRevision = (entry.sceneRevision ?? 0) + 1; entry.objectRender = null;
    fromStack.pop(); (action === "undo" ? history.future : history.past).push(item);
  } else {
    const before = id ? clone(entry.objects?.get(id)) : null;
    if (action !== "create" && !isCanvasText(before)) fail("INVALID_TEXT", "No editable canvas text with this id.");
    if (before && entry.layers?.find(l => l.id === before.layer)?.locked) fail("LAYER_LOCKED", "Text layer is locked.");
    let result;
    if (action === "create") {
      const base = "文字 " + ((entry.objectSeq ?? 0) + 1);
      let name = base;
      for (let suffix = 1; entry.layers?.some(l => l.name === name); suffix++) name = base + " · " + suffix;
      result = applySceneOps(entry, [{ op: "object.create", type: "shape", props: { kind: "text", space: "canvas", ...props } }], { author: "user" }, { layer: name });
      id = result.created[0];
      entry.layers.find(l => l.id === entry.objects.get(id).layer).author = "user";
    } else result = applySceneOps(entry, [action === "delete" ? { op: "object.delete", id } : { op: "object.update", id, props }], { author: "user" });
    // This route owns text inverses; do not also enqueue generic object restore.
    entry.deletedObjectBatches = oldDeleted;
    history.past.push({ id, before: before ?? null, after: clone(entry.objects.get(id)) ?? null });
    history.past = history.past.slice(-50); history.future = [];
  }
  entry.textHistory = history;
  const changedId = id ?? (action === "undo" ? history.future : history.past).at(-1).id;
  const changed = entry.objects.get(changedId);
  (entry.userEdits ??= []).push({ kind: changed ? "edit-object" : "remove-object", id: changedId, action, ...(changed ? { props: clone(changed.props) } : {}) });
  entry.userEdits = entry.userEdits.slice(-60);
  return changedId;
}

export function registerTextTools(server, { ensureSet, saveCanvas }) {
  const n = z.number().finite().min(0).max(1);
  registerAppTool(server, "edit_canvas_text", {
    title: "Edit canvas text", description: "User canvas text: read, create, update, delete or undo/redo. Uses existing vector shape/text records. Read first; edits require that revision. Locked layers and stale edits are refused. Workspace copies use setId.",
    inputSchema: z.object({ imageId: z.string().regex(/^(img|gph):[0-9a-f]{16}$/), setId: z.string().regex(/^c[0-9a-f]{12}$/).optional(),
      action: z.enum(["read", "create", "update", "delete", "undo", "redo"]).default("read"),
      expectedRevision: z.string().regex(/^cv:[0-9a-f]{24}$/).optional(), id: z.string().regex(/^o\d{1,6}$/).optional(),
      props: z.object({ x: n.optional(), y: n.optional(), text: z.string().min(1).max(80).optional(), size: z.number().min(6).max(64).optional(), fill: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).strict().optional(),
    }).strict().superRefine((v, ctx) => {
      const need = (ok, message) => { if (!ok) ctx.addIssue({ code: "custom", message }); };
      if (v.action !== "read") need(v.expectedRevision, "expectedRevision is required");
      if (["read","undo","redo"].includes(v.action)) need(!v.id && !v.props, "This action takes no id or props");
      if (["update","delete"].includes(v.action)) need(v.id, "id is required");
      if (v.action === "create") need(!v.id && v.props?.text?.trim() && v.props.x !== undefined && v.props.y !== undefined, "Create needs text, x and y, and no id");
      if (v.action === "update") need(v.props && Object.keys(v.props).length, "Update needs props");
      if (v.action === "delete") need(!v.props, "Delete takes no props");
    }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ["app"] } },
  }, async args => {
    let entry, restore;
    try {
      entry = await ensureSet(args.imageId + (args.setId ? "#" + args.setId : ""));
      let selectedId;
      if (args.action !== "read") {
        const fields = ["objects","layers","objectSeq","sceneRevision","deletedObjectBatches","textHistory","userEdits"];
        const was = Object.fromEntries(fields.map(k => [k, k === "objects" ? new Map(entry.objects ?? []) : clone(entry[k])]));
        restore = () => { Object.assign(entry, was); entry.objectRender = null; };
        try { selectedId = editText(entry, args); } catch (error) { restore(); throw error; }
        const revision = canvasRevision(entry);
        try { await saveCanvas(entry, { tool: "edit_canvas_text", author: "user", action: args.action }); }
        catch (error) { if (canvasRevision(entry) === revision) restore(); throw Object.assign(error, { code: error.code ?? "SAVE_FAILED" }); }
      }
      const state = { ...textState(entry), ...(selectedId ? { selectedId } : {}) };
      return { content: [{ type: "text", text: "Canvas text " + args.action }], structuredContent: state };
    } catch (error) { return { isError: true, content: [{ type: "text", text: error.message }], structuredContent: { kind: "estampes.text_error", code: error.code ?? "INVALID_TEXT" } }; }
  });
}
