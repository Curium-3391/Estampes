import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startStack, noBrowser } from './helpers/widget-host.js';

test('assistant refines photo + Graph + annotations; user UI and tools share appearance', { skip: noBrowser, timeout: 90000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const ok = async (name, args) => {
      const result = await s.call(name, args);
      assert.ok(!result.isError, name + ': ' + JSON.stringify(result.content));
      return result;
    };
    const tools = (await s.client.listTools()).tools;
    for (const name of ['get_visual_layers','edit_visual_layers']) {
      const tool = tools.find(t => t.name === name);
      assert.ok(tool);
      assert.notDeepEqual(tool._meta?.ui?.visibility, ['app']);
    }
    await s.enable(['org.estampes.graph']);
    const data = (await sharp({ create: { width: 640, height: 480, channels: 3, background: '#568ba1' } }).jpeg().toBuffer()).toString('base64');
    const uploaded = await ok('upload_visual_image', { fileName: 'photo.jpg', total: data.length, offset: 0, data });
    const imageId = uploaded.structuredContent.uploaded.imageId;
    await ok('execute_module', { module: 'org.estampes.graph', capability: 'plot_function', canvas: imageId, params: { expression: 'sin(x)' }, layer: 'Graph' });
    await ok('present_visual', { imageId, layer: 'Annotations', annotations: [{ id: 'target', type: 'rect', x: .2, y: .2, x2: .6, y2: .6, label: 'Target' }] });
    // Convert the photo to an independent image layer, using the existing UI operation.
    await ok('add_image_layer', { imageId });
    const before = (await ok('get_visual_layers', { imageId })).structuredContent;
    const graph = before.layers.find(l => l.name === 'Graph'), annotation = before.layers.find(l => l.name === 'Annotations');
    const pixels = await ok('render_canvas', { imageId, maxSide: 640 });
    const refined = await ok('edit_visual_layers', { imageId, expectedRevision: before.revision, layers: [{ id: graph.id, opacity: .25 }, { id: annotation.id, opacity: .75 }] });
    assert.notEqual((await ok('render_canvas', { imageId, maxSide: 640 })).content.find(c => c.type === 'image').data, pixels.content.find(c => c.type === 'image').data);
    const stale = await s.call('edit_visual_layers', { imageId, expectedRevision: before.revision, layers: [{ id: graph.id, opacity: 1 }] });
    assert.equal(stale.structuredContent.code, 'STALE_CANVAS');
    const ui = await s.open({ imageId });
    await ui.frame.locator('#layer-manager summary').click();
    const row = ui.frame.locator('#layer-manager .row[data-layer="' + graph.id + '"]');
    assert.equal(await row.locator('input[data-act=opacity]').inputValue(), '25');
    await row.locator('input[data-act=opacity]').fill('50');
    await row.locator('input[data-act=opacity]').dispatchEvent('change');
    await ui.frame.locator('#status').filter({ hasText: '已調整透明度' }).waitFor();
    const user = (await ok('get_visual_layers', { imageId })).structuredContent;
    assert.equal(user.layers.find(l => l.id === graph.id).opacity, .5);
    assert.notEqual(user.revision, refined.structuredContent.revision);
    // A user edit must block stale assistant undo as well.
    const undo = await s.call('edit_visual_layers', { imageId, expectedRevision: user.revision, action: 'undo' });
    assert.equal(undo.structuredContent.code, 'HISTORY_CONFLICT');
    await row.locator('input[data-act=toggle]').uncheck();
    await ui.frame.locator('#status').filter({ hasText: '已調整圖層顯示' }).waitFor();
    let state = (await ok('get_visual_layers', { imageId })).structuredContent;
    assert.equal(state.layers.find(l => l.id === graph.id).visible, false);
    assert.equal((await ok('render_canvas', { imageId })).structuredContent.included.objects.some(id => id === 'o1'), false);
    await ui.reload();
    await ui.frame.locator('#layer-manager summary').click();
    assert.equal(await row.locator('input[data-act=toggle]').isChecked(), false);
    // Locked layers remain readable but assistant changes fail.
    await ok('edit_visual_canvas', { imageId, layers: [{ id: graph.id, locked: true }] });
    state = (await ok('get_visual_layers', { imageId })).structuredContent;
    const locked = await s.call('edit_visual_layers', { imageId, expectedRevision: state.revision, layers: [{ id: graph.id, visible: true }] });
    assert.equal(locked.structuredContent.code, 'LAYER_LOCKED');
    assert.deepEqual(ui.errors, []);
    await ui.shot('layer-appearance-refined');
    const last = await ok('edit_visual_layers', { imageId, expectedRevision: state.revision, layers: [{ id: annotation.id, opacity: .3 }] });
    await s.close();
    const restarted = await startStack({ cas: false, env: { ESTAMPES_STORAGE_DIR: s.dir } });
    try {
      const read = (await restarted.call('get_visual_layers', { imageId })).structuredContent;
      assert.equal(read.revision, last.structuredContent.revision);
      assert.equal(read.history.canUndo, true);
      const undone = await restarted.call('edit_visual_layers', { imageId, expectedRevision: read.revision, action: 'undo' });
      assert.ok(!undone.isError, JSON.stringify(undone.content));
      assert.equal(undone.structuredContent.layers.find(l => l.id === annotation.id).opacity, .75);
      const redone = await restarted.call('edit_visual_layers', { imageId, expectedRevision: undone.structuredContent.revision, action: 'redo' });
      assert.equal(redone.structuredContent.revision, read.revision);
    } finally { await restarted.close(); }
  } finally { await s.close(); }
});
