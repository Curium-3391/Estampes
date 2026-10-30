// Optional disk storage (ESTAMPES_STORAGE_DIR). Each image gets a folder:
//   images/<hash>/source       the bytes exactly as received
//   images/<hash>/meta.json    where it came from, original size
//   images/<hash>/canvas.json  marks, layers and links (rewritten atomically)
//   images/<hash>/marks.svg    the same canvas as a layered SVG
//   images/<hash>/history.jsonl one line per change: when, which tool, ids
// Memory stays the working copy; disk is what lets an image come back after
// the cache evicts it or the container restarts. Without a storage dir every
// function here is a no-op and Estampes behaves as before.
import { mkdir, readFile, writeFile, rename, appendFile, readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { config, log } from "./config.js";
import { registerImage, getImage, hasImage, imageIdOf } from "./image-store.js";
import { canvasMarks, canvasLayers } from "./canvas-state.js";
import { exportMarksSvg } from "./marks-file.js";

let root = config.storageDir;
export const storageDir = () => root;
// Tests point storage at a temporary folder.
export function useStorageDir(dir) { root = dir; }

const CANVAS_VERSION = 1;
const folder = (imageId) => join(root, "images", imageId.slice(4));
const hexOk = (imageId) => /^img:[0-9a-f]{16}$/.test(imageId);

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
    marks: canvasMarks(entry), layers: entry.layers ?? [], links,
    ...(entry.userEdits?.length ? { userEdits: entry.userEdits } : {}), savedAt: new Date().toISOString(),
  };
}

export function restoreCanvas(entry, data) {
  if (!data || data.imageId !== entry.imageId) return entry;
  entry.marks = new Map((data.marks ?? []).filter((m) => m && typeof m.id === "string").map((m) => [m.id, m]));
  entry.layers = Array.isArray(data.layers) ? data.layers : [];
  entry.userEdits = Array.isArray(data.userEdits) ? data.userEdits : [];
  entry.pairLinks = new Map(Object.entries(data.links ?? {}).filter(([id]) => hexOk(id))
    .map(([id, list]) => [id, new Map(list.map((l) => [l.id, l]))]));
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
  const dir = folder(entry.imageId);
  const canvas = serializeCanvas(entry);
  const svg = exportMarksSvg(entry, canvas.marks, canvasLayers(entry));
  const line = JSON.stringify({ at: canvas.savedAt, tool, author, changed, ...(removed.length ? { removed } : {}),
    ...(note ? { note } : {}), marks: canvas.marks.length }) + "\n";
  return queued(entry.imageId, async () => {
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, "canvas.json"), JSON.stringify(canvas));
    await atomicWrite(join(dir, "marks.svg"), svg);
    await appendFile(join(dir, "history.jsonl"), line);
  }).catch((error) => log("error", "[storage] save failed", { imageId: entry.imageId, error: String(error?.message || error) }));
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
  for (const name of await readdir(base).catch(() => [])) {
    if (!/^[0-9a-f]{16}$/.test(name) || hasImage("img:" + name)) continue;
    const dir = join(base, name);
    const times = await Promise.all(["canvas.json", "meta.json"].map((f) => stat(join(dir, f)).then((s) => s.mtimeMs, () => 0)));
    if (now - Math.max(...times) > config.retentionDays * 86400000) { await rm(dir, { recursive: true, force: true }); removed++; }
  }
  if (removed) log("info", "[storage] retention sweep", { removed });
  return removed;
}
