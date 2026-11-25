// #86 F1-2: the Flow graph and its static checks, over invented modules (an RC low-pass: parameters -> cutoff -> response samples). Nothing runs.
import test from "node:test";
import assert from "node:assert/strict";
import { FLOW_SCHEMA, checkShape, validateFlow, order, describeNode, LIMITS } from "../src/flow/graph.js";

const obj = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const num = (extra = {}) => ({ type: "number", ...extra });
const cap = (id, input, output, extra = {}) => ({ id, title: id, description: id, target: "none", needs: [], inputSchema: input, ...(extra) });
const mod = (id, caps, outputs = {}) => ({ manifest: { id, version: "1.0.0", capabilities: caps, v2: { abi: 1, targets: Object.fromEntries(caps.map((c) => [c.id, c.target])), outputs } } });
const RC = "org.example.rc", PLOT = "org.example.plot";
const registry = (() => {
  const mods = new Map([
    [RC, mod(RC, [cap("cutoff", obj({ r: num({ minimum: 1 }), c: num({ minimum: 1e-12 }) }, ["r", "c"])), cap("untyped", obj({ x: num() }))], { cutoff: obj({ fc: num({ minimum: 0, maximum: 1e9 }), tau: num({ minimum: 0 }) }, ["fc", "tau"]) })],
    [PLOT, mod(PLOT, [cap("response", obj({ fc: num({ minimum: 0, maximum: 1e12 }), points: { type: "integer", minimum: 2, maximum: 200 } }, ["fc"])), cap("onpage", obj({ v: num() }), null, { target: "document" })], {})],
  ]);
  return { get: (id) => mods.get(id) };
})();
const node = (id, module, capability, params) => ({ id, module, capability, ...(params ? { params } : {}) });
const edge = (a, ap, b, bp) => ({ from: { node: a, port: ap }, to: { node: b, port: bp } });
const flow = (nodes, edges = []) => ({ schema: FLOW_SCHEMA, nodes, edges });
const good = () => flow([node("rc1", RC, "cutoff", { r: 1000, c: 1e-7 }), node("plot", PLOT, "response", { points: 50 })], [edge("rc1", "fc", "plot", "fc")]);
const codes = (r) => r.errors.map((e) => e.code);

test("a well formed, typed, acyclic flow is accepted and gets a run order", () => {
  const r = validateFlow(good(), registry);
  assert.deepEqual([r.ok, r.order], [true, ["rc1", "plot"]]);
  assert.equal(describeNode(registry, { module: RC, capability: "cutoff" }).outputSchema.required[0], "fc");
  assert.equal(describeNode(registry, { module: RC, capability: "nope" }), null);
});

test("the shape is checked without any module: ids, limits, edges to nodes that exist", () => {
  assert.ok(checkShape(null).length);
  assert.ok(checkShape({ ...good(), schema: "x" }).length);
  assert.equal(codes({ errors: checkShape(flow([node("A!", RC, "cutoff")])) })[0], "shape");
  assert.equal(codes({ errors: checkShape(flow([node("a", RC, "cutoff"), node("a", RC, "cutoff")])) })[0], "duplicate");
  assert.equal(codes({ errors: checkShape(flow([node("a", RC, "cutoff")], [edge("a", "fc", "ghost", "fc")])) })[0], "unknown-node");
  const many = flow(Array.from({ length: LIMITS.nodes + 1 }, (_, i) => node("n" + i, RC, "cutoff")));
  assert.equal(codes({ errors: checkShape(many) })[0], "limit");
  assert.equal(validateFlow(many, registry).ok, false);
});

test("modules and capabilities must exist, run without a document, and answer at once", () => {
  assert.deepEqual(codes(validateFlow(flow([node("a", "org.example.gone", "x")]), registry)), ["unknown-capability"]);
  assert.deepEqual(codes(validateFlow(flow([node("a", PLOT, "onpage", { v: 1 })]), registry)), ["unsupported-target"]);
});

test("literals are checked against the input's own schema, and unknown inputs are named", () => {
  const r = validateFlow(flow([node("rc1", RC, "cutoff", { r: 0, c: 1e-7, z: 1 })]), registry);
  assert.deepEqual(codes(r).sort(), ["bad-literal", "unknown-input"]);
});

test("an edge needs a typed upstream, real ports, compatible types, one feeder per input, and no literal beside it", () => {
  const base = (edges, nodes = good().nodes) => validateFlow(flow(nodes, edges), registry);
  assert.deepEqual(codes(base([edge("rc1", "fc", "plot", "fc"), edge("rc1", "tau", "plot", "fc")])).sort(), ["input-fed-twice", "type-mismatch"], "tau has no upper bound, so it does not fit");
  assert.ok(codes(base([edge("rc1", "nope", "plot", "fc")])).includes("unknown-output"));
  assert.ok(codes(base([edge("rc1", "fc", "plot", "nope")])).includes("unknown-input"));
  const untyped = [node("u", RC, "untyped", { x: 1 }), node("plot", PLOT, "response", { points: 5 })];
  assert.ok(codes(base([edge("u", "x", "plot", "fc")], untyped)).includes("untyped-upstream"));
  assert.ok(codes(base([edge("rc1", "fc", "plot", "points")])).includes("type-mismatch"), "a number cannot feed an integer");
  const both = [node("rc1", RC, "cutoff", { r: 1, c: 1 }), node("plot", PLOT, "response", { fc: 5 })];
  assert.ok(codes(base([edge("rc1", "fc", "plot", "fc")], both)).includes("literal-and-edge"));
  // fc here can be 0..1e9 and the plot accepts up to 1e12: fits; the reverse range would not.
  assert.equal(base([edge("rc1", "fc", "plot", "fc")]).ok, true);
});

test("required inputs must be supplied by a literal or an edge", () => {
  const r = validateFlow(flow([node("rc1", RC, "cutoff", { r: 1000 }), node("plot", PLOT, "response")], [edge("rc1", "fc", "plot", "fc")]), registry);
  assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [["missing-input", "nodes[0]"]]);
  assert.match(r.errors[0].message, /needs c/);
});

test("a loop is refused and the nodes on it are named; a self edge is its own error", () => {
  const loop = flow([node("a", RC, "cutoff", { r: 1, c: 1 }), node("b", RC, "cutoff")], [edge("a", "fc", "b", "r"), edge("b", "fc", "a", "r")]);
  const r = validateFlow(loop, registry);
  assert.ok(codes(r).includes("cycle"));
  assert.match(r.errors.find((e) => e.code === "cycle").message, /a, b/);
  assert.ok(codes(validateFlow(flow([node("a", RC, "cutoff", { r: 1, c: 1 })], [edge("a", "fc", "a", "r")]), registry)).includes("self-edge"));
  assert.deepEqual(order(good()), { order: ["rc1", "plot"] });
  assert.deepEqual(order(loop).cycle.sort(), ["a", "b"]);
});

test("the order puts every node after the nodes that feed it, however the list is arranged", () => {
  const nodes = [node("c", RC, "cutoff"), node("b", RC, "cutoff"), node("a", RC, "cutoff", { r: 1, c: 1 })];
  const f = flow(nodes, [edge("a", "fc", "b", "r"), edge("b", "fc", "c", "r")]);
  assert.deepEqual(order(f).order, ["a", "b", "c"]);
});
