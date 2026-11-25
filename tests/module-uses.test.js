// #174-2: a built-in module may call a capability of another module only if its manifest says so (`uses`). The call returns what that
// capability computes; the caller applies it as its own result. Both modules here are invented stand-ins; the core names neither.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { validateManifest, ManifestError } from "../src/modules/manifest.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { canvasObjects } from "../src/scene/scene-ops.js";
import { ensureImage } from "../src/storage.js";

const DRAWER = "org.example.drawer", ASKER = "org.example.asker";
const base = (id, caps, permissions) => ({ id, name: "Stand-in", description: "A stand-in module for tests.", version: "1.0.0", publisher: { name: "Example" },
  license: "MPL-2.0", category: "diagram", coreCompatibility: ">=0.10.0 <1.0.0", permissions, capabilities: caps });
const schema = { type: "object", properties: {}, additionalProperties: false };
const drawerManifest = { schema: "estampes.module/1", ...base(DRAWER, [
  { id: "draw", title: "draw", description: "Draws one axes object.", target: "canvas-or-new", inputSchema: schema, permissions: ["canvas.read", "canvas.write", "workspace.write"] },
  { id: "draw_more", title: "draw more", description: "Needs a permission the asker lacks.", target: "canvas", inputSchema: schema, permissions: ["canvas.read", "canvas.write", "asset.read.selected"] },
], ["canvas.read", "canvas.write", "workspace.write", "asset.read.selected"]), runtime: { kind: "builtin", entry: "drawer" } };
const askerCap = (id, uses) => ({ id, title: id, description: "Asks the drawer.", target: "document-or-new", needs: ["canvas.read", "canvas.write", "workspace.write"], inputSchema: schema, ...(uses ? { uses } : {}) });
const askerManifest = (caps) => ({ schema: "estampes.module/2", ...base(ASKER, caps, ["canvas.read", "canvas.write", "workspace.write"]), runtime: { kind: "builtin", entry: "asker", abi: 1 } });
const OPS = [{ op: "object.create", type: "axes-2d", props: { xRange: [-1, 1], yRange: [-1, 1] } }];

async function setup(askerCaps, askerRun) {
  const drawer = { manifest: drawerManifest, run: () => ({ operations: OPS, summary: "drawn" }) };
  const asker = { manifest: askerManifest(askerCaps), run: askerRun };
  process.env.ESTAMPES_MODULE_V2 = "on";
  const storage = await mkdtemp(join(tmpdir(), "estampes-uses-"));
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0", builtins: [drawer, asker],
    canvases: { ensure: ensureImage, create: async (o) => createBlankCanvas(o), save: async () => {} } });
  const enable = async (id) => { const plan = await h.lifecycle.prepare("enable", id); return h.lifecycle.commit(plan.planId, { consent: plan.consent }); };
  const disable = async (id) => { const plan = await h.lifecycle.prepare("disable", id); return h.lifecycle.commit(plan.planId, { consent: plan.consent }); };
  return { h, enable, disable };
}
const USES = [{ module: DRAWER, capability: "draw" }];
const run = (s, capability = "ask") => s.h.router.execute({ module: ASKER, capability, params: {}, newCanvas: {} });

test("a declared use returns the other module's operations, and the caller's result applies them", async () => {
  const s = await setup([askerCap("ask", USES)], async (cap, params, ctx) => await ctx.use(DRAWER, "draw", {}));
  await s.enable(DRAWER); await s.enable(ASKER);
  const out = await run(s);
  const axes = canvasObjects(out.entry).filter((o) => o.type === "axes-2d");
  assert.equal(axes.length, 1);
  assert.equal(axes[0].provenance?.module, ASKER, "the objects are the caller's: it applied them");
});

test("a capability the manifest did not declare cannot be used", async () => {
  const s = await setup([askerCap("ask", USES)], async (cap, params, ctx) => await ctx.use(DRAWER, "draw_more", {}));
  await s.enable(DRAWER); await s.enable(ASKER);
  await assert.rejects(run(s), /did not declare/);
  const none = await setup([askerCap("ask")], async (cap, params, ctx) => ({ data: { hasUse: typeof ctx.use } }));
  await none.enable(ASKER);
  assert.equal((await none.h.router.execute({ module: ASKER, capability: "ask", params: {}, newCanvas: {} })).data.hasUse, "undefined");
});

test("the other module missing or disabled is a clear error and changes nothing", async () => {
  const s = await setup([askerCap("ask", USES)], async (cap, params, ctx) => await ctx.use(DRAWER, "draw", {}));
  await s.enable(ASKER);
  await assert.rejects(run(s), (e) => e.code === "unavailable" && /org\.example\.drawer/.test(e.message));
});

test("both modules must hold what the used capability needs", async () => {
  const s = await setup([askerCap("ask", [{ module: DRAWER, capability: "draw_more" }])], async (cap, params, ctx) => await ctx.use(DRAWER, "draw_more", {}));
  await s.enable(DRAWER); await s.enable(ASKER);
  await assert.rejects(run(s), (e) => e.code === "permission" && /asset\.read\.selected/.test(e.message));
});

test("the other module being disabled while the caller works drops the result", async () => {
  let s;
  s = await setup([askerCap("ask", USES)], async (cap, params, ctx) => { const r = await ctx.use(DRAWER, "draw", {}); await s.disable(DRAWER); return r; });
  await s.enable(DRAWER); await s.enable(ASKER);
  await assert.rejects(run(s), (e) => e.code === "revoked");
});

test("a module cannot list itself under uses", () => {
  const m = { ...askerManifest([{ ...askerCap("ask", [{ module: ASKER, capability: "other" }]), operations: OPS }]), runtime: { kind: "declarative", entry: "operations", abi: 1 } };
  assert.throws(() => validateManifest(m, { v2: true }), (e) => e instanceof ManifestError && /does not list itself/.test(e.message));
});

test("the calculator reaches Graph only through its declared uses, never by importing it", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/builtin-modules/cas/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*\/graph\//, "no import of the Graph module's files");
  const manifest = JSON.parse(await readFile(new URL("../src/builtin-modules/cas/manifest.json", import.meta.url), "utf8"));
  for (const id of ["plot_result", "refresh_plot"]) {
    const uses = manifest.capabilities.find((c) => c.id === id).uses;
    assert.ok(uses?.length && uses.every((u) => u.module === "org.estampes.graph"), id + " declares what it uses");
  }
});
