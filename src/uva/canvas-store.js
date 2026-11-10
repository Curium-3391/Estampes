// ESTAMPES_CANVAS_STORE=uva: an image's own canvas, and each workspace copy of
// it, lives in its UVA document and nowhere else. src/storage.js reads and
// writes through this store; it writes no canvas, history or image file.
//
// A record is keyed by the canvas (img:<hex>, or img:<hex>#<setId> for a
// workspace copy) and holds
//   canvas   the canvas itself (marks, layers, links, objects, ...)
//   extra    { log, meta, derived }: its change log (the last LOG_LINES
//            lines), the image's metadata (where it came from, its size) and
//            its processed-view recipes and calibrations
// and a per-canvas sequence number `seq` that grows by one with every write
// the store accepts. A write is acknowledged once
//   uva-pending/<hex>[-<setId>].json   is durable (file + folder fsync);
// a coalesced commit then puts it into the UVA document (src/uva/service.js
// syncCanvas) and removes the pending copy once the document holds exactly
// its content. A read takes the higher seq of the pending copy and the
// document. Wall-clock times are never compared.
//
// The image's bytes are a verified, content-addressed asset of the store
// (putImage), written durably before the image is acknowledged.
//
// A canvas the document cannot hold yet (malformed links, over the store
// limits) keeps its pending record, which a read still returns; the reason is
// in the UVA diagnostics. Per canvas, `diagnostics.mirror.canvasStore.images`
// shows the durable pending seq and the committed seq.
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { hashJson } from "../documents/validation.js";
import { createMirror } from "./mirror.js";

// A canvas key: an image's own canvas (img:<hex>) or a workspace copy of it
// (img:<hex>#c<hex>).
const KEY = /^img:([0-9a-f]{16})(?:#(c[0-9a-f]{12}))?$/;
const PENDING = /^([0-9a-f]{16})(?:-(c[0-9a-f]{12}))?\.json$/;
const parts = (key) => { const m = KEY.exec(key ?? ""); return m ? { hex: m[1], setId: m[2] ?? null } : null; };
const keyOf = (canvas) => (canvas?.imageId ?? "") + (canvas?.setId ? "#" + canvas.setId : "");
const RECORD = "estampes.canvas-pending/2";
export const LOG_LINES = 200;
export const contentHash = (canvas) => { const { savedAt, ...rest } = canvas; return hashJson(rest); };
const json = (value) => JSON.parse(JSON.stringify(value));
const cleanExtra = (extra) => ({ log: Array.isArray(extra?.log) ? extra.log : [], meta: extra?.meta ?? null, derived: extra?.derived ?? null });

// Which record a canvas has. Pure: records are { seq, canvas, extra }; the higher seq wins.
export function chooseCanvas({ uva = null, pending = null }) {
  const records = [uva && { from: "uva", ...uva }, pending && { from: "pending", ...pending }].filter(Boolean);
  if (!records.length) return null;
  const latest = records.reduce((a, b) => (b.seq > a.seq ? b : a));
  return { from: latest.from, canvas: latest.canvas, extra: cleanExtra(latest.extra), seq: latest.seq };
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

export async function createCanvasStore({ service, storageDir, idleMs = 15000, maxWaitMs = 120000, log = () => {} }) {
  if (!service?.canvasStore) throw new Error("The UVA service was not opened as a canvas store");
  const dir = join(storageDir, "uva-pending");
  const created = await mkdir(dir, { recursive: true, mode: 0o700 });
  // A new folder must itself survive a crash before its files can.
  if (created) for (let d = dir; ; d = dirname(d)) { await syncDir(dirname(d)); if (d === created || dirname(d) === d) break; }
  const file = (key) => { const p = parts(key); return join(dir, p.hex + (p.setId ? "-" + p.setId : "") + ".json"); };
  // `known`: { hash, extraHash, seq, canvas, extra } of the latest record, per
  // canvas. Every write goes through this store, so a record once read or
  // written stays current. Canvases are bounded by the memory cache that holds
  // their entries; this keeps the most recent ones.
  const queues = new Map(), known = new Map(), images = new Map();
  const remember = (key, value) => { known.delete(key); known.set(key, value); while (known.size > 256) { const old = known.keys().next().value; if (queues.has(old)) break; known.delete(old); } };
  const stats = { writes: 0, committed: 0, read: { uva: 0, pending: 0 }, failedWrites: 0, lastError: null };
  const note = () => service.noteMirror({ canvasStore: { ...stats, read: { ...stats.read }, images: Object.fromEntries(images) } });
  const track = (key, patch) => {
    const prev = images.get(key) ?? {};
    images.delete(key); images.set(key, { ...prev, ...patch });
    while (images.size > 64) images.delete(images.keys().next().value);
  };
  const fault = (where, key, error) => {
    stats.lastError = { where, imageId: key, message: String(error?.message || error), at: new Date().toISOString() };
    note();
    log("error", "[canvas-store] " + where + " failed", { imageId: key, error: stats.lastError.message });
  };
  // Reads and writes of one canvas run one after another.
  function queued(key, job) {
    const next = (queues.get(key) ?? Promise.resolve()).then(job, job), settled = next.catch(() => {});
    queues.set(key, settled);
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return next;
  }
  async function readPending(key) {
    const r = await readJson(file(key));
    return r?.schema === RECORD && Number.isSafeInteger(r.seq) && keyOf(r.canvas) === key ? r : null;
  }
  // A failing UVA read must not pass for "no record".
  const readUva = (key) => service.canvasState(key);

  const mirror = createMirror({
    service, idleMs, maxWaitMs, log,
    read: async (key) => {
      const r = await readPending(key);
      return r && { canvas: r.canvas, seq: r.seq, extra: cleanExtra(r.extra), bytes: await service.imageBytes("img:" + parts(key).hex) };
    },
    onSynced: async (key, result) => {
      if (result.status === "blocked") { track(key, { blocked: true }); note(); return; }
      await queued(key, async () => {
        const r = await readPending(key);
        track(key, { committedSeq: result.seq ?? r?.seq ?? null, blocked: false });
        if (!r || contentHash(r.canvas) !== result.sourceHash || hashJson(cleanExtra(r.extra)) !== result.extraHash) { note(); return; }
        await unlink(file(key));
        await syncDir(dir);
        stats.committed++; note();
      });
    },
  });

  // Inside the key's queue: the canvas's latest record, or null.
  async function current(key) {
    if (known.get(key)?.canvas !== undefined) return known.get(key);
    const [uva, pending] = await Promise.all([readUva(key), readPending(key)]);
    const choice = chooseCanvas({ uva, pending });
    if (!choice) { remember(key, { hash: null, extraHash: null, seq: 0, canvas: null, extra: cleanExtra(null) }); return known.get(key); }
    remember(key, { hash: contentHash(choice.canvas), extraHash: hashJson(choice.extra), seq: choice.seq, canvas: choice.canvas, extra: choice.extra });
    stats.read[choice.from]++;
    note();
    if (choice.from === "pending") mirror.schedule(key);
    return known.get(key);
  }
  // Inside the key's queue: writes the next pending record durably.
  async function put(key, { canvas, line, meta, derived, log: replaceLog }) {
    const was = await current(key);
    const next = canvas === undefined ? was.canvas : json(canvas);
    if (!next) throw new Error("No canvas recorded for " + key + " yet");
    const extra = {
      log: replaceLog ? replaceLog.slice(-LOG_LINES) : line ? [...was.extra.log, json(line)].slice(-LOG_LINES) : was.extra.log,
      meta: meta === undefined ? was.extra.meta : json(meta),
      derived: derived === undefined ? was.extra.derived : json(derived),
    };
    const hash = contentHash(next), extraHash = hashJson(extra);
    if (hash === was.hash && extraHash === was.extraHash) return was.seq;
    const seq = was.seq + 1;
    await durableWrite(file(key), JSON.stringify({ schema: RECORD, seq, canvas: next, extra }));
    remember(key, { hash, extraHash, seq, canvas: next, extra });
    stats.writes++;
    track(key, { pendingSeq: seq });
    note();
    mirror.schedule(key);
    return seq;
  }
  const copy = (r) => (r?.canvas ? json({ canvas: r.canvas, extra: r.extra, seq: r.seq }) : null);

  const api = {
    chooseCanvas,
    // { canvas, extra: { log, meta, derived }, seq } of a canvas, or null.
    read(key) {
      if (!parts(key)) return Promise.resolve(null);
      return queued(key, () => current(key)).then(copy);
    },
    // Resolves with the seq once the record is durable; rejects when it is not.
    // Fields left undefined keep their recorded value; `line` is appended to
    // the change log, `log` replaces it (migration).
    write(key, { canvas, line, meta, derived, log: replaceLog } = {}) {
      if (!parts(key) || (canvas !== undefined && keyOf(canvas) !== key)) return Promise.reject(new Error("Not a canvas of " + key));
      return queued(key, () => put(key, { canvas, line, meta, derived, log: replaceLog })).catch((error) => {
        stats.failedWrites++;
        track(key, { failedSeq: (known.get(key)?.seq ?? 0) + 1 });
        fault("pending write", key, error);
        throw new Error("The canvas was not saved (its durable record could not be written: " + String(error?.message || error) + "); the edit is not acknowledged.");
      });
    },
    // The image's bytes: written durably as a verified asset before resolving.
    putImage: (bytes) => service.putImage(bytes),
    imageBytes: (imageId) => service.imageBytes(imageId),
    recovered: [],
    flush: () => mirror.flush(),
    // Shutdown: finish writes in flight; what waits for a commit stays pending on disk.
    async close() { await mirror.stop(); await Promise.all([...queues.values()]); },
    get pending() { return mirror.pending; },
  };

  // Startup: pending records a stopped server left are committed again.
  for (const name of await readdir(dir)) {
    const m = PENDING.exec(name);
    if (m) {
      const key = "img:" + m[1] + (m[2] ? "#" + m[2] : "");
      // A record in the older format (the legacy file was still written then)
      // holds just the canvas: it is carried over with an empty extra.
      const r = await readJson(join(dir, name));
      if (r?.schema === "estampes.canvas-pending/1" && Number.isSafeInteger(r.seq) && keyOf(r.canvas) === key) {
        await durableWrite(file(key), JSON.stringify({ schema: RECORD, seq: r.seq, canvas: r.canvas, extra: cleanExtra(null) }));
      }
      api.recovered.push(key);
    } else if (name.endsWith(".tmp")) await unlink(join(dir, name)).catch(() => {});
  }
  for (const key of api.recovered) mirror.schedule(key);
  note();
  return api;
}
