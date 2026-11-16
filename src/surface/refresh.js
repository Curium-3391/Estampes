// Keeps Graph plots made from calculator cells in step with their cells.
// Everything goes through the module router, so a disabled module or a
// missing permission stops a refresh like any other call. A cell whose result
// cannot be recomputed keeps its stale links; a plot the user deleted is
// reported, not recreated. Plots on every canvas the notebook is linked to are
// redrawn, not only the one on screen: the cell is fresh once recomputed, so a
// link left stale elsewhere would never be retried.
const CAS = "org.estampes.cas";
const PASS = 20;      // cells recomputed per router call
const ROUNDS = 5;     // so at most 100 stale cells per refresh; `remaining` reports the rest
const MAX_CANVASES = 8;

// Capabilities after which a notebook with autoRefresh redraws its linked
// plots. Turning autoRefresh on counts: stale links already waiting get redrawn.
export const AUTO_REFRESH_AFTER = new Set(["calculate", "define", "recompute", "set_options"]);

export async function refreshLinks({ host, notebooks, notebookId, imageId = null }) {
  const out = { recomputed: [], updated: [], failed: [], remaining: 0 };
  let nb = await notebooks.get(notebookId);
  for (let round = 0; round < ROUNDS; round++) {
    const todo = nb.cells.filter((x) => x.stale && !out.failed.some((f) => f.cell === x.id));
    if (!todo.length) break;
    for (const c of todo.slice(0, PASS)) {
      try {
        await host.router.execute({ module: CAS, capability: "recompute", params: { notebook: notebookId, cell: c.id } });
        out.recomputed.push(c.id);
      } catch (e) { out.failed.push({ cell: c.id, reason: String(e.message ?? e).slice(0, 200) }); }
    }
    nb = await notebooks.get(notebookId);
  }
  out.remaining = nb.cells.filter((x) => x.stale).length;
  const canvases = new Set();
  for (const c of nb.cells) for (const l of c.links ?? []) if (l.status !== "fresh" && l.status !== "removed") canvases.add(l.canvas);
  if (imageId) canvases.delete(imageId);
  const order = [...(imageId ? [imageId] : []), ...canvases].slice(0, MAX_CANVASES);
  let shown = null;
  for (const canvas of order) {
    for (const c of nb.cells) {
      if (c.stale || c.error || !c.result) continue;
      for (const l of c.links ?? []) {
        if (l.canvas !== canvas || l.status === "fresh" || l.status === "removed") continue;
        // A plot the user deleted is not recreated and not retried: the link is
        // marked removed. Only a canvas that was read and lacks the object
        // counts as deleted; a canvas that could not be read (a storage
        // error) leaves the link as it is, to be retried on the next refresh.
        const state = await host.canvases.ensure(canvas).then((e) => (!e ? "unavailable" : e.objects?.has(l.object) ? "alive" : "missing"), () => "unavailable");
        if (state === "unavailable") {
          out.failed.push({ cell: c.id, object: l.object, canvas, reason: "the canvas " + canvas + " could not be read; the plot was left as it is and will be retried" });
          continue;
        }
        if (state === "missing") {
          await notebooks.mutate(notebookId, {}, (d) => { const link = d.cells.find((x) => x.id === c.id)?.links?.find((x) => x.object === l.object && x.canvas === canvas); if (link) link.status = "removed"; return d; });
          out.failed.push({ cell: c.id, object: l.object, canvas, reason: "the plot " + l.object + " was removed from the canvas" });
          continue;
        }
        try {
          const r = await host.router.execute({ module: CAS, capability: "plot_result", canvas,
            params: { notebook: notebookId, cell: c.id, object: l.object, ...(l.domain ? { domain: l.domain } : {}) } });
          out.updated.push({ cell: c.id, object: l.object, canvas });
          if (canvas === imageId || !shown) shown = r.entry ?? shown;
        } catch (e) { out.failed.push({ cell: c.id, object: l.object, canvas, reason: String(e.message ?? e).slice(0, 200) }); }
      }
    }
  }
  out.entry = shown;
  return out;
}

// For any caller (the user's panel or the model through execute_module): when
// the notebook asks for it, redraw what the change made stale.
export async function autoRefresh({ host, notebooks, capability, notebookId, imageId = null }) {
  if (!notebookId || !AUTO_REFRESH_AFTER.has(capability) || !notebooks) return null;
  const nb = await notebooks.get(notebookId);
  if (!nb.autoRefresh) return null;
  return refreshLinks({ host, notebooks, notebookId, imageId });
}
