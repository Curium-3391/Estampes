// #85 V2-2: module-owned views as surface panels.
//
// A view declared in a module/2 manifest (`views[]`) is offered as a panel of kind `module-view`; opening it is an ordinary surface action (it
// never enables the module or grants anything). The surface keeps only which view a panel shows and, optionally, which stored instance of each
// model it is bound to; what the view reads and does comes from the manifest and the instances, so nothing here is a second copy of it.
import { createHash } from "node:crypto";
import { localized } from "../modules/manifest.js";

export const MODULE_VIEW_KIND = "module-view";
const panelIdOf = (viewId) => "view-" + viewId;

// Panel descriptors for every view of every module (module/2 manifests only; others have no `views`).
export function viewPanels(registry) {
  const out = [];
  for (const m of registry.list()) {
    for (const v of m.manifest.views ?? []) {
      out.push({ module: m.manifest.id, moduleName: localized(m.manifest, "name"), moduleState: m.record.state,
        panel: { id: panelIdOf(v.id), kind: MODULE_VIEW_KIND, view: v.id, title: localized(v, "title"), maxInstances: 4, capabilityBindings: v.actions ?? [], defaultBinding: "none" } });
    }
  }
  return out;
}

// What the widget needs to draw the open module-view panels: the view's contract and renderer, and which instance each model is bound to.
// A model with no explicit binding uses the module's most recently changed instance of that type, if there is one.
export async function moduleViewsOf({ view, registry, models }) {
  const out = {};
  for (const p of view.panels) {
    if (p.kind !== MODULE_VIEW_KIND || !p.open) continue;
    const mod = registry.get(p.module);
    const def = mod?.manifest.views?.find((v) => v.id === p.view);
    if (!def) { out[p.panelId] = { module: p.module, view: p.view, unavailable: mod ? "no-view" : "no-module" }; continue; }
    const instances = {}, bound = {};
    for (const name of def.reads) {
      const rows = models ? (await models.list({ module: p.module, model: name })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) : [];
      instances[name] = rows.slice(0, 20).map((r) => ({ id: r.id, revision: r.revision, dataVersion: r.dataVersion }));
      bound[name] = p.models?.[name] && rows.some((r) => r.id === p.models[name]) ? p.models[name] : rows[0]?.id ?? null;
    }
    // A sandboxed-web view: which files the widget must fetch (through the module's host capability ui.get) and the digest each must have.
    let frame;
    if (def.renderer?.type === "sandboxed-web") {
      const ui = mod.runtime?.ui ?? {}, pl = def.renderer.payload;
      frame = { capability: "ui.get", entry: pl.entry, files: [pl.entry, ...(pl.assets ?? [])].filter((f) => ui[f]).map((f) => {
        const bytes = Buffer.from(ui[f].content, ui[f].encoding === "base64" ? "base64" : "utf8");
        return { path: f, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      }) };
    }
    out[p.panelId] = { module: p.module, view: def.id, title: localized(def, "title"), reads: def.reads, actions: def.actions, renderer: def.renderer, ...(frame ? { frame } : {}), bound, instances,
      models: Object.fromEntries((mod.manifest.models ?? []).filter((t) => def.reads.includes(t.id)).map((t) => [t.id, { dataVersion: t.dataVersion }])) };
  }
  return out;
}
