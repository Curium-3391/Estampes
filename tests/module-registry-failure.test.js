// Registry state changes must stay consistent with the file on disk when a
// write fails (architecture review A06): a failed enable must not leave the
// module enabled in memory, and a transient write failure must not wedge
// every later save until the server restarts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { createRegistry } from "../src/modules/registry.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";

const GRAPH = "org.estampes.graph";
const canvases = { ensure: ensureImage, create: createBlankCanvas, save: async () => {} };
// Turning registry.json into a non-empty directory makes the atomic rename
// fail, the same way a full or read-only disk would.
async function breakFile(file) { await rm(file, { force: true }); await mkdir(file, { recursive: true }); await writeFile(join(file, "blocker"), "x"); }
async function fixFile(file) { await rm(file, { recursive: true, force: true }); }

test("registry: a failed enable leaves the module in its persisted state, and the next enable succeeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-reg-fail-"));
  const h = await createModuleHost({ storageDir: dir, coreVersion: "0.10.0", canvases });
  const file = join(h.registry.dir, "registry.json");
  await breakFile(file);
  const plan = await h.lifecycle.prepare("enable", GRAPH);
  await assert.rejects(h.lifecycle.commit(plan.planId, { consent: plan.consent }));
  assert.equal(h.registry.get(GRAPH).record.state, "available", "memory must not show the failed enable");
  await assert.rejects(h.router.execute({ module: GRAPH, capability: "plot_function", params: { expression: "sin(x)" } }), /Only the user can enable/);
  // The fault clears; the queue is not wedged by the earlier rejection.
  await fixFile(file);
  const retry = await h.lifecycle.prepare("enable", GRAPH);
  const done = await h.lifecycle.commit(retry.planId, { consent: retry.consent });
  assert.equal(done.result.state, "enabled");
  assert.equal(JSON.parse(await readFile(file, "utf8")).modules[GRAPH].state, "enabled");
  // A restart sees the same state memory had.
  const again = await createModuleHost({ storageDir: dir, coreVersion: "0.10.0", canvases });
  assert.equal(again.registry.get(GRAPH).record.state, "enabled");
  // No temporary files are left behind by the failed write.
  assert.deepEqual((await readdir(h.registry.dir)).filter((f) => f.endsWith(".tmp")), []);
});

test("registry: a failed write never carries into disk or memory through a later successful write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-reg-chain-"));
  const reg = createRegistry({ dir, coreVersion: "0.10.0" });
  const file = join(dir, "registry.json");
  await reg.setRecord("a", { state: "enabled" });
  await breakFile(file);
  const failed = reg.setRecord("b", { state: "enabled" });
  await assert.rejects(failed);
  assert.equal(reg.records().has("b"), false);
  await fixFile(file);
  await reg.setRecord("c", { state: "disabled" });
  const disk = JSON.parse(await readFile(file, "utf8")).modules;
  assert.deepEqual(Object.keys(disk).sort(), ["a", "c"]);
  assert.deepEqual([...reg.records().keys()].sort(), ["a", "c"]);
});

test("registry: queued writes each report their own outcome and keep their order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-reg-order-"));
  const reg = createRegistry({ dir, coreVersion: "0.10.0" });
  const writes = [reg.setRecord("m", { state: "enabled" }), reg.setRecord("m", { state: "disabled" }), reg.dropRecord("n")];
  await Promise.all(writes);
  assert.equal(reg.records().get("m").state, "disabled");
  assert.equal(JSON.parse(await readFile(join(dir, "registry.json"), "utf8")).modules.m.state, "disabled");
});

test("registry: without a storage folder, changes apply in memory immediately", async () => {
  const reg = createRegistry({ coreVersion: "0.10.0" });
  await reg.setRecord("x", { state: "enabled" });
  assert.equal(reg.records().get("x").state, "enabled");
  await reg.dropRecord("x");
  assert.equal(reg.records().has("x"), false);
});
