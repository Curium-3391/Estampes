// UVA Phase 5B-2b-3a: carries a module's "a source of mine changed" to the
// other documents that hold its bindings. The current document is handled by
// the caller; this reaches the rest through the index, a bounded number per
// call (the rest are reported, not dropped). It marks bindings stale and saves
// each document it changed; it never refreshes anything and names no module.
import { bindingsOf, sourceChanged } from "./derived-coordinator.js";

export const BROADCAST_DOCUMENTS = 8;
const LIVE = ["fresh", "stale", "recomputing", "conflict", "error", "unavailable"];

// canvases: { ensure, save }. events: [{ sourceRef? }]. except: the document already handled.
export async function deliverBroadcast({ index, canvases, module, events, except = null, limit = BROADCAST_DOCUMENTS, note = "" }) {
  const out = { staled: [], documents: [], failed: [], remaining: 0 };
  const todo = index.list(module).filter((c) => c !== except);
  for (const canvas of todo.slice(0, limit)) {
    try {
      const entry = await canvases.ensure(canvas);
      if (!entry) { index.remove(module, canvas); continue; }
      const touched = new Set();
      for (const e of events) for (const id of sourceChanged(entry, { module, ...(e.sourceRef !== undefined ? { sourceRef: e.sourceRef } : {}) })) touched.add(id);
      if (touched.size) {
        await canvases.save(entry, { tool: "execute_module", author: "module", note });
        out.documents.push(canvas);
        out.staled.push(...touched);
      }
      if (!bindingsOf(entry).some((b) => b.source.module === module && LIVE.includes(b.state))) index.remove(module, canvas);
    } catch (e) { out.failed.push({ canvas, reason: String(e?.message ?? e).slice(0, 200) }); }
  }
  out.remaining = Math.max(0, todo.length - limit);
  return out;
}
