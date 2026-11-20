// MCP tools for modules. The model sees a fixed, small set (open the Store,
// list modules, read a module's capabilities, run one, prepare a change);
// enabling a module never adds tools, so no reconnect is needed. The Store
// widget uses app-only tools for browsing and for committing a change,
// which needs the plan's consent nonce that only the widget receives.
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { localized } from "./manifest.js";
import { JOB_ID } from "./jobs.js";
import { describePermission, riskOf, capabilityPermissions } from "./permissions.js";
import { compactObject, renderedObjects, widgetObjects, applySceneOps, sceneRevision } from "../scene/scene-ops.js";
import { renderPreview } from "../scene/preview.js";
import { BACKGROUNDS } from "../scene/blank-canvas.js";

const ModuleIdSchema = z.string().min(3).max(100).describe("Module id, e.g. org.estampes.graph");
// A module works on a canvas: an image (img:) or a Graph document (gph:).
const ImageIdSchema = z.string().regex(/^(img|gph):[0-9a-f]{16}$/);
const STATE_TEXT = { available: "not enabled", installed: "installed, not enabled", enabled: "ENABLED", disabled: "disabled", failed: "failed" };

// A result the user does not need to see yet (#81): the widget shows a
// one-line note with a button instead of reopening the canvas. The model's
// content is unchanged apart from one sentence saying so.
export const BACKGROUND = "background";
export function inBackground(result) {
  if (!result || result.isError) return result;
  const note = { type: "text", text: "(Shown to the user only as a one-line background note; their canvas was not reopened. Call present_visual with this imageId to show the result.)" };
  return { ...result, content: [...(result.content ?? []), note], _meta: { ...(result._meta ?? {}), "estampes/presentation": BACKGROUND } };
}

export function catalogEntry(mod, lang = "zh-TW") {
  const m = mod.manifest;
  return {
    id: m.id, name: localized(m, "name", lang), description: localized(m, "description", lang), version: m.version,
    publisher: m.publisher.name, ...(m.v2 ? { abi: m.v2.abi } : {}), license: m.license, category: m.category, source: mod.source, runtime: m.runtime.kind,
    ...(m.homepage ? { homepage: m.homepage } : {}), ...(m.source ? { sourceUrl: m.source } : {}),
    state: mod.record.state, granted: mod.record.granted ?? [],
    permissions: m.permissions.map(describePermission), risk: riskOf(m.permissions),
    ...(m.network ? { network: m.network } : {}),
    capabilities: m.capabilities.map((c) => ({ id: c.id, title: localized(c, "title", lang) ?? c.id, description: c.description, target: m.v2?.targets[c.id] ?? c.target,
      ...(c.async ? { async: true } : {}), ...(localized(c, "profile", lang) ? { profile: localized(c, "profile", lang) } : {}) })),
    ...(m.panels?.length ? { panels: m.panels.map((p) => ({ id: p.id, title: localized(p, "title", lang), kind: p.kind, maxInstances: p.maxInstances })) } : {}),
    ...(mod.package ? { package: { sha256: mod.package.sha256, keyId: mod.package.keyId, installedAt: mod.package.installedAt } } : {}),
    ...(mod.record.previous?.length ? { rollbackTo: mod.record.previous.at(-1).version } : {}),
  };
}

const catalogText = (list) => list.map((m) => m.id + " " + m.version + " \"" + m.name + "\" [" + STATE_TEXT[m.state] + "]: " +
  m.capabilities.map((c) => c.id).join(", ")).join("\n");

// deps: { host, coreVersion, storeUri, storeHtml, legacyStoreUris, visualUri, canvasPayload(entry), logSizes, admin }
export function registerModuleTools(server, deps) {
  const { host, storeUri, storeHtml, visualUri, canvasPayload, logSizes } = deps;
  const fail = (error) => ({ isError: true, content: [{ type: "text", text: "Estampes modules: " + String(error?.message || error) }] });
  const catalog = () => host.registry.list().map((m) => catalogEntry(m));
  const adminInfo = () => host.admin?.status?.() ?? { configured: false };

  for (const uri of [storeUri, ...(deps.legacyStoreUris ?? [])]) {
    registerAppResource(server, "Estampes module store", uri, { mimeType: RESOURCE_MIME_TYPE },
      async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: storeHtml }] }));
  }

  registerAppTool(server, "open_module_store", {
    title: "Open the Estampes module store",
    description: "Show the Estampes Store inside the chat: the modules this server has (e.g. Graph for plotting functions), what each can do, the permissions it asks for, and whether it is enabled. The user enables, disables, installs or updates modules there with their own clicks; you cannot approve changes for them. Call it when the user asks for the store, for modules or plugins, or when a module you need is not enabled.",
    inputSchema: z.object({
      tab: z.enum(["browse", "installed", "activity"]).default("browse"),
      module: ModuleIdSchema.optional().describe("Open this module's detail page"),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: storeUri } },
  }, async ({ tab, module }) => {
    const list = catalog();
    return {
      content: [{ type: "text", text: "Estampes Store opened (" + tab + (module ? ", " + module : "") + "). Modules on this server:\n" + catalogText(list) +
        "\nThe user enables modules in the Store. Enabled modules run through execute_module; their capabilities and input schemas come from get_module_capabilities." }],
      structuredContent: { kind: "estampes.module_store", tab, ...(module ? { module } : {}), modules: list, admin: adminInfo() },
    };
  });

  server.registerTool("list_modules", {
    title: "List Estampes modules",
    description: "List the modules on this Estampes server with their state (enabled or not) and capability ids. Read-only.",
    inputSchema: z.object({ state: z.enum(["any", "enabled"]).default("any") }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ state }) => {
    const list = catalog().filter((m) => state === "any" || m.state === "enabled");
    return { content: [{ type: "text", text: catalogText(list) || "(no modules)" }], structuredContent: { kind: "estampes.modules", modules: list } };
  });

  server.registerTool("get_module_capabilities", {
    title: "Read a module's capabilities",
    description: "Return one module's capabilities with their exact input schemas, examples, target (none, canvas, canvas-or-new) and the permissions they need, plus whether the module is enabled. Each capability can carry a profile: when to use it and when not to, input limits, cost (latency, resources, billing), where data goes, how far to trust the result and how to check it, and what to do when it fails. Read it before the first execute_module call to a module, and follow its fallbacks when a run fails.",
    inputSchema: z.object({ module: ModuleIdSchema }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ module }) => {
    try {
      const mod = host.registry.get(module);
      if (!mod) throw new Error("no module " + module + "; call list_modules");
      const m = mod.manifest;
      const caps = m.capabilities.map((c) => ({ id: c.id, title: c.title, description: c.description, target: m.v2?.targets[c.id] ?? c.target,
        permissions: capabilityPermissions(m, c), inputSchema: c.inputSchema, ...(c.async ? { async: true } : {}),
        ...(c.profile ? { profile: c.profile } : {}), ...(c.examples ? { examples: c.examples.map(({ description, params }) => ({ description, params })) } : {}) }));
      return {
        content: [{ type: "text", text: m.id + " " + m.version + " is " + STATE_TEXT[mod.record.state] + ". " + JSON.stringify(caps) }],
        structuredContent: { kind: "estampes.module_capabilities", module: m.id, version: m.version, state: mod.record.state, capabilities: caps },
      };
    } catch (error) { return fail(error); }
  });

  registerAppTool(server, "execute_module", {
    title: "Run an Estampes module",
    description: "Run one capability of an ENABLED module (see list_modules / get_module_capabilities) and show the result on the shared canvas. " +
      "Modules add editable objects, not pictures: Graph's plot_function keeps the formula, so a later update_plot with the same object id re-computes the curve, and the user can edit it in the canvas. " +
      "`canvas` = an imageId to draw on (a photo or an earlier canvas); leave it out to start a new blank canvas when the capability allows (target canvas-or-new). " +
      "Results list object ids and the canvas's scene revision; pass expectedRevision to refuse the change if the canvas changed meanwhile. " +
      "visibility 'scratch' keeps objects as your own working notes, drawn only in the preview image you get, not in the user's canvas; publish them later with the module or leave them. " +
      "The result includes a PREVIEW image of the canvas with all objects: check it before telling the user it is done. " +
      "present false (for iterative tuning: several runs before you show anything) keeps the chat quiet: the canvas is not reopened for the user, only a one-line note with a 顯示畫布 button; you still get the preview. Show the final result with present_visual({imageId}).", // model-facing (T3) text naming a zh-TW UI label; Phase 2. i18n-ignore
    inputSchema: z.object({
      module: ModuleIdSchema,
      capability: z.string().min(1).max(48),
      params: z.record(z.string(), z.unknown()).default({}).describe("Input for the capability, matching its inputSchema"),
      canvas: ImageIdSchema.optional().describe("imageId of the canvas to work on"),
      newCanvas: z.object({
        width: z.number().int().min(200).max(4096).optional(), height: z.number().int().min(200).max(4096).optional(),
        background: z.enum(Object.keys(BACKGROUNDS)).optional(), title: z.string().max(80).optional(),
        kind: z.enum(["image", "graph"]).optional().describe("graph: a Graph document (gph:) drawn on a plain colour, with no image behind it"),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Background colour of a graph (#rrggbb, default white)"),
      }).strict().refine((o) => o.kind === "graph" ? o.background === undefined : o.color === undefined, "background is for an image canvas, color for a graph")
        .optional().describe("Options for a new blank canvas, 1600x1000 by default. Without kind it is a Graph document (gph:) on servers with the canvas store; kind image (or a background preset) gives a blank image"),
      expectedRevision: z.number().int().min(0).optional(),
      visibility: z.enum(["public", "scratch"]).default("public"),
      layer: z.string().trim().min(1).max(40).optional().describe("Layer name for new objects; default the module's name"),
      preview: z.boolean().default(true),
      present: z.boolean().default(true).describe("false: run in the background without reopening the user's canvas (#81); call present_visual when done"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: visualUri } },
  }, async ({ module, capability, params, canvas, newCanvas, expectedRevision, visibility, layer, preview, present = true }) => {
    const shown = (result) => (present ? result : inBackground(result));
    try {
      const run = await host.router.execute({ module, capability, params, canvas, newCanvas, expectedRevision, visibility, layer });
      const { entry, scene } = run;
      // A module can ask to be followed up (the calculator redraws its linked plots); a failure there never hides the run itself.
      const followUp = run.job || !deps.afterRun ? "" : await Promise.resolve(deps.afterRun({ module, capability, params, run })).then((n) => (n ? " " + n : ""), () => "");
      if (run.job) {
        return shown({ content: [{ type: "text", text: module + " " + capability + " is running in the background as " + run.job.id + (entry ? " on canvas " + entry.imageId : "") +
          ". It can take minutes. Call get_module_job with this id (waitSeconds up to 25) until its status is done or failed; the result lands on the canvas when it is done. Tell the user it is running." }],
          structuredContent: entry ? { ...(await canvasPayload(entry)).structuredContent, kind: "estampes.module_job", job: run.job } : { kind: "estampes.module_job", job: run.job },
          ...(entry ? { _meta: (await canvasPayload(entry))._meta } : {}) });
      }
      if (!entry) {
        const panels = host.registry.get(module)?.manifest.panels ?? [];
        const hint = panels.length ? " This result is not on a canvas, so the user sees nothing yet. To show it, call manage_surface_panels (action open, module " + module + ", panel " + panels[0].id +
          (run.data?.notebookId ? ", notebook " + run.data.notebookId : "") + ") with the imageId of the canvas they are looking at; omit imageId for a blank canvas." : "";
        return { content: [{ type: "text", text: module + " " + capability + ": " + (run.summary ?? "done") + (run.data !== undefined ? " " + JSON.stringify(run.data) : "") + hint + followUp }],
          structuredContent: { kind: "estampes.module_result", module, capability, ...(run.data !== undefined ? { data: run.data } : {}) } };
      }
      const objects = renderedObjects(entry).map(compactObject);
      const shot = preview ? await renderPreview(entry) : null;
      const payload = await canvasPayload(entry);
      const text = module + " " + capability + (run.summary ? " (" + run.summary + ")" : "") + ": " +
        (run.createdCanvas ? "new blank canvas " + entry.imageId + " (" + entry.width + "x" + entry.height + "). " : "canvas " + entry.imageId + ". ") +
        (scene.created.length ? "Created " + scene.created.join(", ") + ". " : "") + (scene.updated.length ? "Updated " + scene.updated.join(", ") + ". " : "") +
        (scene.deleted.length ? "Deleted " + scene.deleted.join(", ") + ". " : "") +
        (scene.notes?.length ? "WARNINGS: " + scene.notes.map((n) => n.id + ": " + n.note).join("; ") + ". " : "") +
        "Scene revision " + scene.revision + ". Objects on the canvas: " + JSON.stringify(objects) + followUp +
        (shot ? ". The next image is a PREVIEW of the canvas" + (objects.some((o) => o.visibility === "scratch") ? " (scratch objects included, faded; the user does not see them)" : "") + "." : "");
      return logSizes("execute_module", shown({
        content: [{ type: "text", text }, ...(shot ? [{ type: "image", data: shot.data.toString("base64"), mimeType: shot.mimeType }] : [])],
        structuredContent: { ...payload.structuredContent, module: { id: module, capability, revision: scene.revision, created: scene.created, updated: scene.updated }, objects },
        _meta: payload._meta,
      }));
    } catch (error) { return fail(error); }
  });

  registerAppTool(server, "get_module_job", {
    title: "Check a module's background job",
    description: "Return the status of a background job started by execute_module (running, done, failed or interrupted), with its progress, result summary and the objects it created. waitSeconds (up to 25) waits for it to finish before answering. Read-only.",
    inputSchema: z.object({ job: z.string().regex(JOB_ID).describe("job id from execute_module, e.g. job_1a2b3c4d5e6f"), waitSeconds: z.number().min(0).max(25).default(0) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: visualUri } },
  }, async ({ job: id, waitSeconds }) => {
    try {
      const job = await host.jobs.wait(id, waitSeconds * 1000);
      if (!job) throw new Error("no job " + id + " (jobs are kept for the last 100 runs)");
      const text = job.module + " " + job.capability + " " + id + ": " + job.status +
        (job.status === "running" ? (job.progress ? " (" + job.progress + ")" : "") + ". Check again shortly." : "") +
        (job.summary ? ". " + job.summary : "") + (job.data !== undefined ? ". Data: " + JSON.stringify(job.data).slice(0, 4000) : "") +
        (job.created?.length ? ". Created " + job.created.join(", ") + " on canvas " + job.canvas : "") + (job.error ? ". " + job.error : "");
      // A job on a canvas shows that canvas (the widget opens with every app tool, and would otherwise show its sample picture).
      if (job.canvas) {
        const entry = await host.canvases.ensure(job.canvas);
        const payload = await canvasPayload(entry);
        const out = { content: [{ type: "text", text }], structuredContent: { ...payload.structuredContent, kind: "estampes.module_job", job }, _meta: payload._meta };
        // Polling a running job is the AI checking, not something to show: only the finished result opens the canvas (#81).
        return job.status === "running" ? inBackground(out) : out;
      }
      return { content: [{ type: "text", text }], structuredContent: { kind: "estampes.module_job", job } };
    } catch (error) { return fail(error); }
  });

  registerAppTool(server, "prepare_module_change", {
    title: "Prepare a module change for the user to approve",
    description: "Prepare enabling, disabling, installing, updating, rolling back or removing a module. Nothing changes yet: the Store shows the user what would change (version, added permissions, risk, where data goes) and they approve it there themselves; high-risk changes also need the server administrator's code. Never tell the user a change is done until they approved it.",
    inputSchema: z.object({
      action: z.string().min(3).max(20).describe("enable, disable, install, update, rollback, uninstall or purge (depending on the server)"),
      module: ModuleIdSchema,
      version: z.string().max(40).optional().describe("For install/update: the version to install"),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: storeUri } },
  }, async ({ action, module, version }) => {
    try {
      const plan = await host.lifecycle.prepare(action, module, version ? { version } : {}, { by: "model" });
      const shown = host.lifecycle.publicPlan(plan);
      return {
        content: [{ type: "text", text: "Prepared plan " + plan.planId + ": " + action + " " + module + (plan.toVersion ? " " + plan.toVersion : "") +
          ", risk " + plan.risk + (plan.permissions.added.length ? ", adds permissions " + plan.permissions.added.map((p) => p.id).join(", ") : "") +
          (plan.requiresAdmin ? ", needs the administrator code" : "") + ". It is NOT applied: the user must approve it in the Store shown below (it expires in 15 minutes)." }],
        structuredContent: { kind: "estampes.module_store", tab: "plan", plan: shown, modules: catalog(), admin: adminInfo() },
        _meta: { "estampes/consent": { planId: plan.planId, consent: plan.consent } },
      };
    } catch (error) { return fail(error); }
  });

  // ---- App-only tools for the Store widget --------------------------------
  const appOnly = { ui: { visibility: ["app"] } };
  registerAppTool(server, "store_get_catalog", {
    title: "Store catalog", description: "Module catalog for the Estampes Store widget.",
    inputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: appOnly,
  }, async () => ({ content: [{ type: "text", text: "Catalog sent to the Store." }],
    structuredContent: { kind: "estampes.module_catalog", modules: catalog(), admin: adminInfo(), actions: host.lifecycle.actions(), available: (await host.packages?.available?.()) ?? [] } }));

  registerAppTool(server, "store_get_detail", {
    title: "Store module detail", description: "One module's full details for the Estampes Store widget.",
    inputSchema: z.object({ module: ModuleIdSchema }), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: appOnly,
  }, async ({ module }) => {
    try {
      const mod = host.registry.get(module);
      if (!mod) throw new Error("no module " + module);
      return { content: [{ type: "text", text: "Detail sent to the Store." }],
        structuredContent: { kind: "estampes.module_detail", module: catalogEntry(mod), manifest: mod.manifest, activity: host.audit.recent(20, { module }) } };
    } catch (error) { return fail(error); }
  });

  registerAppTool(server, "store_get_plan", {
    title: "Prepare a module change", description: "Prepare a change from a Store button; returns the plan to show before the user confirms.",
    inputSchema: z.object({ action: z.string().min(3).max(20), module: ModuleIdSchema, version: z.string().max(40).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: appOnly,
  }, async ({ action, module, version }) => {
    try {
      const plan = await host.lifecycle.prepare(action, module, version ? { version } : {}, { by: "store" });
      return { content: [{ type: "text", text: "Plan " + plan.planId + " prepared in the Store." }],
        structuredContent: { kind: "estampes.module_plan", plan: host.lifecycle.publicPlan(plan) },
        _meta: { "estampes/consent": { planId: plan.planId, consent: plan.consent } } };
    } catch (error) { return fail(error); }
  });

  registerAppTool(server, "store_commit_plan", {
    title: "Apply an approved module change", description: "Apply a plan the user confirmed in the Store.",
    inputSchema: z.object({
      planId: z.string().max(64), consent: z.string().max(64),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, _meta: appOnly,
  }, async ({ planId, consent }) => {
    try {
      const { plan, result, repeated } = await host.lifecycle.commit(planId, { consent, by: "store" });
      return {
        content: [{ type: "text", text: plan.action + " " + plan.module + (repeated ? " was already applied." : " applied.") }],
        structuredContent: { kind: "estampes.module_plan", plan: host.lifecycle.publicPlan(plan), result, modules: catalog() },
      };
    } catch (error) { return { ...fail(error), structuredContent: { kind: "estampes.module_error", code: error.code ?? "error", message: String(error?.message || error) } }; }
  });

  registerAppTool(server, "store_get_activity", {
    title: "Store activity", description: "Recent module activity (runs, plans, installs, failures) for the Store widget.",
    inputSchema: z.object({ module: ModuleIdSchema.optional(), limit: z.number().int().min(1).max(200).default(50) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: appOnly,
  }, async ({ module, limit }) => ({ content: [{ type: "text", text: "Activity sent to the Store." }],
    structuredContent: { kind: "estampes.module_activity", events: host.audit.recent(limit, { module }), jobs: host.jobs?.list?.({ module }) ?? [] } }));

  // The user edits an object in the canvas (e.g. changes sin(x) to sin(2x)).
  // The Core re-renders it; no module code runs, so it works even after the
  // module was disabled.
  registerAppTool(server, "edit_scene_object", {
    title: "Edit a canvas object", description: "Change or delete a scene object, or restore the last deletion from the canvas widget.",
    inputSchema: z.object({
      imageId: ImageIdSchema, id: z.string().regex(/^o\d{1,6}$/).optional(), restore: z.boolean().default(false),
      props: z.record(z.string(), z.unknown()).optional(), remove: z.boolean().default(false),
      expectedRevision: z.number().int().min(0).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: appOnly,
  }, async ({ imageId, id, props, remove, restore, expectedRevision }) => {
    try {
      const entry = await deps.ensureImage(imageId);
      if (!restore && !id) throw new Error("id is required");
      if (restore && (remove || props)) throw new Error("restore cannot be combined with edits");
      const ops = restore ? [{ op: "object.restore" }] : remove ? [{ op: "object.delete", id, cascade: true }] : [{ op: "object.update", id, props: props ?? {} }];
      const scene = applySceneOps(entry, ops, { author: "user" }, { expectedRevision });
      (entry.userEdits ??= []).push({ kind: restore ? "restore-object" : remove ? "remove-object" : "edit-object", id, ...(props ? { props } : {}) });
      await deps.saveCanvas(entry, { tool: "edit_scene_object", author: "user", changed: scene.updated, removed: scene.deleted });
      return { content: [{ type: "text", text: restore ? "Restored deleted scene objects." : (remove ? "Removed " : "Updated ") + id + "." }],
        structuredContent: { kind: "estampes.scene_objects", imageId, revision: sceneRevision(entry), objects: widgetObjects(entry), canRestoreObjects: !!entry.deletedObjectBatches?.length, layers: deps.canvasLayers(entry),
          notes: scene.notes } };
    } catch (error) { return { ...fail(error), structuredContent: { kind: "estampes.module_error", code: error.code ?? "error", message: String(error?.message || error) } }; }
  });
}
