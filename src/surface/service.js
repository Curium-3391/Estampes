// Surface logic on top of the store: which panels a surface can offer
// (from the modules' estampes.panel/1 descriptors), opening and closing
// them, and layout edits per device profile. Opening a panel is a window
// action: it never enables a module and never grants a permission.
import { z } from "zod";
import { localized } from "../modules/manifest.js";
import { PROFILES, applyLayoutOp, reconcile, LayoutError, MAX_PANELS } from "./layout.js";
import { SurfaceError } from "./store.js";
import { viewPanels } from "./module-views.js";

const OpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("open-panel"), module: z.string().max(100), panel: z.string().max(40), notebook: z.string().regex(/^nb:[0-9a-f]{12}$/).optional(),
    // module-view panels: which stored instance of each model the view shows (otherwise the module's latest one)
    models: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().regex(/^md:[0-9a-f]{12}$/)).refine((o) => Object.keys(o).length <= 8).optional() }).strict(),
  z.object({ op: z.literal("close-panel"), panelId: z.string().max(40) }).strict(),
  z.object({ op: z.literal("layout"), profile: z.enum(PROFILES), layout: z.record(z.string(), z.unknown()) }).strict(),
]);
export const ApplySchema = z.object({ ops: z.array(OpSchema).min(1).max(20) }).strict();

export function createSurfaceService({ store, registry, notebooks, models = () => null }) {
  const offered = () => {
    const out = [];
    for (const m of registry.list()) for (const p of m.manifest.panels ?? []) {
      out.push({ module: m.manifest.id, moduleName: localized(m.manifest, "name"), moduleState: m.record.state, panel: p });
    }
    return [...out, ...viewPanels(registry)];
  };
  // The "graph" panel is the Graph view of the canvas panel (the canvas is a
  // photo or a gph: document and is always open), not a window of its own.
  // Older surfaces may hold an empty "graph" window from before; it is dropped.
  const dropAlias = (doc) => { doc.panels = doc.panels.filter((p) => p.kind !== "graph"); };
  const openIds = (doc) => doc.panels.filter((p) => p.open).map((p) => p.panelId);
  // Bring the canvas forward in every profile: raise it, and put back any
  // window that was maximized over it.
  const showCanvas = (doc) => {
    const ids = openIds(doc);
    const layouts = reconcile(doc.layouts, ids);
    for (const profile of Object.keys(layouts)) {
      let l = layouts[profile];
      for (const id of ids) if (id !== "p:canvas" && l.placements[id]?.mode === "maximized") l = applyLayoutOp(l, { op: "restore", panelId: id }, ids);
      layouts[profile] = applyLayoutOp(l, { op: "focus", panelId: "p:canvas" }, ids);
    }
    doc.layouts = layouts;
  };

  // Everything a client needs to draw the surface.
  function view(doc) {
    doc = { ...doc, panels: doc.panels.filter((p) => p.kind !== "graph") };
    const available = offered().map(({ module, moduleName, moduleState, panel }) => ({
      module, moduleName, enabled: moduleState === "enabled", panel: panel.id, kind: panel.kind, title: localized(panel, "title"),
      maxInstances: panel.maxInstances, instances: doc.panels.filter((p) => p.module === module && p.panel === panel.id).length,
      capabilities: panel.capabilityBindings,
    }));
    const states = Object.fromEntries(registry.list().map((m) => [m.manifest.id, m.record.state]));
    return {
      surfaceId: doc.surfaceId, revision: doc.revision, canvasKey: doc.canvasKey,
      panels: doc.panels.map((p) => ({ ...p, moduleState: p.module === "core" ? "enabled" : states[p.module] ?? "missing" })),
      layouts: reconcile(doc.layouts, openIds(doc)), available,
    };
  }

  return {
    view,
    async state(canvasKey) { return view(await store.forCanvas(canvasKey)); },
    async apply(canvasKey, { ops, expectedRevision, idempotencyKey }) {
      const parsed = ApplySchema.safeParse({ ops });
      if (!parsed.success) throw new SurfaceError("surface ops: " + parsed.error.issues[0].path.join(".") + " " + parsed.error.issues[0].message);
      const result = await store.mutate(canvasKey, { expectedRevision, idempotencyKey }, async (doc) => {
        dropAlias(doc);
        for (const op of parsed.data.ops) {
          if (op.op === "open-panel") {
            const mod = registry.get(op.module);
            const desc = offered().find((o) => o.module === op.module && o.panel.id === op.panel)?.panel;
            if (!desc) throw new SurfaceError("no panel " + op.module + "/" + op.panel);
            if (desc.kind === "graph") { showCanvas(doc); continue; }
            const existing = doc.panels.filter((p) => p.module === op.module && p.panel === op.panel);
            const closed = existing.find((p) => !p.open);
            if (closed) { closed.open = true; if (op.notebook && closed.notebook) closed.notebook = (await notebooks.get(op.notebook)).id; continue; }
            if (existing.length >= desc.maxInstances) throw new SurfaceError(desc.title + " can be open at most " + desc.maxInstances + " time(s)", "limit");
            if (mod.record.state !== "enabled") throw new SurfaceError(mod.manifest.name + " is " + mod.record.state + "; the user enables it in the Store first", "disabled");
            if (doc.panels.length >= MAX_PANELS) throw new SurfaceError("at most " + MAX_PANELS + " panels");
            const n = existing.length + 1;
            const inst = { panelId: "p:" + desc.id.slice(0, 20) + n, module: op.module, panel: desc.id, kind: desc.kind, title: desc.title, open: true };
            if (desc.kind === "module-view") {
              inst.view = desc.view;
              if (op.models) {
                const mod2 = models();
                const def = mod.manifest.views.find((v) => v.id === desc.view);
                for (const [name, id] of Object.entries(op.models)) {
                  if (!def.reads.includes(name)) throw new SurfaceError("the view " + desc.view + " does not read " + name);
                  if (!mod2 || !(await mod2.list({ module: op.module, model: name })).some((r) => r.id === id)) throw new SurfaceError("no " + name + " instance " + id + " of " + op.module);
                }
                inst.models = op.models;
              }
            }
            if (desc.defaultBinding === "surface.casNotebook") inst.notebook = op.notebook ? (await notebooks.get(op.notebook)).id : (await notebooks.create()).id;
            doc.panels.push(inst);
          } else if (op.op === "close-panel") {
            const p = doc.panels.find((x) => x.panelId === op.panelId);
            if (!p) throw new SurfaceError("no panel " + op.panelId);
            if (p.module === "core") throw new SurfaceError("the canvas cannot be closed; minimize it instead");
            p.open = false; // the notebook and its results stay
          } else if (op.op === "layout") {
            try {
              const ids = doc.panels.filter((p) => p.open).map((p) => p.panelId);
              const layouts = reconcile(doc.layouts, ids);
              layouts[op.profile] = applyLayoutOp(layouts[op.profile], op.layout, ids);
              doc.layouts = layouts;
            } catch (error) {
              if (error instanceof LayoutError || error?.name === "ZodError") throw new SurfaceError("layout: " + (error.message || error).toString().slice(0, 200));
              throw error;
            }
          }
        }
        doc.layouts = reconcile(doc.layouts, openIds(doc));
      });
      return { ...view(result.doc), replayed: result.replayed };
    },
  };
}
