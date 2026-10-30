import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest } from "../src/modules/manifest.js";
import { checkSchema, validateValue } from "../src/modules/json-schema.js";
import { satisfies, compareVersions } from "../src/modules/semver.js";
import { readFile } from "node:fs/promises";
import { createModuleHost } from "../src/modules/index.js";
import { fillTemplate } from "../src/modules/runtimes/declarative.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { manifest as graph } from "../src/builtin-modules/graph/index.js";
import { canvasObjects } from "../src/scene/scene-ops.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const base = () => ({
  schema: "estampes.module/1", id: "org.example.demo", name: "Demo", description: "d", version: "1.0.0",
  publisher: { name: "Me" }, license: "MPL-2.0", coreCompatibility: ">=0.10.0 <1.0.0",
  runtime: { kind: "declarative", entry: "ops" }, permissions: ["canvas.write"],
  capabilities: [{ id: "dot", description: "a dot", target: "canvas",
    inputSchema: { type: "object", additionalProperties: false, required: ["x"], properties: { x: { type: "number" } } },
    operations: [{ op: "object.create", type: "shape", props: { kind: "point", x: { $param: "x" }, y: 0.5 } }] }],
});

test("manifest: the bundled Graph manifest is valid for this core", () => {
  assert.equal(validateManifest(graph, { coreVersion: "0.10.0" }).id, "org.estampes.graph");
  assert.throws(() => validateManifest(graph, { coreVersion: "1.2.0" }), /needs Estampes/);
});

test("manifest: strict, unknown fields and unsafe schemas are refused", () => {
  assert.ok(validateManifest(base()));
  const bad = (edit, re) => { const m = base(); edit(m); assert.throws(() => validateManifest(m), re); };
  bad((m) => { m.extra = 1; }, /unrecognized|manifest/i);
  bad((m) => { m.id = "Demo"; }, /manifest\.id/);
  bad((m) => { m.version = "1"; }, /manifest\.version/);
  bad((m) => { m.permissions = ["fs.write"]; }, /manifest\.permissions/);
  bad((m) => { m.capabilities[0].inputSchema.additionalProperties = true; }, /additionalProperties/);
  bad((m) => { m.capabilities[0].inputSchema.properties.x = { type: "string" }; }, /maxLength/);
  bad((m) => { m.capabilities[0].inputSchema.properties.x = { type: "number", $ref: "http://evil" }; }, /not supported/);
  bad((m) => { m.capabilities[0].permissions = ["workspace.write"]; }, /not in the module's permissions/);
  bad((m) => { m.permissions = ["canvas.read"]; }, /needs canvas.write/);
  bad((m) => { m.permissions.push("network.request.approved"); }, /network/);
  bad((m) => { delete m.capabilities[0].operations; }, /needs operations/);
  bad((m) => { m.capabilities.push(clone(m.capabilities[0])); }, /duplicate/);
});

test("json schema subset: validates, fills defaults, rejects regex bombs and unbounded input", () => {
  const s = { type: "object", additionalProperties: false, required: ["a"], properties: {
    a: { type: "integer", minimum: 1, maximum: 5 }, b: { type: "string", enum: ["x", "y"], default: "x" },
    c: { type: "array", maxItems: 2, items: { type: "number" } } } };
  checkSchema(s);
  assert.deepEqual(validateValue(s, { a: 2 }), { a: 2, b: "x" });
  assert.throws(() => validateValue(s, { a: 9 }), /<= 5/);
  assert.throws(() => validateValue(s, { a: 2, z: 1 }), /unknown field/);
  assert.throws(() => validateValue(s, { a: 2, c: [1, 2, 3] }), /at most 2/);
  assert.throws(() => validateValue(s, { a: 2, c: [NaN] }), /finite|expected/);
  assert.throws(() => checkSchema({ type: "string", maxLength: 10, pattern: "(a+)+$" }), /nested quantifiers/);
  assert.throws(() => checkSchema({ type: "array", items: { type: "number" } }), /maxItems/);
});

test("semver ranges", () => {
  assert.ok(satisfies("0.10.0", ">=0.10.0 <1.0.0"));
  assert.ok(!satisfies("1.0.0", ">=0.10.0 <1.0.0"));
  assert.ok(satisfies("0.9.4", "^0.9.0"));
  assert.ok(!satisfies("0.10.0", "^0.9.0"));
  assert.ok(satisfies("2.1.0", "~2.1.0 || >=3.0.0"));
  assert.equal(compareVersions("1.2.3-beta", "1.2.3"), -1);
});

test("declarative templates fill only declared placeholders", () => {
  assert.deepEqual(fillTemplate({ a: { $param: "x" }, b: [{ $param: "y", default: 7 }], c: { $param: "none" } }, { x: 1 }), { a: 1, b: [7] });
});

async function host(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "estampes-mod-"));
  const h = await createModuleHost({ storageDir: dir, coreVersion: "0.10.0", canvases: { ensure: ensureImage, create: createBlankCanvas, save: async () => {} }, ...extra });
  return { h, dir };
}
const enable = async (h, id = "org.estampes.graph") => {
  const plan = await h.lifecycle.prepare("enable", id);
  return h.lifecycle.commit(plan.planId, { consent: plan.consent });
};

test("lifecycle: a model-prepared plan cannot be committed without the consent only the Store has", async () => {
  const { h } = await host();
  await assert.rejects(h.router.execute({ module: "org.estampes.graph", capability: "plot_function", params: { expression: "sin(x)" } }), /Only the user can enable/);
  const plan = await h.lifecycle.prepare("enable", "org.estampes.graph", {}, { by: "model" });
  assert.equal("consent" in h.lifecycle.publicPlan(plan), false);
  await assert.rejects(h.lifecycle.commit(plan.planId, {}), /approved in the Estampes Store/);
  await assert.rejects(h.lifecycle.commit(plan.planId, { consent: "guess" }), /approved in the Estampes Store/);
  const done = await h.lifecycle.commit(plan.planId, { consent: plan.consent });
  assert.equal(done.result.state, "enabled");
  // Committing again changes nothing (idempotent).
  const again = await h.lifecycle.commit(plan.planId, { consent: plan.consent });
  assert.equal(again.repeated, true);
  await h.audit.flush();
  const kinds = (await h.audit.read()).map((e) => e.kind);
  assert.ok(kinds.includes("plan.refused") && kinds.includes("plan.committed"));
});

test("lifecycle: state survives a restart; disabling stops execution but keeps the objects", async () => {
  const { h, dir } = await host();
  await enable(h);
  const run = await h.router.execute({ module: "org.estampes.graph", capability: "plot_function", params: { expression: "sin(x)" } });
  assert.equal(run.createdCanvas, true);
  assert.equal(canvasObjects(run.entry).length, 2);
  const again = await createModuleHost({ storageDir: dir, coreVersion: "0.10.0", canvases: { ensure: ensureImage, create: createBlankCanvas, save: async () => {} } });
  assert.equal(again.registry.get("org.estampes.graph").record.state, "enabled");
  const plan = await h.lifecycle.prepare("disable", "org.estampes.graph");
  await h.lifecycle.commit(plan.planId, { consent: plan.consent });
  await assert.rejects(h.router.execute({ module: "org.estampes.graph", capability: "update_plot", canvas: run.entry.imageId, params: { object: "o2", expression: "x" } }), /disabled/);
  assert.equal(canvasObjects(run.entry).length, 2);
});

test("router: sin(x) then sin(2x) on the same canvas, expected revision enforced, bad input explained", async () => {
  const { h } = await host();
  await enable(h);
  const r1 = await h.router.execute({ module: "org.estampes.graph", capability: "plot_function", params: { expression: "sin(x)" } });
  const id = r1.entry.imageId;
  assert.equal(canvasObjects(r1.entry)[0].props.xTicks, "pi");
  await assert.rejects(h.router.execute({ module: "org.estampes.graph", capability: "update_plot", canvas: id, expectedRevision: 0, params: { object: "o2", expression: "sin(2x)" } }), /changed since/);
  const r2 = await h.router.execute({ module: "org.estampes.graph", capability: "update_plot", canvas: id, expectedRevision: 1, params: { object: "o2", expression: "sin(2x)" } });
  assert.deepEqual(r2.scene.updated, ["o2"]);
  assert.equal(canvasObjects(r2.entry)[1].props.expression, "sin(2x)");
  await assert.rejects(h.router.execute({ module: "org.estampes.graph", capability: "plot_function", canvas: id, params: { expression: "process.exit()" } }), /Unexpected character/);
  await assert.rejects(h.router.execute({ module: "org.estampes.graph", capability: "plot_function", canvas: id, params: { expression: "x", evil: 1 } }), /unknown field/);
  await assert.rejects(h.router.execute({ module: "org.estampes.graph", capability: "nope", canvas: id }), /no capability/);
  // A second plot reuses the canvas's axes.
  const r3 = await h.router.execute({ module: "org.estampes.graph", capability: "plot_function", canvas: id, params: { expression: "cos(x)", color: "red" } });
  assert.deepEqual(r3.scene.created, ["o3"]);
  assert.equal(canvasObjects(r3.entry)[2].props.frame, "o1");
});

test("router: a module that returns something unexpected is refused, not applied", async () => {
  const evil = { manifest: { ...base(), id: "org.example.evil", runtime: { kind: "builtin", entry: "x" },
    capabilities: [{ id: "go", description: "x", target: "canvas", inputSchema: { type: "object", additionalProperties: false, properties: {} } }] },
    run: () => ({ operations: [{ op: "object.create", type: "shape", props: { kind: "text", x: 0.5, y: 0.5, text: "<script>alert(1)</script>" } }], html: "<b>x</b>" }) };
  const { h } = await host({ builtins: [evil] });
  await enable(h, "org.example.evil");
  const entry = await createBlankCanvas({});
  await assert.rejects(h.router.execute({ module: "org.example.evil", capability: "go", canvas: entry.imageId }), /not valid/);
});

test("graph: plot_points and set_axes on a canvas", async () => {
  const { h } = await host();
  await enable(h);
  const pts = await h.router.execute({ module: "org.estampes.graph", capability: "plot_points", params: { points: [[0, 0], [1, 2], [2, 3.5]], style: "dots", label: "data" } });
  assert.equal(canvasObjects(pts.entry).map((o) => o.type).join(), "axes-2d,shape");
  const ax = await h.router.execute({ module: "org.estampes.graph", capability: "set_axes", canvas: pts.entry.imageId, params: { xRange: [-1, 5], title: "Measured" } });
  assert.deepEqual(ax.scene.updated, ["o1"]);
});

test("capability profile: network use must be declared, local work must not claim to leave, jobs are not instant, text must match", async () => {
  const { validateManifest } = await import("../src/modules/manifest.js");
  const astro = JSON.parse(await readFile(new URL("../src/builtin-modules/astrometry/manifest.json", import.meta.url), "utf8"));
  const bad = (edit, pattern) => { const m = structuredClone(astro); edit(m); assert.throws(() => validateManifest(m), pattern); };
  validateManifest(astro);
  bad((m) => { delete m.capabilities[0].profile; delete m.capabilities[0].profileI18n; }, /must say what it sends/);
  bad((m) => { m.capabilities[0].profile.dataFlow.leavesServer = false; }, /must say what it sends/);
  bad((m) => { m.capabilities[1].profile.dataFlow.leavesServer = true; delete m.capabilities[1].profileI18n; }, /no network\.request\.approved/);
  bad((m) => { m.capabilities[0].profile.cost.latency = "instant"; delete m.capabilities[0].profileI18n; }, /cannot be instant/);
  bad((m) => { m.capabilities[0].profileI18n["zh-TW"].dataFlow.leavesServer = false; }, /must match profile/);
  bad((m) => { m.capabilities[0].profile.surprise = 1; }, /Unrecognized|unknown/i);
  // A module with no network needs no profile at all.
  const graph = JSON.parse(await readFile(new URL("../src/builtin-modules/graph/manifest.json", import.meta.url), "utf8"));
  for (const c of graph.capabilities) { delete c.profile; delete c.profileI18n; }
  validateManifest(graph);
});

test("get_module_capabilities and the catalog carry each capability's profile", async () => {
  const { registerModuleTools } = await import("../src/modules/mcp-tools.js");
  const { h } = await host();
  const tools = new Map();
  registerModuleTools({ registerTool: (name, spec, handler) => tools.set(name, handler), registerResource() {} },
    { host: h, storeUri: "ui://s", storeHtml: "", visualUri: "ui://v", canvasPayload: async () => ({}), logSizes: (_n, r) => r, ensureImage: async () => ({}), saveCanvas: async () => {}, canvasLayers: () => [] });
  const caps = await tools.get("get_module_capabilities")({ module: "org.estampes.astrometry" });
  const solve = caps.structuredContent.capabilities.find((c) => c.id === "solve_field");
  assert.equal(solve.async, true);
  assert.equal(solve.profile.dataFlow.leavesServer, true);
  assert.ok(solve.profile.fallbacks.length >= 2 && solve.profile.reliability.verify);
  const store = await tools.get("store_get_catalog")({});
  const listed = store.structuredContent.modules.find((m) => m.id === "org.estampes.astrometry").capabilities.find((c) => c.id === "solve_field");
  assert.match(listed.profile.whenToUse, /夜空照片/, "the Store gets the Traditional Chinese text");
});
