// Which modules this server knows and what state each is in. Built-in
// modules ship with Estampes; packages (packages.js) are installed into
// the storage folder. The state file <storage>/modules/registry.json is
// rewritten atomically; without storage the state lives in memory and
// every module starts disabled again after a restart.
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateManifest } from "./manifest.js";

export const REGISTRY_STATE = "estampes.module-registry/1";
export const STATES = ["available", "installed", "enabled", "disabled", "failed"];

let tmpSeq = 0;
async function atomicWrite(path, data) {
  const tmp = path + "." + process.pid + "." + Date.now() + "." + (++tmpSeq) + ".tmp";
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export function createRegistry({ dir = "", coreVersion, builtins = [] } = {}) {
  const catalog = new Map(); // id -> { manifest, runtime, source }
  const records = new Map(); // id -> persisted record
  for (const b of builtins) {
    const manifest = validateManifest(b.manifest, { coreVersion });
    if (manifest.runtime.kind !== "builtin") throw new Error(manifest.id + ": built-in modules use runtime builtin");
    catalog.set(manifest.id, { manifest, runtime: { kind: "builtin", run: b.run, ...(b.after ? { after: b.after } : {}) }, source: "builtin" });
  }
  const file = dir ? join(dir, "registry.json") : null;
  // Writes run one at a time. A failed write never blocks the ones queued
  // after it: the chain itself always settles, and each caller gets its own
  // write's outcome.
  let saving = Promise.resolve();
  const bodyOf = (map) => JSON.stringify({ schema: REGISTRY_STATE, savedAt: new Date().toISOString(), modules: Object.fromEntries(map) }, null, 2);
  // A record change is published to `records` (what readers and the router
  // see) only after the file holding it is written. If the write fails the
  // registry keeps its previous, still-persisted state, so a failed enable
  // never leaves the module enabled in memory. Each write starts from the
  // records committed so far, so it never carries another caller's
  // unconfirmed change to disk either.
  function commit(change) {
    if (!file) { change(records); return Promise.resolve(); }
    const run = saving.then(async () => {
      const next = new Map(records);
      change(next);
      await mkdir(dir, { recursive: true });
      await atomicWrite(file, bodyOf(next));
      records.clear();
      for (const [k, v] of next) records.set(k, v);
    });
    saving = run.catch(() => {});
    return run;
  }

  const registry = {
    dir, coreVersion,
    async load() {
      if (!file) return;
      let data = null;
      try { data = JSON.parse(await readFile(file, "utf8")); } catch { return; }
      if (data?.schema !== REGISTRY_STATE || typeof data.modules !== "object") return;
      for (const [id, rec] of Object.entries(data.modules)) if (rec && STATES.includes(rec.state)) records.set(id, rec);
    },
    save() { return commit(() => {}); },
    // A package's manifest and runtime join the catalog when it is installed
    // or when the server starts with it installed.
    addPackage(manifest, runtime, packageInfo) {
      catalog.set(manifest.id, { manifest, runtime, source: "package", package: packageInfo });
    },
    removeFromCatalog(id) { if (catalog.get(id)?.source === "package") catalog.delete(id); },
    has: (id) => catalog.has(id),
    record(id) {
      const entry = catalog.get(id);
      if (!entry) return records.get(id) ?? null;
      return records.get(id) ?? { id, source: entry.source, state: entry.source === "builtin" ? "available" : "installed", version: entry.manifest.version, granted: [] };
    },
    setRecord(id, rec) { const value = { ...rec, id, updatedAt: new Date().toISOString() }; return commit((m) => m.set(id, value)); },
    dropRecord(id) { return commit((m) => m.delete(id)); },
    get(id) {
      const entry = catalog.get(id);
      return entry ? { ...entry, record: registry.record(id) } : null;
    },
    list() { return [...catalog.keys()].map((id) => registry.get(id)); },
    records: () => new Map(records),
    flush: () => saving,
  };
  return registry;
}
