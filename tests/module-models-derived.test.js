// #85 V3-A: an object drawn from a model instance is a derived object whose source is that instance. A capability that changes the model
// may announce `broadcast` in the same result (never scene operations or derived objects), the binding turns stale, and refreshing it
// redraws from the instance's current value. Invented module; real router, record store and derived flow over a fake UVA service.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { createRecordStore } from "../src/uva/record-store.js";
import { createModelStore } from "../src/models/store.js";
import { createDerivedFlow } from "../src/modules/derived-flow.js";
import { bindingsOf } from "../src/documents/derived-coordinator.js";
import { hashJson } from "../src/documents/validation.js";

const MOD = "org.example.lamp";
const SCHEMA = { type: "object", additionalProperties: false, required: ["level"], properties: { level: { type: "integer", minimum: 0, maximum: 9 } } };
const REFRESH_IN = { type: "object", additionalProperties: false, properties: { sourceRef: { type: "string", maxLength: 200 }, object: { type: "string", maxLength: 64 } } };
const NONE_IN = { type: "object", additionalProperties: false, properties: { id: { type: "string", maxLength: 20 }, level: { type: "integer" } } };
const cap = (id, extra = {}) => ({ id, title: id, description: "Test capability " + id + ".", target: "document", needs: ["canvas.write", "module.storage.write"], inputSchema: NONE_IN, ...extra });
const manifest = { schema: "estampes.module/2", id: MOD, name: "Lamp", description: "An invented module that draws a model.", version: "1.0.0", publisher: { name: "Example" }, license: "MPL-2.0",
  category: "diagram", coreCompatibility: ">=0.10.0 <1.0.0", permissions: ["canvas.write", "module.storage.write"], models: [{ id: "lamp", dataVersion: 1, schema: SCHEMA }],
  capabilities: [cap("create", { target: "none", needs: ["module.storage.write"], writes: ["lamp"] }), cap("set", { target: "none", needs: ["module.storage.write"], writes: ["lamp"] }),
    cap("draw", { derives: { refresh: "redraw" } }), cap("redraw", { inputSchema: REFRESH_IN })],
  runtime: { kind: "builtin", entry: "lamp", abi: 1 } };
const range = (n) => ({ xRange: [-n, n], yRange: [-n, n] });

function fakeService() {
  const held = new Map();
  return { held, noteMirror() {}, recordKeys: async () => [...held.keys()], recordState: async (key) => held.get(key) ?? null,
    async syncRecord({ key, value, seq, log }) { held.set(key, { value, seq, log, valueHash: hashJson(value) }); return { status: "created", sourceHash: hashJson(value), logHash: hashJson(log ?? []), seq }; } };
}
async function setup(t, { broadcastOnSet = true } = {}) {
  process.env.ESTAMPES_MODULE_V2 = "on";
  const storage = await mkdtemp(join(tmpdir(), "models-derived-"));
  t.after(() => rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const run = async (c, input, ctx) => {
    if (c === "create") return { models: [{ ref: "$l", model: "lamp", value: { level: input.level ?? 1 } }] };
    if (c === "set") return { models: [{ id: input.id, model: "lamp", expectedRevision: (await ctx.models.read("lamp", input.id)).revision, value: { level: input.level } }], ...(broadcastOnSet ? { broadcast: [{ event: "source-changed", sourceRef: input.id }] } : {}) };
    const inst = await ctx.models.read("lamp", input.id ?? input.sourceRef);
    if (c === "draw") return { operations: [{ op: "object.create", ref: "o", type: "axes-2d", props: range(inst.value.level + 1) }], derived: [{ object: "$o", sourceRef: inst.id, sourceRevision: inst.revision, inputsHash: "a".repeat(64) }] };
    return { operations: [{ op: "object.update", id: input.object, props: range(inst.value.level + 1) }], data: { sourceRevision: inst.revision } };
  };
  const canvases = { ensure: ensureImage, create: async (o) => createBlankCanvas(o), save: async () => {} };
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0", builtins: [{ manifest, run }], canvases });
  const records = await createRecordStore({ service: fakeService(), storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
  t.after(() => records.close());
  h.models = createModelStore({ records });
  const plan = await h.lifecycle.prepare("enable", MOD); await h.lifecycle.commit(plan.planId, { consent: plan.consent });
  const flow = createDerivedFlow({ router: h.router, registry: h.registry, canvases, index: h.derivedIndex });
  return { h, flow, call: (capability, params = {}, extra = {}) => h.router.execute({ module: MOD, capability, params, ...extra }) };
}
const drawn = async (s, canvas, id) => (await s.call("draw", { id }, { canvas }));

test("a model change that announces itself turns the object drawn from it stale, and a refresh redraws from the current value", async (t) => {
  const s = await setup(t);
  const made = (await s.call("create", { level: 1 })).models.created[0].id;
  const canvas = await createBlankCanvas({});
  const r = await drawn(s, canvas.imageId, made);
  const [b] = bindingsOf(canvas);
  assert.deepEqual([r.derived.registered.length, b.state, b.source.sourceRef, b.source.sourceRevision], [1, "fresh", made, 1]);
  const size = () => canvas.objects.get(b.target.id).props.xRange[1];
  assert.equal(size(), 2);
  const changed = await s.call("set", { id: made, level: 5 });
  assert.equal(changed.models.status, "applied");
  assert.equal(changed.derived.staledElsewhere, 1, "the document holding the binding is reached through the index");
  assert.equal((await s.flow.list(canvas.imageId)).counts.stale, 1);
  const refreshed = await s.flow.update({ canvas: canvas.imageId, action: "refresh-stale" });
  assert.ok(JSON.stringify(refreshed).includes("fresh"), JSON.stringify(refreshed).slice(0, 300));
  assert.equal(size(), 6, "redrawn from level 5");
  assert.equal(bindingsOf(canvas)[0].source.sourceRevision, 2);
});

test("without a broadcast the object stays as it was, and the model is still written", async (t) => {
  const s = await setup(t, { broadcastOnSet: false });
  const made = (await s.call("create")).models.created[0].id;
  const canvas = await createBlankCanvas({});
  await drawn(s, canvas.imageId, made);
  await s.call("set", { id: made, level: 4 });
  assert.equal((await s.h.models.list({ module: MOD }))[0].revision, 2);
  assert.equal((await s.flow.list(canvas.imageId)).counts.fresh, 1);
});
