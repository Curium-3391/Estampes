import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { registerImage, clearImages } from '../src/image-store.js';
import { applyCanvasChanges, editCanvas, canvasMarks, importMarks } from '../src/canvas-state.js';
import { resolveCoordinateAnnotation as resolve, replayUserAnnotation } from '../src/scene-catalog.js';
import { editLayerAppearance, layerState } from '../src/visual/layer-appearance.js';
import { serializeCanvas, restoreCanvas, useStorageDir } from '../src/storage.js';
import { canvasRevision, renderCanvas } from '../src/scene/canvas-render.js';
import { exportBundle, importBundle } from '../src/bundle.js';
import { workspaceItems, getWorkspace, clearWorkspaces } from '../src/workspace.js';
import { exportMarksSvg, parseMarksFile } from '../src/marks-file.js';

beforeEach(() => { clearImages(); clearWorkspaces(); useStorageDir(''); });
const photo = async () => {
  const entry = await registerImage(await sharp({ create: { width: 400, height: 300, channels: 3, background: '#468' } }).png().toBuffer(), { source: 'test' });
  for (let i = 0; i < 3; i++) applyCanvasChanges(entry, { annotations: [{ id: 'a' + i, type: 'rect', x: .1 + i * .2, y: .2, x2: .2 + i * .2, y2: .4 }], layer: 'layer ' + i, resolve });
  return entry;
};
const edit = (entry, args) => editLayerAppearance(entry, { expectedRevision: canvasRevision(entry), ...args });

test('shared appearance changes pixels without changing marks; exact undo/redo survives reload', async () => {
  const entry = await photo(), marks = JSON.stringify(canvasMarks(entry)), original = await renderCanvas(entry);
  const oldRevision = canvasRevision(entry);
  edit(entry, { layers: [{ id: 'L1', opacity: .42 }, { id: 'L2', visible: false }], order: ['L3', 'L1', 'L2'] });
  const state = layerState(entry), after = await renderCanvas(entry);
  assert.deepEqual(state.layers.map(l => [l.id,l.opacity,l.visible]), [['L3',1,true],['L1',.4,true],['L2',1,false]]);
  assert.notDeepEqual(after.data, original.data);
  assert.equal(after.metadata.included.marks.includes('a1'), false);
  assert.equal(JSON.stringify(canvasMarks(entry)), marks);
  assert.throws(() => editLayerAppearance(entry, { expectedRevision: oldRevision, layers: [{ id: 'L1', opacity: 0 }] }), { code: 'STALE_CANVAS' });
  const restored = { imageId: entry.imageId, width: 400, height: 300 };
  restoreCanvas(restored, JSON.parse(JSON.stringify(serializeCanvas(entry))));
  edit(restored, { action: 'undo' });
  assert.equal(canvasRevision(restored), oldRevision);
  edit(restored, { action: 'redo' });
  assert.equal(canvasRevision(restored), state.revision);
  editCanvas(restored, { layers: [{ id: 'L1', opacity: .9 }] });
  assert.throws(() => edit(restored, { action: 'undo' }), { code: 'HISTORY_CONFLICT' });
});

test('locked layers cannot be changed, moved or crossed; failed batches are atomic', async () => {
  const entry = await photo();
  editCanvas(entry, { layers: [{ id: 'L2', locked: true }] });
  const before = JSON.stringify(serializeCanvas(entry).layers);
  for (const args of [
    { layers: [{ id: 'L1', opacity: .2 }, { id: 'L2', visible: false }] },
    { order: ['L2', 'L1', 'L3'] }, { order: ['L3', 'L2', 'L1'] },
  ]) {
    assert.throws(() => edit(entry, args), { code: 'LAYER_LOCKED' });
    assert.equal(JSON.stringify(entry.layers), before);
  }
  edit(entry, { layers: [{ id: 'L1', opacity: .2 }] });
  editCanvas(entry, { layers: [{ id: 'L1', locked: true }] });
  assert.throws(() => edit(entry, { action: 'undo' }), { code: 'LAYER_LOCKED' });
  assert.throws(() => edit(entry, { order: ['L1', 'L1'] }), /unknown or repeated/);
});

test('zero opacity and shared visibility survive bundle and marks-file export/import', async () => {
  const entry = await photo();
  edit(entry, { layers: [{ id: 'L1', opacity: 0, visible: false }, { id: 'L2', opacity: .5 }], order: ['L3','L2','L1'] });
  const expected = entry.layers.map(l => [l.name,l.opacity??1,l.visible!==false]);
  const svg = exportMarksSvg(entry, canvasMarks(entry), entry.layers);
  assert.match(svg, /style="display:none"/);
  const parsed = parseMarksFile(svg);
  const copy = { imageId: entry.imageId, marks: new Map(), layers: [] };
  importMarks(copy, parsed.marks, { layers: parsed.layers, replayUser: replayUserAnnotation, resolve });
  assert.equal(copy.layers.find(l => l.name === 'layer 0').opacity, 0);
  assert.equal(copy.layers.find(l => l.name === 'layer 0').visible, false);
  assert.deepEqual(copy.layers.map(l => [l.name,l.opacity??1,l.visible!==false]), expected);
  const { buffer } = await exportBundle(entry.imageId);
  clearImages(); clearWorkspaces();
  const imported = await importBundle(buffer);
  const [item] = await workspaceItems(await getWorkspace(imported.workspace.id));
  assert.deepEqual(item.entry.layers.map(l => [l.name,l.opacity??1,l.visible!==false]), expected);
});

test('a failed durable write restores appearance and history; no-op edits do not write', async () => {
  const { registerLayerTools } = await import('../src/visual/layer-tools.js');
  const entry = await photo(), revision = canvasRevision(entry), handlers = new Map();
  let writes = 0;
  registerLayerTools({ registerTool: (name, _spec, handler) => handlers.set(name, handler) }, {
    ensureSet: async () => entry,
    saveCanvas: async () => { writes++; throw new Error('disk full'); },
  });
  const call = handlers.get('edit_visual_layers');
  const noOp = await call({ imageId: entry.imageId, expectedRevision: revision, layers: [{ id: 'L1', opacity: 1 }] });
  assert.ok(!noOp.isError);
  assert.equal(writes, 0);
  const refused = await call({ imageId: entry.imageId, expectedRevision: revision, layers: [{ id: 'L1', opacity: .5 }] });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /disk full/);
  assert.equal(canvasRevision(entry), revision);
  assert.equal(entry.layerHistory, undefined);
});


test('workspace copies retain appearance with independent undo history and tool target', async () => {
  const { commitTransfer, ensureSet } = await import('../src/workspace.js');
  const entry = await photo();
  edit(entry, { layers: [{ id: 'L1', opacity: .2, visible: false }] });
  const transfer = await commitTransfer({ source: entry.imageId, target: 'new', mode: 'copy' });
  const [item] = await workspaceItems(await getWorkspace(transfer.workspaceId));
  const fork = await ensureSet(item.item.set);
  assert.notEqual(fork, entry);
  assert.equal(fork.layers[0].opacity, .2);
  assert.equal(fork.layers[0].visible, false);
  assert.equal(layerState(fork).history.canUndo, false);
  assert.equal(layerState(fork).setId, fork.setId);
  edit(fork, { layers: [{ id: 'L1', opacity: .8, visible: true }] });
  assert.equal(entry.layers[0].opacity, .2);
  assert.equal(entry.layers[0].visible, false);
  edit(fork, { action: 'undo' });
  assert.equal(fork.layers[0].opacity, .2);
});
