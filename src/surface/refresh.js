// Keeps Graph plots made from calculator cells in step with their cells.
// Everything goes through the module router, so a disabled module or a
// missing permission stops a refresh like any other call. A cell whose result
// cannot be recomputed keeps its stale links; a plot the user deleted is
// reported, not recreated.
const CAS = "org.estampes.cas";
const MAX_STALE = 20;

export async function refreshLinks({ host, notebooks, notebookId, imageId }) {
  const out = { recomputed: [], updated: [], failed: [] };
  let nb = await notebooks.get(notebookId);
  for (const c of nb.cells.filter((x) => x.stale).slice(0, MAX_STALE)) {
    try {
      await host.router.execute({ module: CAS, capability: "recompute", params: { notebook: notebookId, cell: c.id } });
      out.recomputed.push(c.id);
    } catch (e) { out.failed.push({ cell: c.id, reason: String(e.message ?? e).slice(0, 200) }); }
  }
  nb = await notebooks.get(notebookId);
  let last = null;
  for (const c of nb.cells) {
    if (c.stale || c.error || !c.result) continue;
    for (const l of c.links ?? []) {
      if (l.canvas !== imageId || l.status === "fresh") continue;
      try {
        last = await host.router.execute({ module: CAS, capability: "plot_result", canvas: imageId,
          params: { notebook: notebookId, cell: c.id, object: l.object, ...(l.domain ? { domain: l.domain } : {}) } });
        out.updated.push({ cell: c.id, object: l.object });
      } catch (e) { out.failed.push({ cell: c.id, object: l.object, reason: String(e.message ?? e).slice(0, 200) }); }
    }
  }
  out.entry = last?.entry ?? null;
  return out;
}
