// Which modules this server knows and what state each is in. Built-in
// modules ship with Estampes; packages (packages.js) are installed into
// the storage folder. The state file <storage>/modules/registry.json is
// rewritten atomically; without storage the state lives in memory and
// every module starts disabled again after a restart.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateManifest } from "./manifest.js";

export const REGISTRY_STATE = "estampes.module-registry/1";
export const STATES = ["available", "installed", "enabled", "disabled", "failed"];

async function atomicWrite(path, data) {
  const tmp = path + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export function createRegistry({ dir = "", coreVersion, builtins = [] } = {}) {
  const catalog = new Map(); // id -> { manifest, runtime, source }
  const records = new Map(); // id -> persisted record
  for (const b of builtins) {
    const manifest = validateManifest(b.manifest, { coreVersion });
    if (manifest.runtime.kind !== "builtin") throw new Error(manifest.id + ": built-in modules use runtime builtin");
    catalog.set(manifest.id, { manifest, runtime: { kind: "builtin", run: b.run }, source: "builtin" });
  }
  const file = dir ? join(dir, "registry.json") : null;
  let saving = Promise.resolve();

  const registry = {
    dir, coreVersion,
    async load() {
      if (!file) return;
      let data = null;
      try { data = JSON.parse(await readFile(file, "utf8")); } catch { return; }
      if (data?.schema !== REGISTRY_STATE || typeof data.modules !== "object") return;
      for (const [id, rec] of Object.entries(data.modules)) if (rec && STATES.includes(rec.state)) records.set(id, rec);
    },
    save() {
      if (!file) return Promise.resolve();
      const body = JSON.stringify({ schema: REGISTRY_STATE, savedAt: new Date().toISOString(), modules: Object.fromEntries(records) }, null, 2);
      saving = saving.then(async () => { await mkdir(dir, { recursive: true }); await atomicWrite(file, body); });
      return saving;
    },
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
    setRecord(id, rec) { records.set(id, { ...rec, id, updatedAt: new Date().toISOString() }); return registry.save(); },
    dropRecord(id) { records.delete(id); return registry.save(); },
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
