// What a .estampes bundle carries besides images and marks: the Visual
// Surface (open panels and per-device layouts) and the calculator notebooks
// its panels show. Both travel as data. On import everything is rebuilt from
// known fields under new ids, nothing is overwritten, notebook results come
// in stale until recomputed, and links to Graph plots are marked stale.

// Looks under each key (what the user asked to export, the workspace, its
// first image) and takes the first surface that exists.
export async function collectBundleExtras({ surfaceStore, notebooks, keys }) {
  if (!surfaceStore) return null;
  let doc = null;
  for (const k of keys.filter(Boolean)) { doc = await surfaceStore.peek(k); if (doc) break; }
  if (!doc) return null;
  const books = [];
  if (notebooks) {
    for (const p of doc.panels) {
      if (!p.notebook || books.some((b) => b.id === p.notebook)) continue;
      try { books.push(notebooks.exportOne(await notebooks.get(p.notebook))); } catch { /* removed notebook: the panel imports empty */ }
    }
  }
  const { panels, layouts } = doc;
  return { surface: { panels, layouts }, notebooks: books };
}

export async function installBundleExtras({ surfaceStore, notebooks, workspaceId, extras }) {
  const out = { notebooks: 0, surface: false, notes: [] };
  if (!extras || (!extras.surface && !extras.notebooks.length)) return out;
  const map = new Map();
  if (notebooks) {
    for (const { id, raw } of extras.notebooks) {
      try {
        const cells = (Array.isArray(raw?.cells) ? raw.cells : []).map((c) => ({ ...c, links: (Array.isArray(c?.links) ? c.links : []).map((l) => ({ ...l, canvas: extras.imageIds?.[l?.canvas] ?? l?.canvas })) }));
        const nb = await notebooks.importOne({ ...raw, cells });
        map.set(id, nb.id); out.notebooks += 1;
      } catch (e) { out.notes.push("A calculator notebook was not imported: " + String(e.message ?? e).slice(0, 120)); }
    }
  } else if (extras.notebooks.length) out.notes.push("This server has no calculator storage; the bundle's notebooks were left out.");
  if (extras.surface && surfaceStore) {
    try { out.surface = (await surfaceStore.importFor(workspaceId, extras.surface, { notebookMap: map })).created; }
    catch (e) { out.notes.push("The surface was not imported: " + String(e.message ?? e).slice(0, 120)); }
  }
  if (out.notebooks) out.notes.push("Calculator results came in as stale: press 重算 to verify them with SymPy.");
  return out;
}
