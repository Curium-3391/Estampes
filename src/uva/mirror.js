// Checkpoint mirror: after the legacy canvas saves, a coalesced background sync
// copies it into its UVA mirror document. The legacy canvas stays the writer, so
// a slow, failing or full UVA store never delays or loses a canvas edit.
//
// A UVA commit costs about 136 KB of disk and ~0.7 s, so edits are coalesced:
// one sync after `idleMs` without a save, and at the latest `maxWaitMs` after the
// first unsynced save.
export function createMirror({ service, read, idleMs = 15000, maxWaitMs = 120000, log = () => {} }) {
  const pending = new Map(); // imageId -> { timer, first }
  let running = Promise.resolve(), closed = false;

  async function sync(imageId) {
    try {
      const input = await read(imageId);
      if (!input) return;
      const r = await service.syncCanvas(input);
      if (r.status === "blocked") log("info", "[uva-mirror] canvas not mirrored", { imageId, reason: r.issues.map((i) => i.message).join("; ") });
      else if (r.status !== "unchanged") log("info", "[uva-mirror] synced", { imageId, status: r.status, revision: r.revision });
    } catch (error) {
      service.noteMirror({ lastError: String(error?.message || error), lastErrorAt: new Date().toISOString(), lastErrorImage: imageId });
      log("warn", "[uva-mirror] sync failed; the canvas itself is saved", { imageId, error: String(error?.message || error) });
    }
  }
  const enqueue = (imageId) => { running = running.then(() => sync(imageId)).then(() => service.noteMirror({ pending: pending.size })); return running; };

  function schedule(imageId) {
    if (closed) return;
    const now = Date.now(), entry = pending.get(imageId) ?? { first: now, timer: null };
    clearTimeout(entry.timer);
    const wait = Math.max(0, Math.min(idleMs, entry.first + maxWaitMs - now));
    entry.timer = setTimeout(() => { pending.delete(imageId); enqueue(imageId); }, wait);
    entry.timer.unref?.();
    pending.set(imageId, entry);
    service.noteMirror({ pending: pending.size });
  }
  // Runs everything now (shutdown, tests).
  async function flush() {
    for (const [imageId, entry] of pending) { clearTimeout(entry.timer); pending.delete(imageId); enqueue(imageId); }
    await running;
    service.noteMirror({ pending: pending.size });
  }
  return { schedule, flush, async close() { await flush(); closed = true; }, get pending() { return pending.size; } };
}
