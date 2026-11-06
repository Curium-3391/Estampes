// The canvas stays the writer; checkpoints are copied into read-only UVA
// documents. Real server process, real MCP calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { startStack } from './helpers/widget-host.js';
import { setTimeout as sleep } from 'node:timers/promises';

const env = beta => ({ ESTAMPES_UVA_BETA: '1', ESTAMPES_UVA_BETA_DIR: beta, ESTAMPES_UVA_BETA_PROFILE: 'linux-process-crash-test', ESTAMPES_UVA_MIRROR: '1', ESTAMPES_UVA_MIRROR_IDLE_SEC: '0', ESTAMPES_RATE_LIMIT_PER_MIN: '0' });
async function upload(stack, color) {
  const data = (await sharp({ create: { width: 320, height: 200, channels: 3, background: color } }).png().toBuffer()).toString('base64');
  return (await stack.call('upload_visual_image', { total: data.length, offset: 0, data, fileName: color + '.png' })).structuredContent.imageId;
}
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('timed out waiting'); await sleep(100); }
}

test('canvas checkpoints appear in a read-only UVA mirror; unchanged canvases write nothing', { timeout: 90000 }, async t => {
  const beta = await mkdtemp(join(tmpdir(), 'uva-mirror-'));
  const stack = await startStack({ cas: false, env: env(beta) });
  t.after(async () => { await stack.close(); await rm(beta, { recursive: true, force: true }); });
  const imageId = await upload(stack, '#336699');
  const list = async () => (await stack.call('experimental_workspace', { action: 'list' })).structuredContent;
  assert.equal((await list()).workspaces.length, 0);
  assert.equal((await list()).diagnostics.mirror.enabled, true);

  // Edit through the ordinary canvas tool.
  const r = await stack.call('present_visual', { imageId, annotations: [{ id: 'a1', type: 'rect', x: .1, y: .2, x2: .4, y2: .5, label: 'first' }] });
  assert.ok(!r.isError, JSON.stringify(r));
  const mirror = await until(async () => (await list()).workspaces[0]);
  assert.equal(mirror.items, 1);
  const open = async () => (await stack.call('experimental_workspace', { action: 'open', documentId: mirror.id })).structuredContent;
  let doc = (await open()).document;
  assert.equal(doc.provenance.legacySetKey, imageId);
  assert.equal(doc.scenes[0].annotations.length, 1);
  assert.equal(doc.scenes[0].annotations[0].label, 'first');
  assert.equal(doc.extensions['estampes.beta:mirror'].authority, 'legacy-canvas');
  const rev1 = doc.revision;

  // A second edit updates the same document; nothing duplicates.
  await stack.call('present_visual', { imageId, annotations: [{ id: 'a2', type: 'point', x: .7, y: .7, label: 'second' }] });
  await until(async () => (await open()).document.revision > rev1);
  doc = (await open()).document;
  assert.equal((await list()).workspaces.length, 1);
  assert.deepEqual(doc.scenes[0].annotations.map(a => a.label).sort(), ['first', 'second']);

  // Re-saving the same canvas (nothing changed) must not commit again.
  const rev2 = doc.revision;
  await stack.call('present_visual', { imageId });
  await sleep(1500);
  assert.equal((await open()).document.revision, rev2);

  // GPT/Workbench cannot edit a mirror: the canvas is the writer.
  const p = await stack.call('experimental_workspace', { action: 'prepare', requestId: 'req:' + randomUUID(), documentId: mirror.id, expectedRevision: rev2, operation: { type: 'rename', title: 'x' } });
  assert.equal(p.isError, true);
  assert.match(p.content[0].text, /mirrors the canvas/);
});

test('a canvas the document model cannot hold is skipped without touching its save', { timeout: 90000 }, async t => {
  const beta = await mkdtemp(join(tmpdir(), 'uva-mirror-blocked-'));
  const stack = await startStack({ cas: false, env: env(beta) });
  t.after(async () => { await stack.close(); await rm(beta, { recursive: true, force: true }); });
  const imageId = await upload(stack, '#996633');
  const layer = await stack.call('add_image_layer', { imageId });
  assert.ok(!layer.isError, JSON.stringify(layer));
  await stack.call('present_visual', { imageId, annotations: [{ id: 'a1', type: 'point', x: .5, y: .5, label: 'still saved' }] });
  const status = await until(async () => { const d = (await stack.call('experimental_workspace', { action: 'status' })).structuredContent.diagnostics.mirror; return d.blocked?.[imageId] ? d : null; });
  assert.match(status.blocked[imageId], /PNG object/);
  // The canvas itself kept the mark.
  const st = await stack.call('get_visual_state', { imageId });
  assert.ok(JSON.stringify(st).includes('still saved'), JSON.stringify(st).slice(0, 400));
  assert.equal((await stack.call('experimental_workspace', { action: 'list' })).structuredContent.workspaces.length, 0);
});

test('a burst of canvas edits becomes a few checkpoints, not one commit per edit', { timeout: 90000 }, async t => {
  const beta = await mkdtemp(join(tmpdir(), 'uva-mirror-burst-'));
  const stack = await startStack({ cas: false, env: { ...env(beta), ESTAMPES_UVA_MIRROR_IDLE_SEC: '2' } });
  t.after(async () => { await stack.close(); await rm(beta, { recursive: true, force: true }); });
  const imageId = await upload(stack, '#663399');
  for (let i = 0; i < 12; i++) {
    const r = await stack.call('present_visual', { imageId, annotations: [{ id: 'm' + i, type: 'point', x: (i + 1) / 14, y: .5, label: 'p' + i }] });
    assert.ok(!r.isError, JSON.stringify(r));
  }
  const diag = async () => (await stack.call('experimental_workspace', { action: 'status' })).structuredContent.diagnostics.mirror;
  await until(async () => { const d = await diag(); return d.syncs >= 1 && d.pending === 0; }, 30000);
  const d = await diag();
  assert.ok(d.syncs <= 3, 'too many commits for one burst: ' + JSON.stringify(d));
  const list = (await stack.call('experimental_workspace', { action: 'list' })).structuredContent.workspaces;
  const doc = (await stack.call('experimental_workspace', { action: 'open', documentId: list[0].id })).structuredContent.document;
  assert.equal(doc.scenes[0].annotations.length, 12);
});
