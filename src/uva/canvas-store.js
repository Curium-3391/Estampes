// ESTAMPES_CANVAS_STORE=uva: an image's own canvas is committed to its UVA
// document, and restored from it.
//
// Three copies of a canvas can exist on disk, each stamped with the savedAt of
// the edit it holds:
//   UVA document         the committed record (src/uva/service.js syncCanvas)
//   uva-pending/<hex>    written durably on every save, before the commit; it is
//                        what the coalesced commit reads, and it is removed once
//                        the document holds exactly its content
//   images/<hex>/canvas.json  the legacy file, still written by the sealed
//                        storage module so ESTAMPES_CANVAS_STORE=legacy can be
//                        switched back at any time
// On restore the newest edit wins; on equal times the committed record does.
// A save that bypassed the server (the sealed workspace and bundle modules write
// canvas.json themselves) is therefore never hidden by an older document, and
// it is committed on the next restore or tool call that touches the canvas.
//
// A canvas the document cannot hold yet (links to other canvases, image objects,
// over the store limits) keeps its pending copy, which then wins on restore;
// the reason is in the UVA diagnostics.
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hashJson } from "../documents/validation.js";
import { createMirror } from "./mirror.js";

const IMAGE = /^img:([0-9a-f]{16})$/;
const PENDING = /^([0-9a-f]{16})\.json$/;
export const contentHash = (canvas) => { const { savedAt, ...rest } = canvas; return hashJson(rest); };

async function syncDir(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durableWrite(path, text) {
  const tmp = path + "." + process.pid + "." + Date.now() + ".tmp", handle = await open(tmp, "w", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await rename(tmp, path);
}
async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function createCanvasStore({ service, storageDir, readSource, restoreCanvas, serializeCanvas, idleMs = 15000, maxWaitMs = 120000, log = () => {} }) {
  if (!service?.canvasStore) throw new Error("The UVA service was not opened as a canvas store");
  const dir = join(storageDir, "uva-pending");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = (imageId) => join(dir, imageId.slice(4) + ".json");
  const queues = new Map(), known = new Map();
  const stats = { writes: 0, committed: 0, restored: { uva: 0, pending: 0, legacy: 0 }, migrated: 0, lastError: null };
  const note = () => service.noteMirror({ canvasStore: { ...stats, restored: { ...stats.restored } } });
  const fault = (where, imageId, error) => {
    stats.lastError = { where, imageId, message: String(error?.message || error), at: new Date().toISOString() };
    note();
    log("error", "[canvas-store] " + where + " failed", { imageId, error: stats.lastError.message });
  };
  // Pending writes and their removal for one image run one after another.
  function queued(imageId, job) {
    const next = (queues.get(imageId) ?? Promise.resolve()).then(job, job), settled = next.catch(() => {});
    queues.set(imageId, settled);
    settled.then(() => { if (queues.get(imageId) === settled) queues.delete(imageId); });
    return next;
  }
  const readPending = (imageId) => readJson(file(imageId));

  const mirror = createMirror({
    service, idleMs, maxWaitMs, log,
    read: async (imageId) => {
      const canvas = await readPending(imageId);
      return canvas && { canvas, bytes: await readSource(imageId) };
    },
    onSynced: async (imageId, result) => {
      if (result.status === "blocked") return;
      await queued(imageId, async () => {
        const canvas = await readPending(imageId);
        if (!canvas || contentHash(canvas) !== result.sourceHash) return;
        await unlink(file(imageId));
        await syncDir(dir);
        stats.committed++; note();
      });
    },
  });

  // Durable before it resolves; the commit follows in the background.
  function write(imageId, value) {
    if (!IMAGE.test(imageId) || value.setId) return Promise.resolve();
    // As it will be read back: JSON drops undefined fields.
    const text = JSON.stringify(value), canvas = JSON.parse(text);
    known.set(imageId, contentHash(canvas));
    return queued(imageId, () => durableWrite(file(imageId), text))
      .then(() => { stats.writes++; mirror.schedule(imageId); }, (error) => fault("pending write", imageId, error));
  }

  // `entry` was just loaded by the legacy storage module from canvas.json.
  async function restore(entry) {
    const imageId = entry?.imageId;
    if (!IMAGE.test(imageId ?? "") || entry.setId) return;
    let uva = null;
    try { uva = await service.canvasState(imageId); } catch (error) { fault("restore from UVA", imageId, error); }
    const [pending, legacy] = await Promise.all([readPending(imageId), readJson(join(storageDir, "images", imageId.slice(4), "canvas.json"))]);
    const candidates = [uva && { from: "uva", canvas: uva.canvas }, pending && { from: "pending", canvas: pending }, legacy && { from: "legacy", canvas: legacy }]
      .filter((c) => c && c.canvas.imageId === imageId && !c.canvas.setId);
    if (!candidates.length) return;
    const best = candidates.reduce((a, b) => (String(b.canvas.savedAt ?? "") > String(a.canvas.savedAt ?? "") ? b : a));
    restoreCanvas(entry, best.canvas);
    const hash = contentHash(best.canvas);
    known.set(imageId, hash);
    stats.restored[best.from]++;
    if (best.from === "pending") mirror.schedule(imageId);
    else if (best.from === "legacy" && hash !== uva?.sourceHash) {
      stats.migrated++;
      if (pending && contentHash(pending) === hash) mirror.schedule(imageId);
      else await write(imageId, best.canvas);
    }
    note();
    return best.from;
  }

  // Commits an in-memory canvas that changed without passing through write().
  function refresh(entry) {
    if (!IMAGE.test(entry?.imageId ?? "") || entry.setId) return Promise.resolve();
    const canvas = JSON.parse(JSON.stringify(serializeCanvas(entry)));
    return known.get(entry.imageId) === contentHash(canvas) ? Promise.resolve() : write(entry.imageId, canvas);
  }

  // Edits saved before a crash or restart are committed again.
  const leftovers = [];
  for (const name of await readdir(dir)) {
    const m = PENDING.exec(name);
    if (m) { leftovers.push("img:" + m[1]); mirror.schedule("img:" + m[1]); }
    else if (name.endsWith(".tmp")) await unlink(join(dir, name)).catch(() => {});
  }
  note();
  return {
    write, restore, refresh, known: () => [...known.keys()], recovered: leftovers,
    flush: () => mirror.flush(),
    // Shutdown: finish writes in flight; what waits for a commit stays pending on disk.
    async close() { await mirror.stop(); await Promise.all([...queues.values()]); },
    get pending() { return mirror.pending; },
  };
}
