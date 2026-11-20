// execute_module: one fixed entry point for every module capability, so
// enabling a module never changes the MCP tool list. The router checks
// that the module is enabled, the capability exists, the grant covers it
// and the input matches its schema; runs it in its runtime; then checks
// the output and applies it as scene operations. A module only ever
// returns data; the Core decides what lands on the canvas.
import { z } from "zod";
import { validateValue } from "./json-schema.js";
import { capabilityPermissions, missingPermissions } from "./permissions.js";
import { applySceneOps, renderedObjects, sceneRevision, SceneOpsError, VISIBILITY } from "../scene/scene-ops.js";
import { localized } from "./manifest.js";
import { plotContext } from "./plot-context.js";

// A string in a v2 module's input that names a document (an image, a Graph
// or a copy of either) other than the one it was pointed at.
const DOCUMENT_ID = /^(img|gph):[0-9a-f]{16}(#c[0-9a-f]+)?$/;
function otherDocument(value, own, depth = 0) {
  if (depth > 8) return null;
  if (typeof value === "string") return DOCUMENT_ID.test(value) && value !== own ? value : null;
  if (Array.isArray(value)) { for (const v of value) { const found = otherDocument(v, own, depth + 1); if (found) return found; } return null; }
  if (value && typeof value === "object") { for (const v of Object.values(value)) { const found = otherDocument(v, own, depth + 1); if (found) return found; } }
  return null;
}

export class ModuleError extends Error {
  constructor(message, code = "invalid") { super(message); this.code = code; }
}

const OutputSchema = z.object({
  operations: z.array(z.unknown()).max(64).default([]),
  summary: z.string().max(300).optional(),
  method: z.string().max(120).optional(),
  // Free-form structured result for capabilities with target "none".
  data: z.unknown().optional(),
}).strict();

// What a module sees of its target canvas: its kind (a Graph document or an
// image), size, revision and (with canvas.read) the public objects plus its
// own scratch objects, and the plot context (axes and function plots) built
// from them (plot-context.js), which is the same for both kinds.
// A v2 module (ADR-005) is told what kind of document it works on, never an
// image id: it gets this one document and nothing that names another.
function canvasContext(entry, moduleId, granted, v2 = false) {
  const kind = entry.kind === "graph" ? "graph" : "image";
  const base = { ...(v2 ? {} : { imageId: entry.imageId }), kind, width: entry.width, height: entry.height, revision: sceneRevision(entry) };
  if (!granted.includes("canvas.read")) return base;
  const objects = renderedObjects(entry)
    .filter((r) => r.object.visibility === "public" || r.object.provenance?.module === moduleId)
    .map((r) => ({ id: r.object.id, type: r.object.type, layer: r.object.layer, props: r.object.props, visibility: r.object.visibility,
      label: r.object.label, source: r.object.provenance?.module ?? r.object.provenance?.author }));
  const marks = [...(entry.marks?.values() ?? [])].slice(0, 200).map((m) => ({ id: m.id, type: m.type, author: m.author,
    box: [m.x, m.y, m.x2 ?? m.x, m.y2 ?? m.y], ...(m.label ? { label: m.label } : {}) }));
  return { ...base, objects, marks, plot: plotContext({ kind, objects }) };
}

// canvases: { ensure(imageId), create(options), save(entry, history) }
// jobs: from jobs.js. egress / readSource are optional host services handed to
// built-in modules (never to other runtimes) when their grant allows.
export function createRouter({ registry, audit, canvases, runtimes, jobs = null, egress = null, readSource = null }) {
  const DEFAULT_JOB_MS = 10 * 60 * 1000;
  return {
    jobs,
    async execute({ module: moduleId, capability: capId, params = {}, canvas: imageId, newCanvas, expectedRevision, visibility = "public", layer }) {
      const started = Date.now();
      const mod = registry.get(moduleId);
      if (!mod) {
        throw new ModuleError("no module " + JSON.stringify(moduleId) + "; known: " + registry.list().map((m) => m.manifest.id).join(", "), "not-found");
      }
      const { manifest, record } = mod;
      if (record.state !== "enabled") {
        throw new ModuleError(manifest.id + " is " + record.state + ". Only the user can enable it: call open_module_store (or prepare_module_change with action enable) so they can approve it in the Store", "disabled");
      }
      const cap = manifest.capabilities.find((c) => c.id === capId);
      if (!cap) throw new ModuleError(manifest.id + " has no capability " + JSON.stringify(capId) + "; it has " + manifest.capabilities.map((c) => c.id).join(", "), "not-found");
      const granted = record.granted ?? [];
      const missing = missingPermissions(granted, capabilityPermissions(manifest, cap));
      if (missing.length) throw new ModuleError(manifest.id + " was not granted " + missing.join(", ") + "; the user must approve it again in the Store", "permission");
      if (!VISIBILITY.includes(visibility)) throw new ModuleError("visibility must be public or scratch");
      let input;
      try { input = validateValue(cap.inputSchema, params ?? {}, "params"); }
      catch (error) { throw new ModuleError(error.message + ". Call get_module_capabilities for the exact schema", "input"); }

      // A v2 module may name only the document it is pointed at; checked before a new document is created, so a refused call leaves nothing behind.
      if (manifest.v2) {
        const stray = otherDocument(input, imageId ?? null);
        if (stray) throw new ModuleError(capId + " may only work on the document it was pointed at; its input names " + stray, "cross-document");
      }
      // Target canvas.
      let entry = null, createdCanvas = false;
      if (cap.target === "none") {
        if (imageId || newCanvas) throw new ModuleError(capId + " does not work on a canvas; leave canvas and newCanvas out");
      } else if (imageId) {
        if (newCanvas) throw new ModuleError("give canvas or newCanvas, not both");
        entry = await canvases.ensure(imageId);
      } else if (cap.target === "canvas-or-new") {
        entry = await canvases.create(newCanvas ?? {});
        createdCanvas = true;
      } else {
        throw new ModuleError(capId + " needs a canvas: pass canvas (an imageId)", "input");
      }
      const seen = entry ? sceneRevision(entry) : null;
      if (entry && expectedRevision !== undefined && expectedRevision !== seen) {
        throw new ModuleError("the canvas changed since revision " + expectedRevision + " (now " + seen + "); read it again and retry", "conflict");
      }

      // What this call may use: for a v2 capability only what it needs (granted ∩ needs), otherwise all that was granted.
      const effective = manifest.v2 ? granted.filter((p) => capabilityPermissions(manifest, cap).includes(p)) : granted;
      const runtime = runtimes[mod.runtime.kind];
      if (!runtime) throw new ModuleError("runtime " + mod.runtime.kind + " is not available on this server", "runtime");
      const ctx = {
        module: { id: manifest.id, version: manifest.version },
        capability: capId, permissions: effective, limits: manifest.limits ?? {},
        canvas: entry ? canvasContext(entry, manifest.id, effective, !!manifest.v2) : null,
        entry: effective.includes("asset.read.selected") ? entry : null,
      };
      const builtin = mod.runtime.kind === "builtin";
      if (builtin && effective.includes("network.request.approved") && egress) {
        ctx.http = (request) => egress.call({ manifest, granted: effective, request, limits: ctx.limits, capability: capId });
      }
      // The original image of the target canvas, for built-in modules and for
      // http modules that declare a multipart file (sent only through egress).
      if ((builtin || mod.runtime.kind === "http") && effective.includes("asset.read.selected") && readSource && entry) ctx.readSource = () => readSource(entry.imageId);

      // Runs the capability and lands its result on the canvas. A background
      // job calls it without a revision check: it was started on purpose and
      // may finish long after the canvas moved on.
      const stop = { cancelled: false };
      const work = async (checkRevision, jobId) => {
        let output;
        try {
          const raw = await runtime.run(mod, capId, input, jobId ? { ...ctx, progress: (note) => jobs.progress(jobId, note), cancelled: () => stop.cancelled } : ctx);
          const parsed = OutputSchema.safeParse(raw ?? {});
          if (!parsed.success) throw new ModuleError("module output is not valid: " + parsed.error.issues[0].message + " at " + parsed.error.issues[0].path.join("."), "output");
          output = parsed.data;
        } catch (error) {
          audit.record({ kind: "run.failed", module: manifest.id, capability: capId, canvas: entry?.imageId, ms: Date.now() - started, error: String(error?.message || error).slice(0, 300) });
          throw error instanceof ModuleError ? error : new ModuleError(manifest.id + " " + capId + " failed: " + (error?.message || error), "run");
        }

        if (stop.cancelled) throw new ModuleError("stopped before its result was applied", "timeout");
        let scene = { created: [], updated: [], deleted: [], published: [], refs: {}, notes: [], revision: seen };
        if (output.operations.length) {
          if (!entry) throw new ModuleError(capId + " returned scene operations but has no canvas", "output");
          try {
            scene = applySceneOps(entry, output.operations, {
              author: "module", module: manifest.id, moduleVersion: manifest.version, capability: capId, method: output.method,
              layerName: localized(manifest, "name"),
            }, { expectedRevision: checkRevision ? seen : undefined, visibility, layer });
          } catch (error) {
            audit.record({ kind: "run.rejected", module: manifest.id, capability: capId, canvas: entry.imageId, error: String(error?.message || error).slice(0, 300) });
            if (error instanceof SceneOpsError) throw new ModuleError("the module's result was refused: " + error.message, error.code === "conflict" ? "conflict" : "output");
            throw error;
          }
          await canvases.save(entry, { tool: "execute_module", author: "module", changed: [...scene.created, ...scene.updated], removed: scene.deleted,
            note: manifest.id + "/" + capId });
        }
        if (runtime.after) {
          try { await runtime.after(mod, capId, input, ctx, { output, scene, entry }); }
          catch (error) { audit.record({ kind: "run.after-failed", module: manifest.id, capability: capId, error: String(error?.message || error).slice(0, 300) }); }
        }
        const ms = Date.now() - started;
        audit.record({ kind: "run", module: manifest.id, capability: capId, canvas: entry?.imageId, createdCanvas,
          created: scene.created.length, updated: scene.updated.length, deleted: scene.deleted.length, ms, ...(jobId ? { job: jobId } : {}) });
        return { module: manifest, capability: cap, entry, createdCanvas, scene, summary: output.summary, data: output.data, ms };
      };

      if (!cap.async) return work(true, null);
      if (!jobs) throw new ModuleError(capId + " runs as a background job, which this server cannot keep", "runtime");
      const job = jobs.create({ module: manifest.id, capability: capId, canvas: entry?.imageId });
      const limitMs = manifest.limits?.jobMs ?? DEFAULT_JOB_MS;
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { stop.cancelled = true; reject(new ModuleError("it took longer than " + Math.round(limitMs / 1000) + " s and was stopped", "timeout")); }, limitMs); });
      Promise.race([work(false, job.id), timeout]).then((r) => {
        jobs.finish(job.id, { status: "done", ...(r.summary ? { summary: r.summary } : {}), ...(r.data !== undefined ? { data: r.data } : {}),
          created: r.scene.created, updated: r.scene.updated, revision: r.scene.revision });
      }, (error) => {
        jobs.finish(job.id, { status: "failed", error: String(error?.message || error).slice(0, 300) });
      }).finally(() => clearTimeout(timer));
      return { module: manifest, capability: cap, entry, createdCanvas, scene: { created: [], updated: [], deleted: [], published: [], refs: {}, notes: [], revision: seen },
        job, ms: Date.now() - started };
    },
  };
}
