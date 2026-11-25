// Flow: the Flow view's own access to flows (#86 F2). The flows themselves live in src/flow/ and the record store; this module only exposes
// them as capabilities so a view can call them through execute_module with every check that has, like any other view's actions. The assistant
// uses the get_flow / edit_flow tools; these capabilities are not meant as steps of a flow (a flow that ran one would only find it busy).
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

let flows = () => null;
// Built-in hook (#174-4): the host gives the module a way to reach the flow service, which exists only when the UVA store runs.
export function init(context) { if (typeof context?.flows === "function") flows = context.flows; }

const need = () => { const f = flows(); if (!f) throw new Error("flows need the UVA store, which is not running; nothing was changed"); return f; };
// The input schema subset has no free-form object, so literal inputs arrive as JSON text.
const json = (text) => {
  let v;
  try { v = JSON.parse(text); } catch { throw new Error("paramsJson is not JSON"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("paramsJson must be a JSON object");
  return v;
};
const opOf = ({ paramsJson, node, ...op }) => ({ ...op, ...(node ? { node: (({ paramsJson: pj, ...n }) => ({ ...n, ...(pj !== undefined ? { params: json(pj) } : {}) }))(node) } : {}), ...(paramsJson !== undefined ? { params: json(paramsJson) } : {}) });
const cmd = (given) => given ?? "cmd_" + randomBytes(8).toString("hex");

export async function run(capability, p) {
  const f = need();
  switch (capability) {
    case "flow_list": { const list = await f.list(); return { data: { flows: list }, summary: list.length + " flow(s)" }; }
    case "flow_get": return { data: await f.get(p.id, { brief: true }) };
    case "flow_create": return { data: await f.create({ name: p.name, commandId: cmd(p.commandId), by: "person" }) };
    case "flow_edit": { const id = cmd(p.commandId); return { data: { commandId: id, ...(await f.edit({ id: p.id, expectedRevision: p.expectedRevision, commandId: id, ops: p.ops.map(opOf), by: "person", brief: true })) } }; }
    case "flow_undo": return { data: await f.undo({ id: p.id, commandId: p.of, undoCommandId: cmd(p.commandId), by: "person", brief: true }) };
    case "flow_run": return { data: await f.run({ id: p.id, brief: true }) };
    default: throw new Error("unknown capability " + capability);
  }
}
