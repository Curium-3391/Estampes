// 5B-4: objects a module made before bindings existed are adopted when their document is
// opened, through a capability the module declares (`derives.adopt`). The module here is a
// stand-in with an invented name; the calculator uses the same path. Nothing in the core knows either.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { resolveAdminKey, writeApproval } from "../src/modules/admin.js";
import { generateSigningKey, signBundle } from "../src/modules/packages.js";
import { validateManifest, ManifestError } from "../src/modules/manifest.js";
import { createDerivedFlow } from "../src/modules/derived-flow.js";
import { createDerivedIndex } from "../src/documents/derived-index.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { applySceneOps } from "../src/scene/scene-ops.js";
import { ensureImage } from "../src/storage.js";
import { bindingsOf } from "../src/documents/derived-coordinator.js";

const keys = generateSigningKey();
const HASH = "d".repeat(64);
const range = (n) => ({ xRange: [-n, n], yRange: [-n, n] });
const OPS = [{ op: "object.create", type: "axes-2d", props: { xRange: [-1, 1], yRange: [-1, 1] } }];
const cap = (id, extra = {}) => ({ id, title: id, description: "stand-in " + id, target: "document", needs: ["canvas.write"], operations: OPS,
  inputSchema: { type: "object", properties: {}, additionalProperties: false }, ...extra });
const REFRESH_IN = { inputSchema: { type: "object", properties: { sourceRef: { type: "string", maxLength: 200 }, object: { type: "string", maxLength: 64 } }, additionalProperties: false } };
const manifest = (id, caps) => ({ schema: "estampes.module/2", id, name: "Stand-in", description: "A stand-in producer for tests.", version: "1.0.0", publisher: { name: "Example" },
  license: "MPL-2.0", category: "diagram", coreCompatibility: ">=0.10.0 <1.0.0", runtime: { kind: "declarative", entry: "operations", abi: 1 }, permissions: ["canvas.read", "canvas.write"], capabilities: caps });
const ADOPT_IN = { needs: ["canvas.read", "canvas.write"], operations: [], inputSchema: { type: "object", required: ["canvas"], properties: { canvas: { type: "string", maxLength: 100 } }, additionalProperties: false } };
const CAPS = () => [cap("make", { derives: { refresh: "remake", adopt: "adopt" } }), cap("remake", REFRESH_IN), cap("adopt", ADOPT_IN), cap("announce"), cap("plain")];
const sign = (m) => signBundle({ schema: "estampes.package/1", manifest: structuredClone(m), files: {} }, keys.privateKey, "pub1");
after(() => { delete process.env.ESTAMPES_MODULE_V2; });

// What each capability of the stand-in answers, by module and capability.
const answers = {};
async function setup({ builtins } = {}) {
  for (const k of Object.keys(answers)) delete answers[k];
  const storage = await mkdtemp(join(tmpdir(), "estampes-derived-"));
  const mods = join(storage, "modules");
  await mkdir(join(mods, "inbox"), { recursive: true });
  await writeFile(join(mods, "trusted-keys.json"), JSON.stringify([{ keyId: "pub1", publisher: "P", publicKey: keys.publicKey, scopes: ["org.example"] }]));
  const { key } = await resolveAdminKey({ storageDir: storage });
  const calls = [], saves = [];
  const runtime = { async run(mod, capability, input, ctx) { calls.push({ module: mod.manifest.id, capability, input }); return structuredClone(await (answers[mod.manifest.id + "/" + capability] ?? (() => ({ operations: OPS })))(input, ctx)); } };
  const canvases = { ensure: ensureImage, create: async (o) => createBlankCanvas(o), save: async (entry, h) => { saves.push(h); } };
  process.env.ESTAMPES_MODULE_V2 = "on";
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0", canvases, adminKey: key, extraRuntimes: { declarative: runtime }, ...(builtins ? { builtins } : {}) });
  const install = async (id, m = manifest(id, CAPS())) => {
    await writeFile(join(mods, "inbox", id + ".estpkg.json"), JSON.stringify(sign(m)));
    for (const action of ["install", "enable"]) {
      const plan = await h.lifecycle.prepare(action, id, {});
      if (action === "install") await writeApproval(storage, key, plan.planId);
      await h.lifecycle.commit(plan.planId, { consent: plan.consent });
    }
  };
  const flow = createDerivedFlow({ router: h.router, registry: h.registry, canvases, index: h.derivedIndex });
  return { h, install, calls, saves, flow, canvases };
}
const MAKER = "org.example.maker", OTHER = "org.example.other";
const make = (n = 1, ref = "ref-1", rev = 1) => () => ({ operations: [{ op: "object.create", ref: "p", type: "axes-2d", props: range(n) }], derived: [{ object: "$p", sourceRef: ref, sourceRevision: rev, inputsHash: HASH }] });
const remake = (n, rev) => (input) => ({ operations: [{ op: "object.update", id: input.object ?? "o1", props: range(n) }], data: { sourceRevision: rev } });
const announce = (sourceRef) => () => ({ broadcast: [{ event: "source-changed", ...(sourceRef ? { sourceRef } : {}) }] });
const run = (s, module, capability, canvas) => s.h.router.execute({ module, capability, canvas, params: {} });


const plain = (canvas, n = 2) => applySceneOps(canvas, Array.from({ length: n }, (_, i) => ({ op: "object.create", type: "axes-2d", props: range(i + 1) })), { author: "module", module: MAKER, capability: "make" });
const adoptAnswer = (list) => () => ({ derived: list.map((d) => ({ sourceRevision: 1, inputsHash: HASH, ...d })), data: { adopted: list.length } });

test("the manifest declares the adopt capability and refuses nonsense", () => {
  const ok = (caps) => validateManifest(manifest(MAKER, caps), { v2: true });
  assert.equal(ok(CAPS()).capabilities[0].derives.adopt, "adopt");
  const bad = (caps, re) => assert.throws(() => ok(caps), (e) => e instanceof ManifestError && re.test(e.message));
  bad([cap("make", { derives: { refresh: "remake", adopt: "nope" } }), cap("remake", REFRESH_IN)], /no capability nope/);
  bad([cap("make", { derives: { refresh: "remake", adopt: "remake" } }), cap("remake", REFRESH_IN)], /different one/);
  bad([cap("make", { derives: { refresh: "remake", adopt: "adopt" } }), cap("remake", REFRESH_IN), cap("adopt")], /must accept the string field canvas/);
  bad([cap("make", { derives: { refresh: "remake", adopt: "adopt" } }), cap("remake", REFRESH_IN), cap("adopt", { ...ADOPT_IN, async: true })], /answer at once/);
});

test("opening a document adopts the objects the module names, once, and records stale and edited ones as such", async () => {
  const s = await setup();
  await s.install(MAKER);
  const canvas = await createBlankCanvas({});
  plain(canvas, 3);
  // The person had already edited o3 before it was adopted.
  applySceneOps(canvas, [{ op: "object.update", id: "o3", props: range(9) }], { author: "user" });
  answers[MAKER + "/adopt"] = adoptAnswer([{ object: "o1", sourceRef: "book/1" }, { object: "o2", sourceRef: "book/2", stale: true }, { object: "o3", sourceRef: "book/3" }]);
  const listed = await s.flow.list(canvas.imageId);
  assert.equal(listed.total, 3);
  const by = Object.fromEntries(listed.bindings.map((b) => [b.object, b.state]));
  assert.deepEqual(by, { o1: "fresh", o2: "stale", o3: "fresh" });
  assert.deepEqual(bindingsOf(canvas).map((b) => [b.source.capability, b.source.sourceRef]), [["make", "book/1"], ["make", "book/2"], ["make", "book/3"]], "recorded under the capability that made them");
  assert.equal(s.calls.filter((c) => c.capability === "adopt").length, 1);
  assert.deepEqual(s.calls.find((c) => c.capability === "adopt").input, { canvas: canvas.imageId }, "the module is told which document");
  // Asked once per document: listing again does not run it again.
  await s.flow.list(canvas.imageId);
  assert.equal(s.calls.filter((c) => c.capability === "adopt").length, 1);
});

test("adoption is idempotent: objects that already have a binding, or are gone, are skipped, and a repeat adds nothing", async () => {
  const s = await setup();
  await s.install(MAKER);
  const canvas = await createBlankCanvas({});
  plain(canvas, 2);
  answers[MAKER + "/adopt"] = adoptAnswer([{ object: "o1", sourceRef: "book/1" }, { object: "o2", sourceRef: "book/2" }, { object: "o77", sourceRef: "book/9" }]);
  await s.flow.list(canvas.imageId);
  assert.equal(bindingsOf(canvas).length, 2, "o77 is not on the document");
  // A second flow (a restart) asks again; nothing is duplicated.
  const again = createDerivedFlow({ router: s.h.router, registry: s.h.registry, canvases: s.canvases, index: s.h.derivedIndex });
  await again.list(canvas.imageId);
  assert.equal(s.calls.filter((c) => c.capability === "adopt").length, 2);
  assert.equal(bindingsOf(canvas).length, 2);
});

test("an adopt run that draws, broadcasts, names a $ref or runs outside the core's call is refused and changes nothing", async () => {
  const s = await setup();
  await s.install(MAKER);
  const canvas = await createBlankCanvas({});
  plain(canvas, 1);
  const adopt = (internal) => s.h.router.execute({ module: MAKER, capability: "adopt", canvas: canvas.imageId, params: { canvas: canvas.imageId }, internal });
  answers[MAKER + "/adopt"] = adoptAnswer([{ object: "o1", sourceRef: "x" }]);
  await assert.rejects(adopt(undefined), (e) => e.code === "output" && /by its \$ref/.test(e.message));
  answers[MAKER + "/adopt"] = () => ({ operations: [{ op: "object.create", type: "axes-2d", props: range(1) }], derived: [{ object: "o1", sourceRef: "x", sourceRevision: 1, inputsHash: HASH }] });
  await assert.rejects(adopt({ adopt: "make" }), (e) => e.code === "output" && /only name existing objects/.test(e.message));
  answers[MAKER + "/adopt"] = adoptAnswer([{ object: "$p", sourceRef: "x" }]);
  await assert.rejects(adopt({ adopt: "make" }), (e) => e.code === "output" && /by id/.test(e.message));
  await assert.rejects(adopt({ adopt: "plain" }), (e) => e.code === "output" && /not declared as the adopt capability/.test(e.message));
  assert.equal(bindingsOf(canvas).length, 0);
  // A module that is not module/2 cannot name derived objects at all (an adopt run is not a way around it).
  answers[MAKER + "/adopt"] = adoptAnswer([{ object: "o1", sourceRef: "x" }]);
  assert.equal((await adopt({ adopt: "make" })).derived.registered.length, 1);
});

test("a person's earlier edit still pauses the first refresh after adoption", async () => {
  const s = await setup();
  await s.install(MAKER);
  const canvas = await createBlankCanvas({});
  plain(canvas, 1);
  applySceneOps(canvas, [{ op: "object.update", id: "o1", props: range(7) }], { author: "user" });
  answers[MAKER + "/adopt"] = adoptAnswer([{ object: "o1", sourceRef: "book/1", stale: true }]);
  await s.flow.list(canvas.imageId);
  answers[MAKER + "/remake"] = remake(2, 2);
  const r = await s.flow.update({ canvas: canvas.imageId, action: "refresh-stale" });
  assert.equal(r.result.refreshed.length, 0, JSON.stringify(r.result));
  assert.equal(bindingsOf(canvas)[0].state, "conflict", "the edit made before adoption is kept");
});
