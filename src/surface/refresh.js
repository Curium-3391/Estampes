// Keeps Graph plots made from calculator cells in step with their cells.
// A stale cell is recomputed through the module router; the plots made from it
// are derived objects (UVA 5B), so redrawing them is the core's refresh of stale
// bindings: the same rules as the Derived panel (a plot the person edited is
// paused, a plot they deleted is reported, never recreated), the same router
// checks (a disabled module or a missing permission stops a refresh). Plots on
// every canvas the notebook is linked to are redrawn, not only the one on screen.
import { createDerivedFlow } from "../modules/derived-flow.js";

const CAS = "org.estampes.cas";
const PASS = 20;      // cells recomputed per router call
const ROUNDS = 5;     // so at most 100 stale cells per refresh; `remaining` reports the rest
const MAX_CANVASES = 8;

// Capabilities after which a notebook with autoRefresh redraws its linked
// plots. Turning autoRefresh on counts: stale plots already waiting get redrawn.
export const AUTO_REFRESH_AFTER = new Set(["calculate", "define", "recompute", "set_options"]);

const reasonOf = (e) => String(e?.message ?? e).slice(0, 200);

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
      } catch (e) { out.failed.push({ cell: c.id, reason: reasonOf(e) }); }
    }
    nb = await notebooks.get(notebookId);
  }
  out.remaining = nb.cells.filter((x) => x.stale).length;
  // The canvases to look at: the one on screen, the ones this notebook's cells were drawn on, and the ones the core knows hold this module's plots.
  const canvases = new Set();
  for (const c of nb.cells) for (const l of c.links ?? []) if (l.status !== "removed") canvases.add(l.canvas);
  for (const id of host.derivedIndex?.list?.(CAS) ?? []) canvases.add(id);
  if (imageId) canvases.delete(imageId);
  const order = [...(imageId ? [imageId] : []), ...canvases].slice(0, MAX_CANVASES);
  const flow = createDerivedFlow({ router: host.router, registry: host.registry, canvases: host.canvases, index: host.derivedIndex, state: host.derivedState });
  let shown = null;
  for (const canvas of order) {
    let r;
    // A plot that was deleted is noticed when the document is opened, before the refresh: say so once, for the ones that were live until now.
    const live = new Set(((await host.canvases.ensure(canvas).catch(() => null))?.derived ?? []).filter((b) => b.state !== "removed").map((b) => b.id));
    try { r = await flow.update({ canvas, action: "refresh-stale" }); }
    catch (e) { out.failed.push({ canvas, reason: "the canvas " + canvas + " could not be updated (" + reasonOf(e) + "); the plots were left as they are and will be retried" }); continue; }
    const row = (id) => r.bindings?.find((b) => b.id === id);
    for (const x of r.result.refreshed) out.updated.push({ object: row(x.id)?.object, canvas });
    for (const x of r.result.paused) out.failed.push({ object: row(x.id)?.object, canvas, reason: x.reason ?? "the plot was edited by hand; refresh paused" });
    for (const x of r.result.failed) out.failed.push({ object: row(x.id)?.object, canvas, reason: x.reason ?? "the plot could not be updated" });
    const gone = new Set([...r.result.removed.map((x) => x.id), ...(r.bindings ?? []).filter((b) => b.state === "removed" && live.has(b.id)).map((b) => b.id)]);
    for (const id of gone) {
      const object = row(id)?.object;
      out.failed.push({ object, canvas, reason: "the plot " + (object ?? "") + " was removed from the canvas" });
      // The notebook's own link record follows (until it is retired): a deleted plot is not retried.
      if (object) await notebooks.mutate(notebookId, {}, (d) => { for (const c of d.cells) for (const l of c.links ?? []) if (l.canvas === canvas && l.object === object) l.status = "removed"; return d; }).catch(() => {});
    }
    out.remaining += r.result.remaining ?? 0;
    if (canvas === imageId || !shown) shown = await host.canvases.ensure(canvas).catch(() => shown);
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
