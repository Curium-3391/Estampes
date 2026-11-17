// Optional disk storage (ESTAMPES_STORAGE_DIR). Each image gets a folder:
//   images/<hash>/source       the bytes exactly as received
//   images/<hash>/meta.json    where it came from, original size
//   images/<hash>/canvas.json  marks, layers, links and rejected claims (rewritten atomically)
//   images/<hash>/marks.svg    the same canvas as a layered SVG
//   images/<hash>/history.jsonl one line per change: when, which tool, ids
//   images/<hash>/sets/<setId>.json  a copy of the canvas made by a workspace
//                              Copy (its own marks, layers and links)
//   workspaces/<hash>.json     a workspace: which canvases it shows and where
//                              (in the UVA store instead, when it is on: useRecords)
//   images/<hash>/derived.json  recipes of processed views (no pixels; each
//                               one renders again from source + recipe)
// Memory stays the working copy; disk is what lets an image come back after
// the cache evicts it or the container restarts. Without a storage dir every
// function here is a no-op and Estampes behaves as before.
import { mkdir, readFile, writeFile, rename, appendFile, readdir, stat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { config, log } from "./config.js";
import { registerImage, getImage, hasImage, imageIdOf } from "./image-store.js";
import { canvasMarks, canvasLayers, setKeyOf } from "./canvas-state.js";
import { exportMarksSvg } from "./marks-file.js";
import { serializeObjects, restoreObjects } from "./scene/scene-ops.js";

let root = config.storageDir;
export const storageDir = () => root;
// Tests point storage at a temporary folder.
export function useStorageDir(dir) { root = dir; }
// With the UVA store on, everything this module keeps is read from and written
// to it, and no file is written here: canvases (with their change log, the
// image's metadata and processed-view recipes) and image bytes through
// src/uva/canvas-store.js, workspaces through src/uva/record-store.js.
// Files an older version wrote are read once, when the store has no record of
// that id, and migrated in; they are never written again. PDF sources
// (documents/) stay files.
let records = null, canvases = null;
export function useRecords(store) { records = store; }
export function useCanvasStore(store) { canvases = store; }
const metaOf = (entry) => ({
  imageId: entry.imageId, sourceAssetId: entry.sourceAssetId, source: entry.source, fileName: entry.fileName,
  original: entry.original, sourceInfo: entry.sourceInfo, ...(entry.page ? { page: entry.page } : {}),
  working: { width: entry.width, height: entry.height }, storedAt: new Date().toISOString(),
});
const derivedOf = (entry) => ((entry.derivedViews?.size || entry.calibrations?.size)
  ? { version: 1, imageId: entry.imageId, views: [...(entry.derivedViews?.values() ?? [])], calibrations: Object.fromEntries(entry.calibrations ?? []) } : null);
// One load of an image at a time: callers that arrive meanwhile share it.
const loading = new Map();
function once(imageId, job) {
  if (loading.has(imageId)) return loading.get(imageId);
  const p = job().finally(() => loading.delete(imageId));
  loading.set(imageId, p);
  return p;
}
// Migrates an image the store does not hold yet from its older files, if any:
// its bytes become a store asset, then its canvas record (canvas, log, meta,
// derived) is written. Returns the entry, or null when there is nothing.
async function migrateImage(imageId, bytes = null, options = {}) {
  const dir = folder(imageId), meta = root ? await readJson(join(dir, "meta.json")) : null;
  if (!bytes && root) { try { bytes = await readFile(join(dir, "source")); } catch { return null; } }
  if (!bytes || imageIdOf(bytes) !== imageId) return null;
  // Decoded first: bytes that are not an image never become a stored asset.
  const entry = await registerImage(bytes, meta ? { source: meta.source ?? "storage", fileName: meta.fileName ?? null, page: meta.page ?? null } : { source: "storage", ...options });
  await canvases.putImage(bytes);
  if (root) {
    restoreCanvas(entry, await readJson(join(dir, "canvas.json")));
    restoreDerived(entry, await readJson(join(dir, "derived.json")));
  }
  await canvases.write(imageId, { canvas: serializeCanvas(entry), meta: meta ?? metaOf(entry), derived: derivedOf(entry), log: root ? await readHistory(imageId, LOG_LINES, { files: true }) : [] });
  log("info", "[storage] migrated into the UVA store", { imageId, marks: entry.marks?.size ?? 0 });
  return entry;
}
const LOG_LINES = 200;
const unsaved = new Set();
// A record written before the image's metadata, processed views and change
// log moved into the store has no meta: those come from their older files,
// once, into the record. Restores the entry's processed views either way.
async function hydrate(imageId, record, entry, meta = record.extra.meta) {
  if (record.extra.meta) { restoreDerived(entry, record.extra.derived); return; }
  const dir = root ? folder(imageId) : null;
  const derived = record.extra.derived ?? (dir ? await readJson(join(dir, "derived.json")) : null);
  restoreDerived(entry, derived);
  const history = record.extra.log.length ? [] : (dir ? await readHistory(imageId, LOG_LINES, { files: true }) : []);
  await canvases.write(imageId, { meta: meta ?? metaOf(entry), derived: derivedOf(entry) ?? undefined, ...(history.length ? { log: history } : {}) });
}

const CANVAS_VERSION = 1;
const folder = (imageId) => join(root, "images", imageId.slice(4));
const hexOk = (imageId) => /^img:[0-9a-f]{16}$/.test(imageId);
// A link store is keyed by an image's own canvas or by a copy of one.
export const SET_ID = /^c[0-9a-f]{8,16}$/;
const setKeyOk = (key) => { const [image, set, extra] = String(key).split("#"); return hexOk(image) && extra === undefined && (set === undefined || SET_ID.test(set)); };
// Where a canvas lives: an image's own canvas, or a copy in sets/.
const canvasPath = (entry) => entry.setId ? join(folder(entry.imageId), "sets", entry.setId + ".json") : join(folder(entry.imageId), "canvas.json");

async function atomicWrite(path, data) {
  const tmp = path + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export async function checkStorage() {
  if (!root) return { enabled: false };
  await mkdir(join(root, "images"), { recursive: true });
  const probe = join(root, ".write-test");
  await atomicWrite(probe, String(Date.now()));
  await rm(probe, { force: true });
  return { enabled: true, dir: root };
}

// Writes for one image run one after another, so a slow write can never
// land after a newer one.
const queues = new Map();
function queued(imageId, job) {
  const next = (queues.get(imageId) ?? Promise.resolve()).then(job, job);
  const settled = next.catch(() => {});
  queues.set(imageId, settled);
  settled.then(() => { if (queues.get(imageId) === settled) queues.delete(imageId); });
  return next;
}
export const flushStorage = () => Promise.all([...queues.values()]);

export function serializeCanvas(entry) {
  const links = {};
  for (const [rightId, store] of entry.pairLinks ?? []) if (store.size) links[rightId] = [...store.values()];
  return {
    ...(entry.baseAsObject ? { baseAsObject: true } : {}),
    version: CANVAS_VERSION, imageId: entry.imageId, width: entry.width, height: entry.height,
    ...(entry.setId ? { setId: entry.setId, ...(entry.derivedFrom ? { derivedFrom: entry.derivedFrom } : {}) } : {}),
    marks: canvasMarks(entry), layers: entry.layers ?? [], links,
    ...(entry.textHistory?.past.length || entry.textHistory?.future.length ? { textHistory: entry.textHistory } : {}),
    ...(entry.layerHistory?.past.length || entry.layerHistory?.future.length ? { layerHistory: entry.layerHistory } : {}),
    ...(entry.userEdits?.length ? { userEdits: entry.userEdits } : {}),
    ...(entry.rejections?.length ? { rejections: entry.rejections } : {}),
    ...(entry.gestureDecisions?.length ? { gestureDecisions: entry.gestureDecisions } : {}),
    ...((entry.objects?.size || entry.deletedObjectBatches?.length) ? { objects: serializeObjects(entry), sceneRevision: entry.sceneRevision ?? 0, objectSeq: entry.objectSeq ?? 0 } : {}),
    ...(entry.deletedObjectBatches?.length ? { deletedObjectBatches: entry.deletedObjectBatches } : {}),
    savedAt: new Date().toISOString(),
  };
}

export function restoreCanvas(entry, data) {
  if (!data || data.imageId !== entry.imageId) return entry;
  entry.marks = new Map((data.marks ?? []).filter((m) => m && typeof m.id === "string").map((m) => [m.id, m]));
  entry.layers = Array.isArray(data.layers) ? data.layers : [];
  entry.textHistory = data.textHistory ?? { past: [], future: [] };
  entry.layerHistory = data.layerHistory ?? { past: [], future: [] };
  entry.userEdits = Array.isArray(data.userEdits) ? data.userEdits : [];
  entry.rejections = Array.isArray(data.rejections) ? data.rejections.filter((r) => r && typeof r.kind === "string" && r.from) : [];
  entry.gestureDecisions = Array.isArray(data.gestureDecisions)
    ? data.gestureDecisions.filter((d) => d && Array.isArray(d.memberIds) && typeof d.verdict === "string") : [];
  entry.pairLinks = new Map(Object.entries(data.links ?? {}).filter(([id]) => setKeyOk(id))
    .map(([id, list]) => [id, new Map(list.map((l) => [l.id, l]))]));
  entry.baseAsObject = !!data.baseAsObject;
  entry.deletedObjectBatches = Array.isArray(data.deletedObjectBatches) ? data.deletedObjectBatches.slice(-10) : [];
  restoreObjects(entry, data.objects);
  entry.sceneRevision = Number.isInteger(data.sceneRevision) ? data.sceneRevision : 0;
  entry.objectSeq = Number.isInteger(data.objectSeq) ? data.objectSeq : 0;
  if (data.derivedFrom) entry.derivedFrom = data.derivedFrom;
  return entry;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

// New image from ChatGPT or a URL: register it and keep its bytes. If the
// same image was stored before, its canvas comes back with it.
export async function intakeImage(bytes, options) {
  const fresh = !hasImage(imageIdOf(bytes));
  // An intake whose durable record failed is not acknowledged; its entry may
  // still be cached, so a retry runs the store path again.
  if (canvases && (fresh || unsaved.has(imageIdOf(bytes)) || loading.has(imageIdOf(bytes)))) return once(imageIdOf(bytes), async () => {
    const imageId = imageIdOf(bytes);
    if (hasImage(imageId) && !unsaved.has(imageId)) return getImage(imageId);
    unsaved.add(imageId);
    const record = await canvases.read(imageId);
    let entry;
    if (!record) entry = await migrateImage(imageId, bytes, options);
    else {
      // Seen before: its canvas comes back with it.
      entry = await registerImage(bytes, options);
      await canvases.putImage(bytes);
      restoreCanvas(entry, record.canvas);
      await hydrate(imageId, record, entry);
    }
    unsaved.delete(imageId);
    return entry;
  });
  const entry = await registerImage(bytes, options);
  if (!root || !fresh) return entry;
  const dir = folder(entry.imageId);
  const saved = await readJson(join(dir, "canvas.json"));
  if (saved) restoreCanvas(entry, saved);
  restoreDerived(entry, await readJson(join(dir, "derived.json")));
  await queued(entry.imageId, async () => {
    await mkdir(dir, { recursive: true });
    if (!(await readJson(join(dir, "meta.json")))) {
      await atomicWrite(join(dir, "source"), bytes);
      await atomicWrite(join(dir, "meta.json"), JSON.stringify({
        imageId: entry.imageId, sourceAssetId: entry.sourceAssetId, source: entry.source, fileName: entry.fileName,
        original: entry.original, sourceInfo: entry.sourceInfo, ...(entry.page ? { page: entry.page } : {}),
        working: { width: entry.width, height: entry.height }, storedAt: new Date().toISOString(),
      }, null, 2));
    }
  });
  return entry;
}

// The image for an id: memory first, then disk (after eviction or restart).
export async function ensureImage(imageId) {
  // An image whose load is under way is waited for even if already cached.
  // A load that failed part-way leaves a cached entry without its saved canvas:
  // it counts as unsaved, so the next call runs the load again.
  if (canvases && hexOk(imageId) && (loading.has(imageId) || unsaved.has(imageId) || !hasImage(imageId))) return once(imageId, async () => {
    if (hasImage(imageId) && !unsaved.has(imageId)) return getImage(imageId);
    unsaved.add(imageId);
    const entry = await restoreImage(imageId);
    unsaved.delete(imageId);
    return entry;
  });
  return ensureFromFiles(imageId);
}
async function restoreImage(imageId) {
  {
    const record = await canvases.read(imageId);
    if (!record) return (await migrateImage(imageId)) ?? getImage(imageId);
    let meta = record.extra.meta;
    // A record from before metadata moved into the store.
    if (!meta && root) meta = await readJson(join(folder(imageId), "meta.json"));
    let bytes = await canvases.imageBytes(imageId);
    if (!bytes && root) { try { bytes = await readFile(join(folder(imageId), "source")); await canvases.putImage(bytes); } catch { bytes = null; } }
    if (!bytes || imageIdOf(bytes) !== imageId) return getImage(imageId);
    const entry = await registerImage(bytes, { source: meta?.source ?? "storage", fileName: meta?.fileName ?? null });
    restoreCanvas(entry, record.canvas);
    if (meta?.page && !entry.page) entry.page = meta.page;
    await hydrate(imageId, record, entry, meta);
    log("info", "[storage] restored", { imageId, marks: entry.marks?.size ?? 0 });
    return entry;
  }
}
async function ensureFromFiles(imageId) {
  if (hasImage(imageId) || !root || !hexOk(imageId)) return getImage(imageId);
  const dir = folder(imageId);
  const meta = await readJson(join(dir, "meta.json"));
  let bytes;
  try { bytes = await readFile(join(dir, "source")); } catch { return getImage(imageId); }
  const entry = await registerImage(bytes, { source: meta?.source ?? "storage", fileName: meta?.fileName ?? null });
  restoreCanvas(entry, await readJson(join(dir, "canvas.json")));
  restoreDerived(entry, await readJson(join(dir, "derived.json")));
  if (meta?.page && !entry.page) entry.page = meta.page;
  log("info", "[storage] restored", { imageId, marks: entry.marks?.size ?? 0 });
  return entry;
}

// A canvas whose save failed must not keep the failed change in memory:
// later reads would show it and the next successful save would persist it
// (architecture review A03). The in-memory canvas goes back to what the
// store holds for it, the last acknowledged (durable) state, or to an empty
// canvas when nothing was ever stored. Only the latest save of a canvas
// rolls back; see saveCanvas.
const saveStates = new WeakMap();
function saveState(entry) {
  let state = saveStates.get(entry);
  if (!state) saveStates.set(entry, state = { issued: 0, latest: null, durable: null, durableSeq: 0, outstanding: new Map() });
  return state;
}
// Returns false when a newer save of the canvas was issued meanwhile: that
// save carries this change and the newer edits, so nothing is restored.
async function rollbackCanvas(entry, key, state, seq) {
  let record = null;
  try { record = await canvases.read(key); }
  catch (error) { log("error", "[storage] the stored canvas could not be read back after a failed save", { set: key, error: String(error?.message || error) }); }
  if (state.issued !== seq) return false;
  // The store's record first; else the last state this process saw
  // acknowledged. Without either, nothing is known to be durable, and the
  // canvas is left as it is rather than emptied.
  const stored = record?.canvas?.imageId === entry.imageId ? record.canvas : state.durable;
  if (!stored) { log("error", "[storage] save failed and no durable state is known; memory keeps the unsaved change", { set: key }); return true; }
  restoreCanvas(entry, structuredClone(stored));
  log("info", "[storage] save failed; canvas restored to its last durable state", { set: key });
  return true;
}

// After a change: rewrite canvas.json and marks.svg, append one history line.
export function saveCanvas(entry, { tool, author = "assistant", changed = [], removed = [], note, commandId, argsHash, canvases: spread } = {}) {
  if (commandId && !canvases) rememberCommand(entry, { at: new Date().toISOString(), tool, author, changed, commandId, argsHash, ...(spread > 1 ? { canvases: spread } : {}) });
  if (canvases) {
    // Acknowledged only once durable in the store: a failure rejects.
    const canvas = serializeCanvas(entry);
    const line = { at: canvas.savedAt, tool, author, changed, ...(removed.length ? { removed } : {}), ...(note ? { note } : {}), ...(commandId ? { commandId, argsHash, ...(spread > 1 ? { canvases: spread } : {}) } : {}), marks: canvas.marks.length };
    const key = setKeyOf(entry), state = saveState(entry), seq = ++state.issued;
    // A command id is recorded in the same line as its edit. If this save fails but a later save of the canvas
    // carries the edit (see below), that later line must carry the record too, or the edit would be durable
    // without its deduplication record: so every save lists the commands whose own saves are not yet durable.
    if (commandId) state.outstanding.set(commandId, { commandId, argsHash, tool, at: canvas.savedAt, ...(spread > 1 ? { canvases: spread } : {}) });
    const carried = [...state.outstanding.values()].filter((c) => c.commandId !== commandId);
    if (carried.length) line.carried = carried;
    const listed = [...(commandId ? [commandId] : []), ...carried.map((c) => c.commandId)];
    // Marks are shared objects that later edits change in place, so the
    // durable copy kept for a rollback is taken now.
    const snapshot = structuredClone(canvas);
    const write = canvases.write(key, { canvas, line }).then(() => {
      if (seq > state.durableSeq) { state.durable = snapshot; state.durableSeq = seq; }
      for (const id of listed) state.outstanding.delete(id);
    });
    const acked = write.catch(async (error) => {
      // A later save of this canvas serialized it after this change, so this
      // change is durable exactly when that save is: answer with its outcome.
      if (state.issued !== seq) return state.latest;
      // The read below waits; a save issued during it supersedes this one.
      if (!(await rollbackCanvas(entry, key, state, seq))) return state.latest;
      // Restored to the last durable state: nothing outstanding was applied.
      state.outstanding.clear();
      throw error;
    });
    state.latest = acked;
    return acked;
  }
  if (!root) return Promise.resolve();
  const path = canvasPath(entry), dir = dirname(path), base = entry.setId ? entry.setId + "." : "";
  const canvas = serializeCanvas(entry);
  const svg = exportMarksSvg(entry, canvas.marks, canvasLayers(entry));
  const line = JSON.stringify({ at: canvas.savedAt, tool, author, changed, ...(removed.length ? { removed } : {}),
    ...(note ? { note } : {}), marks: canvas.marks.length }) + "\n";
  return queued(setKeyOf(entry), async () => {
    await mkdir(dir, { recursive: true });
    await atomicWrite(path, JSON.stringify(canvas));
    await atomicWrite(join(dir, base + "marks.svg"), svg);
    await appendFile(join(dir, base + "history.jsonl"), line);
  }).catch((error) => log("error", "[storage] save failed", { set: setKeyOf(entry), error: String(error?.message || error) }));
}

// A copy of a canvas (workspace Copy), or null when there is none on disk.
export async function readSet(imageId, setId) {
  if (canvases && hexOk(imageId) && SET_ID.test(setId)) {
    const key = imageId + "#" + setId, record = await canvases.read(key);
    if (record) {
      // A copy stored before change logs moved into the store: its log file comes in once.
      if (root && !record.extra.log.length) {
        const older = await readHistory(imageId, LOG_LINES, { files: true, base: join("sets", setId + ".") });
        if (older.length) await canvases.write(key, { log: older });
      }
      return record.canvas?.setId === setId ? record.canvas : null;
    }
    const data = root ? await readJson(join(folder(imageId), "sets", setId + ".json")) : null;
    if (data?.setId !== setId || data.imageId !== imageId) return null;
    // An older copy file: migrated in once, with its own change log.
    await canvases.write(key, { canvas: data, log: await readHistory(imageId, LOG_LINES, { files: true, base: join("sets", setId + ".") }) });
    return data;
  }
  if (!root || !hexOk(imageId) || !SET_ID.test(setId)) return null;
  const data = await readJson(join(folder(imageId), "sets", setId + ".json"));
  return data?.setId === setId ? data : null;
}

// The original bytes of a stored image (for workspace bundles), or null.
export async function readSource(imageId) {
  if (canvases && hexOk(imageId)) {
    const bytes = await canvases.imageBytes(imageId);
    if (bytes) return bytes;
    return (await ensureImage(imageId).catch(() => null))?.sourceBytes ?? null;
  }
  if (!root || !hexOk(imageId)) return null;
  try { return await readFile(join(folder(imageId), "source")); } catch { return null; }
}
export async function readMeta(imageId) {
  if (canvases && hexOk(imageId)) {
    const meta = (await canvases.read(imageId))?.extra.meta;
    if (meta) return meta;
    await ensureImage(imageId).catch(() => null);
    return (await canvases.read(imageId))?.extra.meta ?? null;
  }
  return root && hexOk(imageId) ? readJson(join(folder(imageId), "meta.json")) : null;
}

// ---- Workspaces ----------------------------------------------------------
const WS_HEX = /^[0-9a-f]{16}$/;
const wsPath = (hex) => join(root, "workspaces", hex + ".json");
export function saveWorkspaceFile(doc, line) {
  // A save is acknowledged only once it is durable in the store: a failure rejects.
  if (records) return records.write("workspace", doc.id, doc, { line }).then(() => undefined);
  if (!root) return Promise.resolve();
  const hex = doc.id.slice(3);
  return queued(doc.id, async () => {
    await mkdir(join(root, "workspaces"), { recursive: true });
    await atomicWrite(wsPath(hex), JSON.stringify(doc));
    if (line) await appendFile(join(root, "workspaces", hex + ".history.jsonl"), JSON.stringify(line) + "\n");
  }).catch((error) => log("error", "[storage] workspace save failed", { workspace: doc.id, error: String(error?.message || error) }));
}
// Several workspaces changed by one operation (a merge, split, move or undo).
// In the UVA store they are kept together: once this resolves all are saved,
// a crash included, and when it rejects none is. list: [{ doc, line }].
export function saveWorkspaceFiles(list) {
  if (records && list.length > 1) return records.writeMany(list.map(({ doc, line }) => ({ kind: "workspace", id: doc.id, value: doc, line }))).then(() => undefined);
  return Promise.all(list.map(({ doc, line }) => saveWorkspaceFile(doc, line))).then(() => undefined);
}
export async function readWorkspaceFile(id) {
  if (records) { const doc = await records.read("workspace", String(id)); return doc?.id === id ? doc : null; }
  const hex = String(id).slice(3);
  if (!root || !WS_HEX.test(hex)) return null;
  const doc = await readJson(wsPath(hex));
  return doc?.id === id ? doc : null;
}
export async function workspaceHistory(id, limit = 50) {
  if (records) return (await records.log("workspace", String(id))).slice(-limit);
  const hex = String(id).slice(3);
  if (!root || !WS_HEX.test(hex)) return [];
  try {
    const lines = (await readFile(join(root, "workspaces", hex + ".history.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
export async function listWorkspaceFiles() {
  if (records) return (await Promise.all((await records.list("workspace")).map((id) => records.read("workspace", id)))).filter((d) => d && typeof d.id === "string");
  if (!root) return [];
  const names = await readdir(join(root, "workspaces")).catch(() => []);
  const docs = await Promise.all(names.filter((n) => /^[0-9a-f]{16}\.json$/.test(n)).map((n) => readJson(join(root, "workspaces", n))));
  return docs.filter((d) => d && typeof d.id === "string");
}

function restoreDerived(entry, data) {
  if (data?.calibrations && typeof data.calibrations === "object") {
    entry.calibrations = new Map(Object.entries(data.calibrations).filter(([, c]) => c && Number.isFinite(c.unitsPerPixel)));
  }
  if (!Array.isArray(data?.views)) return;
  entry.derivedViews = new Map(data.views.filter((v) => /^dv:[0-9a-f]{16}$/.test(v?.derivedViewId) && v.imageId === entry.imageId)
    .map((v) => [v.derivedViewId, v]));
}

// Processed-view recipes, rewritten whole (they are small and bounded).
export function saveDerived(entry) {
  if (canvases) {
    if (!(entry.derivedViews?.size || entry.calibrations?.size)) return Promise.resolve();
    return canvases.write(entry.imageId, { derived: derivedOf(entry) }).then(() => undefined)
      .catch((error) => log("error", "[storage] derived save failed", { imageId: entry.imageId, error: String(error?.message || error) }));
  }
  if (!root || !(entry.derivedViews?.size || entry.calibrations?.size)) return Promise.resolve();
  const dir = folder(entry.imageId);
  const body = JSON.stringify({ version: 1, imageId: entry.imageId, views: [...(entry.derivedViews?.values() ?? [])],
    calibrations: Object.fromEntries(entry.calibrations ?? []) });
  return queued(entry.imageId, async () => {
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, "derived.json"), body);
  }).catch((error) => log("error", "[storage] derived save failed", { imageId: entry.imageId, error: String(error?.message || error) }));
}

// PDFs the user gave us, kept (with storage) so a page can be rendered
// again at another DPI without sending the file again.
const pdfPath = (sha) => join(root, "documents", sha, "source.pdf");
export async function saveDocument(bytes, sha) {
  if (!root || !/^[0-9a-f]{64}$/.test(sha)) return;
  try {
    await mkdir(join(root, "documents", sha), { recursive: true });
    await atomicWrite(pdfPath(sha), bytes);
  } catch (error) { log("error", "[storage] document save failed", { sha, error: String(error?.message || error) }); }
}
export async function loadDocument(sha) {
  if (!root || !/^[0-9a-f]{64}$/.test(sha)) return null;
  try { return await readFile(pdfPath(sha)); } catch { return null; }
}

// The change log of one canvas (a copy has its own), for command-id lookups. Only the UVA store keeps command ids.
// Without the UVA store (legacy files or memory only) the ids are kept in memory: retries within one run
// are still applied once, but the record does not survive a restart.
const memoryCommands = new Map();
const MEMORY_COMMAND_LINES = 200;
function rememberCommand(entry, line) {
  const key = setKeyOf(entry), list = memoryCommands.get(key) ?? [];
  memoryCommands.delete(key); memoryCommands.set(key, [...list, line].slice(-MEMORY_COMMAND_LINES));
  while (memoryCommands.size > 256) memoryCommands.delete(memoryCommands.keys().next().value);
}
export async function readCommandLog(entry) {
  if (!canvases) return memoryCommands.get(setKeyOf(entry)) ?? [];
  return (await canvases.read(setKeyOf(entry)))?.extra.log ?? [];
}

// `files`: the older history.jsonl itself (migration); `base`: a workspace copy's prefix.
export async function readHistory(imageId, limit = 50, { files = false, base = "" } = {}) {
  if (canvases && !files && hexOk(imageId)) return ((await canvases.read(imageId))?.extra.log ?? []).slice(-limit);
  if (!root || !hexOk(imageId)) return [];
  try {
    const lines = (await readFile(join(folder(imageId), base + "history.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ESTAMPES_STORAGE_RETENTION_DAYS > 0: drop images untouched for that long.
export async function sweepStorage(now = Date.now()) {
  if (!root || !(config.retentionDays > 0)) return 0;
  // The UVA store keeps its images (it has no asset GC yet); older files are left for migration.
  if (canvases) return 0;
  const base = join(root, "images");
  let removed = 0;
  // Images a workspace still shows stay as long as the workspace does.
  const used = new Set((await listWorkspaceFiles()).flatMap((w) => (w.items ?? []).map((i) => String(i.asset).slice(4))));
  for (const name of await readdir(base).catch(() => [])) {
    if (!/^[0-9a-f]{16}$/.test(name) || hasImage("img:" + name) || used.has(name)) continue;
    const dir = join(base, name);
    const times = await Promise.all(["canvas.json", "meta.json"].map((f) => stat(join(dir, f)).then((s) => s.mtimeMs, () => 0)));
    if (now - Math.max(...times) > config.retentionDays * 86400000) { await rm(dir, { recursive: true, force: true }); removed++; }
  }
  // PDF source documents follow the same retention, judged by their last write.
  for (const name of await readdir(join(root, "documents")).catch(() => [])) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    const dir = join(root, "documents", name);
    const t = await stat(join(dir, "source.pdf")).then((s) => s.mtimeMs, () => 0);
    if (now - t > config.retentionDays * 86400000) { await rm(dir, { recursive: true, force: true }); removed++; }
  }
  if (removed) log("info", "[storage] retention sweep", { removed });
  return removed;
}
