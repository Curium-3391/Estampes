// #86 F1-3: running a flow through the real router: dependency order, incremental recompute, early cutoff, failure and blocking, cancellation, a module
// that is switched off, and the plan that says what would run. Invented modules (RC low-pass slice); no storage, no MCP tool yet.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { FLOW_SCHEMA } from "../src/flow/graph.js";
import { runFlow, plan, emptyState } from "../src/flow/run.js";

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

async function setup(t) {
  process.env.ESTAMPES_MODULE_V2 = "on";
  const storage = await mkdtemp(join(tmpdir(), "flow-run-"));
  t.after(() => rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const calls = [], behave = {};
  const run = (name) => async (c, input) => {
    calls.push(name + "." + c);
    await behave[name + "." + c]?.(input);
    if (c === "cutoff") return { data: { fc: Math.round(1 / (2 * Math.PI * input.r * input.c)), tau: Number((input.r * input.c).toFixed(9)) } };
    if (c === "response") return { data: { peak: 1, n: input.points ?? 20 } };
    return { data: { text: "peak " + input.peak } };
  };
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0", builtins: [{ manifest: rcModule, run: run("rc") }, { manifest: plotModule, run: run("plot") }],
    canvases: { ensure: ensureImage, create: async (o) => createBlankCanvas(o), save: async () => {} } });
  for (const id of [RC, PLOT]) { const p = await h.lifecycle.prepare("enable", id); await h.lifecycle.commit(p.planId, { consent: p.consent }); }
  return { h, calls, behave, ctx: { router: h.router, registry: h.registry } };
}
const node = (id, module, capability, params) => ({ id, module, capability, ...(params ? { params } : {}) });
const edge = (a, ap, b, bp) => ({ from: { node: a, port: ap }, to: { node: b, port: bp } });
const flow = (r = 1000, c = 1e-7) => ({ schema: FLOW_SCHEMA, nodes: [node("label", PLOT, "label"), node("plot", PLOT, "response", { points: 50 }), node("rc1", RC, "cutoff", { r, c })],
  edges: [edge("rc1", "fc", "plot", "fc"), edge("plot", "peak", "label", "peak")] });

test("a run goes in dependency order, passes each result to the next node, and keeps results with what they came from", async (t) => {
  const s = await setup(t);
  const r = await runFlow({ flow: flow(), ...s.ctx });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ran, ["rc1", "plot", "label"]);
  assert.deepEqual(s.calls, ["rc.cutoff", "plot.response", "plot.label"]);
  assert.equal(r.state.nodes.rc1.data.fc, 1592);
  assert.equal(r.state.nodes.label.data.text, "peak 1");
  assert.deepEqual(Object.values(r.state.nodes).map((n) => [n.status, n.revision]), [["fresh", 1], ["fresh", 1], ["fresh", 1]]);
  assert.match(r.state.nodes.plot.inputsHash, /^[0-9a-f]{64}$/);
});

test("running again recomputes nothing; changing one input recomputes only what depends on it", async (t) => {
  const s = await setup(t);
  const first = await runFlow({ flow: flow(), ...s.ctx });
  s.calls.length = 0;
  const again = await runFlow({ flow: flow(), ...s.ctx, state: first.state });
  assert.deepEqual([again.ran, again.reused.sort()], [[], ["label", "plot", "rc1"]]);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(plan(flow(), s.h.registry, first.state).nodes, { rc1: { status: "fresh" }, plot: { status: "fresh" }, label: { status: "fresh" } });
  const p = plan(flow(2000), s.h.registry, first.state);
  assert.deepEqual(p.nodes, { rc1: { status: "stale" }, plot: { status: "stale", pending: "rc1" }, label: { status: "stale", pending: "plot" } }, "what follows a stale node waits for it (it may still turn out unchanged)");
  s.calls.length = 0;
  const changed = await runFlow({ flow: flow(2000), ...s.ctx, state: first.state });
  assert.deepEqual(changed.ran, ["rc1", "plot"], "plot gets a new fc; label's input (peak) did not change so it is reused");
  assert.deepEqual(changed.reused, ["label"], "early cutoff: an identical result does not wake what follows");
  assert.equal(changed.state.nodes.label.revision, 1);
  assert.equal(changed.state.nodes.rc1.revision, 2);
});

test("a result identical to the old one keeps its revision, so nothing after it recomputes", async (t) => {
  const s = await setup(t);
  const first = await runFlow({ flow: flow(1000, 1e-7), ...s.ctx });
  s.calls.length = 0;
  const swapped = await runFlow({ flow: flow(100, 1e-6), ...s.ctx, state: first.state });   // r*c is the same, so fc and tau are the same
  assert.deepEqual(swapped.ran, ["rc1"]);
  assert.deepEqual(swapped.reused, ["plot", "label"]);
  assert.equal(swapped.state.nodes.rc1.revision, 1, "same result, same revision");
});

test("a failing node leaves the nodes that need it blocked, keeps its last good data, and is retried next run", async (t) => {
  const s = await setup(t);
  const first = await runFlow({ flow: flow(), ...s.ctx });
  s.behave["rc.cutoff"] = () => { throw new Error("the solver fell over"); };
  const failed = await runFlow({ flow: flow(5000), ...s.ctx, state: first.state });
  assert.deepEqual([failed.ok, failed.failed, failed.blocked], [false, ["rc1"], ["plot", "label"]]);
  assert.match(failed.state.nodes.rc1.message, /solver fell over/);
  assert.equal(failed.state.nodes.rc1.data.fc > 0, true, "the last good result is still there to read");
  const back = await runFlow({ flow: flow(), ...s.ctx, state: failed.state });
  assert.deepEqual([back.ok, back.ran, back.reused], [true, [], ["rc1", "plot", "label"]], "going back to inputs it already has an answer for needs no run");
  s.calls.length = 0;
  assert.equal(failed.state.nodes.plot.status, "blocked");
  assert.equal(plan(flow(5000), s.h.registry, failed.state).nodes.plot.status, "blocked");
  delete s.behave["rc.cutoff"];
  const healed = await runFlow({ flow: flow(5000), ...s.ctx, state: failed.state });
  assert.deepEqual([healed.ok, healed.ran, healed.reused], [true, ["rc1", "plot"], ["label"]], "plot comes out the same, so label (blocked meanwhile) needs no run");
});

test("a result that breaks the declared outputSchema is a failure of that node, not data for the next", async (t) => {
  const s = await setup(t);
  s.behave["rc.cutoff"] = () => {};
  const bad = { ...flow(), nodes: flow().nodes.map((n) => (n.id === "rc1" ? { ...n, params: { r: 1, c: 1e-12 } } : n)) };   // fc = 1.59e11 > the declared maximum of 1e9
  const r = await runFlow({ flow: bad, ...s.ctx });
  assert.deepEqual([r.failed, r.state.nodes.rc1.code], [["rc1"], "output"]);
  assert.match(r.state.nodes.rc1.message, /outputSchema/);
});

test("a cancelled run keeps what it finished and says what it did not do", async (t) => {
  const s = await setup(t);
  const stop = new AbortController();
  s.behave["plot.response"] = () => stop.abort();
  const r = await runFlow({ flow: flow(), ...s.ctx, signal: stop.signal });
  assert.deepEqual([r.ok, r.ran, r.cancelled], [false, ["rc1", "plot"], ["label"]]);
  assert.equal(r.state.nodes.plot.status, "fresh");
  assert.equal(r.state.nodes.label, undefined);
  delete s.behave["plot.response"];
  const resumed = await runFlow({ flow: flow(), ...s.ctx, state: r.state });
  assert.deepEqual([resumed.ran, resumed.reused], [["label"], ["rc1", "plot"]]);
});

test("a module that is switched off fails its node with the router's own reason; an invalid flow runs nothing", async (t) => {
  const s = await setup(t);
  const p = await s.h.lifecycle.prepare("disable", PLOT); await s.h.lifecycle.commit(p.planId, { consent: p.consent });
  const r = await runFlow({ flow: flow(), ...s.ctx });
  assert.deepEqual([r.ran, r.failed, r.blocked], [["rc1"], ["plot"], ["label"]]);
  assert.ok(r.state.nodes.plot.message.length > 0);
  s.calls.length = 0;
  const loop = { schema: FLOW_SCHEMA, nodes: [node("a", RC, "cutoff", { r: 1, c: 1 }), node("b", RC, "cutoff")], edges: [edge("a", "fc", "b", "r"), edge("b", "fc", "a", "r")] };
  const invalid = await runFlow({ flow: loop, ...s.ctx });
  assert.deepEqual([invalid.ok, invalid.errors.some((e) => e.code === "cycle"), s.calls], [false, true, []]);
  assert.deepEqual(emptyState(), { nodes: {} });
});
