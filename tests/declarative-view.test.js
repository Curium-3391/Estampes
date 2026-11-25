// #85 V2-1: the payload of the declarative renderer is checked when a manifest is read: the tree can only name what the view declared
// (its reads and actions), paths must reach a field of the right kind in the model's schema, and nothing in it can carry code.
import test from "node:test";
import assert from "node:assert/strict";
import { validateManifest, ManifestError, MODULE_SCHEMA_V2 } from "../src/modules/manifest.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const SCHEMA = { type: "object", additionalProperties: false, required: ["a", "b", "sum"],
  properties: { a: { type: "boolean" }, b: { type: "boolean" }, mode: { type: "string", enum: ["x", "y"], maxLength: 4 }, count: { type: "integer", minimum: 0, maximum: 9 }, sum: { type: "integer", minimum: 0, maximum: 3 },
    nested: { type: "object", additionalProperties: false, properties: { deep: { type: "boolean" } } }, list: { type: "array", maxItems: 2, items: { type: "integer", minimum: 0, maximum: 1 } } } };
const ACTION_INPUT = { type: "object", additionalProperties: false, required: ["id", "field", "to"], properties: { id: { type: "string", maxLength: 20 }, field: { type: "string", maxLength: 20 }, to: { type: "boolean" }, rev: { type: "integer", minimum: 1 } } };
const tree = () => ({ root: { type: "stack", children: [
  { type: "text", text: "A one-bit adder" },
  { type: "toggle", label: "A", model: "adder", path: "/a", action: "set", params: { id: { $: "instance" }, field: "a", to: { $: "value" }, rev: { $: "revision" } } },
  { type: "readout", label: "Sum", model: "adder", path: "/sum", format: "text" },
] } });
const base = (payload = tree()) => ({
  schema: MODULE_SCHEMA_V2, id: "org.example.logic", name: "Logic", description: "d", version: "1.0.0", publisher: { name: "Me" }, license: "MPL-2.0", coreCompatibility: ">=0.10.0 <1.0.0",
  runtime: { kind: "declarative", entry: "ops", abi: 1 }, permissions: ["module.storage.write"],
  models: [{ id: "adder", dataVersion: 1, schema: SCHEMA }],
  capabilities: [{ id: "set", description: "set a field", target: "none", needs: ["module.storage.write"], writes: ["adder"], inputSchema: ACTION_INPUT, operations: [] }],
  views: [{ id: "adder-view", title: "Adder", reads: ["adder"], actions: ["set"], renderer: { type: "declarative", schema: "estampes.renderer.declarative/1", payload } }],
});
const refused = (payload, re) => assert.throws(() => validateManifest(base(payload), { v2: true }), (e) => e instanceof ManifestError && re.test(e.message), String(re));
const control = (extra) => ({ root: { type: "stack", children: [{ type: "toggle", label: "A", model: "adder", path: "/a", action: "set", params: { id: { $: "instance" }, field: "a", to: { $: "value" } }, ...extra }] } });

test("a tree of fixed controls is accepted, and {} still is", () => {
  assert.ok(validateManifest(base(), { v2: true }));
  assert.ok(validateManifest(base({}), { v2: true }));
});

test("a control can name only the view's own reads and actions", () => {
  refused(control({ model: "other" }), /not one of the view's reads/);
  refused(control({ action: "dot" }), /not one of the view's actions/);
});

test("a path must reach a single value of the right kind in the model's schema", () => {
  refused(control({ path: "/nope" }), /not a property of the model adder/);
  refused(control({ path: "/list" }), /not a single value/);
  refused(control({ path: "/nested" }), /not a single value/);
  refused(control({ path: "/sum" }), /a toggle needs a boolean field/);
  refused(control({ path: "a" }), /JSON pointer/);
  refused(control({ path: "/a/b/c/d/e" }), /at most 4 segments/);
  refused(control({ path: "/a b" }), /segments of letters/);
  assert.ok(validateManifest(base(control({ path: "/a" })), { v2: true }));
  const deep = control({ path: "/nested/deep" }); assert.ok(validateManifest(base(deep), { v2: true }));
});

test("params are scalars or the host's markers, and must fit the capability's input", () => {
  refused(control({ params: { id: { $: "instance" }, field: "a", to: { $: "value" }, extra: 1 } }), /takes no such input/);
  refused(control({ params: { field: "a", to: { $: "value" } } }), /needs id/);
  refused(control({ params: { id: { $: "instance" }, field: { code: "x" }, to: true } }), /an object here must be/);
  refused(control({ params: { id: { $: "javascript" }, field: "a", to: true } }), /\$/);
  const btn = { root: { type: "button", label: "Go", action: "set", params: { id: { $: "instance" }, field: "a", to: { $: "value" } } } };
  refused(btn, /only a toggle, number or select has a value/);
});

test("nothing that could carry code is accepted: unknown types and fields, markup, deep or large trees", () => {
  refused({ root: { type: "html", text: "<script>" } }, /type must be one of/);
  refused({ root: { type: "text", text: "x", onclick: "alert(1)" } }, /not a field of a text/);
  refused({ root: { type: "text", text: "" } }, /1 to 200/);
  refused({ root: { type: "stack", children: [] } }, /1 to 24 nodes/);
  refused({ tree: {} }, /must be \{\} or \{ root \}/);
  let deep = { type: "text", text: "x" }; for (let i = 0; i < 6; i++) deep = { type: "stack", children: [deep] };
  refused({ root: deep }, /nested deeper than 5/);
  const many = { root: { type: "stack", children: Array.from({ length: 24 }, () => ({ type: "stack", children: Array.from({ length: 3 }, () => ({ type: "text", text: "x" })) })) } };
  refused(many, /at most 64 nodes/);
});

test("select and number controls check their own fields; labels may be localized but stay bounded", () => {
  const sel = (o) => ({ root: { type: "select", label: "Mode", model: "adder", path: "/mode", action: "set", params: { id: { $: "instance" }, field: "m", to: true }, options: o } });
  assert.ok(validateManifest(base(sel([{ value: "x", label: "X" }, { value: "y", label: "Y" }])), { v2: true }));
  refused(sel([]), /1 to 16 options/);
  refused(sel([{ value: {}, label: "X" }]), /value \(text or number\)/);
  const num = { root: { type: "number", label: "N", model: "adder", path: "/count", action: "set", params: { id: { $: "instance" }, field: "n", to: true }, min: "0" } };
  refused(num, /must be a number/);
  refused({ root: { type: "readout", label: "Sum", labelI18n: { "zh-TW": 5 }, model: "adder", path: "/sum" } }, /1 to 120/);
  refused({ root: { type: "readout", label: "Sum", model: "adder", path: "/sum", format: "html" } }, /text, bit or yes-no/);
});
