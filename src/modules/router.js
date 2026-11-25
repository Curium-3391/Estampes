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
import { register, sourceChanged, markStale, bindingsOf, MAX_DERIVED_PER_CANVAS } from "../documents/derived-coordinator.js";
import { deliverBroadcast } from "../documents/derived-broadcast.js";
import { ModelError } from "../models/store.js";
import { allCapabilities, runHostCapability } from "./model-capabilities.js";
import { randomBytes } from "node:crypto";

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
// A model-store refusal as the router's own error, keeping the store's code (conflict, limit, schema, ...).
const asModuleError = (error) => (error instanceof ModelError ? Object.assign(new ModuleError(error.message, error.code === "conflict" ? "conflict" : error.code === "schema" ? "output" : error.code), error.details ? { details: error.details } : {}) : error);

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
  derived: z.array(z.object({ object: z.string().regex(/^(\$[A-Za-z][A-Za-z0-9_-]{0,31}|o\d{1,6})$/), sourceRef: z.string().min(1).max(200),
    sourceRevision: z.number().int().positive(), inputsHash: z.string().regex(/^[0-9a-f]{64}$/), stale: z.boolean().optional() }).strict()).max(50).optional(),
  broadcast: z.array(z.object({ event: z.literal("source-changed"), sourceRef: z.string().min(1).max(200).optional() }).strict()).max(50).optional(),
  // module/2 only (#85 V1-3). Changes to the module's own model instances: either updates of existing instances (`id`, with the
  // `expectedRevision` they were made against; all of them or none) or one new instance (`ref`). Never together with `operations`.
  models: z.array(z.union([
    z.object({ id: z.string().regex(/^md:[0-9a-f]{12}$/), model: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), expectedRevision: z.number().int().positive(), value: z.unknown() }).strict(),
    z.object({ ref: z.string().regex(/^\$[A-Za-z][A-Za-z0-9_-]{0,31}$/), model: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), value: z.unknown() }).strict(),
  ])).min(1).max(8).optional(),
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
export function createRouter({ registry, audit, canvases, runtimes, jobs = null, egress = null, readSource = null, derivedIndex = null, models = null }) {
  const DEFAULT_JOB_MS = 10 * 60 * 1000;
  const modelStore = () => { const store = models?.(); if (!store) throw new ModuleError("model storage is not available on this server", "unavailable"); return store; };
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
      const cap = allCapabilities(manifest).find((c) => c.id === capId);
      if (!cap) throw new ModuleError(manifest.id + " has no capability " + JSON.stringify(capId) + "; it has " + allCapabilities(manifest).map((c) => c.id).join(", "), "not-found");
      const granted = record.granted ?? [];
      const missing = missingPermissions(granted, capabilityPermissions(manifest, cap));
      if (missing.length) throw new ModuleError(manifest.id + " was not granted " + missing.join(", ") + "; the user must approve it again in the Store", "permission");
      if (!VISIBILITY.includes(visibility)) throw new ModuleError("visibility must be public or scratch");
      let input;
      try { input = validateValue(cap.inputSchema, params ?? {}, "params"); }
      catch (error) { throw new ModuleError(error.message + ". Call get_module_capabilities for the exact schema", "input"); }

      // The host's own read capabilities (models.list, models.get): answered here, never by the module's runtime, after the same checks.
      if (cap.host === "models") {
        if (imageId || newCanvas) throw new ModuleError(capId + " does not work on a canvas; leave canvas and newCanvas out");
        let out;
        try { out = await runHostCapability({ store: modelStore(), manifest, capability: capId, input }); } catch (error) { throw asModuleError(error); }
        audit.record({ kind: "run.host", module: manifest.id, capability: capId, ms: Date.now() - started });
        return { module: manifest, capability: cap, entry: null, createdCanvas: false, scene: { created: [], updated: [], deleted: [], published: [], refs: {}, notes: [], revision: null }, summary: out.summary, data: out.data, ms: Date.now() - started };
      }
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
      // #174: a built-in module may call a capability of another module that its manifest names under `uses`. The call returns only what that
      // capability computes (scene operations, summary); nothing is applied here: the caller returns it as its own result and the core applies it
      // under the caller's checks. The other module must be enabled and both modules must hold every permission the used capability needs.
      const usedKeys = new Map();
      const declaredUses = manifest.v2?.uses?.[capId];
      if (builtin && declaredUses?.length) {
        ctx.use = async (useModule, useCapability, useParams = {}) => {
          if (!declaredUses.some((u) => u.module === useModule && u.capability === useCapability)) {
            throw new ModuleError(capId + " did not declare that it uses " + useModule + " " + useCapability + " (manifest uses)", "permission");
          }
          const used = registry.get(useModule);
          if (!used || used.record.state !== "enabled") throw new ModuleError(capId + " needs " + useModule + ", which is " + (used ? used.record.state : "not installed") + (used ? ". Only the user can enable it, in the Store" : ""), "unavailable");
          const ucap = used.manifest.capabilities.find((c) => c.id === useCapability);
          if (!ucap) throw new ModuleError(useModule + " has no capability " + useCapability, "not-found");
          if (ucap.async) throw new ModuleError(useCapability + " runs as a background job and cannot be used from another capability", "run");
          const needs = capabilityPermissions(used.manifest, ucap);
          const lacking = missingPermissions(used.record.granted ?? [], needs);
          if (lacking.length) throw new ModuleError(useModule + " was not granted " + lacking.join(", "), "permission");
          const callerLacks = missingPermissions(granted, needs);
          if (callerLacks.length) throw new ModuleError(manifest.id + " was not granted " + callerLacks.join(", ") + ", which " + useCapability + " needs", "permission");
          let usedInput;
          try { usedInput = validateValue(ucap.inputSchema, useParams ?? {}, "params"); }
          catch (error) { throw new ModuleError(error.message, "input"); }
          if (ucap.target !== "none" && !entry) throw new ModuleError(useCapability + " needs a document", "input");
          const usedRuntime = runtimes[used.runtime.kind];
          if (!usedRuntime) throw new ModuleError("runtime " + used.runtime.kind + " is not available on this server", "runtime");
          const usedPerms = needs.filter((p) => granted.includes(p));
          const raw = await usedRuntime.run(used, useCapability, usedInput, { module: { id: used.manifest.id, version: used.manifest.version }, capability: useCapability,
            permissions: usedPerms, limits: used.manifest.limits ?? {}, canvas: entry && ucap.target !== "none" ? canvasContext(entry, used.manifest.id, usedPerms, !!used.manifest.v2) : null,
            entry: usedPerms.includes("asset.read.selected") ? entry : null });
          const parsed = OutputSchema.safeParse(raw ?? {});
          if (!parsed.success) throw new ModuleError(useModule + " " + useCapability + " returned invalid output: " + parsed.error.issues[0].message, "output");
          if (parsed.data.derived?.length || parsed.data.broadcast?.length) throw new ModuleError(useCapability + " returned derived or broadcast, which cannot be used from another module", "output");
          usedKeys.set(useModule, JSON.stringify([used.record.state, used.record.version, [...(used.record.granted ?? [])].sort()]));
          audit.record({ kind: "run.use", module: manifest.id, capability: capId, used: useModule + " " + useCapability, canvas: entry?.imageId });
          return { operations: parsed.data.operations, ...(parsed.data.summary ? { summary: parsed.data.summary } : {}), ...(parsed.data.method ? { method: parsed.data.method } : {}) };
        };
      }
      // #85 V1-3: a module reads its own model instances (never another module's). Needs module.storage.write, which declaring models requires.
      const modelTypes = manifest.v2?.models;
      if (modelTypes && effective.includes("module.storage.write")) {
        const typeOf = (name) => modelTypes[name] ?? (() => { throw new ModuleError(manifest.id + " declares no model " + JSON.stringify(name), "input"); })();
        ctx.models = {
          list: async (name) => { typeOf(name); return modelStore().list({ module: manifest.id, model: name }); },
          read: async (name, id) => { try { return await modelStore().read({ module: manifest.id, type: typeOf(name), id }); } catch (error) { throw asModuleError(error); } },
        };
      }
      // The original image of the target canvas, for built-in modules and for
      // http modules that declare a multipart file (sent only through egress).
      if ((builtin || mod.runtime.kind === "http") && effective.includes("asset.read.selected") && readSource && entry) ctx.readSource = () => readSource(entry.imageId);

      // Runs the capability and lands its result on the canvas. A background
      // job calls it without a revision check: it was started on purpose and
      // may finish long after the canvas moved on.
      const stop = { cancelled: false };
      // What must still be true when the module answers (5C-1, "late effects 0"): the module is still the same enabled module with the same grants,
      // and, for a refresh of one object, that object is as it was when the call began. Compared by value; a module that was disabled, updated or
      // given other permissions, or an object the person edited meanwhile, makes the answer stale: nothing is applied.
      const moduleStateKey = () => { const m = registry.get(moduleId); return m ? JSON.stringify([m.record.state, m.record.version, [...(m.record.granted ?? [])].sort()]) : "gone"; };
      const targetKey = () => {
        if (internal?.refreshObject === undefined || !(entry?.objects instanceof Map)) return null;
        const o = entry.objects.get(internal.refreshObject);
        return o ? JSON.stringify([o.revision, o.provenance?.editedByUser === true, o.props]) : "gone";
      };
      const stateAtStart = moduleStateKey(), targetAtStart = targetKey();
      const work = async (checkRevision, jobId) => {
        let output;
        try {
          const raw = await runtime.run(mod, capId, input, jobId ? { ...ctx, progress: (note) => jobs.progress(jobId, note), cancelled: () => stop.cancelled } : ctx);
          const parsed = OutputSchema.safeParse(raw ?? {});
          if (!parsed.success) throw new ModuleError("module output is not valid: " + parsed.error.issues[0].message + " at " + parsed.error.issues[0].path.join("."), "output");
          output = parsed.data;
          // #86 F1: a declared outputSchema is a promise about `data`; a result that breaks it is refused before anything is applied.
          const promised = manifest.v2?.outputs?.[capId];
          if (promised && !jobId) {
            try { validateValue(promised, output.data ?? {}, "data"); }
            catch (error) { throw new ModuleError(capId + " returned data that does not fit its outputSchema: " + error.message, "output"); }
          }
        } catch (error) {
          audit.record({ kind: "run.failed", module: manifest.id, capability: capId, canvas: entry?.imageId, ms: Date.now() - started, error: String(error?.message || error).slice(0, 300) });
          throw error instanceof ModuleError ? error : new ModuleError(manifest.id + " " + capId + " failed: " + (error?.message || error), "run");
        }

        if (stop.cancelled) throw new ModuleError("stopped before its result was applied", "timeout");
        if (moduleStateKey() !== stateAtStart) {
          audit.record({ kind: "run.late", module: manifest.id, capability: capId, canvas: entry?.imageId, why: "module changed", ms: Date.now() - started });
          throw new ModuleError(manifest.id + " was disabled, updated or given other permissions while " + capId + " ran; its result was not applied", "revoked");
        }
        for (const [id, key] of usedKeys) {
          const m = registry.get(id);
          if ((m ? JSON.stringify([m.record.state, m.record.version, [...(m.record.granted ?? [])].sort()]) : "gone") !== key) {
            audit.record({ kind: "run.late", module: manifest.id, capability: capId, canvas: entry?.imageId, why: "used module changed", ms: Date.now() - started });
            throw new ModuleError(id + " was disabled, updated or given other permissions while " + capId + " ran; its result was not applied", "revoked");
          }
        }
        if (targetKey() !== targetAtStart) {
          audit.record({ kind: "run.late", module: manifest.id, capability: capId, canvas: entry?.imageId, why: "target changed", ms: Date.now() - started });
          throw new ModuleError("the object changed while it was being updated; its result was not applied", "conflict");
        }
        // Model changes (#85 V1-3): module/2, declared (`writes`), never mixed with scene operations (the two stores cannot commit together), and
        // checked before anything is applied or written.
        const wantsModels = output.models?.length > 0;
        let modelChanges = null;
        if (wantsModels) {
          if (!manifest.v2) throw new ModuleError(capId + " returned models, which only module/2 modules may", "output");
          const allowed = manifest.v2.writes?.[capId];
          if (!allowed?.length) throw new ModuleError(capId + " returned models but does not declare writes in its manifest", "output");
          // A broadcast is allowed beside models (#85 V3-A): it is only a hint that marks this module's own bindings stale, so a model change can reach the objects drawn from it.
          if (output.operations.length || output.derived?.length) throw new ModuleError(capId + " returned models together with scene operations or derived objects; a result is one or the other (a broadcast may accompany models)", "output");
          if (internal) throw new ModuleError(capId + " returned models in a refresh, preview or adoption", "output");
          for (const c of output.models) if (!allowed.includes(c.model)) throw new ModuleError(capId + " may not write model " + c.model + " (writes: " + allowed.join(", ") + ")", "output");
          const creates = output.models.filter((c) => c.ref), updates = output.models.filter((c) => c.id);
          if (creates.length && updates.length) throw new ModuleError("a result either creates one instance or updates existing ones, not both", "output");
          if (creates.length > 1) throw new ModuleError("a result creates at most one instance", "output");
          if (new Set(updates.map((c) => c.id)).size !== updates.length) throw new ModuleError("an instance appears twice in one result", "output");
          if (jobId) throw new ModuleError("a background job cannot write models", "output");
          modelChanges = { creates, updates };
        }
        // Derived objects and broadcasts: module/2 only, declared in the manifest, checked before anything is applied.
        const wantsDerived = output.derived?.length > 0, wantsBroadcast = output.broadcast?.length > 0;
        if ((wantsDerived || wantsBroadcast) && !manifest.v2) throw new ModuleError(capId + " returned derived or broadcast, which only module/2 modules may", "output");
        // An adopt run (5B-4): the module names objects that already exist and were made by the producer capability it was declared for; nothing is drawn.
        const adopting = internal?.adopt !== undefined;
        if (adopting) {
          if (manifest.v2?.adopt?.[internal.adopt] !== capId) throw new ModuleError(capId + " is not declared as the adopt capability of " + internal.adopt, "output");
          if (output.operations.length || wantsBroadcast) throw new ModuleError("an adopt run may only name existing objects", "output");
          const ids = (output.derived ?? []).map((d) => d.object);
          if (ids.some((n) => n.startsWith("$")) || new Set(ids).size !== ids.length) throw new ModuleError("an adopt run must name each existing object once, by id", "output");
        } else if (output.derived?.some((d) => !d.object.startsWith("$") || d.stale !== undefined)) throw new ModuleError("derived.object must name an object this run creates, by its $ref", "output");
        if (wantsDerived && !adopting && !manifest.v2.derives?.[capId]) throw new ModuleError(capId + " returned derived objects but does not declare derives in its manifest", "output");
        if (wantsDerived && !entry) throw new ModuleError(capId + " returned derived objects but has no document", "output");
        if (wantsDerived && adopting) {
          // A module may only adopt what it made itself.
          for (const d of output.derived) {
            const o = entry.objects instanceof Map ? entry.objects.get(d.object) : undefined;
            if (o && o.provenance?.module !== manifest.id) throw new ModuleError("an adopt run may only name objects this module made (" + d.object + ")", "output");
          }
          // Only objects that would really be added count: ones already bound or gone are skipped below.
          const added = output.derived.filter((d) => entry.objects instanceof Map && entry.objects.has(d.object) && !bindingsOf(entry).some((b) => b.target.id === d.object && b.state !== "removed"));
          if (bindingsOf(entry).length + added.length > MAX_DERIVED_PER_CANVAS) throw new ModuleError("a document holds at most " + MAX_DERIVED_PER_CANVAS + " derived objects", "output");
        } else if (wantsDerived) {
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
        // Model changes land here, after every late-effect check above: updates in one all-or-nothing commit, or one new instance.
        let modelResult = null;
        if (modelChanges) {
          const store = modelStore(), commandId = "run-" + randomBytes(8).toString("hex");
          try {
            if (modelChanges.creates.length) {
              const c = modelChanges.creates[0];
              const made = await store.create({ module: manifest.id, type: modelTypes[c.model], value: c.value, commandId, by: "module" });
              modelResult = { status: "applied", created: [{ ref: c.ref, id: made.id }], instances: [made], commandId };
            } else {
              const done = await store.commit({ module: manifest.id, commandId, by: "module", changes: modelChanges.updates.map((c) => ({ id: c.id, type: modelTypes[c.model], expectedRevision: c.expectedRevision, value: c.value })) });
              modelResult = { status: done.status, created: [], instances: done.instances, commandId };
            }
          } catch (error) {
            audit.record({ kind: "run.rejected", module: manifest.id, capability: capId, error: String(error?.message || error).slice(0, 300) });
            throw asModuleError(error);
          }
          audit.record({ kind: "run.models", module: manifest.id, capability: capId, instances: modelResult.instances.map((i) => i.id), commandId });
        }
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
        let derivedResult = null, adoptBackup;
        if (entry && wantsDerived) derivedIndex?.add(manifest.id, entry.imageId);
        if (entry && (wantsDerived || wantsBroadcast)) {
          const registered = [], staled = new Set();
          if (adopting) adoptBackup = entry.derived;
          for (const d of output.derived ?? []) {
            if (adopting) {
              // Idempotent: an object that already has a live binding, or is no longer on the canvas, is skipped.
              const o = entry.objects instanceof Map ? entry.objects.get(d.object) : undefined;
              if (!o || bindingsOf(entry).some((b) => b.target.id === d.object && b.state !== "removed")) continue;
              const b = register(entry, { source: { module: manifest.id, capability: internal.adopt, sourceRef: d.sourceRef, sourceRevision: d.sourceRevision, inputsHash: d.inputsHash }, objectId: d.object, objectEdited: o.provenance?.editedByUser === true });
              if (d.stale) markStale(entry, b.id);
              registered.push(b.id);
              continue;
            }
            registered.push(register(entry, { source: { module: manifest.id, capability: capId, sourceRef: d.sourceRef, sourceRevision: d.sourceRevision, inputsHash: d.inputsHash }, objectId: scene.refs[d.object.slice(1)] }).id);
          }
          for (const e of output.broadcast ?? []) for (const id of sourceChanged(entry, { module: manifest.id, ...(e.sourceRef !== undefined ? { sourceRef: e.sourceRef } : {}) })) staled.add(id);
          derivedResult = { registered, staled: [...staled], ...(adopting ? { named: output.derived.map((d) => d.object) } : {}) };
        }
        if (output.operations.length || derivedResult?.registered.length || derivedResult?.staled.length) {
          try {
            await canvases.save(entry, { tool: "execute_module", author: "module", changed: [...scene.created, ...scene.updated], removed: scene.deleted,
              note: manifest.id + "/" + capId });
          } catch (error) {
            // An adoption that was not saved must not stay in the cached document: the next open would see the bindings and skip it.
            if (adopting) { if (adoptBackup === undefined) delete entry.derived; else entry.derived = adoptBackup; }
            throw error;
          }
        }
        // The same broadcast reaches the other documents that hold this module's bindings (and, with no document at all, all of them).
        if (wantsBroadcast && derivedIndex) {
          const others = await deliverBroadcast({ index: derivedIndex, canvases, module: manifest.id, events: output.broadcast, except: entry?.imageId ?? null, note: manifest.id + "/" + capId });
          derivedResult = { registered: derivedResult?.registered ?? [], staled: derivedResult?.staled ?? [], ...(others.staled.length ? { staledElsewhere: others.staled.length, documents: others.documents } : {}),
            ...(others.remaining ? { remainingDocuments: others.remaining } : {}), ...(others.failed.length ? { failedDocuments: others.failed.length } : {}) };
        } else if (wantsBroadcast && !derivedResult) derivedResult = { registered: [], staled: [] };
        if (runtime.after) {
          try { await runtime.after(mod, capId, input, ctx, { output, scene, entry }); }
          catch (error) {
            audit.record({ kind: "run.after-failed", module: manifest.id, capability: capId, error: String(error?.message || error).slice(0, 300) });
            // An adoption is only complete once its finalization is: the caller must try again.
            if (adopting) throw new ModuleError("the adoption could not be finished: " + String(error?.message || error).slice(0, 200), "internal");
          }
        }
        const ms = Date.now() - started;
        audit.record({ kind: "run", module: manifest.id, capability: capId, canvas: entry?.imageId, createdCanvas,
          created: scene.created.length, updated: scene.updated.length, deleted: scene.deleted.length, ms, ...(jobId ? { job: jobId } : {}) });
        return { module: manifest, capability: cap, entry, createdCanvas, scene, summary: output.summary, data: output.data, ...(derivedResult ? { derived: derivedResult } : {}), ...(modelResult ? { models: modelResult } : {}), ms };
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
