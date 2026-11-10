// ESTAMPES_CANVAS_STORE=uva, beside the canvases: the other records the server
// keeps are committed to UVA too, and restored from it.
//   workspace   workspaces/<hex>.json            (the sealed workspace module)
//   surface     surfaces/sf_<hex>.json           (panels and layouts, src/surface)
//   notebook    cas/notebooks/nb_<hex>.json      (calculator notebooks, src/cas)
// Each record is one UVA document (src/uva/service.js syncRecord), keyed
// "<kind>/<id>".
//
// The modules that own these files are sealed and write them themselves, so
// the file is the working copy, as canvas.json is for a canvas. After every
// tool call (and on a timer as a safety net) settle() finds files that changed
// and writes, per record:
//   uva-pending/records/<kind>-<id>.json   durably (file + folder fsync), with the
//                                          next per-record sequence number `seq`
// then a coalesced commit puts it into its UVA document, and the pending copy
// is removed once the document holds exactly its content. The higher seq wins;
// wall-clock times are never compared.
//
// On startup every record is checked like a canvas (see chooseCanvas in
// canvas-store.js): a file with content the latest record does not know (neither
// its value nor its legacyHash) is adopted as the next seq; otherwise the file
// is rewritten to the latest record, so the sealed modules read the committed
// state. Per record, `diagnostics.mirror.recordStore.records` shows the three
// states separately: the file, the durable pending seq and the committed seq.
import { mkdir, open, readFile, readdir, rename, unlink, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { hashJson } from "../documents/validation.js";
import { createMirror } from "./mirror.js";

const RECORD = "estampes.record-pending/1";
export const KINDS = Object.freeze({
  workspace: { dir: ["workspaces"], file: /^([0-9a-f]{16})\.json$/, id: (m) => "ws:" + m, name: (id) => id.slice(3) + ".json", valid: (v, id) => v?.id === id && Array.isArray(v.items) },
  surface: { dir: ["surfaces"], file: /^sf_([0-9a-f]{16})\.json$/, id: (m) => "sf:" + m, name: (id) => "sf_" + id.slice(3) + ".json", valid: (v, id) => v?.surfaceId === id && typeof v.schema === "string" },
  notebook: { dir: ["cas", "notebooks"], file: /^nb_([0-9a-f]{12})\.json$/, id: (m) => "nb:" + m, name: (id) => "nb_" + id.slice(3) + ".json", valid: (v, id) => v?.id === id && typeof v.schema === "string" },
});
const KEY = /^(workspace|surface|notebook)\/((?:ws|sf):[0-9a-f]{16}|nb:[0-9a-f]{12})$/;
const parts = (key) => { const m = KEY.exec(key ?? ""); return m && ({ ws: "workspace", sf: "surface", nb: "notebook" })[m[2].slice(0, 2)] === m[1] ? { kind: m[1], id: m[2] } : null; };
const PENDING = /^(workspace|surface|notebook)-([a-z]{2})_([0-9a-f]{12,16})\.json$/;

// Which value a record has. Pure: records are { seq, legacyHash, value }.
export function chooseRecord({ uva = null, pending = null, legacy = null }) {
  const records = [uva && { from: "uva", ...uva }, pending && { from: "pending", ...pending }].filter(Boolean);
  if (!records.length) return legacy ? { from: "legacy", value: legacy, adopt: true, seq: 0 } : null;
  const latest = records.reduce((a, b) => (b.seq > a.seq ? b : a));
  if (legacy) {
    const h = hashJson(legacy);
    if (h !== hashJson(latest.value) && h !== latest.legacyHash) return { from: "legacy", value: legacy, adopt: true, seq: latest.seq };
  }
  return { from: latest.from, value: latest.value, adopt: false, seq: latest.seq, repairLegacy: !legacy || hashJson(legacy) !== hashJson(latest.value) };
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

export async function createRecordStore({ service, storageDir, idleMs = 15000, maxWaitMs = 120000, scanEveryMs = 30000, log = () => {} }) {
  if (!service?.syncRecord) throw new Error("The UVA service has no record store");
  const dir = join(storageDir, "uva-pending", "records");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await syncDir(dirname(dir));
  const pendingFile = (key) => { const p = parts(key); return join(dir, p.kind + "-" + p.id.replace(":", "_") + ".json"); };
  const legacyFile = (key) => { const p = parts(key); return join(storageDir, ...KINDS[p.kind].dir, KINDS[p.kind].name(p.id)); };
  // `known`: { hash, seq } of the last record written or restored. `seen`: the
  // file stat last read, so an unchanged file is not read again.
  const queues = new Map(), known = new Map(), seen = new Map(), records = new Map();
  const stats = { writes: 0, committed: 0, restored: { uva: 0, pending: 0, legacy: 0 }, migrated: 0, adopted: 0, repaired: 0, failedWrites: 0, scans: 0, lastError: null };
  const note = () => service.noteMirror({ recordStore: { ...stats, restored: { ...stats.restored }, records: Object.fromEntries(records) } });
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
  function queued(key, job) {
    const next = (queues.get(key) ?? Promise.resolve()).then(job, job), settled = next.catch(() => {});
    queues.set(key, settled);
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return next;
  }
  async function readPending(key) {
    const r = await readJson(pendingFile(key));
    return r?.schema === RECORD && r.key === key && Number.isSafeInteger(r.seq) && r.value && typeof r.value === "object" ? r : null;
  }
  async function readUva(key) {
    try { return await service.recordState(key); } catch (error) { fault("read UVA record", key, error); return null; }
  }
  async function readLegacy(key) {
    const v = await readJson(legacyFile(key));
    return KINDS[parts(key).kind].valid(v, parts(key).id) ? v : null;
  }

  const mirror = createMirror({
    service: { syncCanvas: (input) => service.syncRecord(input), noteMirror: (patch) => { if (patch.lastError) { stats.lastError = { where: "commit", key: patch.lastErrorImage, message: patch.lastError, at: patch.lastErrorAt }; note(); } } }, idleMs, maxWaitMs, log,
    read: async (key) => { const r = await readPending(key); return r && { key, value: r.value, seq: r.seq, legacyHash: r.legacyHash }; },
    onSynced: async (key, result) => {
      if (result.status === "blocked") { track(key, { blocked: result.issues?.[0]?.message ?? true }); fault("commit", key, result.issues?.[0]?.message ?? "blocked"); return; }
      await queued(key, async () => {
        const r = await readPending(key);
        track(key, { committedSeq: result.seq ?? r?.seq ?? null, blocked: false });
        if (!r || hashJson(r.value) !== result.sourceHash) { note(); return; }
        await unlink(pendingFile(key));
        await syncDir(dir);
        stats.committed++; note();
      });
    },
  });

  async function nextSeq(key) {
    if (!known.has(key)) {
      const [pending, uva] = await Promise.all([readPending(key), readUva(key)]);
      known.set(key, { hash: null, seq: Math.max(pending?.seq ?? 0, uva?.seq ?? 0) });
    }
    return known.get(key).seq + 1;
  }
  // Resolves once the pending record is durable; rejects when it is not.
  function write(key, value) {
    if (!parts(key)) return Promise.resolve(null);
    const copy = JSON.parse(JSON.stringify(value)), h = hashJson(copy);
    return queued(key, async () => {
      const seq = await nextSeq(key), now = await readLegacy(key).catch(() => null), legacyHash = now ? hashJson(now) : null;
      await durableWrite(pendingFile(key), JSON.stringify({ schema: RECORD, key, seq, legacyHash, value: copy }));
      known.set(key, { hash: h, seq });
      stats.writes++;
      track(key, { pendingSeq: seq, legacy: legacyHash === h ? "matches" : legacyHash ? "differs" : "missing" });
      note();
      mirror.schedule(key);
      return seq;
    }).catch((error) => { stats.failedWrites++; track(key, { failedSeq: (known.get(key)?.seq ?? 0) + 1 }); fault("pending write", key, error); throw error; });
  }

  async function resolve(key) {
    const [uva, pending, legacy] = await Promise.all([readUva(key), readPending(key), readLegacy(key)]);
    const choice = chooseRecord({ uva, pending, legacy });
    if (!choice) return null;
    known.set(key, { hash: hashJson(choice.value), seq: choice.seq });
    if (choice.adopt) {
      if (choice.seq) stats.adopted++; else stats.migrated++;
      known.set(key, { hash: null, seq: choice.seq });
      await write(key, choice.value);
    } else {
      if (choice.repairLegacy) {
        await mkdir(dirname(legacyFile(key)), { recursive: true, mode: 0o700 });
        await durableWrite(legacyFile(key), JSON.stringify(choice.value));
        stats.repaired++;
      }
      if (choice.from === "pending") mirror.schedule(key);
    }
    stats.restored[choice.from]++;
    return choice;
  }

  // Records whose file changed since it was last read are written as pending.
  async function scan() {
    stats.scans++;
    const jobs = [];
    for (const [kind, k] of Object.entries(KINDS)) {
      const base = join(storageDir, ...k.dir);
      let names = [];
      try { names = await readdir(base); } catch { continue; }
      for (const name of names) {
        const m = k.file.exec(name);
        if (!m) continue;
        const key = kind + "/" + k.id(m[1]), path = join(base, name);
        jobs.push((async () => {
          let st;
          try { st = await stat(path); } catch { return; }
          const mark = st.ino + ":" + st.size + ":" + st.mtimeMs;
          if (seen.get(key) === mark) return;
          const value = await readLegacy(key);
          if (!value) return;
          seen.set(key, mark);
          if (known.get(key)?.hash === hashJson(value)) return;
          await write(key, value);
        })().catch((error) => { seen.delete(key); fault("scan", key, error); }));
      }
    }
    await Promise.all(jobs);
    note();
  }
  let scanning = null, again = false;
  // One scan at a time; a call made while one runs gets one more after it.
  function settle() {
    if (scanning) { again = true; return scanning; }
    scanning = (async () => { do { again = false; await scan(); } while (again); })().finally(() => { scanning = null; });
    return scanning;
  }

  // Startup: every record on disk, in UVA or pending is checked before any
  // module reads its file.
  const leftovers = [];
  for (const name of await readdir(dir)) {
    const m = PENDING.exec(name);
    if (m) leftovers.push(m[1] + "/" + m[2] + ":" + m[3]);
    else if (name.endsWith(".tmp")) await unlink(join(dir, name)).catch(() => {});
  }
  const onDisk = [];
  for (const [kind, k] of Object.entries(KINDS)) for (const name of await readdir(join(storageDir, ...k.dir)).catch(() => [])) { const m = k.file.exec(name); if (m) onDisk.push(kind + "/" + k.id(m[1])); }
  for (const key of new Set([...leftovers, ...await service.recordKeys(), ...onDisk])) {
    if (!parts(key)) continue;
    try { await resolve(key); } catch (error) { fault("startup check", key, error); }
  }
  stats.restored = { uva: 0, pending: 0, legacy: 0 };
  note();
  const timer = scanEveryMs > 0 ? setInterval(() => { settle().catch(() => {}); }, scanEveryMs) : null;
  timer?.unref?.();
  return {
    settle, chooseRecord, recovered: leftovers,
    flush: async () => { await settle(); await mirror.flush(); },
    async close() { clearInterval(timer); await settle().catch(() => {}); await mirror.stop(); await Promise.all([...queues.values()]); },
    get pending() { return mirror.pending; },
  };
}
