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
import { refreshLinks, autoRefresh } from "./refresh.js";

// The canvas: an image (img:) or a Graph document (gph:, UVA Phase 4A-4).
const ImageIdSchema = z.string().regex(/^(img|gph):[0-9a-f]{16}$/);
const WorkspaceIdSchema = z.string().regex(/^ws:[0-9a-f]{16}$/);
const Where = { imageId: ImageIdSchema.optional(), workspaceId: WorkspaceIdSchema.optional() };
const CAS = "org.estampes.cas";
const CAS_CAPABILITIES = ["calculate", "define", "get_notebook", "recompute", "plot_result", "set_options", "refresh_links"];

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
      let out = null, refreshed = null;
      if (capability !== "refresh_links") {
        out = await host.router.execute({
          module: CAS, capability, params: capability === "calculate" || capability === "define" ? { by: "user", ...params } : params,
          ...(needsCanvas ? { canvas: imageId, ...(expectedSceneRevision !== undefined ? { expectedRevision: expectedSceneRevision } : {}) } : {}),
        });
      }
      const notebookId = params.notebook ?? out?.data?.notebookId;
      if (notebookId && capability === "refresh_links") refreshed = await refreshLinks({ host, notebooks: deps.notebooks(), notebookId, imageId: imageId ?? null });
      else if (notebookId) refreshed = await autoRefresh({ host, notebooks: deps.notebooks(), capability, notebookId, imageId: imageId ?? null });
      const entry = refreshed?.entry ?? out?.entry;
      const changed = refreshed?.updated.length || out?.scene.created.length || out?.scene.updated.length;
      const summary = out?.summary ?? (refreshed ? "Graph links refreshed" : capability + " done");
      return {
        content: [{ type: "text", text: summary + (refreshed ? " (updated " + refreshed.updated.length + " plot(s)" + (refreshed.failed.length ? ", " + refreshed.failed.length + " could not be updated" : "") + (refreshed.remaining ? ", " + refreshed.remaining + " cell(s) still stale" : "") + ")" : "") }],
        structuredContent: {
          kind: "estampes.surface_cas", capability, summary, data: out?.data ?? {},
          ...(refreshed ? { refresh: { recomputed: refreshed.recomputed, updated: refreshed.updated, failed: refreshed.failed, remaining: refreshed.remaining } } : {}),
          ...(changed && entry ? { objects: widgetObjects(entry), sceneRevision: sceneRevision(entry), created: out?.scene.created ?? [], updated: out?.scene.updated ?? [] } : {}),
        },
      };
    } catch (error) { return fail(error); }
  });

  // Stops a running calculation the panel started (its `job` id). Nothing is
  // written: a cancelled calculation leaves no cell and no error behind.
  registerAppTool(server, "surface_cas_cancel", {
    title: "Stop a calculation",
    description: "Cancel the calculator job with this id, if it is still running.",
    inputSchema: z.object({ job: z.string().regex(/^[0-9a-f]{8,32}$/) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  }, async ({ job }) => {
    try {
      const client = deps.casClient?.();
      if (!client) throw new SurfaceError("the calculator service is not configured");
      const r = await client.cancel(job);
      return { content: [{ type: "text", text: r.cancelled ? "Calculation stopped." : "Nothing was running for that job." }],
        structuredContent: { kind: "estampes.surface_cas_cancel", job, cancelled: !!r.cancelled } };
    } catch (error) { return fail(error); }
  });

  const modelIndex = async () => {
    const store = host.models;
    if (!store) return {};
    const rows = await store.index({ limit: 100 }).catch(() => []);
    if (!rows.length) return {};
    return { models: rows.map((r) => ({ ...r, moduleState: host.registry.get(r.module)?.record.state ?? "removed" })) };
  };

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
        available: view.available, notebooks,
        // #85: instances of module-owned data (no values; read one with the module's models.get through execute_module).
        ...(await modelIndex()) };
      return { content: [{ type: "text", text: JSON.stringify(compact) }], structuredContent: { kind: "estampes.surface_state", ...compact } };
    } catch (error) { return fail(error); }
  });

  // Opens a panel and shows the user the surface. With an imageId the widget
  // opens on that canvas (a photo or an earlier canvas); with neither imageId
  // nor workspaceId a new blank canvas is made so a calculator can be shown
  // without any picture. `notebook` attaches a calculation the model already
  // made (execute_module org.estampes.cas) to the new calculator panel.
  registerAppTool(server, "manage_surface_panels", {
    title: "Open or close a panel on the user's surface",
    description: "Open or close a panel (for example the scientific calculator) on the user's Visual Surface and show it. Use it when the user asks to open the calculator, or to show the calculator beside a canvas: pass the imageId of the canvas they are looking at (omit it to start a blank canvas). " +
      "After running org.estampes.cas through execute_module, pass that result's notebookId as `notebook` so the user sees the same cells. Opening never enables a module: if it is disabled the user enables it in the Store first. Panels: get_surface_state lists what is available.",
    inputSchema: z.object({
      ...Where, action: z.enum(["open", "close"]),
      module: z.string().max(100).optional().describe("open: module id, e.g. org.estampes.cas"),
      panel: z.string().max(40).optional().describe("open: panel id from get_surface_state.available, e.g. calculator"),
      panelId: z.string().max(40).optional().describe("close: instance id such as p:calculator1"),
      notebook: z.string().regex(/^nb:[0-9a-f]{12}$/).optional().describe("open calculator: show this existing notebook instead of a new one"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: deps.visualUri } },
  }, async ({ imageId, workspaceId, action, module, panel, panelId, notebook }) => {
    try {
      if (action === "open" && (!module || !panel)) throw new SurfaceError("open needs module and panel");
      if (action === "close" && !panelId) throw new SurfaceError("close needs panelId");
      let entry = null, made = false;
      if (imageId) entry = await ensureImage(imageId);
      else if (!workspaceId) { entry = await host.canvases.create({}); await host.canvases.save(entry, { tool: "manage_surface_panels", author: "module", changed: [] }); made = true; }
      const op = action === "open" ? { op: "open-panel", module, panel, ...(notebook ? { notebook } : {}) } : { op: "close-panel", panelId };
      // Asking again for a panel that is already open shows it; a second
      // window is something the user opens from the launcher.
      const already = action === "open" && !notebook && !made && (await service.state(keyOf({ imageId: entry?.imageId, workspaceId }))).panels.some((p) => p.open && p.module === module && p.panel === panel);
      let view = already ? await service.state(keyOf({ imageId: entry?.imageId, workspaceId })) : await service.apply(keyOf({ imageId: entry?.imageId, workspaceId }), { ops: [op] });
      // No canvas was asked for: nothing is shown behind the new panel. The
      // panel fills the workbench (the blank canvas stays one click away).
      if (made && action === "open") {
        const mine = view.panels.filter((p) => p.open && p.module === module && p.panel === panel).at(-1);
        if (mine) view = await service.apply(keyOf({ imageId: entry.imageId }), { ops: ["desktop", "tablet", "mobile"].flatMap((profile) => [
          { op: "layout", profile, layout: { op: "focus", panelId: mine.panelId } }, { op: "layout", profile, layout: { op: "maximize", panelId: mine.panelId } }]) });
      }
      const base = { content: [{ type: "text", text: (action === "open" ? "Opened " : "Closed ") + "panel" + (made ? " on a new blank canvas " + entry.imageId : "") + ". " + text(view) + "." + (entry ? " The user sees it on canvas " + entry.imageId + "." : " Use present_visual with the workspaceId to show the workspace.") }],
        structuredContent: { kind: "estampes.surface_state", surfaceId: view.surfaceId, revision: view.revision, panels: view.panels.map((p) => ({ panelId: p.panelId, kind: p.kind, open: p.open, notebook: p.notebook })), ...(entry ? { imageId: entry.imageId } : {}) } };
      if (!entry || !deps.canvasPayload) return base;
      const payload = await deps.canvasPayload(entry);
      return { content: base.content, structuredContent: { ...payload.structuredContent, surface: base.structuredContent }, _meta: payload._meta };
    } catch (error) { return fail(error); }
  });
}
