// ESTAMPES_CANVAS_STORE=uva, beside the canvases: the other records the server
// keeps live in the UVA store, and nowhere else.
//   workspace   a workspace (src/workspace.js through src/storage.js), with its
//               change log (the last LOG_LINES lines) kept beside it
//   surface     panels and layouts (src/surface/store.js)
//   notebook    calculator notebooks (src/cas/notebooks.js)
// Each record is one UVA document (src/uva/service.js syncRecord), keyed
// "<kind>/<id>".
//
// The modules read and write through this store (read/write/list below); they
// write no files of their own. A write is acknowledged once
//   uva-pending/records/<kind>-<id>.json   is durable (file + folder fsync),
// carrying the next per-record sequence number `seq`; a coalesced commit then
// puts it into its UVA document and removes the pending copy once the document
// holds exactly its content. A read takes the higher seq of the pending copy
// and the document. Wall-clock times are never compared.
//
// Files an older version wrote (workspaces/<hex>.json, surfaces/sf_<hex>.json,
// cas/notebooks/nb_<hex>.json, with workspaces/<hex>.history.jsonl) are only read,
// once, when the store has no record of that id: the file is migrated in as
// seq 1 and never read or written again. Per record,
// `diagnostics.mirror.recordStore.records` shows the durable pending seq and
// the committed seq.
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { hashJson } from "../documents/validation.js";
import { createMirror } from "./mirror.js";

const RECORD = "estampes.record-pending/1";
export const LOG_LINES = 200;
const WS = /^ws:[0-9a-f]{16}$/, SF = /^sf:[0-9a-f]{16}$/, NB = /^nb:[0-9a-f]{12}$/;
const jsonl = (text) => text.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
export const KINDS = Object.freeze({
  workspace: { dir: ["workspaces"], file: /^([0-9a-f]{16})\.json$/, id: (m) => "ws:" + m, name: (id) => id.slice(3) + ".json", logName: (id) => id.slice(3) + ".history.jsonl", idOk: (id) => WS.test(id), valid: (v, id) => v?.id === id && Array.isArray(v.items) },
  surface: { dir: ["surfaces"], file: /^sf_([0-9a-f]{16})\.json$/, id: (m) => "sf:" + m, name: (id) => "sf_" + id.slice(3) + ".json", idOk: (id) => SF.test(id), valid: (v, id) => v?.surfaceId === id && typeof v.schema === "string" },
  notebook: { dir: ["cas", "notebooks"], file: /^nb_([0-9a-f]{12})\.json$/, id: (m) => "nb:" + m, name: (id) => "nb_" + id.slice(3) + ".json", idOk: (id) => NB.test(id), valid: (v, id) => v?.id === id && typeof v.schema === "string" },
});
const keyOf = (kind, id) => KINDS[kind]?.idOk(id) ? kind + "/" + id : null;
const parts = (key) => { const i = String(key).indexOf("/"), kind = String(key).slice(0, i), id = String(key).slice(i + 1); return i > 0 && keyOf(kind, id) === key ? { kind, id } : null; };
const PENDING = /^([a-z]+)-([a-z]{2})_([0-9a-f]{12,16})\.json$/;

// Which value a record has. Pure: records are { seq, value, log }; the higher seq wins.
export function chooseRecord({ uva = null, pending = null }) {
  const records = [uva && { from: "uva", ...uva }, pending && { from: "pending", ...pending }].filter(Boolean);
  if (!records.length) return null;
  const latest = records.reduce((a, b) => (b.seq > a.seq ? b : a));
  return { from: latest.from, value: latest.value, seq: latest.seq, log: Array.isArray(latest.log) ? latest.log : [] };
}
const logHashOf = (log) => hashJson(log ?? []);

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
async function readText(path) {
  try { return await readFile(path, "utf8"); } catch (error) {
    if (["ENOENT", "EISDIR", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
}
const parseJson = (text) => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };

export async function createRecordStore({ service, storageDir, idleMs = 15000, maxWaitMs = 120000, retryEveryMs = 30000, log = () => {} }) {
  if (!service?.syncRecord) throw new Error("The UVA service has no record store");
  const dir = join(storageDir, "uva-pending", "records");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await syncDir(dirname(dir)); await syncDir(storageDir);
  const pendingFile = (key) => { const p = parts(key); return join(dir, p.kind + "-" + p.id.replace(":", "_") + ".json"); };
  const legacyFile = (key) => { const p = parts(key); return join(storageDir, ...KINDS[p.kind].dir, KINDS[p.kind].name(p.id)); };
  // `known`: { hash, seq, value, log } of the latest record, per key. Every write goes
  // through this store, so a value once read or written stays current.
  // `ids`: per kind, every id once listed.
  const queues = new Map(), known = new Map(), records = new Map(), ids = new Map();
  const stats = { writes: 0, committed: 0, read: { uva: 0, pending: 0 }, migrated: 0, failedWrites: 0, lastError: null };
  const note = () => service.noteMirror({ recordStore: { ...stats, read: { ...stats.read }, records: Object.fromEntries(records) } });
  const track = (key, patch) => {
    const prev = records.get(key) ?? {};
    records.delete(key); records.set(key, { ...prev, ...patch });
    while (records.size > 64) records.delete(records.keys().next().value);
  };
  const fault = (where, key, error) => {
    stats.lastError = { where, key, message: String(error?.message || error), at: new Date().toISOString() };
    note();
    log("error", "[record-store] " + where + " failed", { key, error: stats.lastError.message });
  };
  // Reads and writes of one record run one after another.
  function queued(key, job) {
    const next = (queues.get(key) ?? Promise.resolve()).then(job, job), settled = next.catch(() => {});
    queues.set(key, settled);
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return next;
  }
  async function readPending(key) {
    const r = parseJson(await readText(pendingFile(key)));
    return r?.schema === RECORD && r.key === key && Number.isSafeInteger(r.seq) && r.value && typeof r.value === "object" ? r : null;
  }
  // A failing UVA read must not pass for "no record": migration would then
  // adopt an old file over newer committed state.
  const readUva = (key) => service.recordState(key);
  async function readLegacyLog(key) {
    const { kind, id } = parts(key), k = KINDS[kind];
    return k.logName ? jsonl((await readText(join(storageDir, ...k.dir, k.logName(id)))) ?? "").slice(-LOG_LINES) : [];
  }
  async function readLegacy(key) {
    const { kind, id } = parts(key), k = KINDS[kind], v = parseJson(await readText(legacyFile(key)));
    if (!k.valid(v, id)) return null;
    return { value: v, log: await readLegacyLog(key) };
  }

  const mirror = createMirror({
    service: { syncCanvas: (input) => service.syncRecord(input), noteMirror: (patch) => { if (patch.lastError) { stats.lastError = { where: "commit", key: patch.lastErrorImage, message: patch.lastError, at: patch.lastErrorAt }; note(); } } }, idleMs, maxWaitMs, log,
    read: async (key) => { const r = await readPending(key); return r && { key, value: r.value, seq: r.seq, log: r.log ?? [] }; },
    onSynced: async (key, result) => {
      if (result.status === "blocked") { track(key, { blocked: result.issues?.[0]?.message ?? true }); fault("commit", key, result.issues?.[0]?.message ?? "blocked"); return; }
      await queued(key, async () => {
        const r = await readPending(key);
        track(key, { committedSeq: result.seq ?? r?.seq ?? null, blocked: false });
        if (!r || hashJson(r.value) !== result.sourceHash || logHashOf(r.log) !== result.logHash) { note(); return; }
        await unlink(pendingFile(key));
        await syncDir(dir);
        stats.committed++; note();
      });
    },
  });

  // Inside the key's queue: the record's current value, migrating an older
  // file in when the store has none.
  async function current(key) {
    if (known.get(key)?.value !== undefined) return known.get(key).value;
    const [uva, pending] = await Promise.all([readUva(key), readPending(key)]);
    const choice = chooseRecord({ uva, pending });
    if (choice) {
      known.set(key, { hash: hashJson(choice.value), seq: choice.seq, value: choice.value, log: choice.log });
      stats.read[choice.from]++; note();
      if (choice.from === "pending") mirror.schedule(key);
      // A record from before change logs moved into the store has no log
      // field: the older log file is taken in once, the value stays as it is.
      const source = choice.from === "uva" ? uva : pending;
      if (KINDS[parts(key).kind].logName && !Array.isArray(source.log)) {
        try {
          const older = await readLegacyLog(key);
          if (older.length) await put(key, choice.value, { log: older });
        } catch (error) { known.delete(key); throw error; }
      }
      return known.get(key).value;
    }
    const legacy = await readLegacy(key);
    if (!legacy) { known.set(key, { hash: null, seq: 0, value: null, log: [] }); return null; }
    // The empty entry is installed only when there is nothing to migrate: a
    // failed migration must be tried again by the next read.
    try { await put(key, legacy.value, { log: legacy.log }); } catch (error) { known.delete(key); throw error; }
    stats.migrated++;
    note();
    return legacy.value;
  }
  // Inside the key's queue: writes the next pending record durably, with
  // `line` appended to its log (or the whole `log` replaced, on migration).
  async function put(key, value, { line = null, log = null } = {}) {
    if (!known.has(key)) {
      const [pending, uva] = await Promise.all([readPending(key), readUva(key)]);
      known.set(key, { hash: null, seq: Math.max(pending?.seq ?? 0, uva?.seq ?? 0), log: chooseRecord({ uva, pending })?.log ?? [] });
    }
    const was = known.get(key), copy = JSON.parse(JSON.stringify(value)), hash = hashJson(copy), seq = was.seq + 1;
    if (was.hash === hash && !line && !log) return was.seq;
    const lines = log ? log.slice(-LOG_LINES) : line ? [...(was.log ?? []), JSON.parse(JSON.stringify(line))].slice(-LOG_LINES) : (was.log ?? []);
    await durableWrite(pendingFile(key), JSON.stringify({ schema: RECORD, key, seq, value: copy, log: lines }));
    known.set(key, { hash, seq, value: copy, log: lines });
    ids.get(parts(key).kind)?.add(parts(key).id);
    stats.writes++;
    track(key, { pendingSeq: seq });
    note();
    mirror.schedule(key);
    return seq;
  }

  const api = {
    chooseRecord,
    // The value of <kind>/<id>, or null.
    read(kind, id) {
      const key = keyOf(kind, id);
      if (!key) return Promise.resolve(null);
      return queued(key, () => current(key)).then((v) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v))));
    },
    // Resolves with the seq once the record is durable; rejects when it is not.
    // `line`: one entry for the record's change log.
    write(kind, id, value, { line = null } = {}) {
      const key = keyOf(kind, id);
      if (!key) return Promise.reject(new Error("Invalid record " + kind + "/" + id));
      if (!KINDS[kind].valid(value, id)) return Promise.reject(new Error("Not a valid " + kind + " record for " + id));
      return queued(key, async () => { if (known.get(key)?.value === undefined) await current(key); return put(key, value, { line }); })
        .catch((error) => { stats.failedWrites++; track(key, { failedSeq: (known.get(key)?.seq ?? 0) + 1 }); fault("pending write", key, error); throw new Error("The " + kind + " was not saved (its durable record could not be written: " + String(error?.message || error) + ")"); });
    },
    // The record's change log, oldest first.
    log(kind, id) {
      const key = keyOf(kind, id);
      if (!key) return Promise.resolve([]);
      return queued(key, async () => { await current(key); return JSON.parse(JSON.stringify(known.get(key)?.log ?? [])); });
    },
    // Every id of a kind: in the store, pending, or in an older file.
    async list(kind) {
      const k = KINDS[kind];
      if (!ids.has(kind)) {
        const found = new Set();
        for (const key of await service.recordKeys()) { const p = parts(key); if (p?.kind === kind) found.add(p.id); }
        for (const name of await readdir(dir).catch(() => [])) { const m = PENDING.exec(name); if (m?.[1] === kind && keyOf(kind, m[2] + ":" + m[3])) found.add(m[2] + ":" + m[3]); }
        for (const name of await readdir(join(storageDir, ...k.dir)).catch(() => [])) { const m = k.file.exec(name); if (m) found.add(k.id(m[1])); }
        ids.set(kind, found);
      }
      return [...ids.get(kind)];
    },
    recovered: [],
    flush: async () => { await retryPending(); await mirror.flush(); },
    async close() { clearInterval(timer); await mirror.stop(); await Promise.all([...queues.values()]); },
    get pending() { return mirror.pending; },
  };

  // Startup: pending records a stopped server left are committed again.
  for (const name of await readdir(dir)) {
    const m = PENDING.exec(name);
    if (m && parts(m[1] + "/" + m[2] + ":" + m[3])) api.recovered.push(m[1] + "/" + m[2] + ":" + m[3]);
    else if (name.endsWith(".tmp")) await unlink(join(dir, name)).catch(() => {});
  }
  for (const key of api.recovered) mirror.schedule(key);
  note();
  // A pending record whose commit failed (a transient storage error) is tried again.
  async function retryPending() {
    for (const name of await readdir(dir).catch(() => [])) {
      const m = PENDING.exec(name);
      if (m && parts(m[1] + "/" + m[2] + ":" + m[3])) mirror.schedule(m[1] + "/" + m[2] + ":" + m[3]);
    }
  }
  const timer = retryEveryMs > 0 ? setInterval(() => { retryPending().catch(() => {}); }, retryEveryMs) : null;
  timer?.unref?.();
  return api;
}
