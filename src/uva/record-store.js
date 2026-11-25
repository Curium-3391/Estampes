// ESTAMPES_CANVAS_STORE=uva, beside the canvases: the other records the server
// keeps live in the UVA store, and nowhere else.
//   workspace   a workspace (src/workspace.js through src/storage.js), with its
//               change log (the last LOG_LINES lines) kept beside it
//   surface     panels and layouts (src/surface/store.js)
//   notebook    calculator notebooks (src/cas/notebooks.js)
//   model       instances of module-owned data (src/models/store.js)
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
// A change over several records (writeMany: a workspace merge, split or move
// touches two workspaces) is written first as one durable intent,
//   uva-pending/intents/<token>.json   every record's new value and log line,
//                                      with the seq each record had (`base`),
// and acknowledged from then on. Each record is then written as above; the
// intent is removed once all are. An intent a stopped server left, or one
// whose record writes failed, is rolled forward at startup and on the retry
// timer: a record whose seq is still `base` gets its value, one that moved on
// (already written, or changed by a later write) is left as it is. Until then
// a read of such a record answers with the intent's value. No record of the
// change can be seen without the others.
//
// Files an older version wrote (workspaces/<hex>.json, surfaces/sf_<hex>.json,
// cas/notebooks/nb_<hex>.json, with workspaces/<hex>.history.jsonl) are only read,
// once, when the store has no record of that id: the file is migrated in as
// seq 1 and never read or written again. Per record,
// `diagnostics.mirror.recordStore.records` shows the durable pending seq and
// the committed seq.
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { hashJson } from "../documents/validation.js";
import { createMirror } from "./mirror.js";

const RECORD = "estampes.record-pending/1";
const INTENT = "estampes.record-intent/1";
export const LOG_LINES = 200;
const WS = /^ws:[0-9a-f]{16}$/, SF = /^sf:[0-9a-f]{16}$/, NB = /^nb:[0-9a-f]{12}$/, MD = /^md:[0-9a-f]{12}$/;
const jsonl = (text) => text.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
export const KINDS = Object.freeze({
  workspace: { dir: ["workspaces"], file: /^([0-9a-f]{16})\.json$/, id: (m) => "ws:" + m, name: (id) => id.slice(3) + ".json", logName: (id) => id.slice(3) + ".history.jsonl", idOk: (id) => WS.test(id), valid: (v, id) => v?.id === id && Array.isArray(v.items) },
  surface: { dir: ["surfaces"], file: /^sf_([0-9a-f]{16})\.json$/, id: (m) => "sf:" + m, name: (id) => "sf_" + id.slice(3) + ".json", idOk: (id) => SF.test(id), valid: (v, id) => v?.surfaceId === id && typeof v.schema === "string" },
  // #85 V1-2: an instance of a module-owned model (src/models/store.js). Never a legacy file: `dir` only names where none exists.
  model: { dir: ["models"], file: /^md_([0-9a-f]{12})\.json$/, id: (m) => "md:" + m, name: (id) => "md_" + id.slice(3) + ".json", idOk: (id) => MD.test(id), valid: (v, id) => v?.id === id && v.schema === "estampes.model/1" },
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
  const dir = join(storageDir, "uva-pending", "records"), intentDir = join(storageDir, "uva-pending", "intents");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(intentDir, { recursive: true, mode: 0o700 });
  await syncDir(dirname(dir)); await syncDir(storageDir);
  const pendingFile = (key) => { const p = parts(key); return join(dir, p.kind + "-" + p.id.replace(":", "_") + ".json"); };
  const legacyFile = (key) => { const p = parts(key); return join(storageDir, ...KINDS[p.kind].dir, KINDS[p.kind].name(p.id)); };
  // `known`: { hash, seq, value, log } of the latest record, per key. Every write goes
  // through this store, so a value once read or written stays current.
  // `ids`: per kind, every id once listed.
  // `unapplied`: key → { token, value } of an acknowledged intent whose
  // record write has not happened yet; reads answer with its value.
  const queues = new Map(), known = new Map(), records = new Map(), ids = new Map(), unapplied = new Map();
  const stats = { writes: 0, committed: 0, read: { uva: 0, pending: 0 }, migrated: 0, failedWrites: 0, intents: 0, rolledForward: 0, lastError: null };
  const note = () => service.noteMirror({ recordStore: { ...stats, read: { ...stats.read }, unapplied: [...unapplied.keys()], records: Object.fromEntries(records) } });
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
  // `stored`: the record as written, without an acknowledged intent's value.
  async function current(key, { stored = false } = {}) {
    if (!stored && unapplied.has(key)) return unapplied.get(key).value;
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
    unapplied.delete(key); // written, or replaced by a later write
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
    // Several records as one change: resolves once its intent is durable
    // (then every record of it is kept, after a crash too); rejects when it
    // is not, and then none is. entries: [{ kind, id, value, line }].
    writeMany(entries) {
      let items;
      try {
        items = entries.map(({ kind, id, value, line = null }) => {
          const key = keyOf(kind, id);
          if (!key) throw new Error("Invalid record " + kind + "/" + id);
          if (!KINDS[kind].valid(value, id)) throw new Error("Not a valid " + kind + " record for " + id);
          return { key, value: JSON.parse(JSON.stringify(value)), line: line === null ? null : JSON.parse(JSON.stringify(line)) };
        });
        if (new Set(items.map((i) => i.key)).size !== items.length) throw new Error("A record appears twice in one change");
      } catch (error) { return Promise.reject(error); }
      // Every record's queue is held for the whole change. The jobs are queued
      // in one go, so two changes over the same records cannot wait on each other.
      let release;
      const hold = new Promise((r) => { release = r; });
      const arrived = items.map(({ key }) => new Promise((ready) => { queued(key, () => { ready(); return hold; }); }));
      const run = (async () => {
        await Promise.all(arrived);
        for (const item of items) { await current(item.key, { stored: true }); item.base = known.get(item.key)?.seq ?? 0; }
        const tx = { schema: INTENT, token: randomUUID(), records: items };
        const file = join(intentDir, tx.token + ".json");
        await durableWrite(file, JSON.stringify(tx));
        stats.intents++;
        await applyIntent(file, tx, { held: true });
        return tx.token;
      })();
      run.then(release, release);
      return run.catch((error) => {
        stats.failedWrites++; fault("intent write", items.map((i) => i.key).join(","), error);
        throw new Error("The change was not saved (its durable intent could not be written: " + String(error?.message || error) + ")");
      });
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
        for (const key of unapplied.keys()) { const p = parts(key); if (p.kind === kind) found.add(p.id); }
        ids.set(kind, found);
      }
      return [...ids.get(kind)];
    },
    recovered: [],
    flush: async () => { await retryIntents(); await retryPending(); await mirror.flush(); },
    async close() { clearInterval(timer); await mirror.stop(); await Promise.all([...queues.values()]); },
    get pending() { return mirror.pending; },
  };

  // One record of an intent, inside its queue: written when the record is
  // still at the intent's base seq, left alone when it moved on.
  async function applyEntry(entry) {
    await current(entry.key, { stored: true });
    const seq = known.get(entry.key)?.seq ?? 0;
    if (seq === entry.base) await put(entry.key, entry.value, { line: entry.line });
    if (unapplied.get(entry.key)?.token === entry.token) unapplied.delete(entry.key);
  }
  // Never rejects: a record that could not be written keeps the intent on
  // disk (rolled forward later) and is answered from it meanwhile.
  async function applyIntent(file, tx, { held = false } = {}) {
    let failed = 0;
    for (const record of tx.records) {
      const entry = { ...record, token: tx.token };
      try { await (held ? applyEntry(entry) : queued(entry.key, () => applyEntry(entry))); }
      catch (error) {
        failed++;
        if (!known.has(entry.key) || (known.get(entry.key).seq ?? 0) === entry.base) unapplied.set(entry.key, { token: tx.token, value: entry.value });
        fault("intent apply", entry.key, error);
      }
    }
    if (failed) { note(); return false; }
    try { await unlink(file); await syncDir(intentDir); } catch (error) { if (error.code !== "ENOENT") fault("intent remove", tx.token, error); }
    note();
    return true;
  }
  const readIntent = async (name) => {
    const tx = parseJson(await readText(join(intentDir, name)));
    return tx?.schema === INTENT && typeof tx.token === "string" && name === tx.token + ".json" && Array.isArray(tx.records) &&
      tx.records.every((r) => parts(r?.key) && r.value && typeof r.value === "object" && Number.isSafeInteger(r.base)) ? tx : null;
  };
  let rolling = null;
  function retryIntents() {
    rolling ??= (async () => {
      for (const name of await readdir(intentDir).catch(() => [])) {
        if (name.endsWith(".tmp")) continue;
        const tx = await readIntent(name);
        if (!tx) { fault("intent read", name, new Error("unreadable intent " + name + "; left in place")); continue; }
        if (await applyIntent(join(intentDir, name), tx)) stats.rolledForward++;
      }
    })().finally(() => { rolling = null; });
    return rolling;
  }

  // Startup: intents and pending records a stopped server left are taken up again.
  for (const name of await readdir(intentDir)) if (name.endsWith(".tmp")) await unlink(join(intentDir, name)).catch(() => {});
  await retryIntents();
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
  const timer = retryEveryMs > 0 ? setInterval(() => { retryIntents().then(retryPending).catch(() => {}); }, retryEveryMs) : null;
  timer?.unref?.();
  return api;
}
