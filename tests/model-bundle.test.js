// #85 V3-B: model instances travel in a .estampes bundle (models.json under extras), come back under their own ids, never over an instance that
// is already there, and only for a module that is installed and reads that data version. Invented module; real bundle code and model store.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearImages, registerImage } from "../src/image-store.js";
import { useStorageDir } from "../src/storage.js";
import { commitTransfer, clearWorkspaces } from "../src/workspace.js";
import { exportBundle, importBundle } from "../src/bundle.js";
import { unzipFiles } from "../src/zip.js";
import { createRecordStore } from "../src/uva/record-store.js";
import { createModelStore } from "../src/models/store.js";
import { collectModels, installModels } from "../src/models/bundle-extras.js";
import { hashJson } from "../src/documents/validation.js";
import { threeImageFixture } from "./fixtures/three-images.js";

const TYPE = { id: "lamp", dataVersion: 1, schema: { type: "object", additionalProperties: false, required: ["level"], properties: { level: { type: "integer", minimum: 0, maximum: 9 } } } };
const MOD = "org.example.lamp";
const registry = (types = { lamp: TYPE }, present = true) => ({ get: (id) => (present && id === MOD ? { manifest: { v2: { models: types } } } : undefined) });
beforeEach(() => { clearImages(); clearWorkspaces(); useStorageDir(""); });

function fakeService() {
  const held = new Map();
  return { held, noteMirror() {}, recordKeys: async () => [...held.keys()], recordState: async (key) => held.get(key) ?? null,
    async syncRecord({ key, value, seq, log }) { held.set(key, { value, seq, log, valueHash: hashJson(value) }); return { status: "created", sourceHash: hashJson(value), logHash: hashJson(log ?? []), seq }; } };
}
async function stores(t) {
  const dir = await mkdtemp(join(tmpdir(), "model-bundle-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const records = await createRecordStore({ service: fakeService(), storageDir: dir, idleMs: 600000, retryEveryMs: 0 });
  t.after(() => records.close());
  return createModelStore({ records });
}

test("collect takes the instances the surface's views are bound to, without history", async (t) => {
  const store = await stores(t);
  const a = await store.create({ module: MOD, type: TYPE, value: { level: 3 }, commandId: "a" });
  await store.create({ module: MOD, type: TYPE, value: { level: 4 }, commandId: "b" });
  const got = await collectModels({ store, surface: { panels: [{ panelId: "p:view-x0", models: { lamp: a.id } }, { panelId: "p:canvas" }] } });
  assert.deepEqual(got, [{ id: a.id, module: MOD, model: "lamp", dataVersion: 1, revision: 1, value: { level: 3 } }]);
  assert.deepEqual(await collectModels({ store, surface: { panels: [] } }), []);
});

test("a bundle carries models.json and import hands the instances back; a repeat import changes nothing", async (t) => {
  const { a, b1, b2 } = await threeImageFixture(registerImage);
  const done = await commitTransfer({ source: b1.imageId + "+" + b2.imageId, target: a.imageId, mode: "link" });
  const source = await stores(t);
  const made = await source.create({ module: MOD, type: TYPE, value: { level: 7 }, commandId: "c" });
  const items = await collectModels({ store: source, surface: { panels: [{ models: { lamp: made.id } }] } });
  const built = await exportBundle(done.workspaceId, { version: "test", extras: { surface: null, notebooks: [], models: items } });
  assert.deepEqual(built.manifest.extras.models, { file: "models.json", count: 1 });
  assert.equal(JSON.parse(unzipFiles(built.buffer).get("models.json").toString())[0].value.level, 7);

  clearImages(); clearWorkspaces();
  const r = await importBundle(built.buffer, { name: "carried" });
  assert.equal(r.extras.models.length, 1);
  const target = await stores(t);
  const first = await installModels({ store: target, registry: registry(), items: r.extras.models });
  assert.deepEqual([first.restored, first.existing, first.skipped], [1, 0, 0]);
  const back = await target.read({ module: MOD, type: TYPE, id: made.id });
  assert.deepEqual([back.value, back.revision], [{ level: 7 }, 1]);
  const again = await installModels({ store: target, registry: registry(), items: r.extras.models });
  assert.deepEqual([again.restored, again.existing, again.skipped], [0, 1, 0]);
});

test("an instance that is already here is never overwritten, and a different value is reported", async (t) => {
  const store = await stores(t);
  const mine = await store.create({ module: MOD, type: TYPE, value: { level: 1 }, commandId: "m" });
  const out = await installModels({ store, registry: registry(), items: [{ id: mine.id, module: MOD, model: "lamp", dataVersion: 1, value: { level: 9 } }] });
  assert.deepEqual([out.restored, out.existing], [0, 1]);
  assert.match(out.notes[0], /different value/);
  assert.equal((await store.read({ module: MOD, type: TYPE, id: mine.id })).value.level, 1);
});

test("a module that is not installed, a data version it cannot read, a bad value or a bad id are skipped with a reason", async (t) => {
  const store = await stores(t);
  const ok = { id: "md:0123456789ab", module: MOD, model: "lamp", dataVersion: 1, value: { level: 2 } };
  const gone = await installModels({ store, registry: registry(undefined, false), items: [ok] });
  assert.deepEqual([gone.restored, gone.skipped], [0, 1]); assert.match(gone.notes[0], /not installed/);
  const old = await installModels({ store, registry: registry({ lamp: { ...TYPE, dataVersion: 2 } }), items: [ok] });
  assert.match(old.notes[0], /data version 1/);
  const bad = await installModels({ store, registry: registry(), items: [{ ...ok, value: { level: 99 } }, { ...ok, id: "nope" }, { junk: true }] });
  assert.deepEqual([bad.restored, bad.skipped], [0, 3]);
  assert.equal((await store.list({ module: MOD })).length, 0, "nothing was written");
  const none = await installModels({ store: null, registry: registry(), items: [ok] });
  assert.match(none.notes[0], /no model storage/);
});
