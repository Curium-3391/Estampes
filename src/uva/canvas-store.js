// ESTAMPES_CANVAS_STORE=uva: an image's own canvas is committed to its UVA
// document, and restored from it.
//
// Records of a canvas, each carrying a per-image sequence number `seq` that
// grows by one with every save the store accepts:
//   UVA document           the committed record (src/uva/service.js syncCanvas)
//   uva-pending/<hex>.json written durably (file + folder fsync) for every save
//                          before the save is acknowledged; the coalesced commit
//                          reads it, and it is removed once the document holds
//                          exactly its content
// Between records, the higher seq wins. Wall-clock times are never compared.
//
// images/<hex>/canvas.json is the legacy copy, still written by the sealed
// storage module so ESTAMPES_CANVAS_STORE=legacy can be switched back. It has no
// seq, so each record also keeps `legacyHash`: the content canvas.json held when
// the record was written. On restore, canvas.json is
//   - adopted when the store has no record (migration),
//   - adopted as the next seq when it holds content the latest record does not
//     know (neither its canvas nor its legacyHash): a save that bypassed the
//     server, such as the sealed workspace and bundle modules,
//   - otherwise ignored, and rewritten to the chosen record, so the sealed
//     modules (which read canvas.json themselves) see the committed canvas.
// The same check runs for every stored canvas at startup.
//
// A save is acknowledged only once its pending record is durable; if that write
// fails the save fails, even though canvas.json may already hold it. Per image,
// `diagnostics.mirror.canvasStore.images` shows the three states separately:
// the legacy copy, the durable pending seq and the committed seq.
//
// A canvas the document cannot hold yet (links to other canvases, workspace copies,
// over the store limits) keeps its pending record, which then wins on restore;
// the reason is in the UVA diagnostics.
import { mkdir, open, readFile, readdir, rename, unlink, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { hashJson } from "../documents/validation.js";
import { createMirror } from "./mirror.js";

const IMAGE = /^img:([0-9a-f]{16})$/;
const PENDING = /^([0-9a-f]{16})\.json$/;
const RECORD = "estampes.canvas-pending/1";
export const contentHash = (canvas) => { const { savedAt, ...rest } = canvas; return hashJson(rest); };
const json = (value) => JSON.parse(JSON.stringify(value));

// Which canvas an image has. Pure: records are { seq, legacyHash, canvas }.
export function chooseCanvas({ uva = null, pending = null, legacy = null }) {
  const records = [uva && { from: "uva", ...uva }, pending && { from: "pending", ...pending }].filter(Boolean);
  if (!records.length) return legacy ? { from: "legacy", canvas: legacy, adopt: true, seq: 0 } : null;
  const latest = records.reduce((a, b) => (b.seq > a.seq ? b : a));
  if (legacy) {
    const hash = contentHash(legacy);
    if (hash !== contentHash(latest.canvas) && hash !== latest.legacyHash) return { from: "legacy", canvas: legacy, adopt: true, seq: latest.seq };
  }
  return { from: latest.from, canvas: latest.canvas, adopt: false, seq: latest.seq, repairLegacy: !legacy || contentHash(legacy) !== contentHash(latest.canvas) };
}

async function syncDir(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durableWrite(path, text) {
  const tmp = path + "." + process.pid + "." + Date.now() + ".tmp", handle = await open(tmp, "w", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await rename(tmp, path);
  await syncDir(dirname(path));
}
async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (["ENOENT", "EISDIR", "ENOTDIR"].includes(error.code) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function createCanvasStore({ service, storageDir, readSource, restoreCanvas, serializeCanvas, idleMs = 15000, maxWaitMs = 120000, log = () => {} }) {
  if (!service?.canvasStore) throw new Error("The UVA service was not opened as a canvas store");
  const dir = join(storageDir, "uva-pending");
  const created = await mkdir(dir, { recursive: true, mode: 0o700 });
  // A new folder must itself survive a crash before its files can.
  if (created) for (let d = dir; ; d = dirname(d)) { await syncDir(dirname(d)); if (d === created || dirname(d) === d) break; }
  const file = (imageId) => join(dir, imageId.slice(4) + ".json");
  const legacyFile = (imageId) => join(storageDir, "images", imageId.slice(4), "canvas.json");
  // `known`: { hash, seq } of the last record written or restored, per image.
  // `restored`: entry objects already restored or saved through this store.
  const queues = new Map(), known = new Map(), restored = new WeakSet(), images = new Map();
  const stats = { writes: 0, committed: 0, restored: { uva: 0, pending: 0, legacy: 0 }, migrated: 0, adopted: 0, repaired: 0, failedWrites: 0, lastError: null };
  const note = () => service.noteMirror({ canvasStore: { ...stats, restored: { ...stats.restored }, images: Object.fromEntries(images) } });
  const track = (imageId, patch) => {
    const prev = images.get(imageId) ?? {};
    images.delete(imageId); images.set(imageId, { ...prev, ...patch });
    while (images.size > 64) images.delete(images.keys().next().value);
  };
  const fault = (where, imageId, error) => {
    stats.lastError = { where, imageId, message: String(error?.message || error), at: new Date().toISOString() };
    note();
    log("error", "[canvas-store] " + where + " failed", { imageId, error: stats.lastError.message });
  };
  // Records of one image are written and removed one after another.
  function queued(imageId, job) {
    const next = (queues.get(imageId) ?? Promise.resolve()).then(job, job), settled = next.catch(() => {});
    queues.set(imageId, settled);
    settled.then(() => { if (queues.get(imageId) === settled) queues.delete(imageId); });
    return next;
  }
  async function readPending(imageId) {
    const r = await readJson(file(imageId));
    return r?.schema === RECORD && Number.isSafeInteger(r.seq) && r.canvas?.imageId === imageId ? r : null;
  }
  async function readUva(imageId) {
    try { return await service.canvasState(imageId); } catch (error) { fault("read UVA record", imageId, error); return null; }
  }
  const legacyHashNow = async (imageId) => { const c = await readJson(legacyFile(imageId)); return c ? contentHash(c) : null; };
  // The legacy copy follows the chosen record (sealed modules read it directly).
  async function repairLegacy(imageId, canvas) {
    try { await lstat(join(storageDir, "images", imageId.slice(4), "source")); } catch { return; }
    await durableWrite(legacyFile(imageId), JSON.stringify(canvas));
    stats.repaired++;
  }

  const mirror = createMirror({
    service, idleMs, maxWaitMs, log,
    read: async (imageId) => {
      const r = await readPending(imageId);
      return r && { canvas: r.canvas, seq: r.seq, legacyHash: r.legacyHash, bytes: await readSource(imageId) };
    },
    onSynced: async (imageId, result) => {
      if (result.status === "blocked") { track(imageId, { blocked: true }); note(); return; }
      await queued(imageId, async () => {
        const r = await readPending(imageId);
        track(imageId, { committedSeq: result.seq ?? r?.seq ?? null, blocked: false });
        if (!r || contentHash(r.canvas) !== result.sourceHash) { note(); return; }
        await unlink(file(imageId));
        await syncDir(dir);
        stats.committed++; note();
      });
    },
  });

  // The next seq for an image, from memory or, the first time, from its records.
  async function nextSeq(imageId) {
    if (!known.has(imageId)) {
      const [pending, uva] = await Promise.all([readPending(imageId), readUva(imageId)]);
      known.set(imageId, { hash: null, seq: Math.max(pending?.seq ?? 0, uva?.seq ?? 0) });
    }
    return known.get(imageId).seq + 1;
  }
  // Resolves once the record is durable; rejects when it is not. `value` is the
  // canvas captured at save time; `after` is the legacy save it follows.
  function write(imageId, value, { entry, after } = {}) {
    if (!IMAGE.test(imageId) || value.setId) return Promise.resolve(null);
    if (entry) restored.add(entry);
    const canvas = json(value), hash = contentHash(canvas);
    return queued(imageId, async () => {
      await after;
      const seq = await nextSeq(imageId), legacyHash = await legacyHashNow(imageId);
      await durableWrite(file(imageId), JSON.stringify({ schema: RECORD, seq, legacyHash, canvas }));
      known.set(imageId, { hash, seq });
      stats.writes++;
      track(imageId, { pendingSeq: seq, legacy: legacyHash === hash ? "matches" : legacyHash ? "differs" : "missing" });
      note();
      mirror.schedule(imageId);
      return seq;
    }).catch((error) => {
      stats.failedWrites++;
      track(imageId, { failedSeq: (known.get(imageId)?.seq ?? 0) + 1 });
      fault("pending write", imageId, error);
      throw new Error("The canvas was not saved to the UVA canvas store (its pending copy could not be written: " + String(error?.message || error) + "). canvas.json may still hold it; the edit is not acknowledged.");
    });
  }

  // Applies chooseCanvas for one image: adopts or repairs the legacy copy.
  async function resolve(imageId) {
    const [uva, pending, legacy] = await Promise.all([readUva(imageId), readPending(imageId), readJson(legacyFile(imageId))]);
    const choice = chooseCanvas({ uva, pending, legacy: legacy?.imageId === imageId && !legacy.setId ? legacy : null });
    if (!choice) return null;
    known.set(imageId, { hash: contentHash(choice.canvas), seq: choice.seq });
    if (choice.adopt) {
      if (choice.seq) stats.adopted++; else stats.migrated++;
      known.set(imageId, { hash: null, seq: choice.seq });
      await write(imageId, choice.canvas);
    } else {
      if (choice.repairLegacy) await repairLegacy(imageId, choice.canvas);
      if (choice.from === "pending") mirror.schedule(imageId);
    }
    stats.restored[choice.from]++;
    note();
    return choice;
  }

  // `entry` was just loaded by the legacy storage module from canvas.json.
  async function restore(entry) {
    const imageId = entry?.imageId;
    if (!IMAGE.test(imageId ?? "") || entry.setId) return null;
    restored.add(entry);
    const choice = await queued(imageId, () => null).then(() => resolve(imageId));
    if (choice) restoreCanvas(entry, choice.canvas);
    return choice?.from ?? null;
  }

  // Records an in-memory canvas that changed without passing through write().
  function refresh(entry) {
    if (!IMAGE.test(entry?.imageId ?? "") || entry.setId) return Promise.resolve(null);
    const canvas = json(serializeCanvas(entry));
    return known.get(entry.imageId)?.hash === contentHash(canvas) ? Promise.resolve(null) : write(entry.imageId, canvas);
  }

  // Startup: every stored canvas and every leftover pending record is checked,
  // so the legacy copy matches its record before anything reads it; leftover
  // records are committed again.
  const leftovers = [];
  for (const name of await readdir(dir)) {
    const m = PENDING.exec(name);
    if (m) leftovers.push("img:" + m[1]);
    else if (name.endsWith(".tmp")) await unlink(join(dir, name)).catch(() => {});
  }
  for (const imageId of new Set([...leftovers, ...await service.canvasImages()])) {
    try { await resolve(imageId); } catch (error) { fault("startup check", imageId, error); }
  }
  stats.restored = { uva: 0, pending: 0, legacy: 0 };
  note();
  return {
    write, restore, refresh, chooseCanvas, recovered: leftovers,
    current: (entry) => !entry || restored.has(entry) || !IMAGE.test(entry.imageId ?? "") || !!entry.setId,
    flush: () => mirror.flush(),
    // Shutdown: finish writes in flight; what waits for a commit stays pending on disk.
    async close() { await mirror.stop(); await Promise.all([...queues.values()]); },
    get pending() { return mirror.pending; },
  };
}
