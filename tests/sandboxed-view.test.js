// U3: the manifest and package side of the `sandboxed-web` renderer: what a manifest may say, which package files must exist, and how the
// host serves them (ui.get) with a digest the widget can check. Invented module, in-process; the widget side is tests/sandboxed-view-e2e.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { resolveAdminKey, writeApproval } from "../src/modules/admin.js";
import { generateSigningKey, signBundle } from "../src/modules/packages.js";
import { validateManifest, ManifestError } from "../src/modules/manifest.js";
import { moduleViewsOf } from "../src/surface/module-views.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { createRecordStore } from "../src/uva/record-store.js";
import { createModelStore } from "../src/models/store.js";
import { config } from "../src/config.js";
import { hashJson } from "../src/documents/validation.js";

const ID = "org.example.circuit";
const keys = generateSigningKey();
const obj = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const cap = (id, extra) => ({ id, title: id, description: "Test capability " + id + ".", target: "none", needs: ["module.storage.write"], writes: ["circuit"], ...extra });
const PAYLOAD = { entry: "ui/index.html", assets: ["ui/app.js"], shims: ["no-service-worker", "memory-storage"], state: { model: "circuit", report: { action: "save_circuit", path: "/text", minIntervalMs: 1000 } } };
const manifest = (over = {}, payload = PAYLOAD) => ({ schema: "estampes.module/2", id: ID, name: "Circuit", description: "A package module with a web view.", version: "1.0.0",
  publisher: { name: "Example" }, license: "MPL-2.0", category: "electronics", coreCompatibility: ">=0.10.0", permissions: ["module.storage.write", "ui.sandboxed-frame"],
  models: [{ id: "circuit", dataVersion: 1, schema: obj({ text: { type: "string", maxLength: 40 } }, ["text"]), maxBytes: 512 }],
  runtime: { kind: "declarative", entry: "none", abi: 1 },
  capabilities: [
    cap("save_circuit", { inputSchema: obj({ id: { type: "string", maxLength: 20 }, revision: { type: "integer", minimum: 1 }, data: { type: "string", maxLength: 40 } }, ["data"]),
      models: [{ id: { $param: "id" }, model: "circuit", expectedRevision: { $param: "revision" }, value: { text: { $param: "data" } } }] }),
    { id: "read_only", title: "read_only", description: "A capability that writes nothing.", target: "none", needs: [], inputSchema: obj({}), operations: [] },
  ],
  views: [{ id: "panel", title: "Circuit", reads: ["circuit"], actions: ["save_circuit"], renderer: { type: "sandboxed-web", schema: "estampes.renderer.sandboxed-web/1", payload } }], ...over });
const HTML = '<!doctype html><html><head><script src="app.js"></script></head><body><p id="x">hello</p></body></html>';
const JS = "window.estampes.ready();";
const FILES = { "ui/index.html": { encoding: "utf8", content: HTML }, "ui/app.js": { encoding: "utf8", content: JS } };
const sha = (s) => createHash("sha256").update(s).digest("hex");

function fakeService() {
  const held = new Map();
  return { held, noteMirror() {}, recordKeys: async () => [...held.keys()], recordState: async (key) => held.get(key) ?? null,
    async syncRecord({ key, value, seq, log }) { held.set(key, { value, seq, log, valueHash: hashJson(value) }); return { status: "created", sourceHash: hashJson(value), logHash: hashJson(log ?? []), seq }; } };
}
async function setup(t, m = manifest(), files = FILES) {
  process.env.ESTAMPES_MODULE_V2 = "on";
  const storage = await mkdtemp(join(tmpdir(), "sandboxed-view-"));
  t.after(() => rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mods = join(storage, "modules");
  await mkdir(join(mods, "inbox"), { recursive: true });
  await writeFile(join(mods, "trusted-keys.json"), JSON.stringify([{ keyId: "pub1", publisher: "Example", publicKey: keys.publicKey, scopes: ["org.example"] }]));
  await writeFile(join(mods, "inbox", "circuit.estpkg.json"), JSON.stringify(signBundle({ schema: "estampes.package/1", manifest: m, files }, keys.privateKey, "pub1")));
  const { key } = await resolveAdminKey({ storageDir: storage });
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0", adminKey: key, canvases: { ensure: ensureImage, create: async (o) => createBlankCanvas(o), save: async () => {} } });
  const records = await createRecordStore({ service: fakeService(), storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
  t.after(() => records.close());
  h.models = createModelStore({ records });
  const approve = async (action) => { const p = await h.lifecycle.prepare(action, ID); if (p.requiresAdmin) await writeApproval(storage, key, p.planId); await h.lifecycle.commit(p.planId, { consent: p.consent }); return p; };
  return { h, approve, call: (capability, params) => h.router.execute({ module: ID, capability, params }) };
}
const refused = (m, re) => assert.throws(() => validateManifest(m, { coreVersion: "0.10.0", v2: true }), (e) => e instanceof ManifestError && re.test(e.message));

test("the sandboxed-web payload is checked at manifest time, without running any JS", () => {
  assert.doesNotThrow(() => validateManifest(manifest(), { coreVersion: "0.10.0", v2: true }));
  refused(manifest({ permissions: ["module.storage.write"] }), /ui\.sandboxed-frame/);
  refused(manifest({}, { ...PAYLOAD, entry: "index.html" }), /payload\.entry/);
  refused(manifest({}, { ...PAYLOAD, entry: "ui/../index.html" }), /payload\.entry/);
  refused(manifest({}, { ...PAYLOAD, assets: ["https://example.com/app.js"] }), /payload\.assets\[0\]/);
  refused(manifest({}, { ...PAYLOAD, assets: ["ui/app.js", "ui/app.js"] }), /listed twice/);
  refused(manifest({}, { ...PAYLOAD, shims: ["eval-everything"] }), /not a shim/);
  refused(manifest({}, { ...PAYLOAD, url: "https://example.com" }), /not part of/);
  refused(manifest({}, { ...PAYLOAD, state: { model: "other", report: PAYLOAD.state.report } }), /state\.model/);
  refused(manifest({}, { ...PAYLOAD, state: { model: "circuit", report: { ...PAYLOAD.state.report, action: "nope" } } }), /report\.action/);
  refused(manifest({}, { ...PAYLOAD, state: { model: "circuit", report: { ...PAYLOAD.state.report, minIntervalMs: 5 } } }), /minIntervalMs/);
  refused(manifest({}, { ...PAYLOAD, state: { model: "circuit", report: { ...PAYLOAD.state.report, path: "/a/b/c/d/e" } } }), /JSON pointer/);
  // The report action has to be one that writes the model: a read-only capability cannot keep the state.
  const m = manifest(); m.views[0].actions = ["save_circuit", "read_only"];
  m.views[0].renderer.payload = { ...PAYLOAD, state: { model: "circuit", report: { ...PAYLOAD.state.report, action: "read_only" } } };
  refused(m, /writes circuit/);
});

test("a package that names a UI file it does not contain is refused at install", async (t) => {
  const s = await setup(t, manifest(), { "ui/index.html": FILES["ui/index.html"] });
  const [row] = await s.h.packages.available();
  assert.match(row.error, /ui\/app\.js.*not a file of the package/);
  await assert.rejects(() => s.h.lifecycle.prepare("install", ID), /no verified package/);
});

test("ui.get serves the verified package file in chunks, with a digest of the whole file", async (t) => {
  const big = "A".repeat(200 * 1024) + "end";
  const s = await setup(t, manifest({}, { ...PAYLOAD, assets: ["ui/app.js", "ui/big.txt"] }), { ...FILES, "ui/big.txt": { encoding: "utf8", content: big } });
  const plan = await s.approve("install");
  assert.ok(plan.permissions?.some?.((p) => p.id === "ui.sandboxed-frame" && p.risk === "high") || plan.risk === "high", "the Store shows the frame permission as high risk");
  await s.approve("enable");
  const first = await s.call("ui.get", { path: "ui/big.txt" });
  assert.equal(first.data.size, big.length);
  assert.equal(first.data.sha256, sha(big));
  assert.equal(first.data.done, false);
  let got = Buffer.alloc(0), r = first, calls = 1;
  for (; calls < 100; calls++) { got = Buffer.concat([got, Buffer.from(r.data.chunk, "base64")]); if (r.data.done) break; r = await s.call("ui.get", { path: "ui/big.txt", offset: got.length }); }
  assert.ok(calls > 1, "a 200 KB file needs more than one chunk");
  assert.equal(got.toString(), big);
  await assert.rejects(() => s.call("ui.get", { path: "ui/missing.js" }), /no UI file/);
  await assert.rejects(() => s.call("ui.get", { path: "ui/index.html", offset: 99999 }), /past the end/);
});

test("the surface tells the widget which files to fetch and the digest each must have", async (t) => {
  const s = await setup(t);
  await s.approve("install"); await s.approve("enable");
  const view = { panels: [{ panelId: "p:view-panel", kind: "module-view", module: ID, view: "panel", open: true }] };
  const out = await moduleViewsOf({ view, registry: s.h.registry, models: s.h.models });
  const def = out["p:view-panel"];
  assert.equal(def.renderer.type, "sandboxed-web");
  assert.deepEqual(def.frame, { capability: "ui.get", entry: "ui/index.html", files: [
    { path: "ui/index.html", bytes: Buffer.byteLength(HTML), sha256: sha(HTML) }, { path: "ui/app.js", bytes: Buffer.byteLength(JS), sha256: sha(JS) }] });
});

test("without the granted permission a module's frame files are not served", async (t) => {
  const s = await setup(t);
  await s.approve("install");
  await assert.rejects(() => s.call("ui.get", { path: "ui/index.html" }), /only the user can enable it/i);
});

test("a ui.get chunk fits the server's result budget even when it is sent twice", async (t) => {
  const big = "B".repeat(300 * 1024);
  const s = await setup(t, manifest({}, { ...PAYLOAD, assets: ["ui/app.js", "ui/big.txt"] }), { ...FILES, "ui/big.txt": { encoding: "utf8", content: big } });
  await s.approve("install"); await s.approve("enable");
  const first = await s.call("ui.get", { path: "ui/big.txt" });
  // text content and structured content each carry the data once, as the module tools build a result
  const wire = JSON.stringify({ content: [{ type: "text", text: "x ui.get: " + first.summary + " " + JSON.stringify(first.data) }], structuredContent: { data: first.data } });
  assert.ok(wire.length <= config.maxResultChars, wire.length + " characters against a budget of " + config.maxResultChars);
  assert.ok(first.data.chunk.length > 20000, "a chunk is still a useful size");
  // the whole file still arrives, in order
  let got = Buffer.alloc(0), r = first;
  for (let i = 0; i < 100; i++) { got = Buffer.concat([got, Buffer.from(r.data.chunk, "base64")]); if (r.data.done) break; r = await s.call("ui.get", { path: "ui/big.txt", offset: got.length }); }
  assert.equal(got.toString(), big);
});
