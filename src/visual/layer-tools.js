import { z } from 'zod';
import { editLayerAppearance, layerState } from './layer-appearance.js';
import { canvasRevision } from '../scene/canvas-render.js';

export function registerLayerTools(server, { ensureSet, saveCanvas }) {
  const target = { imageId: z.string().regex(/^img:[0-9a-f]{16}$/), setId: z.string().regex(/^c[0-9a-f]{12}$/).optional() };
  const load = ({ imageId, setId }) => ensureSet(imageId + (setId ? '#' + setId : ''));
  const errorResult = (error) => ({ isError: true, content: [{ type: 'text', text: error.message }], structuredContent: { kind: 'estampes.layer_error', code: error.code ?? 'INVALID_LAYER_EDIT' } });
  server.registerTool('get_visual_layers', {
    title: 'Read shared layer appearance',
    description: 'Read stable layer IDs, author, bottom-to-top order, opacity, shared visibility, locks and the canvas revision. Workspace copies require setId from get_workspace_state or canvasReads. View-local hiddenLayers may additionally hide a layer. Blend modes and brightness/contrast are not layer properties.',
    inputSchema: z.object(target), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async args => {
    try { const state = layerState(await load(args)); return { content: [{ type: 'text', text: JSON.stringify(state) }], structuredContent: state }; }
    catch (error) { return errorResult(error); }
  });
  server.registerTool('edit_visual_layers', {
    title: 'Adjust shared layer appearance',
    description: 'Adjust existing layer opacity (0..1, rounded to 0.05), visibility or bottom-to-top order without changing source pixels. Read get_visual_layers first and pass its revision as expectedRevision. Stale edits fail; refresh and review, never blindly retry. Locked layers cannot be edited, unlocked or moved. action undo/redo reverses the last appearance step if unchanged. Shared state persists and is used by render_canvas and the user canvas; use present_visual to present the result.',
    inputSchema: z.object({ ...target, expectedRevision: z.string().regex(/^cv:[0-9a-f]{24}$/), action: z.enum(['apply', 'undo', 'redo']).default('apply'),
      layers: z.array(z.object({ id: z.string().regex(/^L\d{1,6}$/), opacity: z.number().min(0).max(1).optional(), visible: z.boolean().optional() }).strict()).max(60).default([]),
      order: z.array(z.string().regex(/^L\d{1,6}$/)).max(200).optional(),
    }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async args => {
    try {
      const entry = await load(args), oldLayers = entry.layers, oldHistory = entry.layerHistory;
      if (editLayerAppearance(entry, args)) {
        const revision = canvasRevision(entry);
        try { await saveCanvas(entry, { tool: 'edit_visual_layers', author: 'assistant', action: args.action }); }
        catch (error) {
          if (canvasRevision(entry) === revision) { entry.layers = oldLayers; entry.layerHistory = oldHistory; }
          throw error;
        }
      }
      const state = layerState(entry);
      return { content: [{ type: 'text', text: JSON.stringify(state) }], structuredContent: state };
    } catch (error) { return errorResult(error); }
  });
}
