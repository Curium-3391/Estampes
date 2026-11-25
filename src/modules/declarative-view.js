// #85 V2-1: the payload of the built-in `declarative` renderer (`estampes.renderer.declarative/1`).
//
// A declarative view is a small tree of fixed controls that the host draws itself: the module ships no script, markup or style, so
// sandboxing, keyboard and screen-reader behaviour, and the mobile layout are the host's. The tree says only WHAT to show and WHICH
// capability a control requests; it never carries code or an expression.
//
//   payload: { root: Node }                       ({} is allowed: a view with nothing to show yet)
//   Node:    stack   { children: [Node], direction?: "column" | "row" }
//            text    { text }
//            readout { label, model, path, format?: "text" | "bit" | "yes-no" }          shows one field of a model instance
//            toggle  { label, model, path, action, params? }                              a boolean field
//            number  { label, model, path, action, params?, min?, max?, step? }           a number field
//            select  { label, model, path, action, params?, options: [{ value, label }] } one of a few values
//            button  { label, action, params? }
//   `model` is one of the view's `reads`, `path` a JSON pointer into that model's schema (at most 4 plain segments, the leaf a scalar of
//   the control's kind), `action` one of the view's `actions` (a capability of the same module: running it is execute_module, with every
//   check that has). `params` are the capability's input: JSON scalars, or { "$": "value" | "instance" | "revision" } which the host fills in
//   with what the person entered, the id of the instance the view shows, and the revision it was read at.
// The same tree is checked again by the front end before it draws anything; this is the manifest-time check, so a bad tree is refused at install.
const MAX_NODES = 64, MAX_DEPTH = 5, MAX_CHILDREN = 24, MAX_OPTIONS = 16, MAX_PARAMS = 8;
const TYPES = new Set(["stack", "text", "readout", "toggle", "number", "select", "button"]);
const CONTROLS = new Set(["toggle", "number", "select", "button"]);
const SEGMENT = /^[A-Za-z0-9_-]{1,32}$/;
const MARKERS = new Set(["value", "instance", "revision"]);
const FORMATS = new Set(["text", "bit", "yes-no"]);
const KEYS = {
  stack: ["type", "children", "direction"], text: ["type", "text", "textI18n"],
  readout: ["type", "label", "labelI18n", "model", "path", "format"],
  toggle: ["type", "label", "labelI18n", "model", "path", "action", "params"],
  number: ["type", "label", "labelI18n", "model", "path", "action", "params", "min", "max", "step"],
  select: ["type", "label", "labelI18n", "model", "path", "action", "params", "options"],
  button: ["type", "label", "labelI18n", "action", "params"],
};

const fail = (where, message) => { throw new Error(where + ": " + message); };
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const text = (where, v, max = 120) => { if (typeof v !== "string" || !v.length || v.length > max) fail(where, "must be a text of 1 to " + max + " characters"); };
function i18n(where, v, max = 120) {
  if (v === undefined) return;
  if (!isObject(v) || Object.keys(v).length > 8) fail(where, "must be an object of at most 8 locales");
  for (const [k, t] of Object.entries(v)) { if (!/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(k)) fail(where, "bad locale " + JSON.stringify(k)); text(where + "." + k, t, max); }
}

// The schema property a pointer reaches, or an Error naming where it stops.
function leaf(where, model, path) {
  if (typeof path !== "string" || !path.startsWith("/")) fail(where + ".path", "must be a JSON pointer such as /a or /inputs/a");
  const segments = path.slice(1).split("/");
  if (segments.length > 4 || segments.some((s) => !SEGMENT.test(s))) fail(where + ".path", "at most 4 segments of letters, digits, _ or -");
  let node = model.schema;
  for (const s of segments) {
    if (node?.type !== "object" || !isObject(node.properties) || !(s in node.properties)) fail(where + ".path", path + " is not a property of the model " + model.id);
    node = node.properties[s];
  }
  if (!["boolean", "integer", "number", "string"].includes(node.type)) fail(where + ".path", path + " is not a single value (boolean, number or text)");
  return node;
}

function params(where, node, ctx) {
  const p = node.params;
  if (p === undefined) return;
  if (!isObject(p) || Object.keys(p).length > MAX_PARAMS) fail(where + ".params", "must be an object of at most " + MAX_PARAMS + " entries");
  for (const [k, v] of Object.entries(p)) {
    const at = where + ".params." + k;
    if (isObject(v)) {
      if (Object.keys(v).length !== 1 || !MARKERS.has(v.$)) fail(at, 'an object here must be { "$": "value" | "instance" | "revision" }');
      if (v.$ === "value" && !["toggle", "number", "select"].includes(node.type)) fail(at, "only a toggle, number or select has a value");
    } else if (!(v === null || ["string", "number", "boolean"].includes(typeof v)) || (typeof v === "string" && v.length > 100)) fail(at, "must be a scalar (or a $ marker)");
  }
  const input = ctx.actions?.[node.action]?.inputSchema;
  if (input?.properties) {
    for (const k of Object.keys(p)) if (!(k in input.properties)) fail(where + ".params." + k, node.action + " takes no such input");
    for (const k of input.required ?? []) if (!(k in p)) fail(where + ".params", node.action + " needs " + k);
  }
}

// ctx: { view: { reads, actions }, models: { <id>: model type }, actions: { <capability id>: capability } }
export function validateDeclarative(payload, ctx) {
  if (!isObject(payload) || (Object.keys(payload).length && (Object.keys(payload).length !== 1 || !("root" in payload)))) fail("payload", "must be {} or { root }");
  if (!("root" in payload)) return;
  let count = 0;
  const walk = (node, where, depth) => {
    if (++count > MAX_NODES) fail(where, "a view has at most " + MAX_NODES + " nodes");
    if (depth > MAX_DEPTH) fail(where, "nested deeper than " + MAX_DEPTH);
    if (!isObject(node) || !TYPES.has(node.type)) fail(where, "type must be one of " + [...TYPES].join(", "));
    for (const k of Object.keys(node)) if (!KEYS[node.type].includes(k)) fail(where, JSON.stringify(k) + " is not a field of a " + node.type);
    if (node.type === "stack") {
      if (node.direction !== undefined && !["column", "row"].includes(node.direction)) fail(where + ".direction", "column or row");
      if (!Array.isArray(node.children) || !node.children.length || node.children.length > MAX_CHILDREN) fail(where + ".children", "1 to " + MAX_CHILDREN + " nodes");
      node.children.forEach((c, i) => walk(c, where + ".children[" + i + "]", depth + 1));
      return;
    }
    if (node.type === "text") { text(where + ".text", node.text, 200); i18n(where + ".textI18n", node.textI18n, 200); return; }
    text(where + ".label", node.label); i18n(where + ".labelI18n", node.labelI18n);
    if (node.model !== undefined || node.type === "readout" || ["toggle", "number", "select"].includes(node.type)) {
      if (!ctx.view.reads.includes(node.model)) fail(where + ".model", JSON.stringify(node.model) + " is not one of the view's reads (" + ctx.view.reads.join(", ") + ")");
      const prop = leaf(where, ctx.models[node.model], node.path);
      const want = { toggle: ["boolean"], number: ["integer", "number"] }[node.type];
      if (want && !want.includes(prop.type)) fail(where + ".path", "a " + node.type + " needs a " + want.join(" or ") + " field, " + node.path + " is " + prop.type);
    }
    if (node.type === "readout") { if (node.format !== undefined && !FORMATS.has(node.format)) fail(where + ".format", "text, bit or yes-no"); return; }
    if (CONTROLS.has(node.type)) {
      if (!ctx.view.actions.includes(node.action)) fail(where + ".action", JSON.stringify(node.action) + " is not one of the view's actions (" + ctx.view.actions.join(", ") + ")");
      params(where, node, ctx);
    }
    if (node.type === "number") for (const k of ["min", "max", "step"]) if (node[k] !== undefined && !Number.isFinite(node[k])) fail(where + "." + k, "must be a number");
    if (node.type === "select") {
      if (!Array.isArray(node.options) || !node.options.length || node.options.length > MAX_OPTIONS) fail(where + ".options", "1 to " + MAX_OPTIONS + " options");
      node.options.forEach((o, i) => {
        if (!isObject(o) || Object.keys(o).some((k) => !["value", "label"].includes(k)) || !["string", "number"].includes(typeof o.value)) fail(where + ".options[" + i + "]", "{ value (text or number), label }");
        text(where + ".options[" + i + "].label", o.label, 60);
      });
    }
  };
  walk(payload.root, "root", 1);
}
