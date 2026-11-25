// #86 F1-4: the edits a person or an assistant makes to a flow graph, as small named operations over the graph (not whole-graph replacement), so
// a change says what it means and a stale edit fails as a whole. Pure: it returns a new graph and never looks at a module; `validateFlow` judges the
// result. An operation that cannot apply (no such node, a node id used twice) refuses the whole edit.
import { FlowError } from "./store.js";
import { clone } from "../records/revisioned.js";

export const MAX_OPS = 50;
export const OP_NAMES = ["add_node", "remove_node", "set_params", "connect", "disconnect"];

const same = (a, b) => a.from.node === b.from.node && a.from.port === b.from.port && a.to.node === b.to.node && a.to.port === b.to.port;
const ref = (r) => ({ node: r?.node, port: r?.port });

export function applyOps(flow, ops) {
  if (!Array.isArray(ops) || !ops.length) throw new FlowError("an edit needs at least one operation", "input");
  if (ops.length > MAX_OPS) throw new FlowError("at most " + MAX_OPS + " operations in one edit", "limit");
  const g = clone(flow);
  ops.forEach((op, i) => {
    const at = "ops[" + i + "] (" + op?.op + ")", fail = (m, code = "op") => { throw new FlowError(at + ": " + m, code, { index: i }); };
    const node = (id) => g.nodes.find((n) => n.id === id) ?? fail("no node " + id);
    switch (op?.op) {
      case "add_node": {
        const n = op.node;
        if (!n || typeof n !== "object") fail("a node is { id, module, capability, params? }");
        if (g.nodes.some((x) => x.id === n.id)) fail("node " + n.id + " already exists");
        g.nodes.push({ id: n.id, module: n.module, capability: n.capability, ...(n.params ? { params: n.params } : {}) });
        break;
      }
      case "remove_node": node(op.id); g.nodes = g.nodes.filter((n) => n.id !== op.id); g.edges = g.edges.filter((e) => e.from.node !== op.id && e.to.node !== op.id); break;
      case "set_params": { const n = node(op.id); if (op.params && Object.keys(op.params).length) n.params = op.params; else delete n.params; break; }
      case "connect": {
        const e = { from: ref(op.from), to: ref(op.to) };
        if (g.edges.some((x) => same(x, e))) fail("that connection already exists");
        g.edges.push(e);
        break;
      }
      case "disconnect": {
        const e = { from: ref(op.from), to: ref(op.to) };
        if (!g.edges.some((x) => same(x, e))) fail("no such connection");
        g.edges = g.edges.filter((x) => !same(x, e));
        break;
      }
      default: fail("unknown operation; use one of " + OP_NAMES.join(", "));
    }
  });
  return g;
}
