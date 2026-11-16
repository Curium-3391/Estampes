// DocumentStore (UVA Phase 3, PR-3B-1): one per widget. Every viewer on a
// document shares one entry: the newest snapshot plus its ordered revision.
// Written as a plain module so node can test it; the widget inlines it with
// the `export` keywords stripped (see widget-source.js).
//
// Revisions are {epoch, counter, hash}, from the server's documents_get_changes:
//   same epoch, counter older      -> ignored (a late or duplicated answer)
//   same epoch and counter, same hash -> ignored (already have it)
//   same epoch and counter, different hash -> integrity error, never
//       last-writer-wins: the store keeps what it has and tells subscribers
//   same epoch, counter newer      -> applied
//   other epoch (server restarted) -> the server is authoritative: applied
export const POLL_BATCH = 12;

export function createDocumentStore({ fetchChanges } = {}) {
  const docs = new Map(); // id -> {revision, snapshot, stale, missing, error, subs:Set}
  const entryOf = (id) => { let d = docs.get(id); if (!d) docs.set(id, d = { revision: null, snapshot: null, stale: false, missing: false, error: null, subs: new Set() }); return d; };
  const view = (id, d, extra = {}) => ({ documentId: id, revision: d.revision, snapshot: d.snapshot, stale: d.stale, missing: d.missing, error: d.error, ...extra });
  const emit = (id, d, extra) => { const v = view(id, d, extra); for (const fn of [...d.subs]) { try { fn(v); } catch {} } };

  // Returns "applied" | "ignored" | "conflict".
  function accept(id, revision, snapshot, { gap = false } = {}) {
    const d = entryOf(id), had = d.revision;
    if (had && revision.epoch === had.epoch) {
      if (revision.counter < had.counter) return "ignored";
      if (revision.counter === had.counter) {
        if (revision.hash === had.hash) { if (d.stale || d.missing) { d.stale = false; d.missing = false; emit(id, d); } return "ignored"; }
        d.error = "revision " + revision.counter + " has two different contents";
        emit(id, d, { conflict: true });
        return "conflict";
      }
    }
    if (!snapshot) {
      // "Unchanged" with a higher counter (the content went A, B, A): keep the snapshot, adopt the newer revision,
      // so a late snapshot of the middle revision cannot overwrite it.
      if (had && d.snapshot && revision.epoch === had.epoch && revision.hash === had.hash && revision.counter > had.counter) {
        d.revision = revision; d.stale = false; d.missing = false; d.error = null;
        return "ignored";
      }
      return "ignored";
    }
    d.revision = revision; d.snapshot = snapshot; d.stale = false; d.missing = false; d.error = null;
    emit(id, d, gap ? { gap: true } : {});
    return "applied";
  }

  return {
    get: (id) => { const d = docs.get(id); return d ? view(id, d) : null; },
    ids: () => [...docs.keys()].filter((id) => docs.get(id).subs.size > 0),
    // Observe a document. Returns an unsubscribe; the last one releases it.
    subscribe(id, fn) {
      const d = entryOf(id); d.subs.add(fn);
      return () => { d.subs.delete(fn); if (!d.subs.size) docs.delete(id); };
    },
    // Feed a state that arrived another way (a tool result, the host's globals).
    hydrate: (id, revision, snapshot) => accept(id, revision, snapshot),
    // Ask the server about every observed document, 12 per call.
    async reconcile(only) {
      const ids = (only ?? this.ids()).filter((id) => docs.has(id));
      const report = { applied: 0, ignored: 0, conflicts: 0, missing: 0, failed: false };
      for (let i = 0; i < ids.length; i += POLL_BATCH) {
        const chunk = ids.slice(i, i + POLL_BATCH);
        let answer;
        try {
          answer = await fetchChanges(chunk.map((documentId) => ({ documentId, ...(docs.get(documentId)?.revision ? { sinceRevision: docs.get(documentId).revision } : {}) })));
        } catch (error) {
          // Offline or the host refused: keep the last snapshot, say it may be old, never claim it is saved.
          report.failed = true;
          for (const id of chunk) { const d = docs.get(id); if (d) { d.stale = true; d.error = String(error?.message || error).slice(0, 160); emit(id, d); } }
          continue;
        }
        for (const r of answer?.documents ?? []) {
          if (!docs.has(r.documentId)) continue; // released while the call was in flight
          if (r.status === "missing") { const d = docs.get(r.documentId); d.missing = true; d.error = r.error ?? null; emit(r.documentId, d); report.missing++; continue; }
          if (r.status === "unchanged") { accept(r.documentId, r.revision, null); report.ignored++; continue; }
          const out = accept(r.documentId, r.revision, r.snapshot, { gap: r.status === "gap" });
          if (out === "applied") report.applied++; else if (out === "conflict") report.conflicts++; else report.ignored++;
        }
      }
      return report;
    },
  };
}
