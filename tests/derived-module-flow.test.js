// 5B-2b-2: a module/2 module becomes a producer through its manifest and its
// output alone. The module here is a stand-in with an invented name; the same
// path will carry the calculator. Nothing in the core knows either.
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
  license: "MPL-2.0", category: "diagram", coreCompatibility: ">=0.10.0 <1.0.0", runtime: { kind: "declarative", entry: "operations", abi: 1 }, permissions: ["canvas.write"], capabilities: caps });
const CAPS = () => [cap("make", { derives: { refresh: "remake" } }), cap("remake", REFRESH_IN), cap("announce"), cap("plain")];
const sign = (m) => signBundle({ schema: "estampes.package/1", manifest: structuredClone(m), files: {} }, keys.privateKey, "pub1");
after(() => { delete process.env.ESTAMPES_MODULE_V2; });

// What each capability of the stand-in answers, by module and capability.
const answers = {};
async function setup() {
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
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0", canvases, adminKey: key, extraRuntimes: { declarative: runtime } });
  const install = async (id, m = manifest(id, CAPS())) => {
    await writeFile(join(mods, "inbox", id + ".estpkg.json"), JSON.stringify(sign(m)));
    for (const action of ["install", "enable"]) {
      const plan = await h.lifecycle.prepare(action, id, {});
      if (action === "install") await writeApproval(storage, key, plan.planId);
      await h.lifecycle.commit(plan.planId, { consent: plan.consent });
    }
  };
  const flow = createDerivedFlow({ router: h.router, registry: h.registry, canvases });
  return { h, install, calls, saves, flow, canvases };
}
const MAKER = "org.example.maker", OTHER = "org.example.other";
const make = (n = 1, ref = "ref-1", rev = 1) => () => ({ operations: [{ op: "object.create", ref: "p", type: "axes-2d", props: range(n) }], derived: [{ object: "$p", sourceRef: ref, sourceRevision: rev, inputsHash: HASH }] });
const remake = (n, rev) => (input) => ({ operations: [{ op: "object.update", id: input.object ?? "o1", props: range(n) }], data: { sourceRevision: rev } });
const announce = (sourceRef) => () => ({ broadcast: [{ event: "source-changed", ...(sourceRef ? { sourceRef } : {}) }] });
const run = (s, module, capability, canvas) => s.h.router.execute({ module, capability, canvas, params: {} });

test("the manifest says which capability refreshes what a capability makes, and refuses nonsense", () => {
  const ok = (caps) => validateManifest(manifest(MAKER, caps), { v2: true });
  assert.equal(ok(CAPS()).capabilities[0].derives.refresh, "remake");
  const bad = (caps, re) => assert.throws(() => ok(caps), (e) => e instanceof ManifestError && re.test(e.message));
  bad([cap("make", { derives: { refresh: "nope" } })], /no capability nope/);
  bad([cap("make", { derives: { refresh: "remake" } }), cap("remake")], /must accept the string fields/);
  bad([cap("make", { derives: { refresh: "make" } })], /different one/);
  bad([cap("make", { derives: { refresh: "remake" } }), cap("remake", { derives: { refresh: "make" } })], /cannot create derived/);
  bad([cap("make", { derives: { refresh: "remake" } }), cap("remake", { target: "none", needs: [] })], /work on the document/);
  bad([cap("make", { derives: { refresh: "remake" }, async: true, profile: { whenToUse: "x", cost: { latency: "hours" } } }), cap("remake", REFRESH_IN)], /not async|answer at once/);
  assert.throws(() => validateManifest({ ...manifest(MAKER, CAPS()), schema: "estampes.module/1", runtime: { kind: "declarative", entry: "operations" } }, { v2: true }), ManifestError);
});

test("a capability that makes derived objects is recorded, saved with them, and listed", async () => {
  const s = await setup();
  await s.install(MAKER);
  answers[MAKER + "/make"] = make(1, "ref-1", 1);
  const canvas = await createBlankCanvas({});
  const r = await run(s, MAKER, "make", canvas.imageId);
  assert.equal(r.derived.registered.length, 1);
  const [b] = bindingsOf(canvas);
  assert.deepEqual([b.state, b.target.id, b.source.module, b.source.capability, b.source.sourceRef], ["fresh", r.scene.created[0], MAKER, "make", "ref-1"]);
  assert.equal(s.saves.length, 1, "the objects and their binding are saved together");
  const listed = await s.flow.list(canvas.imageId);
  assert.deepEqual([listed.total, listed.counts, listed.bindings[0].object], [1, { fresh: 1 }, b.target.id]);
  assert.match(listed.bindings[0].bindingHash, /^[0-9a-f]{64}$/);
});

test("derived and broadcast are refused unless the module is module/2 and declared it", async () => {
  const s = await setup();
  await s.install(MAKER);
  const canvas = await createBlankCanvas({});
  answers[MAKER + "/plain"] = make();
  await assert.rejects(run(s, MAKER, "plain", canvas.imageId), (e) => e.code === "output" && /does not declare derives/.test(e.message));
  answers[MAKER + "/make"] = () => ({ operations: [{ op: "object.create", ref: "p", type: "axes-2d", props: range(1) }], derived: [{ object: "$other", sourceRef: "x", sourceRevision: 1, inputsHash: HASH }] });
  await assert.rejects(run(s, MAKER, "make", canvas.imageId), (e) => e.code === "output" && /creates with a ref/.test(e.message));
  answers[MAKER + "/make"] = () => ({ operations: [{ op: "object.create", ref: "p", type: "axes-2d", props: range(1) }], derived: [{ object: "$p", sourceRef: "x", sourceRevision: 1, inputsHash: "nope" }] });
  await assert.rejects(run(s, MAKER, "make", canvas.imageId), (e) => e.code === "output");
  assert.equal(canvas.objects?.size ?? 0, 0, "a refused run leaves the document alone");
  assert.equal(bindingsOf(canvas).length, 0);
});

test("a broadcast makes the module's matching bindings stale, and only that module's", async () => {
  const s = await setup();
  await s.install(MAKER); await s.install(OTHER);
  const canvas = await createBlankCanvas({});
  answers[MAKER + "/make"] = make(1, "ref-1");
  await run(s, MAKER, "make", canvas.imageId);
  answers[MAKER + "/make"] = make(2, "ref-2");
  await run(s, MAKER, "make", canvas.imageId);
  // Another module naming the same sourceRef, or none, changes nothing of this module's.
  answers[OTHER + "/announce"] = announce("ref-1");
  const none = await run(s, OTHER, "announce", canvas.imageId);
  assert.deepEqual(none.derived.staled, []);
  answers[OTHER + "/announce"] = announce();
  assert.deepEqual((await run(s, OTHER, "announce", canvas.imageId)).derived.staled, []);
  assert.deepEqual(bindingsOf(canvas).map((b) => b.state), ["fresh", "fresh"]);
  // The owner, naming one source.
  answers[MAKER + "/announce"] = announce("ref-2");
  const one = await run(s, MAKER, "announce", canvas.imageId);
  assert.equal(one.derived.staled.length, 1);
  assert.deepEqual(bindingsOf(canvas).map((b) => b.state), ["fresh", "stale"]);
  // Without a sourceRef, all of its own.
  answers[MAKER + "/announce"] = announce();
  await run(s, MAKER, "announce", canvas.imageId);
  assert.deepEqual(bindingsOf(canvas).map((b) => b.state), ["stale", "stale"]);
});

test("refreshing calls the module's declared refresh capability with the source and the object, and records what it wrote", async () => {
  const s = await setup();
  await s.install(MAKER);
  const canvas = await createBlankCanvas({});
  answers[MAKER + "/make"] = make(1, "ref-1", 1);
  const made = await run(s, MAKER, "make", canvas.imageId);
  const id = made.scene.created[0];
  answers[MAKER + "/announce"] = announce();
  await run(s, MAKER, "announce", canvas.imageId);
  answers[MAKER + "/remake"] = remake(5, 2);
  const out = await s.flow.update({ canvas: canvas.imageId, action: "refresh-stale" });
  assert.equal(out.result.refreshed.length, 1);
  const call = s.calls.filter((c) => c.capability === "remake").at(-1);
  assert.deepEqual(call.input, { sourceRef: "ref-1", object: id });
  assert.deepEqual(canvas.objects.get(id).props.xRange, [-5, 5]);
  const [b] = bindingsOf(canvas);
  assert.deepEqual([b.state, b.source.sourceRevision, b.lastApplied.objectRevision], ["fresh", 2, canvas.objects.get(id).revision]);
});

test("a refresh may only update its own object and may not make derived objects or broadcast; the object stays as it was", async () => {
  const s = await setup();
  await s.install(MAKER);
  const canvas = await createBlankCanvas({});
  answers[MAKER + "/make"] = make(1);
  const id = (await run(s, MAKER, "make", canvas.imageId)).scene.created[0];
  answers[MAKER + "/announce"] = announce();
  answers[MAKER + "/plain"] = () => ({ operations: [{ op: "object.create", type: "axes-2d", props: range(7) }] });
  const stranger = (await run(s, MAKER, "plain", canvas.imageId)).scene.created[0];
  const cases = {
    "creates another object": () => ({ operations: [{ op: "object.create", type: "axes-2d", props: range(3) }], data: { sourceRevision: 2 } }),
    "updates another object": () => ({ operations: [{ op: "object.update", id: stranger, props: range(3) }], data: { sourceRevision: 2 } }),
    "broadcasts": () => ({ operations: [{ op: "object.update", id, props: range(3) }], broadcast: [{ event: "source-changed" }], data: { sourceRevision: 2 } }),
    "forgets the source revision": () => ({ operations: [{ op: "object.update", id, props: range(3) }] }),
  };
  for (const [name, reply] of Object.entries(cases)) {
    await run(s, MAKER, "announce", canvas.imageId);
    answers[MAKER + "/remake"] = reply;
    const out = await s.flow.update({ canvas: canvas.imageId, action: "refresh-stale" });
    assert.equal(out.result.failed.length, 1, name);
    assert.equal(bindingsOf(canvas)[0].state, "error", name);
    // A refused reply changes nothing; a reply the module itself wrote but left without a revision stays as the module wrote it.
    if (name !== "forgets the source revision") assert.deepEqual(canvas.objects.get(id).props.xRange, [-1, 1], name + ": the object is untouched");
    assert.equal(canvas.objects.size, 2, name);
    // Back to a good state for the next case.
    answers[MAKER + "/remake"] = remake(1, 2 + Object.keys(cases).indexOf(name));
    const list = await s.flow.list(canvas.imageId);
    const act = async (action) => { const l = await s.flow.list(canvas.imageId); await s.flow.update({ canvas: canvas.imageId, action, binding: l.bindings[0].id, expectedBindingHash: l.bindings[0].bindingHash }); };
    await act("refresh");
    // An object the module changed without reporting a revision no longer matches what was applied: that is a conflict, and a person resolves it.
    if (bindingsOf(canvas)[0].state === "conflict") await act("overwrite");
    assert.equal(bindingsOf(canvas)[0].state, "fresh", name + ": a good refresh recovers it");
  }
});

test("an object the person edited is not rewritten; overwrite is the person's choice, and afterwards refreshes work again", async () => {
  const s = await setup();
  await s.install(MAKER);
  const canvas = await createBlankCanvas({});
  answers[MAKER + "/make"] = make(1);
  const id = (await run(s, MAKER, "make", canvas.imageId)).scene.created[0];
  applySceneOps(canvas, [{ op: "object.update", id, props: range(7) }], { author: "user" });
  answers[MAKER + "/announce"] = announce();
  await run(s, MAKER, "announce", canvas.imageId);
  answers[MAKER + "/remake"] = remake(5, 2);
  const before = s.calls.length;
  const out = await s.flow.update({ canvas: canvas.imageId, action: "refresh-stale" });
  assert.deepEqual([out.result.paused.length, out.result.refreshed.length], [1, 0]);
  assert.equal(s.calls.length, before, "the module was not asked");
  assert.deepEqual(canvas.objects.get(id).props.xRange, [-7, 7]);
  let [row] = (await s.flow.list(canvas.imageId)).bindings;
  assert.equal(row.state, "conflict");
  await assert.rejects(s.flow.update({ canvas: canvas.imageId, action: "overwrite", binding: row.id, expectedBindingHash: "0".repeat(64) }), { code: "STALE_BINDING" });
  await assert.rejects(s.flow.update({ canvas: canvas.imageId, action: "refresh", binding: row.id, expectedBindingHash: row.bindingHash }), { code: "ILLEGAL_ACTION" });
  const done = await s.flow.update({ canvas: canvas.imageId, action: "overwrite", binding: row.id, expectedBindingHash: row.bindingHash });
  assert.equal(done.result.outcome, "refreshed");
  assert.deepEqual(canvas.objects.get(id).props.xRange, [-5, 5]);
  // The flag that a person once edited it stays on the object, but it is not an edit made after the module's last write.
  assert.equal(canvas.objects.get(id).provenance.editedByUser, true);
  await run(s, MAKER, "announce", canvas.imageId);
  answers[MAKER + "/remake"] = remake(9, 3);
  const again = await s.flow.update({ canvas: canvas.imageId, action: "refresh-stale" });
  assert.equal(again.result.refreshed.length, 1);
  assert.deepEqual(canvas.objects.get(id).props.xRange, [-9, 9]);
});

test("a disabled module's bindings are unavailable and come back stale when it is enabled again; a deleted object is removed", async () => {
  const s = await setup();
  await s.install(MAKER);
  const canvas = await createBlankCanvas({});
  answers[MAKER + "/make"] = make(1, "a");
  await run(s, MAKER, "make", canvas.imageId);
  answers[MAKER + "/make"] = make(2, "b");
  const second = (await run(s, MAKER, "make", canvas.imageId)).scene.created[0];
  const plan = await s.h.lifecycle.prepare("disable", MAKER, {});
  await s.h.lifecycle.commit(plan.planId, { consent: plan.consent });
  assert.deepEqual((await s.flow.list(canvas.imageId)).bindings.map((b) => b.state), ["unavailable", "unavailable"]);
  const back = await s.h.lifecycle.prepare("enable", MAKER, {});
  await s.h.lifecycle.commit(back.planId, { consent: back.consent });
  assert.deepEqual((await s.flow.list(canvas.imageId)).bindings.map((b) => b.state), ["stale", "stale"]);
  applySceneOps(canvas, [{ op: "object.delete", id: second }], { author: "user" });
  const states = (await s.flow.list(canvas.imageId)).bindings.map((b) => b.state).sort();
  assert.deepEqual(states, ["removed", "stale"]);
});

test("a refresh that was cut off (the binding was left recomputing) is reported as an error after a restart, not left running", async () => {
  const s = await setup();
  await s.install(MAKER);
  const canvas = await createBlankCanvas({});
  answers[MAKER + "/make"] = make(1);
  await run(s, MAKER, "make", canvas.imageId);
  canvas.derived = bindingsOf(canvas).map((b) => ({ ...b, state: "recomputing" }));
  const [row] = (await s.flow.list(canvas.imageId)).bindings;
  assert.equal(row.state, "error");
  assert.match(row.reason, /interrupted/);
});
