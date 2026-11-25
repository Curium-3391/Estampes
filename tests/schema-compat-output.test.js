// #86 F1-1: a capability may declare the shape of its result (`outputSchema`); it is checked at manifest time, shown in discovery, enforced when the
// capability runs, and two shapes can be compared before anything runs (the type check of a Flow edge). Invented modules, no Flow yet.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest, ManifestError } from "../src/modules/manifest.js";
import { assignable, outputPorts, inputPorts } from "../src/modules/schema-compat.js";
import { createModuleHost } from "../src/modules/index.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { schemaHash } from "../src/modules/search.js";

const MOD = "org.example.rc";
const OUT = { type: "object", additionalProperties: false, required: ["fc"], properties: { fc: { type: "number", minimum: 0, maximum: 1e9 }, label: { type: "string", maxLength: 40 } } };
const cap = (id, extra = {}) => ({ id, title: id, description: "Test capability " + id + ".", target: "none", needs: [], inputSchema: { type: "object", additionalProperties: false, properties: {} }, ...extra });
const manifest = (caps) => ({ schema: "estampes.module/2", id: MOD, name: "RC", description: "An invented module with typed results.", version: "1.0.0", publisher: { name: "Example" }, license: "MPL-2.0",
  category: "diagram", coreCompatibility: ">=0.10.0 <1.0.0", permissions: [], capabilities: caps, runtime: { kind: "builtin", entry: "rc", abi: 1 } });
const checkable = (caps) => ({ ...manifest(caps.map((c) => ({ ...c, operations: [{ op: "object.create", type: "axes-2d", props: { xRange: [-1, 1], yRange: [-1, 1] } }] }))), runtime: { kind: "declarative", entry: "operations", abi: 1 } });
const check = (caps) => validateManifest(checkable(caps), { v2: true });

test("outputSchema is checked with the same rules as inputSchema, only on module/2, and not on a background job", () => {
  assert.deepEqual(check([cap("cutoff", { outputSchema: OUT })]).capabilities[0].outputSchema, OUT);
  const bad = (extra, re) => assert.throws(() => check([cap("x", extra)]), (e) => e instanceof ManifestError && re.test(e.message));
  bad({ outputSchema: { type: "object", properties: {} } }, /additionalProperties/);
  bad({ outputSchema: { type: "string", maxLength: 5 } }, /must be an object schema/);
  bad({ outputSchema: { type: "object", additionalProperties: false, properties: { a: { type: "string" } } } }, /maxLength/);
  bad({ outputSchema: OUT, async: true, profile: { whenToUse: "x", cost: { latency: "seconds" } } }, /background job/);
  assert.throws(() => validateManifest({ ...checkable([cap("x", { outputSchema: OUT })]), schema: "estampes.module/1", runtime: { kind: "declarative", entry: "operations" } }, { v2: false }), ManifestError);
});

test("a declared outputSchema is enforced on the result, and a capability without one is unchanged", async (t) => {
  process.env.ESTAMPES_MODULE_V2 = "on";
  const storage = await mkdtemp(join(tmpdir(), "outschema-"));
  t.after(() => rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let answer;
  const caps = [cap("cutoff", { outputSchema: OUT }), cap("free")];
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0", builtins: [{ manifest: manifest(caps), run: () => answer }],
    canvases: { ensure: ensureImage, create: async (o) => createBlankCanvas(o), save: async () => {} } });
  const plan = await h.lifecycle.prepare("enable", MOD); await h.lifecycle.commit(plan.planId, { consent: plan.consent });
  const run = (capability) => h.router.execute({ module: MOD, capability, params: {} });
  answer = { data: { fc: 159.2, label: "RC" } };
  assert.deepEqual((await run("cutoff")).data, { fc: 159.2, label: "RC" });
  for (const bad of [{ data: { fc: -1 } }, { data: { label: "x" } }, { data: { fc: 1, extra: true } }, {}, { data: { fc: "1" } }]) {
    answer = bad;
    await assert.rejects(run("cutoff"), (e) => e.code === "output" && /outputSchema/.test(e.message), JSON.stringify(bad));
  }
  answer = { data: { anything: [1, 2] } };
  assert.deepEqual((await run("free")).data, { anything: [1, 2] });
  const m = h.registry.get(MOD).manifest;
  assert.notEqual(schemaHash(m, m.capabilities[0]), schemaHash({ ...m, v2: { ...m.v2, outputs: undefined } }, m.capabilities[0]), "the contract hash covers the output shape");
});

test("assignable: what fits where, conservatively, with the reason when it does not", () => {
  const num = (extra = {}) => ({ type: "number", ...extra }), int = (extra = {}) => ({ type: "integer", ...extra }), str = (n, extra = {}) => ({ type: "string", maxLength: n, ...extra });
  assert.equal(assignable(int(), num()).ok, true, "an integer is a number");
  assert.equal(assignable(num(), int()).ok, false);
  assert.equal(assignable(num({ minimum: 0, maximum: 10 }), num({ minimum: -1, maximum: 100 })).ok, true);
  assert.match(assignable(num({ minimum: 0 }), num({ minimum: 1 })).reason, /below 1/);
  assert.match(assignable(num(), num({ maximum: 5 })).reason, /above 5/);
  assert.equal(assignable(str(10), str(20)).ok, true);
  assert.match(assignable(str(30), str(20)).reason, /longer than 20/);
  assert.equal(assignable({ type: "string", enum: ["a", "b"] }, str(5)).ok, true, "a limited source fits");
  assert.equal(assignable(str(5), { type: "string", enum: ["a", "b"] }).ok, false, "an unlimited source does not fit a list");
  assert.equal(assignable({ type: "string", enum: ["a", "b"] }, { type: "string", enum: ["a", "b", "c"] }).ok, true);
  assert.equal(assignable({ const: 3 }, num({ maximum: 5 })).ok, true);
  assert.equal(assignable(num(), { oneOf: [str(5), num()] }).ok, true, "any accepted shape will do");
  assert.equal(assignable({ oneOf: [int(), num()] }, num()).ok, true, "every source shape must fit");
  assert.equal(assignable({ oneOf: [int(), str(3)] }, num()).ok, false);
  const arr = (item, n) => ({ type: "array", maxItems: n, items: item });
  assert.equal(assignable(arr(int(), 5), arr(num(), 10)).ok, true);
  assert.match(assignable(arr(int(), 50), arr(num(), 10)).reason, /more than 10/);
  assert.match(assignable(arr(str(5), 5), arr(num(), 10)).path, /\[\]/);
  const obj = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
  assert.equal(assignable(obj({ a: int() }, ["a"]), obj({ a: num(), b: num() }, ["a"])).ok, true);
  assert.match(assignable(obj({ a: int() }), obj({ a: num() }, ["a"])).reason, /may leave it out/);
  assert.match(assignable(obj({ z: int() }), obj({ a: num() })).reason, /does not accept this field/);
  assert.equal(assignable(null, num()).ok, false);
});

test("ports are the fields of the schemas, with whether each is required", () => {
  assert.deepEqual(outputPorts(OUT).map((p) => [p.name, p.required]), [["fc", true], ["label", false]]);
  assert.deepEqual(inputPorts({ type: "object", additionalProperties: false, required: ["r"], properties: { r: { type: "number" }, c: { type: "number" } } }).map((p) => p.name), ["r", "c"]);
  assert.deepEqual(outputPorts(undefined), []);
});
