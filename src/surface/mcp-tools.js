// MCP tools for the Visual Surface workbench. The widget uses app-only
// tools (surface_get_state, surface_apply, surface_cas) with its own
// clicks; the model gets two small tools to read the surface and to open or
// close panels on the user's screen. Calculations always go through the
// module router, so a disabled or ungranted module cannot be used from a panel.
import { z } from "zod";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { widgetObjects, sceneRevision } from "../scene/scene-ops.js";
import { cellSummary } from "../cas/notebooks.js";
import { SurfaceError } from "./store.js";

const ImageIdSchema = z.string().regex(/^img:[0-9a-f]{16}$/);
const WorkspaceIdSchema = z.string().regex(/^ws:[0-9a-f]{16}$/);
const Where = { imageId: ImageIdSchema.optional(), workspaceId: WorkspaceIdSchema.optional() };
const CAS = "org.estampes.cas";
const CAS_CAPABILITIES = ["calculate", "define", "get_notebook", "recompute", "plot_result"];

const keyOf = ({ imageId, workspaceId }) => {
  if (!imageId && !workspaceId) throw new SurfaceError("give imageId or workspaceId");
  return workspaceId ?? imageId;
};
const fail = (error) => ({ isError: true, content: [{ type: "text", text: "Estampes surface: " + String(error?.message || error) }], structuredContent: { kind: "estampes.surface_error", code: error?.code ?? "error", message: String(error?.message || error).slice(0, 300) } });

// deps: { service, host, notebooks(): store, ensureImage, logSizes }
export function registerSurfaceTools(server, deps) {
  const { service, host, ensureImage } = deps;

  // The open calculator panels' notebooks, bounded.
  async function notebooksOf(view, { full = false, cells = 20 } = {}) {
    const store = deps.notebooks();
    const out = {};
    if (!store) return out;
    for (const p of view.panels) {
      if (!p.notebook || !p.open) continue;
      try { out[p.panelId] = store.summary(await store.get(p.notebook), { cells, full }); } catch { /* removed notebook */ }
    }
    return out;
  }
  const text = (view) => "Surface " + view.surfaceId + " revision " + view.revision + ": " +
    view.panels.filter((p) => p.open).map((p) => p.panelId + " (" + p.kind + ")").join(", ");

  registerAppTool(server, "surface_get_state", {
    title: "Read the surface",
    description: "Panels, layouts and open calculator notebooks of the Visual Surface, for the Estampes widget.",
    inputSchema: z.object({ ...Where }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  }, async (args) => {
    try {
      if (args.imageId) await ensureImage(args.imageId);
      const view = await service.state(keyOf(args));
      return { content: [{ type: "text", text: text(view) }], structuredContent: { kind: "estampes.surface", ...view, notebooks: await notebooksOf(view, { full: true, cells: 50 }) } };
    } catch (error) { return fail(error); }
  });

  registerAppTool(server, "surface_apply", {
    title: "Arrange the surface",
    description: "Open or close panels and move, resize, dock or reorder them (user action from the widget). Layouts are kept per device profile.",
    inputSchema: z.object({
      ...Where, expectedRevision: z.number().int().min(1).optional(), idempotencyKey: z.string().min(1).max(64).optional(),
      ops: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  }, async ({ imageId, workspaceId, expectedRevision, idempotencyKey, ops }) => {
    try {
      if (imageId) await ensureImage(imageId);
      const view = await service.apply(keyOf({ imageId, workspaceId }), { ops, expectedRevision, idempotencyKey });
      return { content: [{ type: "text", text: text(view) }], structuredContent: { kind: "estampes.surface", ...view, notebooks: await notebooksOf(view, { full: true, cells: 50 }) } };
    } catch (error) { return fail(error); }
  });

  registerAppTool(server, "surface_cas", {
    title: "Run a calculator action",
    description: "Run one calculator (org.estampes.cas) capability for a panel: calculate, define, get_notebook, recompute or plot_result. Goes through the module router, so the module must be enabled and granted.",
    inputSchema: z.object({
      imageId: ImageIdSchema.optional(), capability: z.enum(CAS_CAPABILITIES),
      params: z.record(z.string(), z.unknown()).refine((o) => JSON.stringify(o).length <= 20000, "params too large"),
      expectedSceneRevision: z.number().int().min(0).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  }, async ({ imageId, capability, params, expectedSceneRevision }) => {
    try {
      const needsCanvas = capability === "plot_result";
      if (needsCanvas && !imageId) throw new SurfaceError("plot_result needs the canvas (imageId)");
      const out = await host.router.execute({
        module: CAS, capability, params: capability === "calculate" || capability === "define" ? { by: "user", ...params } : params,
        ...(needsCanvas ? { canvas: imageId, ...(expectedSceneRevision !== undefined ? { expectedRevision: expectedSceneRevision } : {}) } : {}),
      });
      const changed = out.scene.created.length || out.scene.updated.length;
      return {
        content: [{ type: "text", text: out.summary ?? capability + " done" }],
        structuredContent: {
          kind: "estampes.surface_cas", capability, summary: out.summary, data: out.data,
          ...(changed && out.entry ? { objects: widgetObjects(out.entry), sceneRevision: sceneRevision(out.entry), created: out.scene.created, updated: out.scene.updated } : {}),
        },
      };
    } catch (error) { return fail(error); }
  });

  server.registerTool("get_surface_state", {
    title: "Read the Visual Surface state",
    description: "What the user has open on the Estampes Visual Surface: panels (canvas/Graph, scientific calculator), which are open, and every calculator cell with its exact result, status (exact, approximate, complex, conditional, partial, undefined), freshness (fresh/stale/error) and the Graph objects drawn from it. Read this instead of asking the user what they typed into the calculator. Results here were computed by SymPy; do not restate them differently.",
    inputSchema: z.object({ ...Where, cells: z.number().int().min(1).max(100).default(30) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (args) => {
    try {
      if (args.imageId) await ensureImage(args.imageId);
      const view = await service.state(keyOf(args));
      const notebooks = await notebooksOf(view, { cells: args.cells });
      const compact = { surfaceId: view.surfaceId, revision: view.revision, panels: view.panels.map((p) => ({ panelId: p.panelId, kind: p.kind, module: p.module, open: p.open, moduleState: p.moduleState, ...(p.notebook ? { notebook: p.notebook } : {}) })),
        available: view.available, notebooks };
      return { content: [{ type: "text", text: JSON.stringify(compact) }], structuredContent: { kind: "estampes.surface_state", ...compact } };
    } catch (error) { return fail(error); }
  });

  server.registerTool("manage_surface_panels", {
    title: "Open or close a panel on the user's surface",
    description: "Open or close a panel (for example the scientific calculator) on the user's Visual Surface. This changes what the user sees, so use it only when they asked for it or it is clearly needed. Opening never enables a module: if the module is disabled, ask the user to enable it in the Store (open_module_store). Closing keeps the panel's data.",
    inputSchema: z.object({
      ...Where, action: z.enum(["open", "close"]),
      module: z.string().max(100).optional().describe("open: module id, e.g. org.estampes.cas"),
      panel: z.string().max(40).optional().describe("open: panel id from get_surface_state.available, e.g. calculator"),
      panelId: z.string().max(40).optional().describe("close: instance id such as p:calculator1"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ imageId, workspaceId, action, module, panel, panelId }) => {
    try {
      if (imageId) await ensureImage(imageId);
      const op = action === "open" ? { op: "open-panel", module, panel } : { op: "close-panel", panelId };
      if (action === "open" && (!module || !panel)) throw new SurfaceError("open needs module and panel");
      if (action === "close" && !panelId) throw new SurfaceError("close needs panelId");
      const view = await service.apply(keyOf({ imageId, workspaceId }), { ops: [op] });
      return { content: [{ type: "text", text: (action === "open" ? "Opened " : "Closed ") + "panel. " + text(view) + ". The widget shows it after it refreshes." }], structuredContent: { kind: "estampes.surface_state", surfaceId: view.surfaceId, revision: view.revision, panels: view.panels } };
    } catch (error) { return fail(error); }
  });
}
