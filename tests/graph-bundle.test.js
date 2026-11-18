// UVA Phase 4A-4c: a .estampes bundle carries Graph documents. A Graph has no
// bytes: the manifest lists it as an asset of kind "graph" with no file, its
// set carries the colour, marks and objects, and the importing server makes a
// new Graph (new gph: id) and restores the set into it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUvaService } from "../src/uva/service.js";
import { createCanvasStore } from "../src/uva/canvas-store.js";
import { createGraphCanvas, ensureImage, saveCanvas, serializeCanvas, useCanvasStore } from "../src/storage.js";
import { applyCanvasChanges, canvasMarks } from "../src/canvas-state.js";
import { applySceneOps } from "../src/scene/scene-ops.js";
import { canvasBackground } from "../src/visual/background.js";
import { isGraphId, forgetGraph } from "../src/visual/graph-docs.js";
import { createWorkspace, clearWorkspaces, getWorkspace, workspaceItems, commitTransfer } from "../src/workspace.js";
import { exportBundle, importBundle } from "../src/bundle.js";
import { unzipFiles } from "../src/zip.js";

const resolve = (a) => a;
async function folders(t) {
  const storage = await mkdtemp(join(tmpdir(), "graph-bundle-legacy-")), beta = await mkdtemp(join(tmpdir(), "graph-bundle-uva-"));
  t.after(() => Promise.all([rm(storage, { recursive: true, force: true }), rm(beta, { recursive: true, force: true })]));
  return { storage, beta };
}
async function open({ storage, beta }) {
  const service = await createUvaService({ enabled: true, canvasStore: true, directory: beta, profile: "linux-process-crash-test", legacyDirectory: storage });
  const store = await createCanvasStore({ service, storageDir: storage, idleMs: 0 });
  useCanvasStore(store);
  return { service, store, async close() { await store.flush(); await store.close(); await service.close(); useCanvasStore(null); } };
}
const graphDocs = async (service) => (await service.store.snapshot()).documents.filter((d) => d.kind === "graph" && d.extensions?.["estampes.beta:mirror"]);
// Key order does not change what an object says: compare in canonical form.
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const objectsOf = (entry) => JSON.stringify(canonical(serializeCanvas(entry).objects ?? []));

async function plottedGraph() {
  const g = await createGraphCanvas({ width: 900, height: 600, color: "#fbf8f1", title: "parabola" });
  applyCanvasChanges(g, { annotations: [{ id: "peak", type: "point", x: .5, y: .2, label: "vertex" }], resolve });
  applySceneOps(g, [
    { op: "object.create", type: "axes-2d", props: { xRange: [-3, 3], yRange: [-1, 9] } },
    { op: "object.create", type: "function-plot", props: { frame: "o1", expression: "x^2" } },
  ], { author: "assistant" });
  await saveCanvas(g, { tool: "test" });
  return g;
}

test("a bundle carries a Graph as data, and the import makes a new Graph with the same colour, axes and marks", { timeout: 120000 }, async (t) => {
  clearWorkspaces();
  const dirs = await folders(t);
  let s = await open(dirs);
  t.after(() => s.close().catch(() => {}));
  const g = await plottedGraph();
  const made = await createWorkspace({ name: "graph only", items: [{ set: g.imageId }] });
  const { buffer, manifest } = await exportBundle(made.workspace.id);

  const asset = manifest.assets.find((a) => a.id === g.imageId);
  assert.deepEqual({ kind: asset.kind, width: asset.width, height: asset.height, file: asset.file }, { kind: "graph", width: 900, height: 600, file: undefined });
  const files = unzipFiles(buffer);
  assert.deepEqual([...files.keys()].filter((n) => n.startsWith("assets/")), [], "no image file for a Graph");

  await s.store.flush();
  const before = (await graphDocs(s.service)).length;
  const r = await importBundle(buffer, { name: "carried" });
  assert.equal(r.verified, true, JSON.stringify({ mismatch: r.mismatch, unsupported: r.unsupported, warnings: r.warnings }));
  assert.deepEqual(r.summary.map((x) => x.how), ["restored"]);
  const [imported] = (await workspaceItems(await getWorkspace(r.workspace.id))).map((it) => it.entry);
  assert.ok(isGraphId(imported.imageId) && imported.imageId !== g.imageId, "a new Graph id: " + imported.imageId);
  assert.equal(imported.kind, "graph");
  assert.deepEqual([imported.width, imported.height], [900, 600]);
  assert.deepEqual(canvasBackground(imported), { kind: "solid", color: "#fbf8f1" });
  assert.deepEqual(canvasMarks(imported).map((m) => m.label), ["vertex"]);
  assert.equal(objectsOf(imported), objectsOf(g), "the same vector axes and plot");
  assert.deepEqual(canvasMarks(g).map((m) => m.label), ["vertex"], "the original is untouched");

  // Importing the same bundle again answers with the same workspace and makes no second Graph.
  const again = await importBundle(buffer);
  assert.equal(again.repeated, true);
  assert.equal(again.workspaceId ?? again.workspace?.id, r.workspace.id);
  await s.store.flush();
  assert.equal((await graphDocs(s.service)).length, before + 1, "one new Graph in the store, not two");
  const importedId = imported.imageId;
  await s.close();

  s = await open(dirs);
  forgetGraph(importedId);
  const back = await ensureImage(importedId);
  assert.deepEqual(canvasMarks(back).map((m) => m.label), ["vertex"], "the imported Graph comes back after a restart");
  assert.equal(objectsOf(back), objectsOf(g));
  assert.deepEqual(canvasBackground(back), { kind: "solid", color: "#fbf8f1" });
  await s.close();
});

test("a copy of a Graph travels as a copy of the new Graph, with its own marks", { timeout: 120000 }, async (t) => {
  clearWorkspaces();
  const dirs = await folders(t);
  const s = await open(dirs);
  t.after(() => s.close().catch(() => {}));
  const g = await plottedGraph();
  const made = await createWorkspace({ items: [{ set: g.imageId }] });
  const split = await commitTransfer({ source: made.workspace.id, target: "new", items: ["wi-1"], mode: "copy" });
  const copyKey = (await getWorkspace(split.workspaceId)).items[0].set;
  assert.match(copyKey, /^gph:[0-9a-f]{16}#c/);
  const copied = await createWorkspace({ items: [{ set: g.imageId }, { set: copyKey }] });
  const copy = (await workspaceItems(await getWorkspace(copied.workspace.id))).find((it) => it.item.set === copyKey).entry;
  applyCanvasChanges(copy, { annotations: [{ id: "c1", type: "point", x: .9, y: .9, label: "copy only" }], resolve });
  await saveCanvas(copy, { tool: "test" });
  const { buffer, manifest } = await exportBundle(copied.workspace.id);
  assert.equal(manifest.assets.length, 1, "one Graph asset for the Graph and its copy");

  const r = await importBundle(buffer, { collision: "copy" });
  assert.equal(r.verified, true, JSON.stringify({ mismatch: r.mismatch, warnings: r.warnings }));
  const back = (await workspaceItems(await getWorkspace(r.workspace.id))).map((it) => it.entry);
  const [own, other] = [back.find((e) => !e.setId), back.find((e) => e.setId)];
  assert.ok(isGraphId(own.imageId) && own.imageId !== g.imageId);
  assert.equal(other.imageId, own.imageId, "the copy belongs to the new Graph");
  assert.deepEqual(canvasMarks(own).map((m) => m.label), ["vertex"]);
  assert.deepEqual(canvasMarks(other).map((m) => m.label).sort(), ["copy only", "vertex"]);
  assert.equal(objectsOf(other), objectsOf(g));
  assert.deepEqual(canvasBackground(other), { kind: "solid", color: "#fbf8f1" });
});

test("a server without the UVA store refuses a bundle with a Graph and makes nothing", { timeout: 120000 }, async (t) => {
  clearWorkspaces();
  const dirs = await folders(t);
  const s = await open(dirs);
  t.after(() => s.close().catch(() => {}));
  const g = await plottedGraph();
  const made = await createWorkspace({ items: [{ set: g.imageId }] });
  const { buffer } = await exportBundle(made.workspace.id);
  await s.close();
  clearWorkspaces();
  await assert.rejects(importBundle(buffer), /UVA canvas store/);
});
