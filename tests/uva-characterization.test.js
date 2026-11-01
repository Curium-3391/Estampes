// Phase 0 characterization only. These tests assert existing behavior; they
// do not implement Document, Graph anchoring, or multi-viewport APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySceneOps, renderedObjects } from '../src/scene/scene-ops.js';
import { serializeCanvas, restoreCanvas } from '../src/storage.js';

const entry = () => ({ imageId: 'img:0123456789abcdef', width: 1600, height: 1000,
  marks: new Map(), layers: [], objects: new Map() });
const actor = { author: 'module', module: 'org.estampes.graph', moduleVersion: '1.0.0' };

test('UVA characterization: changing axes reprojects frame shapes but leaves normalized user ink unchanged', () => {
  const e = entry();
  const r = applySceneOps(e, [
    { op: 'object.create', ref: 'axes', type: 'axes-2d', props: { xRange: [-10, 10], yRange: [-10, 10] } },
    { op: 'object.create', type: 'shape', props: { kind: 'point', space: 'frame', frame: '$axes', x: 2, y: 3 } },
  ], actor);
  const ink = { id: 'user-rich', type: 'polyline', author: 'user', grounding: 'user-pointer',
    x: .2, y: .2, x2: .4, y2: .4, points: [{ x: .2, y: .2 }, { x: .4, y: .4 }], layer: 'L9' };
  e.marks.set(ink.id, structuredClone(ink));
  const before = structuredClone(renderedObjects(e).find(x => x.object.id === r.created[1]).primitives);
  const revision = e.sceneRevision;
  applySceneOps(e, [{ op: 'object.update', id: r.created[0], props: { xRange: [-20, 20] } }], actor);
  const after = renderedObjects(e).find(x => x.object.id === r.created[1]).primitives;
  assert.notDeepEqual(after, before);
  assert.deepEqual(e.marks.get(ink.id), ink);
  assert.equal(e.sceneRevision, revision + 1);
});

test('UVA characterization: storage form retains rich ink, empty locked layers, gesture decisions and deleted objects', () => {
  const e = entry();
  const r = applySceneOps(e, [
    { op: 'object.create', type: 'axes-2d', props: { xRange: [-1, 1], yRange: [-1, 1] } },
  ], actor);
  applySceneOps(e, [{ op: 'object.delete', id: r.created[0] }], { author: 'user' });
  e.layers.push({ id: 'L99', author: 'user', name: 'empty locked', opacity: 0, locked: true });
  e.marks.set('ink', { id: 'ink', author: 'user', grounding: 'user-pointer', type: 'arrow',
    x: .1, y: .2, x2: .5, y2: .6, layer: 'L99', color: 'red', pen: 'highlighter', size: 'fine',
    note: 'claim', confidence: 'low', evidence: [{ observer: 'user', kind: 'position', says: 'here', image: e.imageId, region: [.1, .2, .5, .6] }],
    ambiguities: ['uncertain'], review: 'rejected', reviewReason: 'different object',
    previouslyRejected: { at: '2026-11-01T00:00:00Z' }, findingUpdatedAt: 42,
    strokeOrder: 2, relativeStartMs: 10, relativeEndMs: 30, pointerType: 'pen',
    role: 'context', edited: true, object: 'legacy-landmark', derivedFrom: { set: e.imageId, mark: 'original' } });
  e.gestureDecisions = [{ memberIds: ['ink'], verdict: 'user-rejected' }];
  e.rejections = [{ kind: 'note', from: { image: e.imageId, text: 'claim' } }];
  e.userEdits = [{ kind: 'move-mark', id: 'ink' }];
  e.baseAsObject = true;
  const serialized = structuredClone(serializeCanvas(e));
  const restored = restoreCanvas(entry(), serialized);
  const { savedAt: _a, ...before } = serialized;
  const { savedAt: _b, ...after } = serializeCanvas(restored);
  assert.deepEqual(after, before);
  assert.equal(restored.layers.at(-1).opacity, 0);
  assert.equal(restored.deletedObjectBatches[0][0].id, r.created[0]);
});
