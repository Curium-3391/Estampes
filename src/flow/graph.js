// #86 F1-2: the Flow graph (`estampes.flow/1`) and its static checks. A Flow is nodes (one module capability each, with literal inputs) and
// edges (one node's output field into another node's input field). Nothing here runs a capability or stores anything: it answers "is this graph
// well formed, type correct and acyclic, and in what order would it run". It names no module; every fact about a node comes from the module's own
// manifest (its inputSchema, outputSchema and target) through the registry.
import { validateValue } from "../modules/json-schema.js";
import { assignable, outputPorts, inputPorts } from "../modules/schema-compat.js";

export const FLOW_SCHEMA = "estampes.flow/1";
export const LIMITS = { nodes: 64, edges: 256, paramBytes: 4096 };
const NODE_ID = /^[a-z][a-z0-9_-]{0,23}$/, PORT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MODULE_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/, CAPABILITY_ID = /^[a-z][a-z0-9_]{0,47}$/;

const err = (path, code, message) => ({ path, code, message });

// What a node's capability offers, read from the manifest: null when there is no such module or capability.
export function describeNode(registry, node) {
  const mod = registry.get(node.module);
  const cap = mod?.manifest.capabilities.find((c) => c.id === node.capability);
  if (!mod || !cap) return null;
  const m = mod.manifest;
  return { module: m.id, capability: cap.id, inputSchema: cap.inputSchema, outputSchema: m.v2?.outputs?.[cap.id] ?? null, target: m.v2?.targets?.[cap.id] ?? cap.target, async: !!cap.async };
}

// Checks the graph's shape without looking at any module (so a stored graph can be read even when a module is gone).
export function checkShape(flow) {
  const errors = [];
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) return [err("flow", "shape", "a flow is an object")];
  if (flow.schema !== FLOW_SCHEMA) errors.push(err("schema", "shape", "schema must be " + FLOW_SCHEMA));
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : null, edges = Array.isArray(flow.edges) ? flow.edges : null;
  if (!nodes) errors.push(err("nodes", "shape", "nodes must be a list"));
  if (!edges) errors.push(err("edges", "shape", "edges must be a list"));
  if (!nodes || !edges) return errors;
  if (nodes.length > LIMITS.nodes) errors.push(err("nodes", "limit", "at most " + LIMITS.nodes + " nodes"));
  if (edges.length > LIMITS.edges) errors.push(err("edges", "limit", "at most " + LIMITS.edges + " edges"));
  const ids = new Set();
  nodes.forEach((n, i) => {
    const p = "nodes[" + i + "]";
    if (!n || typeof n !== "object") return errors.push(err(p, "shape", "a node is an object"));
    if (typeof n.id !== "string" || !NODE_ID.test(n.id)) errors.push(err(p + ".id", "shape", "node ids are lowercase words like rc1"));
    else if (ids.has(n.id)) errors.push(err(p + ".id", "duplicate", "node id " + n.id + " is used twice"));
    else ids.add(n.id);
    if (typeof n.module !== "string" || !MODULE_ID.test(n.module)) errors.push(err(p + ".module", "shape", "a module id"));
    if (typeof n.capability !== "string" || !CAPABILITY_ID.test(n.capability)) errors.push(err(p + ".capability", "shape", "a capability id"));
    if (n.params !== undefined && (!n.params || typeof n.params !== "object" || Array.isArray(n.params))) errors.push(err(p + ".params", "shape", "params is an object of literal inputs"));
    else if (n.params && Buffer.byteLength(JSON.stringify(n.params)) > LIMITS.paramBytes) errors.push(err(p + ".params", "limit", "params are larger than " + LIMITS.paramBytes + " bytes"));
  });
  edges.forEach((e, i) => {
    const p = "edges[" + i + "]";
    for (const side of ["from", "to"]) {
      const s = e?.[side];
      if (!s || typeof s.node !== "string" || typeof s.port !== "string" || !PORT.test(s.port)) errors.push(err(p + "." + side, "shape", "{ node, port }"));
      else if (!ids.has(s.node)) errors.push(err(p + "." + side + ".node", "unknown-node", "no node " + s.node));
    }
  });
  return errors;
}

// The order the nodes could run in (every node after all that feed it), or the nodes that sit on or behind a cycle.
export function order(flow) {
  const ids = flow.nodes.map((n) => n.id), indeg = new Map(ids.map((id) => [id, 0])), out = new Map(ids.map((id) => [id, []]));
  for (const e of flow.edges) { if (!indeg.has(e.from.node) || !indeg.has(e.to.node)) continue; out.get(e.from.node).push(e.to.node); indeg.set(e.to.node, indeg.get(e.to.node) + 1); }
  const ready = ids.filter((id) => indeg.get(id) === 0), done = [];
  while (ready.length) {
    const id = ready.shift(); done.push(id);
    for (const next of out.get(id)) { indeg.set(next, indeg.get(next) - 1); if (indeg.get(next) === 0) ready.push(next); }
  }
  return done.length === ids.length ? { order: done } : { cycle: ids.filter((id) => !done.includes(id)) };
}

// Full check against the installed modules. Returns { ok, errors, order? }. Errors carry a path into the graph, a code and a sentence.
export function validateFlow(flow, registry) {
  const errors = checkShape(flow);
  if (errors.some((e) => e.code === "shape" || e.code === "limit")) return { ok: false, errors };
  const info = new Map();
  flow.nodes.forEach((n, i) => {
    const p = "nodes[" + i + "]", d = describeNode(registry, n);
    if (!d) return errors.push(err(p, "unknown-capability", n.module + " " + n.capability + " is not installed"));
    info.set(n.id, d);
    if (d.target !== "none") errors.push(err(p, "unsupported-target", n.capability + " works on a document; a flow can only run capabilities that need no document yet"));
    if (d.async) errors.push(err(p, "unsupported-async", n.capability + " runs as a background job; a flow runs capabilities that answer at once"));
    for (const [k, v] of Object.entries(n.params ?? {})) {
      const prop = d.inputSchema.properties?.[k];
      if (!prop) { errors.push(err(p + ".params." + k, "unknown-input", n.capability + " has no input " + k)); continue; }
      try { validateValue(prop, v, k); } catch (e) { errors.push(err(p + ".params." + k, "bad-literal", e.message)); }
    }
  });
  const fed = new Map();
  flow.edges.forEach((e, i) => {
    const p = "edges[" + i + "]", from = info.get(e.from.node), to = info.get(e.to.node);
    if (e.from.node === e.to.node) errors.push(err(p, "self-edge", "a node cannot feed itself"));
    if (!from || !to) return;
    const source = outputPorts(from.outputSchema).find((x) => x.name === e.from.port), target = inputPorts(to.inputSchema).find((x) => x.name === e.to.port);
    if (!from.outputSchema) return errors.push(err(p + ".from", "untyped-upstream", from.capability + " does not declare an outputSchema, so nothing can be connected to its results"));
    if (!source) return errors.push(err(p + ".from.port", "unknown-output", from.capability + " has no output " + e.from.port));
    if (!target) return errors.push(err(p + ".to.port", "unknown-input", to.capability + " has no input " + e.to.port));
    const key = e.to.node + "." + e.to.port;
    if (fed.has(key)) errors.push(err(p + ".to", "input-fed-twice", key + " is already fed by edge " + fed.get(key)));
    fed.set(key, i);
    const owner = flow.nodes.find((n) => n.id === e.to.node);
    if (owner.params && Object.hasOwn(owner.params, e.to.port)) errors.push(err(p + ".to", "literal-and-edge", key + " has a literal value and an edge"));
    const fit = assignable(source.schema, target.schema, e.from.node + "." + e.from.port);
    if (!fit.ok) errors.push(err(p, "type-mismatch", "cannot feed " + e.from.node + "." + e.from.port + " into " + key + ": " + fit.reason + " (" + fit.path + ")"));
    else if (!source.required && target.required) errors.push(err(p, "type-mismatch", e.from.node + "." + e.from.port + " is optional in the result but " + key + " needs it"));
  });
  flow.nodes.forEach((n, i) => {
    const d = info.get(n.id);
    if (!d) return;
    for (const port of inputPorts(d.inputSchema)) {
      if (port.required && !Object.hasOwn(n.params ?? {}, port.name) && !fed.has(n.id + "." + port.name)) errors.push(err("nodes[" + i + "]", "missing-input", n.id + " needs " + port.name + " (a literal or an edge)"));
    }
  });
  const sorted = order(flow);
  if (sorted.cycle) errors.push(err("edges", "cycle", "the nodes " + sorted.cycle.join(", ") + " feed each other in a loop; loops are not supported yet"));
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], order: sorted.order };
}
