// A change over several records (a workspace merge, split, move or undo) is
// all-or-nothing across a crash: writeMany acknowledges it once its durable
// intent exists, and an intent whose record writes did not all happen is
// rolled forward at the next start (or by the retry timer).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecordStore } from "../src/uva/record-store.js";
import { hashJson } from "../src/documents/validation.js";

function fakeService() {
  const held = new Map();
  return {
    held, noteMirror() {}, recordKeys: async () => [...held.keys()], recordState: async (key) => held.get(key) ?? null,
    async syncRecord({ key, value, seq, log }) {
      held.set(key, { value, seq, log, valueHash: hashJson(value) });
      return { status: "created", sourceHash: hashJson(value), logHash: hashJson(log ?? []), seq };
    },
  };
}
async function storageDir(t) {
  const root = await mkdtemp(join(tmpdir(), "record-intents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const A = "ws:" + "a1".repeat(8), B = "ws:" + "b2".repeat(8);
const ws = (id, items, revision) => ({ id, name: id, items, revision });
const intents = async (storage) => (await readdir(join(storage, "uva-pending", "intents")).catch(() => [])).filter((n) => n.endsWith(".json"));
const pendingPath = (storage, id) => join(storage, "uva-pending", "records", "workspace-" + id.replace(":", "_") + ".json");
const open = (service, storage) => createRecordStore({ service, storageDir: storage, idleMs: 600000, retryEveryMs: 0 });
// The record file of B cannot be written while a folder sits at its path,
// standing in for a crash between the intent and B's own write.
const blockB = (storage) => mkdir(pendingPath(storage, B));
const unblockB = (storage) => rmdir(pendingPath(storage, B));
async function seeded(t) {
  const storage = await storageDir(t), service = fakeService();
  const store = await open(service, storage);
  await store.write("workspace", A, ws(A, ["x", "y"], 1), { line: { kind: "create" } });
  await store.write("workspace", B, ws(B, ["z"], 1), { line: { kind: "create" } });
  await store.flush();
  return { storage, service, store };
}
const move = () => [
  { kind: "workspace", id: A, value: ws(A, ["y"], 2), line: { kind: "move", token: "u-1" } },
  { kind: "workspace", id: B, value: ws(B, ["z", "x"], 2), line: { kind: "move", token: "u-1" } },
];

test("a change over two records is written whole and leaves no intent", async (t) => {
  const { storage, store } = await seeded(t);
  t.after(() => store.close());
  await store.writeMany(move());
  assert.deepEqual((await store.read("workspace", A)).items, ["y"]);
  assert.deepEqual((await store.read("workspace", B)).items, ["z", "x"]);
  assert.deepEqual(await intents(storage), []);
  assert.equal((await store.log("workspace", B)).length, 2);
});

test("a change cut off after its intent is rolled forward at the next start", async (t) => {
  const { storage, service, store } = await seeded(t);
  await blockB(storage);
  await store.writeMany(move()); // acknowledged: its intent is durable
  assert.equal((await intents(storage)).length, 1, "the intent stays while B is not written");
  assert.deepEqual((await store.read("workspace", B)).items, ["z", "x"], "B is read from the intent meanwhile");
  await store.close();
  await unblockB(storage);
  const again = await open(service, storage);
  t.after(() => again.close());
  assert.deepEqual((await again.read("workspace", A)).items, ["y"]);
  assert.deepEqual((await again.read("workspace", B)).items, ["z", "x"], "B rolled forward");
  assert.deepEqual(await intents(storage), []);
  assert.deepEqual((await again.log("workspace", B)).map((l) => l.kind), ["create", "move"]);
});

test("a record that is still unwritable after a restart is answered from the intent and written by the retry", async (t) => {
  const { storage, service, store } = await seeded(t);
  await blockB(storage);
  await store.writeMany(move());
  await store.close();
  const again = await open(service, storage);
  t.after(() => again.close());
  assert.deepEqual((await again.read("workspace", B)).items, ["z", "x"], "after a restart too");
  assert.equal((await intents(storage)).length, 1);
  await unblockB(storage);
  await again.flush();
  assert.deepEqual(await intents(storage), []);
  assert.deepEqual((await again.read("workspace", B)).items, ["z", "x"]);
});

test("rolling forward is idempotent and never overwrites a later write", async (t) => {
  const { storage, service, store } = await seeded(t);
  await blockB(storage);
  await store.writeMany(move());
  const [name] = await intents(storage);
  const intent = await readFile(join(storage, "uva-pending", "intents", name), "utf8");
  await unblockB(storage);
  await store.flush();
  assert.deepEqual(await intents(storage), []);
  // A later change to B, then the old intent shows up again (as if its
  // removal had been lost): it must not take B back, nor log the move twice.
  await store.write("workspace", B, ws(B, ["z"], 3), { line: { kind: "edit" } });
  await store.close();
  await writeFile(join(storage, "uva-pending", "intents", name), intent);
  const again = await open(service, storage);
  t.after(() => again.close());
  assert.deepEqual((await again.read("workspace", B)).items, ["z"], "the later write stands");
  assert.deepEqual((await again.read("workspace", A)).items, ["y"]);
  assert.deepEqual((await again.log("workspace", B)).map((l) => l.kind), ["create", "move", "edit"]);
  assert.deepEqual((await again.log("workspace", A)).map((l) => l.kind), ["create", "move"]);
  assert.deepEqual(await intents(storage), []);
});

test("a later write to a record of an unfinished change wins over the roll-forward", async (t) => {
  const { storage, service, store } = await seeded(t);
  await blockB(storage);
  await store.writeMany(move());
  await unblockB(storage);
  await store.write("workspace", B, ws(B, ["w"], 3), { line: { kind: "edit" } });
  assert.deepEqual((await store.read("workspace", B)).items, ["w"]);
  await store.close();
  const again = await open(service, storage);
  t.after(() => again.close());
  assert.deepEqual((await again.read("workspace", B)).items, ["w"]);
  assert.deepEqual(await intents(storage), []);
});

test("a change whose intent cannot be written is refused and changes nothing", async (t) => {
  const { storage, store } = await seeded(t);
  t.after(() => store.close());
  await rm(join(storage, "uva-pending", "intents"), { recursive: true });
  await writeFile(join(storage, "uva-pending", "intents"), "not a folder");
  await assert.rejects(store.writeMany(move()), /was not saved/);
  assert.deepEqual((await store.read("workspace", A)).items, ["x", "y"]);
  assert.deepEqual((await store.read("workspace", B)).items, ["z"]);
  await assert.rejects(store.writeMany([move()[0], move()[0]]), /twice/);
  await assert.rejects(store.writeMany([{ kind: "workspace", id: A, value: { id: B, items: [] } }]), /Not a valid/);
});

test("two changes over the same records run one after the other", async (t) => {
  const { store } = await seeded(t);
  t.after(() => store.close());
  const second = [
    { kind: "workspace", id: B, value: ws(B, ["z"], 3), line: { kind: "move-back" } },
    { kind: "workspace", id: A, value: ws(A, ["x", "y"], 3), line: { kind: "move-back" } },
  ];
  await Promise.all([store.writeMany(move()), store.writeMany(second)]);
  assert.deepEqual((await store.read("workspace", A)).items, ["x", "y"]);
  assert.deepEqual((await store.log("workspace", A)).map((l) => l.kind), ["create", "move", "move-back"]);
});
