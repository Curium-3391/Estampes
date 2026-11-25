// #85 V2-2: a module's views are offered as surface panels (kind module-view); opening one is a surface action that never enables the
// module; the surface state carries what the widget needs (renderer, bound instances) and nothing the module could use to run code.
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
import { createSurfaceStore } from "../src/surface/store.js";
import { createSurfaceService } from "../src/surface/service.js";
import { moduleViewsOf } from "../src/surface/module-views.js";
import { hashJson } from "../src/documents/validation.js";

const MOD = "org.example.logic";
const SCHEMA = { type: "object", additionalProperties: false, required: ["a", "sum"], properties: { a: { type: "boolean" }, sum: { type: "integer", minimum: 0, maximum: 3 } } };
const manifest = { schema: "estampes.module/2", id: MOD, name: "Logic", description: "An invented module with a view.", version: "1.0.0", publisher: { name: "Example" }, license: "MPL-2.0",
  category: "diagram", coreCompatibility: ">=0.10.0 <1.0.0", permissions: ["module.storage.write"], models: [{ id: "adder", dataVersion: 1, schema: SCHEMA }],
  capabilities: [{ id: "set", title: "set", description: "Sets a field.", target: "none", needs: ["module.storage.write"], writes: ["adder"], inputSchema: { type: "object", additionalProperties: false, properties: { id: { type: "string", maxLength: 20 } } } }],
  views: [{ id: "adder-view", title: "Adder", titleI18n: { "zh-TW": "加法器" }, reads: ["adder"], actions: ["set"], renderer: { type: "declarative", schema: "estampes.renderer.declarative/1",
    payload: { root: { type: "stack", children: [{ type: "readout", label: "Sum", model: "adder", path: "/sum" }, { type: "toggle", label: "A", model: "adder", path: "/a", action: "set", params: { id: { $: "instance" } } }] } } } }],
  runtime: { kind: "builtin", entry: "logic", abi: 1 } };

function fakeService() {
  const held = new Map();
  return { held, noteMirror() {}, recordKeys: async () => [...held.keys()], recordState: async (key) => held.get(key) ?? null,
    async syncRecord({ key, value, seq, log }) { held.set(key, { value, seq, log, valueHash: hashJson(value) }); return { status: "created", sourceHash: hashJson(value), logHash: hashJson(log ?? []), seq }; } };
}
async function setup(t) {
  process.env.ESTAMPES_MODULE_V2 = "on";
  const storage = await mkdtemp(join(tmpdir(), "module-view-"));
  t.after(() => rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0", builtins: [{ manifest, run: () => ({}) }], canvases: { ensure: ensureImage, create: async (o) => createBlankCanvas(o), save: async () => {} } });
  const records = await createRecordStore({ service: fakeService(), storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
  t.after(() => records.close());
  h.models = createModelStore({ records });
  const service = createSurfaceService({ store: createSurfaceStore({ dir: "" }), registry: h.registry, notebooks: null, models: () => h.models });
  const enable = async () => { const p = await h.lifecycle.prepare("enable", MOD); await h.lifecycle.commit(p.planId, { consent: p.consent }); };
  const make = (value) => h.models.create({ module: MOD, type: h.registry.get(MOD).manifest.v2.models.adder, value, commandId: "c" + Math.random() });
  return { h, service, enable, make, key: "gph:0123456789abcdef" };
}

test("a view is offered as a module-view panel, with its title, even before the module is enabled", async (t) => {
  const s = await setup(t);
  const st = await s.service.state(s.key);
  const offer = st.available.find((a) => a.module === MOD);
  assert.equal(offer.kind, "module-view");
  assert.equal(offer.panel, "view-adder-view");
  assert.equal(offer.title, "加法器");
  assert.equal(offer.enabled, false);
  assert.deepEqual(offer.capabilities, ["set"]);
});

test("opening needs the module enabled, records which view the panel shows, and never enables or grants anything", async (t) => {
  const s = await setup(t);
  await assert.rejects(s.service.apply(s.key, { ops: [{ op: "open-panel", module: MOD, panel: "view-adder-view" }] }), /enables it in the Store first/);
  assert.equal(s.h.registry.get(MOD).record.state !== "enabled", true, "opening did not enable it");
  await s.enable();
  const st = await s.service.apply(s.key, { ops: [{ op: "open-panel", module: MOD, panel: "view-adder-view" }] });
  const p = st.panels.find((x) => x.kind === "module-view");
  assert.equal(p.view, "adder-view");
  assert.equal(p.module, MOD);
  assert.match(p.panelId, /^p:view-adder-view\d$/);
});

test("the state for the widget carries the view's contract and the bound instance: explicit, else the latest", async (t) => {
  const s = await setup(t);
  await s.enable();
  const first = await s.make({ a: false, sum: 0 });
  await new Promise((r) => setTimeout(r, 5));
  const second = await s.make({ a: true, sum: 1 });
  let st = await s.service.apply(s.key, { ops: [{ op: "open-panel", module: MOD, panel: "view-adder-view" }] });
  let views = await moduleViewsOf({ view: st, registry: s.h.registry, models: s.h.models });
  const only = Object.values(views)[0];
  assert.equal(only.bound.adder, second.id, "no binding: the latest instance");
  assert.equal(only.instances.adder.length, 2);
  assert.deepEqual(only.reads, ["adder"]);
  assert.deepEqual(only.actions, ["set"]);
  assert.equal(only.renderer.type, "declarative");
  assert.equal(only.renderer.payload.root.type, "stack");
  // An explicit binding at open time wins, and is checked.
  st = await s.service.apply(s.key, { ops: [{ op: "open-panel", module: MOD, panel: "view-adder-view", models: { adder: first.id } }] });
  views = await moduleViewsOf({ view: st, registry: s.h.registry, models: s.h.models });
  const bound = Object.entries(views).find(([, v]) => v.bound.adder === first.id);
  assert.ok(bound, "the second panel shows the instance it was bound to");
  await assert.rejects(s.service.apply(s.key, { ops: [{ op: "open-panel", module: MOD, panel: "view-adder-view", models: { adder: "md:000000000000" }, }] }), /no adder instance/);
  await assert.rejects(s.service.apply(s.key, { ops: [{ op: "open-panel", module: MOD, panel: "view-adder-view", models: { other: first.id } }] }), /does not read other/);
});

test("a disabled module keeps its panel and its instances; a removed view leaves an inert marker, never a crash", async (t) => {
  const s = await setup(t);
  await s.enable();
  const inst = await s.make({ a: false, sum: 0 });
  let st = await s.service.apply(s.key, { ops: [{ op: "open-panel", module: MOD, panel: "view-adder-view" }] });
  const p = (await s.service.state(s.key)).panels.find((x) => x.kind === "module-view");
  const dis = await s.h.lifecycle.prepare("disable", MOD); await s.h.lifecycle.commit(dis.planId, { consent: dis.consent });
  st = await s.service.state(s.key);
  assert.equal(st.panels.find((x) => x.panelId === p.panelId).moduleState, "disabled");
  const views = await moduleViewsOf({ view: st, registry: s.h.registry, models: s.h.models });
  assert.equal(views[p.panelId].bound.adder, inst.id, "the data is still there");
  const ghost = { ...st, panels: [{ ...p, open: true, view: "gone" }] };
  assert.equal((await moduleViewsOf({ view: ghost, registry: s.h.registry, models: s.h.models }))[p.panelId].unavailable, "no-view");
  const none = { ...st, panels: [{ ...p, open: true, module: "org.example.removed" }] };
  assert.equal((await moduleViewsOf({ view: none, registry: s.h.registry, models: s.h.models }))[p.panelId].unavailable, "no-module");
});
