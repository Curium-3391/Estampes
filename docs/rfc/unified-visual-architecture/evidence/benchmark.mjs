// Phase 0 research harness: existing APIs, synthetic data, temporary storage.
// Run from repository root with Node 22. It never reads a user's storage.
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { compileExpression } from '../../../../src/scene/expression.js';
import { sampleFunction, frameOf } from '../../../../src/scene/objects.js';
import { applySceneOps } from '../../../../src/scene/scene-ops.js';
import { renderCanvas } from '../../../../src/scene/canvas-render.js';
import { intakeImage, useStorageDir, flushStorage } from '../../../../src/storage.js';
import { clearImages } from '../../../../src/image-store.js';
import { clearWorkspaces } from '../../../../src/workspace.js';
import { exportBundle, importBundle } from '../../../../src/bundle.js';

const dir = await mkdtemp(join(tmpdir(), 'estampes-uva-bench-'));
useStorageDir(dir);
const results = [];
const n = 12;
async function measure(name, fn, fixture) {
  for (let i = 0; i < 2; i++) await fn();
  const samples = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); samples.push(performance.now() - t); }
  samples.sort((a, b) => a - b);
  results.push({ name, fixture, samplesMs: samples, medianMs: samples[Math.floor(n / 2)], p95Ms: samples[Math.ceil(.95 * n) - 1] });
}
try {
  const bytes = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const e = await intakeImage(bytes, { source: 'uva-synthetic' });
  e.marks = new Map();
  const actor = { author: 'module', module: 'org.estampes.graph' };
  const axes = applySceneOps(e, [{ op: 'object.create', type: 'axes-2d', props: { xRange: [-10, 10], yRange: [-10, 10] } }], actor).created[0];
  const f = frameOf(e.objects.get(axes));
  const fn = compileExpression('tan(x)');
  await measure('sample-tan', () => sampleFunction(fn, f, [-10, 10]), { expression: 'tan(x)', range: [-10, 10] });
  for (let i = 0; i < 20; i++) applySceneOps(e, [{ op: 'object.create', type: 'function-plot', props: { expression: `sin(${i + 1}*x)`, frame: axes } }], actor);
  e.layers.push({ id: 'L99', name: 'ink', author: 'user' });
  for (let i = 0; i < 100; i++) {
    const points = Array.from({ length: 128 }, (_, j) => ({ x: j / 127, y: .1 + .8 * i / 100 + .001 * Math.sin(j) }));
    e.marks.set('ink-' + i, { id: 'ink-' + i, type: 'polyline', author: 'user', grounding: 'user-pointer', layer: 'L99', points,
      x: 0, y: Math.min(...points.map(p => p.y)), x2: 1, y2: Math.max(...points.map(p => p.y)) });
  }
  const fixture = { image: [3000, 2000], plots: 20, marks: 100, pointsPerMark: 128, outputMaxSide: 1600 };
  await measure('render-mixed-warm', () => renderCanvas(e, { maxSide: 1600 }), fixture);
  await measure('bundle-export', () => exportBundle(e.imageId), fixture);
  const bundle = await exportBundle(e.imageId);
  await measure('bundle-import-fresh', async () => {
    const target = await mkdtemp(join(dir, 'import-'));
    useStorageDir(target); clearImages(); clearWorkspaces();
    await importBundle(bundle.buffer, { collision: 'copy' });
    await flushStorage();
  }, { ...fixture, bytes: bundle.buffer.length });
  const output = { status: 'OBSERVED', commit: '7fb9b73442401fc32a7034888deaf49303e582a6',
    node: process.version, cpu: cpus()[0]?.model, cpuCount: cpus().length, hostTotalMemory: totalmem(),
    sharp: sharp.versions, warmups: 2, samples: n, rssEndBytes: process.memoryUsage().rss,
    notes: ['single process; no browser; no multi-viewer inference', 'fresh import resets registries and uses a new temporary storage directory per sample', 'RSS is endpoint snapshot, not peak or per-viewer attribution'], results };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} finally { useStorageDir(''); await rm(dir, { recursive: true, force: true }); }
