// Assistant appearance edits share the canvas's layer records. They cannot
// unlock layers or change authorship. Inverse steps touch appearance only.
import { canvasLayers } from '../canvas-state.js';
import { canvasRevision } from '../scene/canvas-render.js';
import { applyLayerEdit, reorderLayers } from './layer-contract.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const appearance = (layers) => layers.map(({ id, opacity, visible }) => ({ id, opacity: opacity ?? 1, visible: visible !== false }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
export const layerState = (entry) => ({
  kind: 'estampes.visual_layers', imageId: entry.imageId, ...(entry.setId ? { setId: entry.setId } : {}),
  revision: canvasRevision(entry),
  layers: canvasLayers(entry).map((l, order) => ({ ...l, order, opacity: l.opacity ?? 1, visible: l.visible !== false, locked: !!l.locked, editable: !l.locked })),
  history: { canUndo: !!entry.layerHistory?.past.length, canRedo: !!entry.layerHistory?.future.length },
  supported: { opacity: { min: 0, max: 1, step: 0.05 }, visibility: true, ordering: 'bottom-to-top', blendMode: false },
});

export function editLayerAppearance(entry, { expectedRevision, action = 'apply', layers = [], order }) {
  if (expectedRevision !== canvasRevision(entry)) fail('STALE_CANVAS', 'Canvas changed. Read get_visual_layers and review before retrying.');
  const before = appearance(entry.layers ?? []);
  let next = clone(entry.layers ?? []), history = clone(entry.layerHistory ?? { past: [], future: [] });
  if (action === 'apply') {
    if (new Set(layers.map(l => l.id)).size !== layers.length) fail('INVALID_LAYER_EDIT', 'Repeated layer id');
    for (const edit of layers) {
      const layer = next.find(l => l.id === edit.id);
      if (!layer) fail('INVALID_LAYER_EDIT', 'Unknown layer ' + edit.id);
      if (layer.locked) fail('LAYER_LOCKED', 'Layer ' + edit.id + ' is locked; ask the user to unlock it.');
      applyLayerEdit(layer, edit);
    }
    if (order) next = reorderLayers(next, order);
  } else {
    if (layers.length || order) fail('INVALID_LAYER_EDIT', 'Undo/redo cannot include layers or order');
    const source = action === 'undo' ? history.past : history.future;
    const item = source.at(-1);
    if (!item) fail('HISTORY_CONFLICT', 'Nothing to ' + action);
    const from = action === 'undo' ? item.after : item.before, to = action === 'undo' ? item.before : item.after;
    if (!same(before, from)) fail('HISTORY_CONFLICT', 'Layer appearance changed since that step; it cannot be overwritten.');
    next = to.map(state => {
      const layer = { ...next.find(l => l.id === state.id) };
      applyLayerEdit(layer, { opacity: state.opacity, visible: state.visible });
      return layer;
    });
    source.pop();
    (action === 'undo' ? history.future : history.past).push(item);
  }
  const after = appearance(next);
  // A locked layer cannot move or be crossed by another layer.
  for (const [i, layer] of (entry.layers ?? []).entries()) {
    const at = next.findIndex(l => l.id === layer.id);
    if (!layer.locked) continue;
    const belowBefore = before.slice(0, i).map(l => l.id).sort();
    const belowAfter = after.slice(0, at).map(l => l.id).sort();
    if (at !== i || !same(before[i], after[at]) || !same(belowBefore, belowAfter)) {
      fail('LAYER_LOCKED', 'Layer ' + layer.id + ' is locked.');
    }
  }
  if (same(before, after)) return false;
  if (action === 'apply') {
    history.past.push({ before, after });
    history.past = history.past.slice(-50);
    history.future = [];
  }
  entry.layers = next;
  entry.layerHistory = history;
  return true;
}
