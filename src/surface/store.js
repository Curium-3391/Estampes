// Surface documents: which panels exist, whether they are open, and one
// layout per device profile. Stored in the shared server store
// (<storage>/surfaces), never in the browser, so a reloaded widget, a phone
// after a desktop session, or the model all see the same arrangement.
// A surface is keyed by what it shows (an imageId or a workspace id), so
// opening the same canvas again finds the same surface.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SURFACE_SCHEMA, defaultLayouts } from "./layout.js";

export const SURFACE_ID = /^sf:[0-9a-f]{16}$/;
export class SurfaceError extends Error {
  constructor(message, code = "invalid") { super(message); this.code = code; }
}
export const surfaceIdFor = (canvasKey) => "sf:" + createHash("sha256").update(String(canvasKey)).digest("hex").slice(0, 16);

export function createSurfaceStore({ dir = "" } = {}) {
  const docs = new Map(), queues = new Map();
  const file = (id) => join(dir, id.replace(":", "_") + ".json");

  async function persist(doc) {
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    const path = file(doc.surfaceId), tmp = path + "." + process.pid + "." + Date.now() + ".tmp";
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, path);
  }
  async function load(id) {
    if (docs.has(id)) return docs.get(id);
    if (!dir || !SURFACE_ID.test(id)) return null;
    try {
      const doc = JSON.parse(await readFile(file(id), "utf8"));
      if (doc?.schema !== SURFACE_SCHEMA || doc.surfaceId !== id) return null;
      docs.set(id, doc);
      return doc;
    } catch { return null; }
  }
  const fresh = (canvasKey) => {
    const panels = [{ panelId: "p:canvas", module: "core", panel: "canvas", kind: "canvas", title: "Canvas", open: true }];
    return { schema: SURFACE_SCHEMA, surfaceId: surfaceIdFor(canvasKey), canvasKey, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      panels, layouts: defaultLayouts(["p:canvas"]), idem: {} };
  };

  return {
    // The surface for a canvas key, created on first use.
    async forCanvas(canvasKey) {
      const id = surfaceIdFor(canvasKey);
      const existing = await load(id);
      if (existing) return existing;
      return this.mutate(canvasKey, {}, () => {}, { create: true });
    },
    async mutate(canvasKey, { expectedRevision, idempotencyKey } = {}, fn, { create = false } = {}) {
      const id = surfaceIdFor(canvasKey);
      const prev = queues.get(id) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(async () => {
        let cur = await load(id);
        if (!cur) { cur = fresh(canvasKey); if (!create) { docs.set(id, cur); } }
        if (idempotencyKey && cur.idem?.[idempotencyKey]) return { doc: cur, replayed: true };
        if (expectedRevision !== undefined && expectedRevision !== cur.revision) {
          throw new SurfaceError("the surface changed since revision " + expectedRevision + " (now " + cur.revision + "); read it again and retry", "conflict");
        }
        const draft = structuredClone(cur);
        const value = await fn(draft);
        draft.revision = cur.revision + 1;
        draft.updatedAt = new Date().toISOString();
        if (idempotencyKey) {
          draft.idem = { ...(draft.idem ?? {}), [idempotencyKey]: draft.revision };
          const keys = Object.keys(draft.idem);
          for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete draft.idem[k];
        }
        docs.set(id, draft);
        try { await persist(draft); } catch (error) { docs.set(id, cur); throw error; }
        return create ? draft : { doc: draft, value, replayed: false };
      });
      queues.set(id, run);
      return run;
    },
  };
}
