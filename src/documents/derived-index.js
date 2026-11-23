// UVA Phase 5B-2b-3a: which documents hold derived bindings of which module.
// A module that says "a source of mine changed" (broadcast) can only reach the
// documents the core knows hold its bindings; this is that list. It names no
// module itself (the module id is just a key) and it is only a hint: a missing
// or stale entry costs a missed or an empty delivery, never a wrong binding.
// It heals itself: a document that is opened, or that gets a new binding, is
// added again, and a document with no live binding of a module is dropped.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MAX_CANVASES_PER_MODULE = 1000;
const MODULE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CANVAS = /^[A-Za-z0-9:#._-]{1,100}$/;

// file: where it is kept ("" keeps it in memory only).
export function createDerivedIndex({ file = "" } = {}) {
  const map = new Map(); // module -> Set of canvas ids, oldest first
  let saving = Promise.resolve();
  const body = () => JSON.stringify({ schema: "estampes.derived-index/1", modules: Object.fromEntries([...map].map(([k, v]) => [k, [...v]])) });
  const persist = () => {
    if (!file) return saving;
    saving = saving.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      await writeFile(tmp, body());
      await rename(tmp, file);
    }).catch(() => {});
    return saving;
  };
  return {
    // An unreadable or missing file is an empty index: it fills again as documents are opened.
    async load() {
      if (!file) return;
      try {
        const doc = JSON.parse(await readFile(file, "utf8"));
        for (const [m, list] of Object.entries(doc?.modules ?? {})) {
          if (!MODULE.test(m) || !Array.isArray(list)) continue;
          map.set(m, new Set(list.filter((c) => typeof c === "string" && CANVAS.test(c)).slice(-MAX_CANVASES_PER_MODULE)));
        }
      } catch { /* start empty */ }
    },
    add(module, canvas) {
      if (!MODULE.test(module) || !CANVAS.test(String(canvas))) return;
      const set = map.get(module) ?? new Set();
      if (set.has(canvas)) return;
      set.add(canvas);
      while (set.size > MAX_CANVASES_PER_MODULE) set.delete(set.values().next().value);
      map.set(module, set);
      persist();
    },
    remove(module, canvas) {
      const set = map.get(module);
      if (!set?.delete(canvas)) return;
      if (!set.size) map.delete(module);
      persist();
    },
    list: (module) => [...(map.get(module) ?? [])],
    flush: () => saving,
  };
}
