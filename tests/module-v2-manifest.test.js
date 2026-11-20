// UVA Phase 5A-1: estampes.module/2 is a strict manifest of its own (ADR-005).
// Only the format is checked here; nothing runs a v2 module yet.
import test from "node:test";
import assert from "node:assert/strict";
import { validateManifest, ManifestError, abiChange, MODULE_SCHEMA_V2, SUPPORTED_ABI } from "../src/modules/manifest.js";
import { manifest as graph } from "../src/builtin-modules/graph/index.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const v2 = () => ({
  schema: MODULE_SCHEMA_V2, id: "org.example.demo", name: "Demo", description: "d", version: "1.0.0",
  publisher: { name: "Me" }, license: "MPL-2.0", coreCompatibility: ">=0.10.0 <1.0.0",
  runtime: { kind: "declarative", entry: "ops", abi: 1 }, permissions: ["canvas.write"],
  capabilities: [{ id: "dot", description: "a dot", target: "document", needs: ["canvas.write"],
    inputSchema: { type: "object", additionalProperties: false, required: ["x"], properties: { x: { type: "number" } } },
    operations: [{ op: "object.create", type: "shape", props: { kind: "point", x: { $param: "x" }, y: 0.5 } }] }],
});
const refused = (m, re, opts = { v2: true }) => assert.throws(() => validateManifest(m, opts), (e) => e instanceof ManifestError && re.test(e.message), String(re));

test("a valid v2 manifest is accepted only when v2 is asked for, and comes back unchanged", () => {
  const m = v2();
  const out = validateManifest(clone(m), { v2: true });
  assert.equal(out.schema, MODULE_SCHEMA_V2);
  assert.deepEqual(out.capabilities[0].needs, ["canvas.write"]);
  assert.equal(out.capabilities[0].target, "document");
  assert.equal(out.runtime.abi, 1);
  refused(m, /not enabled on this server yet/, {});
  refused(m, /not enabled on this server yet/, { coreVersion: "0.20.0" });
});

test("v1 manifests are untouched: still valid, and the v2 fields are refused on them", () => {
  assert.equal(validateManifest(graph, { coreVersion: "0.10.0" }).schema, "estampes.module/1");
  assert.equal(validateManifest(graph, { coreVersion: "0.10.0", v2: true }).schema, "estampes.module/1");
  const v1 = clone(graph); v1.capabilities[0].needs = ["canvas.write"];
  refused(v1, /needs|Unrecognized/);
});

test("v2 is strict: ABI is a required integer, the target is a document target, needs is required", () => {
  let m = v2(); delete m.runtime.abi; refused(m, /runtime\.abi/);
  m = v2(); m.runtime.abi = "1"; refused(m, /runtime\.abi/);
  m = v2(); m.runtime.abi = 1.5; refused(m, /runtime\.abi/);
  m = v2(); m.runtime.abi = SUPPORTED_ABI + 1; refused(m, /newer than this server supports/);
  m = v2(); m.capabilities[0].target = "canvas"; refused(m, /target/);
  m = v2(); delete m.capabilities[0].needs; refused(m, /needs/);
  m = v2(); m.capabilities[0].permissions = ["canvas.write"]; refused(m, /Unrecognized|permissions/);
  m = v2(); m.extra = 1; refused(m, /Unrecognized/);
  m = v2(); m.runtime.kind = "wasm"; refused(m, /wasm runtime is not available/);
  m = v2(); m.runtime.kind = "builtin"; refused(m, /built-in modules use/);
});

test("v2 keeps the permission rules: needs stays inside the module's permissions and matches the target", () => {
  let m = v2(); m.capabilities[0].needs = ["canvas.write", "cas.compute"]; refused(m, /not in the module's permissions/);
  m = v2(); m.capabilities[0].needs = []; refused(m, /needs canvas\.write/);
  m = v2(); m.capabilities[0].target = "document-or-new"; refused(m, /needs workspace\.write/);
  m.permissions = ["canvas.write", "workspace.write"]; m.capabilities[0].needs = ["canvas.write", "workspace.write"];
  assert.equal(validateManifest(m, { v2: true }).capabilities[0].target, "document-or-new");
  m = v2(); m.capabilities[0].target = "none"; m.capabilities[0].needs = [];
  assert.equal(validateManifest(m, { v2: true }).capabilities[0].target, "none");
});

test("abiChange tells the Store what happened to a module's ABI", () => {
  assert.deepEqual(abiChange(undefined, 1), { from: null, to: 1, kind: "new" });
  assert.deepEqual(abiChange(1, 1), { from: 1, to: 1, kind: "same" });
  assert.deepEqual(abiChange(1, 2), { from: 1, to: 2, kind: "upgrade" });
  assert.deepEqual(abiChange(2, 1), { from: 2, to: 1, kind: "downgrade" });
  assert.deepEqual(abiChange(1, undefined), { from: 1, to: null, kind: "removed" });
  assert.deepEqual(abiChange(undefined, undefined), { from: null, to: null, kind: "none" });
});
