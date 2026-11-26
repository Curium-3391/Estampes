// U2: a signed package module (declarative runtime, estampes.module/2) writes its own model instances through a `models` template.
// The router's checks are the ones every module meets; nothing new can write. Invented module, in-process, fake UVA document service.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { resolveAdminKey, writeApproval } from "../src/modules/admin.js";
import { generateSigningKey, signBundle } from "../src/modules/packages.js";
import { validateManifest, ManifestError } from "../src/modules/manifest.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { createRecordStore } from "../src/uva/record-store.js";
import { createModelStore } from "../src/models/store.js";
import { hashJson } from "../src/documents/validation.js";

const ID = "org.example.circuit";
const keys = generateSigningKey();
const obj = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const cap = (id, extra) => ({ id, title: id, description: "Test capability " + id + ".", target: "none", needs: ["module.storage.write"], writes: ["circuit"], ...extra });
const manifest = (over = {}) => ({ schema: "estampes.module/2", id: ID, name: "Circuit", description: "A package module that keeps its own data.", version: "1.0.0",
  publisher: { name: "Example" }, license: "MPL-2.0", category: "electronics", coreCompatibility: ">=0.10.0", permissions: ["module.storage.write"],
  models: [{ id: "circuit", dataVersion: 1, schema: obj({ text: { type: "string", maxLength: 40 } }, ["text"]), maxBytes: 512 }],
  runtime: { kind: "declarative", entry: "none", abi: 1 },
  capabilities: [
    cap("create_circuit", { inputSchema: obj({ text: { type: "string", maxLength: 100 } }, ["text"]), models: [{ ref: "$c", model: "circuit", value: { text: { $param: "text" } } }] }),
    cap("set_circuit", { inputSchema: obj({ id: { type: "string", maxLength: 20 }, revision: { type: "integer", minimum: 1 }, text: { type: "string", maxLength: 100 } }, ["id", "revision", "text"]),
      models: [{ id: { $param: "id" }, model: "circuit", expectedRevision: { $param: "revision" }, value: { text: { $param: "text" } } }] }),
  ], ...over });

function fakeService() {
  const held = new Map();
  return { held, noteMirror() {}, recordKeys: async () => [...held.keys()], recordState: async (key) => held.get(key) ?? null,
    async syncRecord({ key, value, seq, log }) { held.set(key, { value, seq, log, valueHash: hashJson(value) }); return { status: "created", sourceHash: hashJson(value), logHash: hashJson(log ?? []), seq }; } };
}
async function setup(t, m = manifest()) {
  process.env.ESTAMPES_MODULE_V2 = "on";
  const storage = await mkdtemp(join(tmpdir(), "decl-models-"));
  t.after(() => rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const mods = join(storage, "modules");
  await mkdir(join(mods, "inbox"), { recursive: true });
  await writeFile(join(mods, "trusted-keys.json"), JSON.stringify([{ keyId: "pub1", publisher: "Example", publicKey: keys.publicKey, scopes: ["org.example"] }]));
  await writeFile(join(mods, "inbox", "circuit.estpkg.json"), JSON.stringify(signBundle({ schema: "estampes.package/1", manifest: m, files: {} }, keys.privateKey, "pub1")));
  const { key } = await resolveAdminKey({ storageDir: storage });
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0", adminKey: key, canvases: { ensure: ensureImage, create: async (o) => createBlankCanvas(o), save: async () => {} } });
  const records = await createRecordStore({ service: fakeService(), storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
  t.after(() => records.close());
  h.models = createModelStore({ records });
  const approve = async (action) => { const p = await h.lifecycle.prepare(action, ID); if (p.requiresAdmin) await writeApproval(storage, key, p.planId); await h.lifecycle.commit(p.planId, { consent: p.consent }); };
  await approve("install"); await approve("enable");
  return { h, call: (capability, params) => h.router.execute({ module: ID, capability, params }) };
}

test("a package module creates, then updates, its own model instance with the revision it read", async (t) => {
  const s = await setup(t);
  const made = await s.call("create_circuit", { text: "R1 10k" });
  const inst = made.models.instances[0];
  assert.deepEqual(inst.value, { text: "R1 10k" });
  const upd = await s.call("set_circuit", { id: inst.id, revision: inst.revision, text: "R1 1k" });
  assert.deepEqual(upd.models.instances[0].value, { text: "R1 1k" });
  // A stale revision is a conflict and writes nothing.
  await assert.rejects(s.call("set_circuit", { id: inst.id, revision: inst.revision, text: "R1 2k" }), /changed|conflict|revision/i);
  assert.equal((await s.h.models.read({ module: ID, type: manifest().models[0], id: inst.id })).value.text, "R1 1k");
});

test("the model's own schema and size limits still apply to a template result", async (t) => {
  const s = await setup(t);
  await assert.rejects(s.call("create_circuit", { text: "x".repeat(60) }), /at most 40/);
  assert.equal((await s.h.models.list({ module: ID })).length, 0);
});

test("manifest rules: models template needs writes, a literal model, target none and no operations", () => {
  const ok = (m) => validateManifest(m, { coreVersion: "0.10.0", v2: true });
  const base = manifest();
  ok(base);
  const withCap = (c) => ({ ...base, capabilities: [c] });
  const tpl = base.capabilities[0];
  assert.throws(() => ok(withCap({ ...tpl, writes: undefined })), ManifestError);
  assert.throws(() => ok(withCap({ ...tpl, operations: [{ op: "object.create" }] })), /not together|operations/);
  assert.throws(() => ok(withCap({ ...tpl, target: "document" })), /target none|canvas\.write|document/);
  assert.throws(() => ok(withCap({ ...tpl, models: [{ ref: "$c", model: { $param: "text" }, value: {} }] })), /literal model id/);
  assert.throws(() => ok(withCap({ ...tpl, models: [{ model: "circuit", value: {} }] })), /new instance or/);
  assert.throws(() => ok(withCap({ ...tpl, models: [{ id: "md:0123456789ab", model: "circuit", value: {} }] })), /new instance or/);
  assert.throws(() => ok(withCap({ ...tpl, needs: [] })), /module\.storage\.write/);
  assert.throws(() => ok({ ...base, capabilities: [{ ...tpl, models: undefined }] }), /needs operations/);
  // A v1 manifest has no such field.
  assert.throws(() => validateManifest({ ...base, schema: "estampes.module/1", runtime: { kind: "declarative", entry: "none" }, capabilities: [{ id: "x", description: "d", inputSchema: obj({}), models: tpl.models, target: "none" }] }, { coreVersion: "0.10.0" }), ManifestError);
});
