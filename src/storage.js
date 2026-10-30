// Optional disk storage (ESTAMPES_STORAGE_DIR). Each image gets a folder:
//   images/<hash>/source       the bytes exactly as received
//   images/<hash>/meta.json    where it came from, original size
//   images/<hash>/canvas.json  marks, layers, links and rejected claims (rewritten atomically)
//   images/<hash>/marks.svg    the same canvas as a layered SVG
//   images/<hash>/history.jsonl one line per change: when, which tool, ids
//   images/<hash>/sets/<setId>.json  a copy of the canvas made by a workspace
//                              Copy (its own marks, layers and links)
//   workspaces/<hash>.json     a workspace: which canvases it shows and where
// Memory stays the working copy; disk is what lets an image come back after
// the cache evicts it or the container restarts. Without a storage dir every
// function here is a no-op and Estampes behaves as before.
import { mkdir, readFile, writeFile, rename, appendFile, readdir, stat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { config, log } from "./config.js";
import { registerImage, getImage, hasImage, imageIdOf } from "./image-store.js";
import { canvasMarks, canvasLayers, setKeyOf } from "./canvas-state.js";
import { exportMarksSvg } from "./marks-file.js";

let root = config.storageDir;
export const storageDir = () => root;
// Tests point storage at a temporary folder.
export function useStorageDir(dir) { root = dir; }

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
    version: CANVAS_VERSION, imageId: entry.imageId, width: entry.width, height: entry.height,
    ...(entry.setId ? { setId: entry.setId, ...(entry.derivedFrom ? { derivedFrom: entry.derivedFrom } : {}) } : {}),
    marks: canvasMarks(entry), layers: entry.layers ?? [], links,
    // Objects other modules keep with a canvas pass through unchanged.
    ...(entry.objects !== undefined ? { objects: entry.objects } : {}),
    ...(entry.userEdits?.length ? { userEdits: entry.userEdits } : {}),
    ...(entry.rejections?.length ? { rejections: entry.rejections } : {}), savedAt: new Date().toISOString(),
  };
}

export function restoreCanvas(entry, data) {
  if (!data || data.imageId !== entry.imageId) return entry;
  entry.marks = new Map((data.marks ?? []).filter((m) => m && typeof m.id === "string").map((m) => [m.id, m]));
  entry.layers = Array.isArray(data.layers) ? data.layers : [];
  entry.userEdits = Array.isArray(data.userEdits) ? data.userEdits : [];
  entry.rejections = Array.isArray(data.rejections) ? data.rejections.filter((r) => r && typeof r.kind === "string" && r.from) : [];
  entry.pairLinks = new Map(Object.entries(data.links ?? {}).filter(([id]) => setKeyOk(id))
    .map(([id, list]) => [id, new Map(list.map((l) => [l.id, l]))]));
  if (data.objects !== undefined) entry.objects = data.objects;
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
  const entry = await registerImage(bytes, options);
  if (!root || !fresh) return entry;
  const dir = folder(entry.imageId);
  const saved = await readJson(join(dir, "canvas.json"));
  if (saved) restoreCanvas(entry, saved);
  await queued(entry.imageId, async () => {
    await mkdir(dir, { recursive: true });
    if (!(await readJson(join(dir, "meta.json")))) {
      await atomicWrite(join(dir, "source"), bytes);
      await atomicWrite(join(dir, "meta.json"), JSON.stringify({
        imageId: entry.imageId, source: entry.source, fileName: entry.fileName, original: entry.original,
        working: { width: entry.width, height: entry.height }, storedAt: new Date().toISOString(),
      }, null, 2));
    }
  });
  return entry;
}

// The image for an id: memory first, then disk (after eviction or restart).
export async function ensureImage(imageId) {
  if (hasImage(imageId) || !root || !hexOk(imageId)) return getImage(imageId);
  const dir = folder(imageId);
  const meta = await readJson(join(dir, "meta.json"));
  let bytes;
  try { bytes = await readFile(join(dir, "source")); } catch { return getImage(imageId); }
  const entry = await registerImage(bytes, { source: meta?.source ?? "storage", fileName: meta?.fileName ?? null });
  restoreCanvas(entry, await readJson(join(dir, "canvas.json")));
  log("info", "[storage] restored", { imageId, marks: entry.marks?.size ?? 0 });
  return entry;
}

// After a change: rewrite canvas.json and marks.svg, append one history line.
export function saveCanvas(entry, { tool, author = "assistant", changed = [], removed = [], note } = {}) {
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
  if (!root || !hexOk(imageId) || !SET_ID.test(setId)) return null;
  const data = await readJson(join(folder(imageId), "sets", setId + ".json"));
  return data?.setId === setId ? data : null;
}

// The original bytes of a stored image (for workspace bundles), or null.
export async function readSource(imageId) {
  if (!root || !hexOk(imageId)) return null;
  try { return await readFile(join(folder(imageId), "source")); } catch { return null; }
}
export async function readMeta(imageId) {
  return root && hexOk(imageId) ? readJson(join(folder(imageId), "meta.json")) : null;
}

// ---- Workspaces ----------------------------------------------------------
const WS_HEX = /^[0-9a-f]{16}$/;
const wsPath = (hex) => join(root, "workspaces", hex + ".json");
export function saveWorkspaceFile(doc, line) {
  if (!root) return Promise.resolve();
  const hex = doc.id.slice(3);
  return queued(doc.id, async () => {
    await mkdir(join(root, "workspaces"), { recursive: true });
    await atomicWrite(wsPath(hex), JSON.stringify(doc));
    if (line) await appendFile(join(root, "workspaces", hex + ".history.jsonl"), JSON.stringify(line) + "\n");
  }).catch((error) => log("error", "[storage] workspace save failed", { workspace: doc.id, error: String(error?.message || error) }));
}
export async function readWorkspaceFile(id) {
  const hex = String(id).slice(3);
  if (!root || !WS_HEX.test(hex)) return null;
  const doc = await readJson(wsPath(hex));
  return doc?.id === id ? doc : null;
}
export async function workspaceHistory(id, limit = 50) {
  const hex = String(id).slice(3);
  if (!root || !WS_HEX.test(hex)) return [];
  try {
    const lines = (await readFile(join(root, "workspaces", hex + ".history.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
export async function listWorkspaceFiles() {
  if (!root) return [];
  const names = await readdir(join(root, "workspaces")).catch(() => []);
  const docs = await Promise.all(names.filter((n) => /^[0-9a-f]{16}\.json$/.test(n)).map((n) => readJson(join(root, "workspaces", n))));
  return docs.filter((d) => d && typeof d.id === "string");
}

export async function readHistory(imageId, limit = 50) {
  if (!root || !hexOk(imageId)) return [];
  try {
    const lines = (await readFile(join(folder(imageId), "history.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ESTAMPES_STORAGE_RETENTION_DAYS > 0: drop images untouched for that long.
export async function sweepStorage(now = Date.now()) {
  if (!root || !(config.retentionDays > 0)) return 0;
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
  if (removed) log("info", "[storage] retention sweep", { removed });
  return removed;
}
