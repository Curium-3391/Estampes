// UVA Phase 5A-2 (ADR-005): with ESTAMPES_MODULE_V2 on, a v2 package installs and
// runs. A v2 capability gets only the permissions it needs, is told what kind of
// document it works on (never an image id) and cannot name another document.
// With the flag off nothing changes and an installed v2 package is not run.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { resolveAdminKey, writeApproval } from "../src/modules/admin.js";
import { generateSigningKey, signBundle } from "../src/modules/packages.js";
import { catalogEntry } from "../src/modules/mcp-tools.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";

const callout = JSON.parse(await readFile(new URL("../examples/modules/callout/module.json", import.meta.url), "utf8"));
let created = 0;
const canvases = { ensure: ensureImage, create: async (o) => { created++; return createBlankCanvas(o); }, save: async () => {} };
const keys = generateSigningKey();
const sign = (manifest) => signBundle({ schema: "estampes.package/1", manifest: JSON.parse(JSON.stringify(manifest)), files: {} }, keys.privateKey, "pub1");
const v1 = (version = "1.0.0") => ({ ...structuredClone(callout), version, permissions: ["canvas.read", "canvas.write"], capabilities: callout.capabilities.map(({ examples, ...c }) => ({ ...c, permissions: undefined })) });
const v2 = (version = "1.0.0", id = "org.example.callout2") => {
  const m = v1(version);
  return { ...m, schema: "estampes.module/2", id, runtime: { ...m.runtime, abi: 1 },
    capabilities: m.capabilities.map(({ permissions, target, ...c }) => ({ ...c, target: "document", needs: ["canvas.write"] })) };
};

async function setup({ moduleV2 = true } = {}) {
  const storage = await mkdtemp(join(tmpdir(), "estampes-v2-"));
  const mods = join(storage, "modules");
  await mkdir(join(mods, "inbox"), { recursive: true });
  await writeFile(join(mods, "trusted-keys.json"), JSON.stringify([{ keyId: "pub1", publisher: "P", publicKey: keys.publicKey, scopes: ["org.example"] }]));
  const { key } = await resolveAdminKey({ storageDir: storage });
  const seen = [];
  // The declarative runtime is replaced by one that records what the module is given.
  const recorder = { async run(_mod, capability, _input, ctx) { seen.push({ capability, ctx }); return { operations: [] }; } };
  // The flag is the server's ESTAMPES_MODULE_V2, read when a package is checked.
  const boot = ({ moduleV2: on = moduleV2 } = {}) => {
    process.env.ESTAMPES_MODULE_V2 = on ? "on" : "off";
    return createModuleHost({ storageDir: storage, coreVersion: "0.10.0", canvases, adminKey: key, extraRuntimes: { declarative: recorder } });
  };
  const put = (name, bundle) => writeFile(join(mods, "inbox", name + ".estpkg.json"), JSON.stringify(bundle));
  const commit = async (h, action, id, opts = {}, approve = false) => {
    const plan = await h.lifecycle.prepare(action, id, opts);
    if (approve) await writeApproval(storage, key, plan.planId);
    await h.lifecycle.commit(plan.planId, { consent: plan.consent });
    return plan;
  };
  return { boot, put, commit, seen };
}
after(() => { delete process.env.ESTAMPES_MODULE_V2; });
const params = (text) => ({ x: 0.1, y: 0.1, x2: 0.4, y2: 0.2, text });

test("with the flag off a v2 package is refused with a reason and v1 modules are unchanged", async () => {
  const s = await setup({ moduleV2: false });
  await s.put("two", sign(v2())); await s.put("one", sign({ ...v1(), id: "org.example.one" }));
  const h = await s.boot();
  const list = await h.packages.available();
  assert.match(list.find((e) => e.file === "two.estpkg.json").error, /not enabled on this server yet/);
  assert.equal(list.find((e) => e.file === "one.estpkg.json").error, undefined);
});

test("with the flag on a v2 module runs with only the permissions it needs, a document kind and no image id", async () => {
  const s = await setup();
  await s.put("two", sign(v2())); await s.put("one", sign({ ...v1(), id: "org.example.one" }));
  const h = await s.boot();
  const plan = await s.commit(h, "install", "org.example.callout2", {}, true);
  assert.deepEqual(plan.abi, { from: null, to: 1, kind: "new" });
  await s.commit(h, "install", "org.example.one", {}, true);
  await s.commit(h, "enable", "org.example.callout2"); await s.commit(h, "enable", "org.example.one");
  assert.deepEqual(h.registry.record("org.example.callout2").granted.sort(), ["canvas.read", "canvas.write"], "the module was granted what it asked for");
  const canvas = await createBlankCanvas({});
  await h.router.execute({ module: "org.example.callout2", capability: "add_callout", canvas: canvas.imageId, params: params("t") });
  await h.router.execute({ module: "org.example.one", capability: "add_callout", canvas: canvas.imageId, params: params("t") });
  const [two, one] = [s.seen.at(-2).ctx, s.seen.at(-1).ctx];
  assert.deepEqual(two.permissions, ["canvas.write"], "only what the capability needs");
  assert.equal(two.canvas.imageId, undefined, "no image id for a v2 module");
  assert.equal(two.canvas.kind, "image");
  assert.equal(two.canvas.objects, undefined, "canvas.read was not needed, so the document's objects are not shown");
  assert.deepEqual(one.permissions.sort(), ["canvas.read", "canvas.write"], "v1: everything granted, as before");
  assert.equal(one.canvas.imageId, canvas.imageId);
  assert.ok(Array.isArray(one.canvas.objects));
  const entry = catalogEntry(h.registry.get("org.example.callout2"));
  assert.equal(entry.abi, 1);
  assert.equal(entry.capabilities[0].target, "document");
});

test("a v2 module cannot name another document in its input; its own id and plain text are fine", async () => {
  const s = await setup();
  await s.put("two", sign(v2()));
  const h = await s.boot();
  await s.commit(h, "install", "org.example.callout2", {}, true); await s.commit(h, "enable", "org.example.callout2");
  const own = await createBlankCanvas({}), other = await createBlankCanvas({});
  const run = (text, canvas = own.imageId) => h.router.execute({ module: "org.example.callout2", capability: "add_callout", canvas, params: params(text) });
  await run("hello"); await run(own.imageId); await run("see img:12 or gph:zz");
  await assert.rejects(run(other.imageId), (e) => e.code === "cross-document" && e.message.includes(other.imageId));
  await assert.rejects(run("gph:0123456789abcdef"), (e) => e.code === "cross-document");
  await assert.rejects(run("img:0123456789abcdef#c0a1"), (e) => e.code === "cross-document");
  // The same text is accepted for a v1 module: v1 behaviour is unchanged.
  await s.put("one", sign({ ...v1(), id: "org.example.one" }));
  await s.commit(h, "install", "org.example.one", {}, true); await s.commit(h, "enable", "org.example.one");
  await h.router.execute({ module: "org.example.one", capability: "add_callout", canvas: own.imageId, params: params(other.imageId) });
});

test("a refused cross-document call creates no new document", async () => {
  const s = await setup();
  const m = v2("1.0.0", "org.example.fresh");
  m.permissions = ["canvas.write", "workspace.write"];
  m.capabilities = m.capabilities.map((c) => ({ ...c, target: "document-or-new", needs: ["canvas.write", "workspace.write"] }));
  await s.put("fresh", sign(m));
  const h = await s.boot();
  await s.commit(h, "install", "org.example.fresh", {}, true); await s.commit(h, "enable", "org.example.fresh");
  const other = await createBlankCanvas({});
  const before = created;
  await assert.rejects(h.router.execute({ module: "org.example.fresh", capability: "add_callout", params: params(other.imageId) }), (e) => e.code === "cross-document");
  assert.equal(created, before, "nothing was created for the refused call");
  await h.router.execute({ module: "org.example.fresh", capability: "add_callout", params: params("fine") });
  assert.equal(created, before + 1, "an accepted call still creates its document");
});

test("an update with the same ABI says so; with the flag off again an installed v2 module is not run", async () => {
  const s = await setup();
  await s.put("two", sign(v2("1.0.0")));
  let h = await s.boot();
  await s.commit(h, "install", "org.example.callout2", {}, true); await s.commit(h, "enable", "org.example.callout2");
  await s.put("two-b", sign(v2("1.1.0")));
  const up = await h.lifecycle.prepare("update", "org.example.callout2");
  assert.deepEqual(up.abi, { from: 1, to: 1, kind: "same" });
  // Back to the default: the package is no longer valid for this server, so it is marked failed and never run.
  h = await s.boot({ moduleV2: false });
  assert.equal(h.registry.record("org.example.callout2").state, "failed");
  assert.match(h.registry.record("org.example.callout2").error, /not enabled on this server yet/);
  await assert.rejects(h.router.execute({ module: "org.example.callout2", capability: "add_callout", canvas: (await createBlankCanvas({})).imageId, params: params("t") }), /no module/);
  // Turning the flag on again loads the package again; like any package that failed to load it stays marked failed until it is enabled or reinstalled.
  h = await s.boot();
  assert.ok(h.registry.get("org.example.callout2"));
  assert.equal(h.registry.record("org.example.callout2").state, "failed");
});
