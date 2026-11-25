// #86 F2: the Flow module (the Flow view's own access to flows) through the real router: a person's edit and run, the way the view calls them.
// Invented modules for the nodes (RC low-pass slice); in-process only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecordStore } from "../src/uva/record-store.js";
import { createModuleHost } from "../src/modules/index.js";
import { validateManifest } from "../src/modules/manifest.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { createFlowStore } from "../src/flow/store.js";
import { createFlowService } from "../src/flow/service.js";
import * as flowModule from "../src/builtin-modules/flow/index.js";
import { hashJson } from "../src/documents/validation.js";

const obj = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const num = (extra = {}) => ({ type: "number", ...extra });
const cap = (id, inputSchema, outputSchema) => ({ id, title: id, description: "Test capability " + id + ".", target: "none", needs: [], inputSchema, outputSchema });
const mf = (id, caps) => ({ schema: "estampes.module/2", id, name: id, description: "An invented module for flows.", version: "1.0.0", publisher: { name: "Example" }, license: "MPL-2.0",
  category: "diagram", coreCompatibility: ">=0.10.0 <1.0.0", permissions: [], capabilities: caps, runtime: { kind: "builtin", entry: id, abi: 1 } });
const RC = "org.example.rc", FLOW = "org.estampes.flow";
const rcModule = mf(RC, [cap("cutoff", obj({ r: num({ minimum: 1 }), c: num({ minimum: 1e-12 }) }, ["r", "c"]), obj({ fc: num({ minimum: 0, maximum: 1e9 }) }, ["fc"]))]);

function fakeService() {
  const held = new Map();
  return { held, noteMirror() {}, recordKeys: async () => [...held.keys()], recordState: async (key) => held.get(key) ?? null,
    async syncRecord({ key, value, seq, log }) { held.set(key, { value, seq, log, valueHash: hashJson(value) }); return { status: "created", sourceHash: hashJson(value), logHash: hashJson(log ?? []), seq }; } };
}
async function setup(t) {
  const storage = await mkdtemp(join(tmpdir(), "flow-module-"));
  t.after(() => rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const host = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0",
    builtins: [{ manifest: rcModule, run: async (_c, i) => ({ data: { fc: Math.round(1 / (2 * Math.PI * i.r * i.c)) } }) }, { manifest: flowModule.manifest, run: flowModule.run, init: flowModule.init }],
    canvases: { ensure: ensureImage, create: async (o) => createBlankCanvas(o), save: async () => {} } });
  for (const id of [RC, FLOW]) { const p = await host.lifecycle.prepare("enable", id); await host.lifecycle.commit(p.planId, { consent: p.consent }); }
  const records = await createRecordStore({ service: fakeService(), storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
  t.after(() => records.close());
  host.flows = createFlowService({ store: createFlowStore({ records }), registry: host.registry, router: host.router });
  await host.initBuiltins({ flows: () => host.flows ?? null });
  const call = async (capability, params) => (await host.router.execute({ module: FLOW, capability, params })).data;
  return { host, call };
}

test("the Flow module's manifest is valid and declares the flow-graph view over its own capabilities", () => {
  const m = validateManifest(flowModule.manifest, { coreVersion: "0.10.0", v2: true, builtin: true });
  assert.equal(m.views[0].renderer.type, "flow-graph");
  assert.deepEqual(Object.keys(m.views[0].renderer.payload.actions).sort(), ["create", "edit", "get", "list", "run", "undo"]);
  const bad = structuredClone(flowModule.manifest);
  bad.views[0].renderer.payload.actions.run = "flow_nope";
  assert.throws(() => validateManifest(bad, { coreVersion: "0.10.0", v2: true, builtin: true }), /payload\.actions\.run must name one of the view's actions/);
  bad.views[0].renderer.payload = { actions: flowModule.manifest.views[0].renderer.payload.actions, extra: 1 };
  assert.throws(() => validateManifest(bad, { coreVersion: "0.10.0", v2: true, builtin: true }), /payload\.extra/);
});

test("create, edit with literal inputs, run, change an input, undo: the way the view does it", async (t) => {
  const { call } = await setup(t);
  assert.deepEqual((await call("flow_list", {})).flows, []);
  const made = await call("flow_create", { name: "RC" });
  assert.match(made.id, /^fl:[0-9a-f]{12}$/);
  const built = await call("flow_edit", { id: made.id, expectedRevision: 1, ops: [{ op: "add_node", node: { id: "rc1", module: RC, capability: "cutoff", paramsJson: '{"r":1000,"c":1e-7}' } }] });
  assert.equal(built.valid, true);
  assert.deepEqual(built.flow.nodes[0].params, { r: 1000, c: 1e-7 });
  assert.match(built.commandId, /^cmd_/);
  const ran = await call("flow_run", { id: made.id });
  assert.deepEqual(ran.ran, ["rc1"]);
  assert.equal(ran.results.rc1.data.fc, 1592);
  const changed = await call("flow_edit", { id: made.id, expectedRevision: 2, ops: [{ op: "set_params", id: "rc1", paramsJson: '{"r":2000,"c":1e-7}' }] });
  assert.equal(changed.plan.rc1.status, "stale");
  const undone = await call("flow_undo", { id: made.id, of: changed.commandId });
  assert.deepEqual(undone.flow.nodes[0].params, { r: 1000, c: 1e-7 });
  assert.equal(undone.plan.rc1.status, "fresh", "back to inputs it already has an answer for");
  assert.equal((await call("flow_get", { id: made.id })).revision, 4);
  assert.equal((await call("flow_list", {})).flows[0].nodes, 1);
});

test("a stale edit, a bad paramsJson and a missing store each say so and change nothing", async (t) => {
  const { host, call } = await setup(t);
  const { id } = await call("flow_create", { name: "RC" });
  await assert.rejects(call("flow_edit", { id, expectedRevision: 9, ops: [{ op: "remove_node", id: "x" }] }), /changed since revision 9|no node x/);
  await assert.rejects(call("flow_edit", { id, expectedRevision: 1, ops: [{ op: "add_node", node: { id: "a", module: RC, capability: "cutoff", paramsJson: "[1]" } }] }), /must be a JSON object/);
  await assert.rejects(call("flow_edit", { id, expectedRevision: 1, ops: [{ op: "add_node", node: { id: "a", module: RC, capability: "cutoff", paramsJson: "{" } }] }), /not JSON/);
  assert.equal((await call("flow_get", { id })).revision, 1);
  delete host.flows;
  await assert.rejects(call("flow_list", {}), /UVA store/);
});
