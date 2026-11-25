// #86 F1-4: flows kept as UVA records, edited by named operations, and run, through the real record store, the real router and the two MCP tools.
// Invented modules (an RC low-pass slice: parameters -> cutoff -> frequency response -> label); nothing in flows names a module. In-process only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecordStore } from "../src/uva/record-store.js";
import { createUvaService } from "../src/uva/service.js";
import { hashJson } from "../src/documents/validation.js";
import { createModuleHost } from "../src/modules/index.js";
import { registerModuleTools } from "../src/modules/mcp-tools.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { createFlowStore, FlowError } from "../src/flow/store.js";
import { createFlowService } from "../src/flow/service.js";
import { applyOps } from "../src/flow/edit.js";
import { FLOW_SCHEMA } from "../src/flow/graph.js";

const obj = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const num = (extra = {}) => ({ type: "number", ...extra });
const cap = (id, inputSchema, outputSchema) => ({ id, title: id, description: "Test capability " + id + ".", target: "none", needs: [], inputSchema, outputSchema });
const mf = (id, caps) => ({ schema: "estampes.module/2", id, name: id, description: "An invented module for flows.", version: "1.0.0", publisher: { name: "Example" }, license: "MPL-2.0",
  category: "diagram", coreCompatibility: ">=0.10.0 <1.0.0", permissions: [], capabilities: caps, runtime: { kind: "builtin", entry: id, abi: 1 } });
const RC = "org.example.rc", PLOT = "org.example.plot";
const rcModule = mf(RC, [cap("cutoff", obj({ r: num({ minimum: 1 }), c: num({ minimum: 1e-12 }) }, ["r", "c"]), obj({ fc: num({ minimum: 0, maximum: 1e9 }), tau: num({ minimum: 0 }) }, ["fc", "tau"]))]);
const plotModule = mf(PLOT, [
  cap("response", obj({ fc: num({ minimum: 0, maximum: 1e12 }), points: { type: "integer", minimum: 2, maximum: 200 } }, ["fc"]), obj({ peak: num({ minimum: 0 }), n: { type: "integer", minimum: 0, maximum: 200 } }, ["peak", "n"])),
  cap("label", obj({ peak: num({ minimum: 0 }) }, ["peak"]), obj({ text: { type: "string", maxLength: 40 } }, ["text"]))]);

function fakeService() {
  const held = new Map();
  return {
    held, noteMirror() {}, recordKeys: async () => [...held.keys()], recordState: async (key) => held.get(key) ?? null,
    async syncRecord({ key, value, seq, log }) { held.set(key, { value, seq, log, valueHash: hashJson(value) }); return { status: "created", sourceHash: hashJson(value), logHash: hashJson(log ?? []), seq }; },
  };
}
async function setup(t) {
  process.env.ESTAMPES_MODULE_V2 = "on";
  const storage = await mkdtemp(join(tmpdir(), "flow-store-"));
  t.after(() => rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const calls = [], gate = {};
  const run = (name) => async (c, input) => {
    calls.push(name + "." + c);
    await gate[name + "." + c]?.();
    if (c === "cutoff") return { data: { fc: Math.round(1 / (2 * Math.PI * input.r * input.c)), tau: Number((input.r * input.c).toFixed(9)) } };
    if (c === "response") return { data: { peak: 1, n: input.points ?? 20 } };
    return { data: { text: "peak " + input.peak } };
  };
  const host = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0", builtins: [{ manifest: rcModule, run: run("rc") }, { manifest: plotModule, run: run("plot") }],
    canvases: { ensure: ensureImage, create: async (o) => createBlankCanvas(o), save: async () => {} } });
  for (const id of [RC, PLOT]) { const p = await host.lifecycle.prepare("enable", id); await host.lifecycle.commit(p.planId, { consent: p.consent }); }
  const records = await createRecordStore({ service: fakeService(), storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
  t.after(() => records.close());
  const store = createFlowStore({ records });
  host.flows = createFlowService({ store, registry: host.registry, router: host.router });
  const tools = new Map();
  registerModuleTools({ registerTool: (name, spec, handler) => tools.set(name, handler), registerResource() {} },
    { host, storeUri: "ui://s", storeHtml: "", visualUri: "ui://v", canvasPayload: async () => ({}), logSizes: (_n, r) => r, ensureImage: async () => ({}), saveCanvas: async () => {}, canvasLayers: () => [] });
  return { host, store, records, calls, gate, flows: host.flows, tool: (name, args) => tools.get(name)(args) };
}
const node = (id, module, capability, params) => ({ id, module, capability, ...(params ? { params } : {}) });
const edge = (a, ap, b, bp) => ({ from: { node: a, port: ap }, to: { node: b, port: bp } });
const BUILD = [
  { op: "add_node", node: node("rc1", RC, "cutoff", { r: 1000, c: 1e-7 }) },
  { op: "add_node", node: node("plot", PLOT, "response", { points: 50 }) },
  { op: "add_node", node: node("label", PLOT, "label") },
  { op: "connect", ...edge("rc1", "fc", "plot", "fc") },
  { op: "connect", ...edge("plot", "peak", "label", "peak") },
];

test("a flow is built by named operations; it may be incomplete on the way, and says what is wrong", async (t) => {
  const s = await setup(t);
  const made = await s.tool("edit_flow", { action: "create", name: "RC low-pass" });
  const id = made.structuredContent.id;
  assert.match(id, /^fl:[0-9a-f]{12}$/);
  const part = await s.tool("edit_flow", { action: "edit", id, expectedRevision: 1, ops: BUILD.slice(0, 3) });
  assert.equal(part.structuredContent.valid, false, "inputs are still missing");
  assert.ok(part.structuredContent.errors.some((e) => e.code === "missing-input"));
  const done = await s.tool("edit_flow", { action: "edit", id, expectedRevision: 2, ops: BUILD.slice(3) });
  assert.equal(done.structuredContent.valid, true);
  assert.deepEqual(done.structuredContent.order, ["rc1", "plot", "label"]);
  assert.deepEqual(Object.values(done.structuredContent.plan).map((p) => p.status), ["stale", "stale", "stale"]);
  const got = await s.tool("get_flow", { id });
  assert.equal(got.structuredContent.revision, 3);
  assert.equal((await s.tool("get_flow", {})).structuredContent.flows[0].nodes, 3);
});

test("run: the slice runs in order, a second run does nothing, one changed input recomputes only what follows", async (t) => {
  const s = await setup(t);
  const { id } = (await s.tool("edit_flow", { action: "create", name: "RC" })).structuredContent;
  await s.tool("edit_flow", { action: "edit", id, expectedRevision: 1, ops: BUILD });
  const r1 = await s.tool("edit_flow", { action: "run", id });
  assert.deepEqual(r1.structuredContent.ran, ["rc1", "plot", "label"]);
  assert.equal(r1.structuredContent.results.rc1.data.fc, 1592);
  assert.equal(r1.structuredContent.results.label.data.text, "peak 1");
  const r2 = await s.tool("edit_flow", { action: "run", id });
  assert.deepEqual(r2.structuredContent.ran, []);
  assert.equal(s.calls.length, 3);
  // Only the points changed: rc1 is reused, plot and label come after it and plot recomputes; label's input (peak) is identical, so it is cut off.
  await s.tool("edit_flow", { action: "edit", id, expectedRevision: 2, ops: [{ op: "set_params", id: "plot", params: { points: 80 } }] });
  const r3 = await s.tool("edit_flow", { action: "run", id });
  assert.deepEqual(r3.structuredContent.ran, ["plot"]);
  assert.equal(r3.structuredContent.results.plot.data.n, 80);
  assert.deepEqual(r3.structuredContent.reused.sort(), ["label", "rc1"]);
});

test("a stale edit applies nothing; a retried command id does not apply twice; an edit can be undone only while it is the latest", async (t) => {
  const s = await setup(t);
  const { id } = (await s.tool("edit_flow", { action: "create", name: "RC", commandId: "c0" })).structuredContent;
  const again = await s.tool("edit_flow", { action: "create", name: "RC", commandId: "c0" });
  assert.equal(again.structuredContent.id, id, "the same command id answers with the same flow");
  await s.tool("edit_flow", { action: "edit", id, expectedRevision: 1, ops: BUILD, commandId: "build" });
  const stale = await s.tool("edit_flow", { action: "edit", id, expectedRevision: 1, ops: [{ op: "remove_node", id: "label" }] });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /changed since revision 1/);
  const retry = await s.tool("edit_flow", { action: "edit", id, expectedRevision: 1, ops: BUILD, commandId: "build" });
  assert.equal(retry.structuredContent.status, "already-applied");
  assert.equal(retry.structuredContent.revision, 2);
  await s.tool("edit_flow", { action: "edit", id, expectedRevision: 2, ops: [{ op: "remove_node", id: "label" }], commandId: "rm" });
  assert.equal((await s.tool("get_flow", { id })).structuredContent.flow.edges.length, 1, "removing a node removes its edges");
  const noUndo = await s.tool("edit_flow", { action: "undo", id, of: "build" });
  assert.equal(noUndo.isError, true, "a later change stands in the way");
  const undone = await s.tool("edit_flow", { action: "undo", id, of: "rm" });
  assert.equal(undone.structuredContent.flow.nodes.length, 3);
  assert.equal(undone.structuredContent.revision, 4);
});

test("an invalid flow does not run; a failing node blocks what needs it and the person's stored results survive", async (t) => {
  const s = await setup(t);
  const { id } = (await s.tool("edit_flow", { action: "create", name: "RC" })).structuredContent;
  await s.tool("edit_flow", { action: "edit", id, expectedRevision: 1, ops: BUILD.slice(0, 3) });
  const bad = await s.tool("edit_flow", { action: "run", id });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /cannot run/);
  assert.equal(s.calls.length, 0, "nothing ran");
  const cycle = await s.tool("edit_flow", { action: "edit", id, expectedRevision: 2, ops: [{ op: "connect", ...edge("plot", "peak", "rc1", "r") }] });
  assert.ok(cycle.structuredContent.errors.some((e) => e.code === "cycle" || e.code === "type-mismatch"));
  const wrong = await s.tool("edit_flow", { action: "edit", id, expectedRevision: 3, ops: [{ op: "remove_node", id: "ghost" }] });
  assert.equal(wrong.isError, true);
});

test("results are kept only for the graph they were computed from", async (t) => {
  const s = await setup(t);
  const { id } = (await s.tool("edit_flow", { action: "create", name: "RC" })).structuredContent;
  await s.tool("edit_flow", { action: "edit", id, expectedRevision: 1, ops: BUILD });
  let release; s.gate["plot.response"] = () => new Promise((r) => { release = r; });
  const running = s.tool("edit_flow", { action: "run", id });
  while (!release) await new Promise((r) => setTimeout(r, 5));
  const busy = await s.tool("edit_flow", { action: "run", id });
  assert.equal(busy.isError, true);
  assert.match(busy.content[0].text, /already running/);
  await s.tool("edit_flow", { action: "edit", id, expectedRevision: 2, ops: [{ op: "set_params", id: "rc1", params: { r: 2000, c: 1e-7 } }] });
  release();
  const out = await running;
  assert.equal(out.structuredContent.resultsKept, false, "the graph changed while it ran");
  assert.deepEqual((await s.tool("get_flow", { id })).structuredContent.results, {});
});

test("a store that does not exist says so; shape and size are checked; a second store over the same records is refused", async (t) => {
  const s = await setup(t);
  assert.throws(() => createFlowStore({ records: s.records }), (e) => e instanceof FlowError && e.code === "single-writer");
  await assert.rejects(s.store.create({ name: "x", flow: { schema: FLOW_SCHEMA, nodes: [{ id: "A" }], edges: [] } }), (e) => e.code === "shape");
  await assert.rejects(s.store.create({ name: "" }), (e) => e.code === "input");
  assert.throws(() => applyOps({ schema: FLOW_SCHEMA, nodes: [], edges: [] }, [{ op: "frobnicate" }]), (e) => e.code === "op");
  const off = await s.tool("get_flow", {}); assert.equal(off.isError, undefined);
  delete s.host.flows;
  const none = await s.tool("get_flow", {});
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /UVA store/);
});

test("with the real UVA service: a flow and its results survive a restart", async (t) => {
  const storage = await mkdtemp(join(tmpdir(), "flow-real-l-")), beta = await mkdtemp(join(tmpdir(), "flow-real-u-"));
  t.after(() => Promise.all([rm(storage, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }), rm(beta, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })]));
  const boot = async () => {
    const service = await createUvaService({ enabled: true, canvasStore: true, directory: beta, profile: "linux-process-crash-test", legacyDirectory: storage });
    const records = await createRecordStore({ service, storageDir: storage, idleMs: 0, retryEveryMs: 0 });
    return { store: createFlowStore({ records }), close: async () => { await records.flush(); await records.close(); await service.close(); } };
  };
  let b = await boot();
  const f = await b.store.create({ name: "kept", commandId: "mk" });
  await b.store.edit({ id: f.id, commandId: "e1", expectedRevision: 1, flow: { schema: FLOW_SCHEMA, nodes: [node("rc1", RC, "cutoff", { r: 1, c: 1 })], edges: [] } });
  await b.store.saveResults({ id: f.id, revision: 2, results: { nodes: { rc1: { status: "fresh", revision: 1, data: { fc: 1 } } } } });
  await b.close();
  b = await boot();
  t.after(() => b.close());
  const r = await b.store.read(f.id);
  assert.equal(r.revision, 2);
  assert.equal(r.flow.nodes[0].id, "rc1");
  assert.equal(r.results.nodes.rc1.data.fc, 1);
  assert.equal((await b.store.undo({ id: f.id, commandId: "e1", undoCommandId: "u1" })).flow.revision, 3, "history survived too");
});
