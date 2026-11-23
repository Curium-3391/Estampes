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
import { register, sourceChanged, bindingsOf, MAX_DERIVED_PER_CANVAS } from "../documents/derived-coordinator.js";
import { deliverBroadcast } from "../documents/derived-broadcast.js";

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
  // module/2 only (UVA 5B-2b-2). `derived`: objects this run creates (named by the $ref
  // of their object.create) that the core should keep up to date from a source;
  // sourceRef is opaque to the core. `broadcast`: the module says a source of its own
  // changed, so bindings made from it become stale.
  derived: z.array(z.object({ object: z.string().regex(/^\$[A-Za-z][A-Za-z0-9_-]{0,31}$/), sourceRef: z.string().min(1).max(200),
    sourceRevision: z.number().int().positive(), inputsHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).max(50).optional(),
  broadcast: z.array(z.object({ event: z.literal("source-changed"), sourceRef: z.string().min(1).max(200).optional() }).strict()).max(50).optional(),
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
export function createRouter({ registry, audit, canvases, runtimes, jobs = null, egress = null, readSource = null, derivedIndex = null }) {
  const DEFAULT_JOB_MS = 10 * 60 * 1000;
  return {
    jobs,
    // `internal` is for the core's own refresh of a derived object: { refreshObject, dryRun? } (a dry run reports what would be written and applies nothing). It is never reachable from a tool.
    async execute({ module: moduleId, capability: capId, params = {}, canvas: imageId, newCanvas, expectedRevision, visibility = "public", layer, internal }) {
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
      // A v1 package module predates Graph documents (ADR-005): it is refused on a Graph and new canvases it creates are images. Built-in modules are unaffected.
      const imagesOnly = mod.source === "package" && !manifest.v2;
      // Target canvas.
      let entry = null, createdCanvas = false;
      if (cap.target === "none") {
        if (imageId || newCanvas) throw new ModuleError(capId + " does not work on a canvas; leave canvas and newCanvas out");
      } else if (imageId) {
        if (newCanvas) throw new ModuleError("give canvas or newCanvas, not both");
        entry = await canvases.ensure(imageId);
        if (imagesOnly && entry.kind === "graph") throw new ModuleError(manifest.id + " is a v1 package module and works on images only; this is a Graph document. A module/2 package can declare it works on documents", "target-unsupported");
      } else if (cap.target === "canvas-or-new") {
        entry = await canvases.create(imagesOnly ? { ...(newCanvas ?? {}), kind: "image" } : (newCanvas ?? {}));
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
        // Derived objects and broadcasts: module/2 only, declared in the manifest, checked before anything is applied.
        const wantsDerived = output.derived?.length > 0, wantsBroadcast = output.broadcast?.length > 0;
        if ((wantsDerived || wantsBroadcast) && !manifest.v2) throw new ModuleError(capId + " returned derived or broadcast, which only module/2 modules may", "output");
        if (wantsDerived && !manifest.v2.derives?.[capId]) throw new ModuleError(capId + " returned derived objects but does not declare derives in its manifest", "output");
        if (wantsDerived && !entry) throw new ModuleError(capId + " returned derived objects but has no document", "output");
        if (wantsDerived) {
          const made = new Set(output.operations.filter((op) => op?.op === "object.create" && typeof op.ref === "string").map((op) => "$" + op.ref));
          const named = output.derived.map((d) => d.object);
          if (named.some((n) => !made.has(n)) || new Set(named).size !== named.length) throw new ModuleError("derived.object must name, once each, an object this run creates with a ref", "output");
          if (bindingsOf(entry).length + named.length > MAX_DERIVED_PER_CANVAS) throw new ModuleError("a document holds at most " + MAX_DERIVED_PER_CANVAS + " derived objects", "output");
        }
        if (internal?.refreshObject !== undefined) {
          if (wantsDerived || wantsBroadcast) throw new ModuleError("a refresh may not create derived objects or broadcast", "output");
          const stray = output.operations.find((op) => !(op?.op === "object.update" && op.id === internal.refreshObject));
          if (stray) throw new ModuleError("a refresh may only update " + internal.refreshObject, "output");
        }
        // A preview: the module has said what it would write; nothing is applied, saved or linked.
        if (internal?.dryRun === true) {
          if (internal.refreshObject === undefined) throw new ModuleError("a preview is only for a refresh", "invalid");
          audit.record({ kind: "run.preview", module: manifest.id, capability: capId, canvas: entry?.imageId, ms: Date.now() - started });
          return { module: manifest, capability: cap, entry, createdCanvas, scene: { created: [], updated: [], deleted: [], published: [], refs: {}, notes: [], revision: seen }, summary: output.summary, data: output.data, preview: { operations: output.operations }, ms: Date.now() - started };
        }
        // A v2 module may not change or delete what the user has edited since. The core's own refresh of a derived object is exempt: the coordinator has already decided whether that object may be rewritten (it pauses on an edit, and the person's overwrite lifts it).
        if (manifest.v2 && entry && internal?.refreshObject === undefined) {
          const edited = new Set(renderedObjects(entry).filter((r) => r.object.provenance?.editedByUser).map((r) => r.object.id));
          const hit = output.operations.find((op) => op && (op.op === "object.update" || op.op === "object.delete") && edited.has(op.id));
          if (hit) throw new ModuleError(capId + " tried to " + hit.op.split(".")[1] + " " + hit.id + ", which the user edited; leave it, or create a separate object", "user-edited");
        }
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
        }
        // Registered together with the objects, saved together with them.
        let derivedResult = null;
        if (entry && wantsDerived) derivedIndex?.add(manifest.id, entry.imageId);
        if (entry && (wantsDerived || wantsBroadcast)) {
          const registered = [], staled = new Set();
          for (const d of output.derived ?? []) {
            registered.push(register(entry, { source: { module: manifest.id, capability: capId, sourceRef: d.sourceRef, sourceRevision: d.sourceRevision, inputsHash: d.inputsHash }, objectId: scene.refs[d.object.slice(1)] }).id);
          }
          for (const e of output.broadcast ?? []) for (const id of sourceChanged(entry, { module: manifest.id, ...(e.sourceRef !== undefined ? { sourceRef: e.sourceRef } : {}) })) staled.add(id);
          derivedResult = { registered, staled: [...staled] };
        }
        if (output.operations.length || derivedResult?.registered.length || derivedResult?.staled.length) {
          await canvases.save(entry, { tool: "execute_module", author: "module", changed: [...scene.created, ...scene.updated], removed: scene.deleted,
            note: manifest.id + "/" + capId });
        }
        // The same broadcast reaches the other documents that hold this module's bindings (and, with no document at all, all of them).
        if (wantsBroadcast && derivedIndex) {
          const others = await deliverBroadcast({ index: derivedIndex, canvases, module: manifest.id, events: output.broadcast, except: entry?.imageId ?? null, note: manifest.id + "/" + capId });
          derivedResult = { registered: derivedResult?.registered ?? [], staled: derivedResult?.staled ?? [], ...(others.staled.length ? { staledElsewhere: others.staled.length, documents: others.documents } : {}),
            ...(others.remaining ? { remainingDocuments: others.remaining } : {}), ...(others.failed.length ? { failedDocuments: others.failed.length } : {}) };
        } else if (wantsBroadcast && !derivedResult) derivedResult = { registered: [], staled: [] };
        if (runtime.after) {
          try { await runtime.after(mod, capId, input, ctx, { output, scene, entry }); }
          catch (error) { audit.record({ kind: "run.after-failed", module: manifest.id, capability: capId, error: String(error?.message || error).slice(0, 300) }); }
        }
        const ms = Date.now() - started;
        audit.record({ kind: "run", module: manifest.id, capability: capId, canvas: entry?.imageId, createdCanvas,
          created: scene.created.length, updated: scene.updated.length, deleted: scene.deleted.length, ms, ...(jobId ? { job: jobId } : {}) });
        return { module: manifest, capability: cap, entry, createdCanvas, scene, summary: output.summary, data: output.data, ...(derivedResult ? { derived: derivedResult } : {}), ms };
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
