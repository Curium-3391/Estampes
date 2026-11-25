// #85 V1-2: instances of module-owned data. Real record store (the fake UVA service only stands in for the document commit, except in the
// last test, which uses the real service and a restart). The module is an invented one; the store names none.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, mkdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecordStore } from "../src/uva/record-store.js";
import { createUvaService } from "../src/uva/service.js";
import { createModelStore, ModelError } from "../src/models/store.js";
import { hashJson } from "../src/documents/validation.js";

const MOD = "org.example.logic";
const COUNTER = { id: "counter", dataVersion: 1, maxBytes: 2048, maxInstances: 3, schema: { type: "object", additionalProperties: false, required: ["n"], properties: { n: { type: "integer", minimum: 0, maximum: 1000000 }, note: { type: "string", maxLength: 100 } } } };
const types = { counter: COUNTER };

function fakeService() {
  const held = new Map();
  return {
    held, noteMirror() {}, recordKeys: async () => [...held.keys()], recordState: async (key) => held.get(key) ?? null,
    async syncRecord({ key, value, seq, log }) { held.set(key, { value, seq, log, valueHash: hashJson(value) }); return { status: "created", sourceHash: hashJson(value), logHash: hashJson(log ?? []), seq }; },
  };
}
async function setup(t, { service = fakeService(), total } = {}) {
  const storage = await mkdtemp(join(tmpdir(), "model-store-"));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const records = await createRecordStore({ service, storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
  t.after(() => records.close());
  return { storage, service, records, models: createModelStore({ records, ...(total ? { total } : {}) }) };
}
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof ModelError && e.code === code, code);
const make = (models, n = 0, extra = {}) => models.create({ module: MOD, type: COUNTER, value: { n }, commandId: "mk-" + Math.random(), ...extra });
const set = (models, inst, n, commandId, extra = {}) => models.commit({ module: MOD, commandId, changes: [{ id: inst.id, type: COUNTER, expectedRevision: inst.revision, value: { n } }], ...extra });

test("instances are independent records: several of one type, listed without values, owned by one module", async (t) => {
  const { models } = await setup(t);
  const a = await make(models, 1), b = await make(models, 2);
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^md:[0-9a-f]{12}$/);
  assert.deepEqual((await models.list({ module: MOD })).map((x) => x.id).sort(), [a.id, b.id].sort());
  assert.equal((await models.list({ module: MOD }))[0].value, undefined, "a listing carries no values");
  assert.equal((await models.read({ module: MOD, type: COUNTER, id: a.id })).value.n, 1);
  await rejects(models.read({ module: "org.example.other", type: COUNTER, id: a.id }), "forbidden");
  assert.deepEqual(await models.list({ module: "org.example.other" }), []);
});

test("a value must fit the type, its size limit and the instance limits", async (t) => {
  const { models } = await setup(t, { total: 4 });
  await rejects(models.create({ module: MOD, type: COUNTER, value: { n: -1 } }), "schema");
  await rejects(models.create({ module: MOD, type: COUNTER, value: { n: 1, extra: true } }), "schema");
  const small = { ...COUNTER, id: "small", maxBytes: 256, schema: { ...COUNTER.schema, properties: { ...COUNTER.schema.properties, note: { type: "string", maxLength: 400 } } } };
  await rejects(models.create({ module: MOD, type: small, value: { n: 1, note: "x".repeat(300) } }), "limit");
  assert.deepEqual(await models.list({ module: MOD }), [], "a refused value leaves no instance");
  for (let i = 0; i < 3; i++) await make(models, i);
  await rejects(make(models, 9), "limit"); // maxInstances 3 of the type
  await models.create({ module: "org.example.other", type: COUNTER, value: { n: 1 } });
  await rejects(models.create({ module: "org.example.third", type: COUNTER, value: { n: 1 } }), "limit"); // total 4
});

test("a write names the revision it was made against; a stale one is a conflict and writes nothing", async (t) => {
  const { models } = await setup(t);
  const a = await make(models, 1);
  const r2 = await set(models, a, 2, "c1");
  assert.equal(r2.instances[0].revision, 2);
  await rejects(set(models, a, 3, "c2"), "conflict"); // still believes revision 1
  assert.equal((await models.read({ module: MOD, type: COUNTER, id: a.id })).value.n, 2);
  assert.equal((await set(models, r2.instances[0], 3, "c2")).instances[0].revision, 3);
});

test("a change over several instances is all or nothing: one stale revision fails the whole change", async (t) => {
  const { models, storage } = await setup(t);
  const a = await make(models, 1), b = await make(models, 1);
  await set(models, b, 5, "b-moves"); // b is now at revision 2; the change below still believes 1
  await rejects(models.commit({ module: MOD, commandId: "both", changes: [
    { id: a.id, type: COUNTER, expectedRevision: 1, value: { n: 10 } }, { id: b.id, type: COUNTER, expectedRevision: 1, value: { n: 10 } }] }), "conflict");
  assert.equal((await models.read({ module: MOD, type: COUNTER, id: a.id })).value.n, 1, "a was not written");
  assert.equal((await models.read({ module: MOD, type: COUNTER, id: b.id })).value.n, 5);
  assert.deepEqual((await readdir(join(storage, "uva-pending", "intents")).catch(() => [])).filter((n) => n.endsWith(".json")), [], "no intent left behind");
  const ok = await models.commit({ module: MOD, commandId: "both-2", changes: [
    { id: a.id, type: COUNTER, expectedRevision: 1, value: { n: 10 } }, { id: b.id, type: COUNTER, expectedRevision: 2, value: { n: 10 } }] });
  assert.deepEqual(ok.instances.map((i) => i.revision), [2, 3]);
});

test("concurrent writers lose no update: every increment lands exactly once", async (t) => {
  const { models } = await setup(t);
  const a = await make(models, 0);
  const bump = async (k) => {
    for (;;) {
      const cur = await models.read({ module: MOD, type: COUNTER, id: a.id });
      try { await models.commit({ module: MOD, commandId: "inc-" + k, changes: [{ id: a.id, type: COUNTER, expectedRevision: cur.revision, value: { n: cur.value.n + 1 } }] }); return; }
      catch (e) { if (e.code !== "conflict") throw e; }
    }
  };
  await Promise.all(Array.from({ length: 40 }, (_, k) => bump(k)));
  const end = await models.read({ module: MOD, type: COUNTER, id: a.id });
  assert.equal(end.value.n, 40);
  assert.equal(end.revision, 41);
});

test("changes over the same instances in opposite order cannot deadlock", async (t) => {
  const { models } = await setup(t);
  const a = await make(models, 0), b = await make(models, 0);
  const move = async (k, order) => {
    for (;;) {
      const cur = new Map(); for (const i of [a, b]) cur.set(i.id, await models.read({ module: MOD, type: COUNTER, id: i.id }));
      try { await models.commit({ module: MOD, commandId: "mv-" + k, changes: order.map((i) => ({ id: i.id, type: COUNTER, expectedRevision: cur.get(i.id).revision, value: { n: cur.get(i.id).value.n + 1 } })) }); return; }
      catch (e) { if (e.code !== "conflict") throw e; }
    }
  };
  await Promise.race([
    Promise.all(Array.from({ length: 60 }, (_, k) => move(k, k % 2 ? [a, b] : [b, a]))),
    new Promise((_, no) => setTimeout(() => no(new Error("deadlock: the changes did not finish")), 20000)),
  ]);
  for (const i of [a, b]) assert.equal((await models.read({ module: MOD, type: COUNTER, id: i.id })).value.n, 60);
});

test("a command id that was already applied answers with the earlier result; with different data it is refused", async (t) => {
  const { models } = await setup(t);
  const a = await make(models, 1, { commandId: "mk-1" });
  assert.equal((await make(models, 1, { commandId: "mk-1" })).id, a.id, "the same create again is the same instance");
  await rejects(make(models, 2, { commandId: "mk-1" }), "duplicate-command");
  const first = await set(models, a, 2, "set-2");
  const again = await set(models, a, 2, "set-2"); // retry with the old revision, as a lost reply would
  assert.equal(again.status, "already-applied");
  assert.equal(again.instances[0].revision, first.instances[0].revision, "nothing was written twice");
  await rejects(set(models, a, 7, "set-2"), "duplicate-command");
});

test("an undo is a new change with a precondition: it restores only while its command is still the latest", async (t) => {
  const { models } = await setup(t);
  const a = await make(models, 1);
  const c1 = await set(models, a, 2, "c1"), c2 = await set(models, c1.instances[0], 3, "c2");
  await rejects(models.undo({ module: MOD, types, commandId: "c1", undoCommandId: "u1" }), "conflict");
  assert.equal((await models.read({ module: MOD, type: COUNTER, id: a.id })).value.n, 3, "the later change was not overwritten");
  const u = await models.undo({ module: MOD, types, commandId: "c2", undoCommandId: "u2" });
  assert.equal(u.instances[0].value.n, 2);
  assert.equal(u.instances[0].revision, 4, "an undo is a new revision, not a rewind");
  assert.equal((await models.undo({ module: MOD, types, commandId: "c2", undoCommandId: "u2" })).status, "already-applied");
  await rejects(models.undo({ module: MOD, types, commandId: "c1", undoCommandId: "u3" }), "conflict"); // c1 is no longer the latest either
});

test("undoing a change over several instances is atomic, and a conflict on one leaves all of them alone", async (t) => {
  const { models } = await setup(t);
  const a = await make(models, 1), b = await make(models, 1);
  await models.commit({ module: MOD, commandId: "pair", changes: [{ id: a.id, type: COUNTER, expectedRevision: 1, value: { n: 5 } }, { id: b.id, type: COUNTER, expectedRevision: 1, value: { n: 5 } }] });
  await set(models, { id: b.id, revision: 2 }, 9, "other-agent"); // someone else changes b afterwards
  await rejects(models.undo({ module: MOD, types, commandId: "pair", undoCommandId: "u" }), "conflict");
  assert.equal((await models.read({ module: MOD, type: COUNTER, id: a.id })).value.n, 5, "a was not rolled back alone");
  assert.equal((await models.read({ module: MOD, type: COUNTER, id: b.id })).value.n, 9);
  await rejects(models.undo({ module: MOD, types, commandId: "mk", undoCommandId: "u" }), "not-found");
  const c = await make(models, 1, { commandId: "creation" });
  await rejects(models.undo({ module: MOD, types, commandId: "creation", undoCommandId: "u9" }), "unsupported");
  assert.ok(c.id);
});

test("an instance of a version the module does not read is kept as it is and not opened", async (t) => {
  const { models, records } = await setup(t);
  const a = await make(models, 1);
  const v3 = { ...COUNTER, dataVersion: 3, readsVersions: [3] };
  await rejects(models.read({ module: MOD, type: v3, id: a.id }), "incompatible");
  await rejects(models.commit({ module: MOD, commandId: "x", changes: [{ id: a.id, type: v3, expectedRevision: 1, value: { n: 2 } }] }), "incompatible");
  const raw = await records.read("model", a.id);
  assert.equal(raw.revision, 1); assert.equal(raw.value.n, 1);
  const v3reads1 = { ...COUNTER, dataVersion: 3, readsVersions: [1, 3] };
  assert.equal((await models.read({ module: MOD, type: v3reads1, id: a.id })).value.n, 1);
  assert.equal((await models.commit({ module: MOD, commandId: "up", changes: [{ id: a.id, type: v3reads1, expectedRevision: 1, value: { n: 2 } }] })).instances[0].dataVersion, 3, "a write brings the instance to the current version");
});

test("one model store per record store: a second writer would not see the locks", async (t) => {
  const { records } = await setup(t);
  assert.throws(() => createModelStore({ records }), (e) => e.code === "single-writer");
});

test("the history of an instance is bounded", async (t) => {
  const { models, records } = await setup(t);
  const a = await make(models, 0);
  let cur = a;
  for (let i = 1; i <= 40; i++) cur = (await set(models, cur, i, "h" + i)).instances[0];
  const raw = await records.read("model", a.id);
  assert.ok(raw.history.length <= 20, "at most 20 commands are remembered");
  assert.equal(raw.revision, 41);
  const big = await models.create({ module: MOD, type: { ...COUNTER, id: "big", maxBytes: 65536 }, value: { n: 0 } });
  let b = big;
  for (let i = 1; i <= 12; i++) b = (await models.commit({ module: MOD, commandId: "g" + i, changes: [{ id: b.id, type: { ...COUNTER, id: "big", maxBytes: 65536 }, expectedRevision: b.revision, value: { n: i } }] })).instances[0];
  assert.ok((await records.read("model", big.id)).history.length <= 4, "a 64 KB type keeps fewer entries");
});

test("a change cut off after its intent is rolled forward at the next start, whole", async (t) => {
  const { storage, service, records, models } = await setup(t);
  const a = await make(models, 1), b = await make(models, 1);
  await records.flush();
  const blocked = join(storage, "uva-pending", "records", "model-" + b.id.replace(":", "_") + ".json");
  await mkdir(blocked); // b's own file cannot be written: stands in for a crash between the intent and b's write
  await models.commit({ module: MOD, commandId: "pair", changes: [{ id: a.id, type: COUNTER, expectedRevision: 1, value: { n: 7 } }, { id: b.id, type: COUNTER, expectedRevision: 1, value: { n: 7 } }] });
  assert.equal((await models.read({ module: MOD, type: COUNTER, id: b.id })).value.n, 7, "read from the intent meanwhile");
  await records.close();
  await rmdir(blocked);
  const again = await createRecordStore({ service, storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
  t.after(() => again.close());
  const reopened = createModelStore({ records: again });
  for (const i of [a, b]) { const r = await reopened.read({ module: MOD, type: COUNTER, id: i.id }); assert.equal(r.value.n, 7); assert.equal(r.revision, 2); }
});

test("with the real UVA service: instances survive a restart", async (t) => {
  const storage = await mkdtemp(join(tmpdir(), "model-real-l-")), beta = await mkdtemp(join(tmpdir(), "model-real-u-"));
  t.after(() => Promise.all([rm(storage, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }), rm(beta, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })]));
  const boot = async () => {
    const service = await createUvaService({ enabled: true, canvasStore: true, directory: beta, profile: "linux-process-crash-test", legacyDirectory: storage });
    const records = await createRecordStore({ service, storageDir: storage, idleMs: 0, retryEveryMs: 0 });
    return { models: createModelStore({ records }), close: async () => { await records.flush(); await records.close(); await service.close(); } };
  };
  let b = await boot();
  const one = await make(b.models, 3), two = await make(b.models, 4);
  await b.models.commit({ module: MOD, commandId: "pair", changes: [{ id: one.id, type: COUNTER, expectedRevision: 1, value: { n: 30 } }, { id: two.id, type: COUNTER, expectedRevision: 1, value: { n: 40 } }] });
  await b.close();
  b = await boot();
  t.after(() => b.close());
  assert.equal((await b.models.read({ module: MOD, type: COUNTER, id: one.id })).value.n, 30);
  assert.equal((await b.models.read({ module: MOD, type: COUNTER, id: two.id })).revision, 2);
  const undone = await b.models.undo({ module: MOD, types, commandId: "pair", undoCommandId: "u" });
  assert.deepEqual(undone.instances.map((i) => i.value.n).sort(), [3, 4], "the undo works from the restarted store's history");
});
