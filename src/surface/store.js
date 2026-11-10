// Surface documents: which panels exist, whether they are open, and one
// layout per device profile. Stored in the shared server store
// (<storage>/surfaces), never in the browser, so a reloaded widget, a phone
// after a desktop session, or the model all see the same arrangement.
// A surface is keyed by what it shows (an imageId or a workspace id), so
// opening the same canvas again finds the same surface.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SURFACE_SCHEMA, defaultLayouts, LayoutsSchema, reconcile } from "./layout.js";

export const SURFACE_ID = /^sf:[0-9a-f]{16}$/;
export class SurfaceError extends Error {
  constructor(message, code = "invalid") { super(message); this.code = code; }
}
export const surfaceIdFor = (canvasKey) => "sf:" + createHash("sha256").update(String(canvasKey)).digest("hex").slice(0, 16);

// `records()`: the UVA record store when it is on (src/uva/record-store.js);
// surfaces are then read from and written to it, and no file is written here.
export function createSurfaceStore({ dir = "", records = () => null } = {}) {
  const docs = new Map(), queues = new Map();
  const file = (id) => join(dir, id.replace(":", "_") + ".json");

  async function persist(doc) {
    if (records()) { await records().write("surface", doc.surfaceId, doc); return; }
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    const path = file(doc.surfaceId), tmp = path + "." + process.pid + "." + Date.now() + ".tmp";
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, path);
  }
  async function load(id) {
    if (docs.has(id)) return docs.get(id);
    if (!(dir || records()) || !SURFACE_ID.test(id)) return null;
    // A store that cannot be read throws: "no surface" would let a fresh one replace it.
    const read = records() ? () => records().read("surface", id) : async () => { try { return JSON.parse(await readFile(file(id), "utf8")); } catch { return null; } };
    const doc = await read();
    if (doc?.schema !== SURFACE_SCHEMA || doc.surfaceId !== id) return null;
    docs.set(id, doc);
    return doc;
  }
  const fresh = (canvasKey) => {
    const panels = [{ panelId: "p:canvas", module: "core", panel: "canvas", kind: "canvas", title: "Canvas", open: true }];
    return { schema: SURFACE_SCHEMA, surfaceId: surfaceIdFor(canvasKey), canvasKey, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      panels, layouts: defaultLayouts(["p:canvas"]), idem: {} };
  };

  return {
    // The surface for a canvas key if one exists; never creates one.
    async peek(canvasKey) { return load(surfaceIdFor(canvasKey)); },
    // The surface for a canvas key, created on first use.
    async forCanvas(canvasKey) {
      const id = surfaceIdFor(canvasKey);
      const existing = await load(id);
      if (existing) return existing;
      return this.mutate(canvasKey, {}, () => {}, { create: true });
    },
    // For .estampes bundles: a surface for a canvas key built from what a
    // file says. Panels and layouts are rebuilt from known fields, layouts are
    // checked against the schema (or reset), and an existing surface is never
    // overwritten. `notebookMap` renames the notebooks the panels show.
    async importFor(canvasKey, raw, { notebookMap = new Map() } = {}) {
      const id = surfaceIdFor(canvasKey);
      if (await load(id)) return { created: false };
      const doc = fresh(canvasKey);
      const seen = new Set(["p:canvas"]);
      for (const p of (Array.isArray(raw?.panels) ? raw.panels : []).slice(0, 12)) {
        if (!p || typeof p !== "object" || !/^p:[a-z0-9][a-z0-9-]{0,30}$/.test(p.panelId) || seen.has(p.panelId) || p.module === "core") continue;
        if (typeof p.module !== "string" || typeof p.panel !== "string" || typeof p.kind !== "string") continue;
        seen.add(p.panelId);
        const inst = { panelId: p.panelId, module: p.module.slice(0, 100), panel: p.panel.slice(0, 40), kind: p.kind.slice(0, 20), title: typeof p.title === "string" ? p.title.slice(0, 60) : p.panel, open: p.open === true };
        if (typeof p.notebook === "string" && notebookMap.has(p.notebook)) inst.notebook = notebookMap.get(p.notebook);
        doc.panels.push(inst);
      }
      const ids = doc.panels.filter((p) => p.open).map((p) => p.panelId);
      const parsed = LayoutsSchema.safeParse(raw?.layouts);
      doc.layouts = reconcile(parsed.success ? parsed.data : defaultLayouts(ids), ids);
      docs.set(id, doc);
      try { await persist(doc); } catch (error) { docs.delete(id); throw error; }
      return { created: true, surfaceId: id };
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
