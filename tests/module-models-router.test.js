// #85 V1-3: a capability writes its module's model instances through the router. A result is models or scene operations, never both;
// updates are all-or-nothing with the revisions they were made against; only declared writes land; a module reads only its own data.
// Invented module; real record store over a fake UVA document service.
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
import { hashJson } from "../src/documents/validation.js";

const MOD = "org.example.logic";
const objectSchema = (props) => ({ type: "object", additionalProperties: false, properties: props });
const MODELS = [
  { id: "adder", dataVersion: 1, schema: { ...objectSchema({ a: { type: "integer", minimum: 0, maximum: 1 }, b: { type: "integer", minimum: 0, maximum: 1 } }), required: ["a", "b"] }, maxInstances: 4 },
  { id: "note", dataVersion: 1, schema: objectSchema({ text: { type: "string", maxLength: 40 } }) },
];
const PERMS = ["canvas.write", "workspace.write", "module.storage.write"];
const cap = (id, extra = {}) => ({ id, title: id, description: "Test capability " + id + ".", target: "none", needs: ["module.storage.write"], inputSchema: { type: "object", properties: {}, additionalProperties: false }, ...extra });
const manifest = { schema: "estampes.module/2", id: MOD, name: "Logic", description: "An invented module that keeps models.", version: "1.0.0", publisher: { name: "Example" },
  license: "MPL-2.0", category: "diagram", coreCompatibility: ">=0.10.0 <1.0.0", permissions: PERMS, models: MODELS,
  capabilities: [cap("save", { writes: ["adder"] }), cap("save_note", { writes: ["note"] }), cap("mixed", { writes: ["adder"], target: "document-or-new", needs: ["module.storage.write", "canvas.write", "workspace.write"] }), cap("peek"), cap("readonly")],
  runtime: { kind: "builtin", entry: "logic", abi: 1 } };

function fakeService() {
  const held = new Map();
  return { held, noteMirror() {}, recordKeys: async () => [...held.keys()], recordState: async (key) => held.get(key) ?? null,
    async syncRecord({ key, value, seq, log }) { held.set(key, { value, seq, log, valueHash: hashJson(value) }); return { status: "created", sourceHash: hashJson(value), logHash: hashJson(log ?? []), seq }; } };
}
async function setup(t, run, { withStore = true } = {}) {
  process.env.ESTAMPES_MODULE_V2 = "on";
  const storage = await mkdtemp(join(tmpdir(), "models-router-"));
  t.after(() => rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0", builtins: [{ manifest, run }],
    canvases: { ensure: ensureImage, create: async (o) => createBlankCanvas(o), save: async () => {} } });
  const records = await createRecordStore({ service: fakeService(), storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
  t.after(() => records.close());
  if (withStore) h.models = createModelStore({ records });
  const plan = await h.lifecycle.prepare("enable", MOD); await h.lifecycle.commit(plan.planId, { consent: plan.consent });
  return { h, records, call: (capability, params = {}, extra = {}) => h.router.execute({ module: MOD, capability, params, ...extra }) };
}
const create = (a = 0, b = 1) => ({ models: [{ ref: "$m1", model: "adder", value: { a, b } }] });

test("a capability creates an instance and the result names its id", async (t) => {
  const s = await setup(t, (c) => (c === "save" ? create() : {}));
  const out = await s.call("save");
  assert.match(out.models.created[0].id, /^md:[0-9a-f]{12}$/);
  assert.equal(out.models.created[0].ref, "$m1");
  assert.deepEqual(out.models.instances[0].value, { a: 0, b: 1 });
  assert.equal((await s.h.models.list({ module: MOD })).length, 1);
});

test("updates are all or nothing and carry the revision they were made against", async (t) => {
  let plan;
  const s = await setup(t, (c) => (c === "save" ? plan() : {}));
  plan = create; const one = (await s.call("save")).models.instances[0];
  plan = create; const two = (await s.call("save")).models.instances[0];
  plan = () => ({ models: [{ id: one.id, model: "adder", expectedRevision: 1, value: { a: 1, b: 1 } }, { id: two.id, model: "adder", expectedRevision: 1, value: { a: 1, b: 0 } }] });
  const done = await s.call("save");
  assert.equal(done.models.status, "applied");
  assert.deepEqual(done.models.instances.map((i) => i.revision), [2, 2]);
  // One stale revision fails the whole change; the other instance is untouched.
  plan = () => ({ models: [{ id: one.id, model: "adder", expectedRevision: 2, value: { a: 0, b: 0 } }, { id: two.id, model: "adder", expectedRevision: 1, value: { a: 0, b: 0 } }] });
  await assert.rejects(s.call("save"), (e) => e.code === "conflict" && e.details.stale.length === 1);
  assert.equal((await s.h.models.read({ module: MOD, type: MODELS[0], id: one.id })).revision, 2);
  assert.deepEqual((await s.h.models.read({ module: MOD, type: MODELS[0], id: one.id })).value, { a: 1, b: 1 });
});

test("a result is models or scene operations, never both, and nothing is written when it is refused", async (t) => {
  const s = await setup(t, (c) => (c === "mixed" ? { ...create(), operations: [{ op: "object.create", type: "axes-2d", props: { xRange: [-1, 1], yRange: [-1, 1] } }] } : {}));
  await assert.rejects(s.call("mixed", {}, { newCanvas: {} }), (e) => e.code === "output" && /one or the other/.test(e.message));
  assert.deepEqual(await s.h.models.list({ module: MOD }), []);
});

test("only declared writes land: another model, an undeclared capability, a module/1 style result", async (t) => {
  const s = await setup(t, (c) => (c === "save" ? { models: [{ ref: "$m1", model: "note", value: { text: "x" } }] } : c === "readonly" ? create() : {}));
  await assert.rejects(s.call("save"), (e) => e.code === "output" && /may not write model note/.test(e.message));
  await assert.rejects(s.call("readonly"), (e) => e.code === "output" && /does not declare writes/.test(e.message));
  assert.deepEqual(await s.h.models.list({ module: MOD }), []);
});

test("a value that breaks the type's schema is refused, and so is creating past the limit", async (t) => {
  let out = create(5, 5);
  const s = await setup(t, (c) => (c === "save" ? out : {}));
  await assert.rejects(s.call("save"), (e) => e.code === "output");
  out = create();
  for (let i = 0; i < 4; i++) await s.call("save");
  await assert.rejects(s.call("save"), (e) => e.code === "limit");
});

test("creating and updating, or creating twice, in one result is refused", async (t) => {
  let out;
  const s = await setup(t, (c) => (c === "save" ? out : {}));
  out = { models: [{ ref: "$a", model: "adder", value: { a: 0, b: 0 } }, { ref: "$b", model: "adder", value: { a: 1, b: 1 } }] };
  await assert.rejects(s.call("save"), /at most one instance/);
  out = { models: [{ ref: "$a", model: "adder", value: { a: 0, b: 0 } }, { id: "md:000000000000", model: "adder", expectedRevision: 1, value: { a: 1, b: 1 } }] };
  await assert.rejects(s.call("save"), /not both/);
  assert.deepEqual(await s.h.models.list({ module: MOD }), []);
});

test("a module reads its own instances through ctx.models, and a type it did not declare is an error", async (t) => {
  const s = await setup(t, async (c, p, ctx) => {
    if (c === "save") return create();
    if (c === "peek") { const [first] = await ctx.models.list("adder"); return { data: { n: (await ctx.models.list("adder")).length, value: (await ctx.models.read("adder", first.id)).value } }; }
    if (c === "readonly") return { data: { other: await ctx.models.list("nope") } };
    return {};
  });
  await s.call("save");
  assert.deepEqual((await s.call("peek")).data, { n: 1, value: { a: 0, b: 1 } });
  await assert.rejects(s.call("readonly"), /declares no model/);
});

test("without model storage a write says so and changes nothing", async (t) => {
  const s = await setup(t, (c) => (c === "save" ? create() : {}), { withStore: false });
  await assert.rejects(s.call("save"), (e) => e.code === "unavailable");
});

test("a module that is disabled while it runs writes nothing", async (t) => {
  let s;
  s = await setup(t, async (c) => { if (c !== "save") return {}; const plan = await s.h.lifecycle.prepare("disable", MOD); await s.h.lifecycle.commit(plan.planId, { consent: plan.consent }); return create(); });
  await assert.rejects(s.call("save"), (e) => e.code === "revoked");
  assert.deepEqual(await s.h.models.list({ module: MOD }), []);
});

// ---- V1-3b: the host's own read capabilities, discovery, and the instance index ----
import { buildIndex, searchCapabilities } from "../src/modules/search.js";
import { hostCapabilities } from "../src/modules/model-capabilities.js";

test("models.list and models.get are the host's: found by search, run through execute_module, bounded, own data only", async (t) => {
  const s = await setup(t, (c) => (c === "save" ? create(1, 0) : {}));
  const made = (await s.call("save")).models.created[0].id;
  await s.call("save");
  const found = searchCapabilities(buildIndex(s.h.registry.list()), { query: "models.list", state: "enabled", limit: 20 });
  assert.ok(found.results.some((r) => r.module === MOD && r.capability === "models.list"), "discoverable");
  const list = await s.call("models.list");
  assert.equal(list.data.total, 2);
  assert.equal(list.data.instances[0].value, undefined, "a listing carries no values");
  assert.equal((await s.call("models.list", { model: "note" })).data.total, 0);
  const one = await s.call("models.get", { model: "adder", id: made });
  assert.deepEqual(one.data.instance.value, { a: 1, b: 0 });
  assert.equal(one.data.instance.revision, 1);
  await assert.rejects(s.call("models.get", { model: "adder" }), (e) => e.code === "input");
  await assert.rejects(s.call("models.get", { model: "note", id: made }), (e) => e.code === "wrong-type");
  await assert.rejects(s.call("models.get", { model: "adder", id: "md:000000000000" }), (e) => e.code === "not-found");
});

test("the host capabilities obey the module's state and grants, like any capability", async (t) => {
  const s = await setup(t, (c) => (c === "save" ? create() : {}));
  await s.call("save");
  const plan = await s.h.lifecycle.prepare("disable", MOD); await s.h.lifecycle.commit(plan.planId, { consent: plan.consent });
  await assert.rejects(s.call("models.list"), (e) => e.code === "disabled");
});

test("a module without models gets no host capabilities, and a module cannot declare a capability that shadows one", async (t) => {
  assert.deepEqual(hostCapabilities({ v2: {} }), []);
  assert.deepEqual(hostCapabilities({ v2: { models: {} } }), []);
  const { validateManifest, ManifestError } = await import("../src/modules/manifest.js");
  const bad = { ...manifest, capabilities: [cap("models.list")] };
  assert.throws(() => validateManifest(bad, { v2: true, builtin: true }), (e) => e instanceof ManifestError);
});

test("the instance index lists every instance without values and says what state its module is in", async (t) => {
  const s = await setup(t, (c) => (c === "save" ? create() : {}));
  await s.call("save");
  const rows = await s.h.models.index();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["bytes", "dataVersion", "id", "model", "module", "revision", "updatedAt"]);
});
