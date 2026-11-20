// The layer contract: a layer groups marks and scene objects by when and by
// whom they were made. The user can rename, reorder, lock and fade it. This
// module owns the record shape and the rules; canvas-state.js applies them
// to a photo canvas (UVA Phase 2, PR-2A).
import { t } from "../i18n/index.js";
import { defaultName, asNamed, NAME_FIELDS } from "../i18n/names.js";
export const LAYER_FIELDS = Object.freeze(["id", "author", "name", ...NAME_FIELDS, "module", "locked", "opacity", "visible"]);
export const LAYER_NAME_MAX = 40;
export const AUTHOR_NAME = Object.freeze({ user: t("name.author.user"), assistant: t("name.author.assistant") });

// Opacity is stored in steps of 0.05; 1 (fully opaque) is the absence of the field.
export const layerOpacity = (v) => Math.round(Math.min(1, Math.max(0, v)) * 20) / 20;

export const layerLocked = (layer) => layer?.locked === true;
export const findLayer = (layers, id) => layers.find((l) => l.id === id);

const idNumber = (layer) => +String(layer.id).slice(1) || 0;
const nextId = (layers) => "L" + (layers.reduce((m, l) => Math.max(m, idNumber(l)), 0) + 1);

// A fresh layer record (not yet added to the list). `name` is a text, or a
// named record from defaultName(). Unnamed layers count the author's previous
// layers ("AI · #2") and keep the key, so a viewer sees it in their language.
export function newLayerRecord(layers, author, name) {
  const n = layers.filter((l) => l.author === author).length + 1;
  const given = asNamed(name);
  return { id: nextId(layers), author, ...(given.name ? given : defaultName("name.layer.numbered", { author, n })) };
}

// Apply one user edit (name / locked / opacity) to a layer record in place.
// Returns the edit entries to report to the assistant. `fail` builds the error.
export function applyLayerEdit(layer, edit, fail = (m) => new Error(m)) {
  const edits = [];
  if (edit.name !== undefined) {
    const name = String(edit.name).trim().slice(0, LAYER_NAME_MAX);
    if (!name) throw fail("name is empty");
    if (name !== layer.name) edits.push({ kind: "rename-layer", layer: layer.id, from: layer.name, to: name });
    // A name the person typed is theirs: the default name's key no longer applies.
    if (name !== layer.name) for (const f of NAME_FIELDS) delete layer[f];
    layer.name = name;
  }
  if (edit.locked !== undefined && !!edit.locked !== !!layer.locked) {
    edits.push({ kind: edit.locked ? "lock-layer" : "unlock-layer", layer: layer.id });
    if (edit.locked) layer.locked = true; else delete layer.locked;
  }
  if (edit.opacity !== undefined) {
    const o = layerOpacity(Number(edit.opacity));
    if (o >= 1) delete layer.opacity; else layer.opacity = o;
  }
  if (edit.visible !== undefined) {
    if (edit.visible !== (layer.visible !== false)) edits.push({ kind: "visibility-layer", layer: layer.id, visible: edit.visible });
    if (edit.visible) delete layer.visible; else layer.visible = false;
  }
  return edits;
}

// The new drawing order. `order` lists some layer ids first; the rest keep
// their relative order after them. Unknown or repeated ids are an error.
export function reorderLayers(layers, order, fail = (m) => new Error(m)) {
  const byId = new Map(layers.map((l) => [l.id, l]));
  if (new Set(order).size !== order.length || order.some((id) => !byId.has(id))) throw fail("unknown or repeated layer id");
  return [...order.map((id) => byId.get(id)), ...layers.filter((l) => !order.includes(l.id))];
}
