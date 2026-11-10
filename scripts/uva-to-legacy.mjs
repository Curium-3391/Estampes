// Before switching ESTAMPES_CANVAS_STORE from uva to legacy: writes what lives
// only in the UVA store back to the files the legacy store reads: images (their
// bytes, metadata, canvas, processed views and change log), workspace copies,
// workspaces with their change logs, panel surfaces and calculator notebooks.
// Run it with the server stopped:
//   node scripts/uva-to-legacy.mjs <storage dir> [<uva dir>] [<profile>]
// Each record is written from the higher seq of its committed document and its
// durable pending copy, the same choice the server makes. Nothing in the UVA
// store is changed, so switching back to uva later is safe.
import { mkdir, writeFile, rename, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createUvaService } from "../src/uva/service.js";
import { createRecordStore, KINDS } from "../src/uva/record-store.js";
import { createCanvasStore } from "../src/uva/canvas-store.js";

const [storageArg, uvaArg, profileArg] = process.argv.slice(2);
if (!storageArg) { console.error("Usage: node scripts/uva-to-legacy.mjs <storage dir> [<uva dir>] [<profile>]"); process.exit(2); }
const storageDir = resolve(storageArg), uvaDir = resolve(uvaArg ?? storageDir.replace(/\/+$/, "") + "-uva");
const service = await createUvaService({ enabled: true, canvasStore: true, directory: uvaDir, profile: profileArg ?? "linux-process-crash-test", legacyDirectory: storageDir });
// No commits are made: pending copies stay where they are for the next start.
const records = await createRecordStore({ service, storageDir, idleMs: 3600000, retryEveryMs: 0 });
const canvases = await createCanvasStore({ service, storageDir, idleMs: 3600000 });
// Only records the store holds: an id that exists only as an older file is left as it is.
const stored = new Set(await service.recordKeys());
for (const name of await readdir(join(storageDir, "uva-pending", "records")).catch(() => [])) {
  const m = /^([a-z]+)-([a-z]{2})_([0-9a-f]{12,16})\.json$/.exec(name);
  if (m) stored.add(m[1] + "/" + m[2] + ":" + m[3]);
}
const written = { canvas: 0, image: 0 };
const put = async (path, data) => { const tmp = path + ".uva-to-legacy.tmp"; await writeFile(tmp, data); await rename(tmp, path); };
const lines = (log) => log.map((l) => JSON.stringify(l) + "\n").join("");
try {
  // Canvases: the store's documents and their pending copies.
  const canvasKeys = new Set(await service.canvasImages());
  for (const name of await readdir(join(storageDir, "uva-pending")).catch(() => [])) {
    const m = /^([0-9a-f]{16})(?:-(c[0-9a-f]{12}))?\.json$/.exec(name);
    if (m) canvasKeys.add("img:" + m[1] + (m[2] ? "#" + m[2] : ""));
  }
  const images = new Set();
  for (const key of [...canvasKeys].sort()) {
    const record = await canvases.read(key);
    if (!record) continue;
    const [imageId, setId] = key.split("#"), folder = join(storageDir, "images", imageId.slice(4));
    if (!images.has(imageId)) {
      images.add(imageId);
      await mkdir(folder, { recursive: true });
      const bytes = await canvases.imageBytes(imageId).catch(() => null);
      if (bytes) { await put(join(folder, "source"), bytes); written.image++; }
    }
    if (setId) {
      await mkdir(join(folder, "sets"), { recursive: true });
      await put(join(folder, "sets", setId + ".json"), JSON.stringify(record.canvas));
      await put(join(folder, "sets", setId + ".history.jsonl"), lines(record.extra.log));
    } else {
      await put(join(folder, "canvas.json"), JSON.stringify(record.canvas));
      await put(join(folder, "history.jsonl"), lines(record.extra.log));
      if (record.extra.meta) await put(join(folder, "meta.json"), JSON.stringify(record.extra.meta));
      if (record.extra.derived) await put(join(folder, "derived.json"), JSON.stringify(record.extra.derived));
    }
    written.canvas++;
  }
  for (const [kind, k] of Object.entries(KINDS)) {
    written[kind] = 0;
    for (const key of stored) {
      if (!key.startsWith(kind + "/")) continue;
      const id = key.slice(kind.length + 1);
      const value = await records.read(kind, id);
      if (!value) continue;
      const folder = join(storageDir, ...k.dir), path = join(folder, k.name(id)), tmp = path + ".uva-to-legacy.tmp";
      await mkdir(folder, { recursive: true });
      await writeFile(tmp, JSON.stringify(value));
      await rename(tmp, path);
      if (k.logName) {
        const logPath = join(folder, k.logName(id));
        await writeFile(logPath + ".uva-to-legacy.tmp", (await records.log(kind, id)).map((l) => JSON.stringify(l) + "\n").join(""));
        await rename(logPath + ".uva-to-legacy.tmp", logPath);
      }
      written[kind]++;
    }
  }
} finally { await canvases.close(); await records.close(); await service.close(); }
console.log(JSON.stringify({ storageDir, uvaDir, written }));
