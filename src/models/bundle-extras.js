// #85 V3-B: model instances in a .estampes bundle. Which ones: those a module-view panel of the workspace's surface is bound to. They travel as
// data (owner module, model type, data version, revision, value; no history). On import they are put back under their own ids, never over an
// instance that is already there, and only for a module that is installed here and reads that data version; everything else is reported and
// skipped. The panel's binding itself is not carried: an imported view shows the module's most recent instance until it is bound again.
export const MAX_BUNDLE_MODELS = 64;

export async function collectModels({ store, surface }) {
  if (!store || !surface?.panels) return [];
  const ids = [];
  for (const p of surface.panels) for (const id of Object.values(p.models ?? {})) if (typeof id === "string" && !ids.includes(id)) ids.push(id);
  const out = [];
  for (const id of ids.slice(0, MAX_BUNDLE_MODELS)) { const one = await store.peek(id); if (one) out.push(one); }
  return out;
}

const clean = (m) => (m && typeof m === "object" && typeof m.id === "string" && typeof m.module === "string" && typeof m.model === "string" && Number.isInteger(m.dataVersion) && m.value !== undefined)
  ? { id: m.id, module: m.module, model: m.model, dataVersion: m.dataVersion, value: m.value } : null;

// registry: the module registry (installed modules and their v2 model types).
export async function installModels({ store, registry, items }) {
  const out = { restored: 0, existing: 0, skipped: 0, notes: [] };
  const list = (Array.isArray(items) ? items : []).slice(0, MAX_BUNDLE_MODELS);
  if (!list.length) return out;
  if (!store) { out.skipped = list.length; out.notes.push("This server has no model storage; the bundle's " + list.length + " model instance(s) were left out."); return out; }
  for (const raw of list) {
    const m = clean(raw);
    const skip = (why) => { out.skipped += 1; out.notes.push("Model instance " + String(raw?.id).slice(0, 20) + " was not imported: " + why); };
    if (!m) { skip("it is not readable"); continue; }
    const type = registry.get(m.module)?.manifest?.v2?.models?.[m.model];
    if (!type) { skip(m.module + " is not installed here, or does not declare " + m.model); continue; }
    if (![type.dataVersion, ...(type.readsVersions ?? [])].includes(m.dataVersion)) { skip(m.module + " here does not read data version " + m.dataVersion); continue; }
    try {
      const r = await store.restore({ module: m.module, type, id: m.id, value: m.value });
      if (r.status === "exists") { out.existing += 1; if (!r.same) out.notes.push("Model instance " + m.id + " already exists here with a different value; it was kept as it is."); } else out.restored += 1;
    } catch (e) { skip(String(e.message ?? e).slice(0, 120)); }
  }
  return out;
}
