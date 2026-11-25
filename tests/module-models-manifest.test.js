// #85 V1-1: the manifest contract for module-owned data (`models`), the capabilities that write it (`writes`) and the views that present it
// (`views`). Only the format is checked here: nothing stores or draws anything yet. The renderer is chosen by `renderer.type`; the view
// contract around it does not depend on which one.
import test from "node:test";
import assert from "node:assert/strict";
import { validateManifest, ManifestError, runtimeManifest, MODULE_SCHEMA_V2 } from "../src/modules/manifest.js";
import { registerRenderer, rendererTypes } from "../src/modules/renderers.js";
import { manifest as graph } from "../src/builtin-modules/graph/index.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const SCHEMA = { type: "object", additionalProperties: false, properties: { a: { type: "integer", minimum: 0, maximum: 1 } } };
const base = () => ({
  schema: MODULE_SCHEMA_V2, id: "org.example.logic", name: "Logic", description: "d", version: "1.0.0",
  publisher: { name: "Me" }, license: "MPL-2.0", coreCompatibility: ">=0.10.0 <1.0.0",
  runtime: { kind: "declarative", entry: "ops", abi: 1 }, permissions: ["canvas.write", "module.storage.write"],
  models: [{ id: "adder", dataVersion: 2, readsVersions: [1, 2], schema: SCHEMA }],
  capabilities: [
    { id: "set_input", description: "set an input", target: "none", needs: ["module.storage.write"], writes: ["adder"], inputSchema: { type: "object", additionalProperties: false, properties: {} }, operations: [] },
    { id: "dot", description: "a dot", target: "document", needs: ["canvas.write"], inputSchema: { type: "object", additionalProperties: false, properties: {} }, operations: [] },
  ],
  views: [{ id: "adder-view", title: "Adder", reads: ["adder"], actions: ["set_input"], renderer: { type: "declarative", schema: "estampes.renderer.declarative/1", payload: {} } }],
});
const refused = (m, re) => assert.throws(() => validateManifest(m, { v2: true }), (e) => e instanceof ManifestError && re.test(e.message), String(re));

test("a manifest with a model type, a writing capability and a view is accepted and keeps what it declared", () => {
  const out = validateManifest(clone(base()), { v2: true });
  assert.equal(out.models[0].maxBytes, 16384, "default size limit");
  assert.equal(out.models[0].maxInstances, 32, "default instance limit");
  assert.deepEqual(out.capabilities[0].writes, ["adder"]);
  assert.deepEqual(out.views[0].reads, ["adder"]);
  const rt = runtimeManifest(out);
  assert.deepEqual(rt.v2.writes, { set_input: ["adder"] });
  assert.equal(rt.models.length, 1);
});

test("models and views are optional, and v1 manifests refuse them", () => {
  const m = base(); delete m.models; delete m.views; m.permissions = ["canvas.write"]; delete m.capabilities[0].writes; m.capabilities[0].needs = ["canvas.write"];
  assert.ok(validateManifest(m, { v2: true }));
  const v1 = clone(graph); v1.models = base().models;
  assert.throws(() => validateManifest(v1, { coreVersion: "0.10.0" }), (e) => e instanceof ManifestError);
});

test("storing data is an explicit permission: models and writes need module.storage.write", () => {
  let m = base(); m.permissions = ["canvas.write"]; m.capabilities[0].needs = ["canvas.write"]; refused(m, /declaring models needs module\.storage\.write/);
  m = base(); m.capabilities[0].needs = ["canvas.write"]; m.capabilities[0].target = "document"; refused(m, /that writes models needs module\.storage\.write/);
});

test("a model type is bounded and closed like an input schema, and versions make sense", () => {
  let m = base(); m.models.push({ ...clone(m.models[0]) }); refused(m, /duplicate id/);
  m = base(); m.models[0].schema = { type: "object", properties: {} }; refused(m, /additionalProperties/);
  m = base(); m.models[0].schema = { type: "string", maxLength: 10 }; refused(m, /must be an object schema/);
  m = base(); m.models[0].readsVersions = [3]; refused(m, /newer than its own dataVersion/);
  m = base(); m.models[0].readsVersions = [1, 1]; refused(m, /duplicate version/);
  m = base(); m.models[0].dataVersion = 0; refused(m, /dataVersion/);
  m = base(); m.models[0].maxBytes = 70000; refused(m, /maxBytes/);
  m = base(); m.models[0].id = "Adder"; refused(m, /models/);
});

test("writes name declared models; a background job cannot write yet", () => {
  let m = base(); m.capabilities[0].writes = ["nope"]; refused(m, /no model nope/);
  m = base(); m.capabilities[0].async = true; m.capabilities[0].profile = { whenToUse: "x", cost: { latency: "seconds" } }; refused(m, /background job cannot write models/);
});

test("a capability id can never contain a dot, so the host's own models.list and models.get cannot be shadowed", () => {
  for (const id of ["models.list", "models.get", "models.", ".x"]) { const m = base(); m.capabilities[1].id = id; refused(m, /capabilities/); }
});

test("a view names models and actions that exist", () => {
  let m = base(); m.views[0].reads = ["nope"]; refused(m, /views\[0\].*no model nope/);
  m = base(); m.views[0].actions = ["nope"]; refused(m, /no capability nope/);
  m = base(); m.views.push(clone(m.views[0])); refused(m, /duplicate id/);
  m = base(); m.views[0].ephemeral = { schema: { type: "object", properties: {} } }; refused(m, /additionalProperties/);
});

test("the renderer is chosen by type: an unknown type is refused (fail closed), and the declarative one is not drawn yet", () => {
  let m = base(); m.views[0].renderer.type = "sandboxed-web"; refused(m, /not supported by this server \(supported: declarative\)/);
  m = base(); m.views[0].renderer.schema = "estampes.renderer.declarative/9"; refused(m, /renderer\.schema must be/);
  m = base(); m.views[0].renderer.payload = { tree: [] }; refused(m, /not available yet; leave payload empty/);
  m = base(); delete m.views[0].renderer.payload; refused(m, /payload/);
});

test("the view contract does not depend on the renderer: a second renderer type plugs in without changing the rest", () => {
  const seen = [];
  const remove = registerRenderer("test-frame", { schema: "estampes.renderer.test-frame/1", validate: (p) => { seen.push(p); if (p.bundle !== undefined && typeof p.bundle !== "string") throw new Error("bundle must be a string"); } });
  try {
    assert.ok(rendererTypes().includes("test-frame"));
    const m = base(); m.views[0].renderer = { type: "test-frame", schema: "estampes.renderer.test-frame/1", payload: { bundle: "files/ui.html" } };
    const out = validateManifest(m, { v2: true });
    assert.equal(out.views[0].renderer.type, "test-frame");
    assert.deepEqual(out.views[0].reads, ["adder"], "reads, actions and the models are checked the same way");
    assert.equal(seen.length, 1, "only the renderer's own validator looks at the payload");
    m.views[0].renderer.payload = { bundle: 5 }; refused(m, /bundle must be a string/);
    m.views[0].renderer.payload = { big: "x".repeat(70000) }; refused(m, /larger than 64 KB/);
    m.views[0].reads = ["nope"]; m.views[0].renderer.payload = {}; refused(m, /no model nope/);
  } finally { remove(); }
  const again = base(); again.views[0].renderer = { type: "test-frame", schema: "estampes.renderer.test-frame/1", payload: {} };
  refused(again, /not supported by this server/);
});
