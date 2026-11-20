// UVA Phase 4B-2: ESTAMPES_GRAPH_DOCUMENTS=readonly, the rollback for Graph
// documents. No new Graph; every change to an existing Graph (or a copy of
// one) is refused with GRAPH_READ_ONLY and nothing stored changes; reading,
// render_canvas and export still work. Images are not affected.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCanvasStoreServer } from "./helpers/canvas-store-server.js";

const GRAPH = "org.estampes.graph";
const idIn = (r, prefix) => (JSON.stringify(r.structuredContent ?? {}).match(new RegExp(prefix + ":[0-9a-f]{16}")) ?? [])[0];
const refused = (r, what) => {
  assert.equal(r.isError, true, what + " should be refused: " + JSON.stringify(r.content).slice(0, 300));
  assert.match(JSON.stringify(r.content), /GRAPH_READ_ONLY/, what + ": " + JSON.stringify(r.content).slice(0, 300));
  assert.match(JSON.stringify(r.content), /ESTAMPES_GRAPH_DOCUMENTS/, what + " names the setting");
};

test("ESTAMPES_GRAPH_DOCUMENTS=readonly: Graphs stay readable, every change and every new Graph is refused", { timeout: 180000 }, async (t) => {
  const storage = await mkdtemp(join(tmpdir(), "graph-ro-legacy-")), beta = await mkdtemp(join(tmpdir(), "graph-ro-uva-"));
  t.after(() => Promise.all([rm(storage, { recursive: true, force: true }), rm(beta, { recursive: true, force: true })]));

  // Made with Graphs on: a Graph with a mark, and a bundle that carries it.
  let s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  t.after(() => s.kill());
  await s.enable(GRAPH);
  const made = await s.call("execute_module", { module: GRAPH, capability: "plot_function", params: { expression: "sin(x)" }, newCanvas: { kind: "graph" }, present: false });
  const id = idIn(made, "gph");
  await s.call("present_visual", { imageId: id, annotations: [{ id: "peak", type: "point", x: 0.3, y: 0.25, label: "peak" }] });
  // A second Graph, and a workspace that holds both.
  const id2 = idIn(await s.call("execute_module", { module: GRAPH, capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "graph" }, present: false }), "gph");
  await s.call("present_visual", { imageId: id2, annotations: [{ id: "q", type: "point", x: 0.6, y: 0.6, label: "q" }] });
  const both = (await s.call("create_workspace", { canvases: [id, id2] })).structuredContent;
  const wsBoth = both.workspaceId ?? both.workspace?.id;
  await s.stop();

  s = await startCanvasStoreServer(storage, beta, { idle: "0", env: { ESTAMPES_GRAPH_DOCUMENTS: "readonly" } });
  const before = (await s.call("get_visual_state", { imageId: id })).structuredContent;
  assert.deepEqual(before.marks.map((m) => m.id), ["peak"], "the Graph is still readable");
  const rendered = await s.call("render_canvas", { imageId: id });
  assert.ok(rendered.content.some((c) => c.type === "image"), "render_canvas still works");
  const ws0 = (await s.call("create_workspace", { canvases: [id] })).structuredContent;
  await s.call("export_workspace_bundle", { workspace: ws0.workspaceId ?? ws0.workspace?.id });

  // Every kind of change is refused.
  refused(await s.raw("present_visual", { imageId: id, annotations: [{ id: "new", type: "point", x: 0.5, y: 0.5 }] }), "a new mark");
  refused(await s.raw("edit_visual_canvas", { imageId: id, marks: [{ id: "peak", label: "renamed" }] }), "a relabel");
  refused(await s.raw("execute_module", { module: GRAPH, capability: "plot_function", canvas: id, params: { expression: "cos(x)" } }), "a module run on the Graph");
  const layers = (await s.call("get_visual_layers", { imageId: id })).structuredContent;
  refused(await s.raw("edit_visual_layers", { imageId: id, expectedRevision: layers.revision, layers: [{ id: layers.layers[0].id, opacity: 0.5 }] }), "a layer change");
  // One edit across two Graphs: refused as a whole, neither Graph changes (not even in memory).
  const before2 = (await s.call("get_visual_state", { imageId: id2 })).structuredContent;
  refused(await s.raw("edit_visual_canvas", { imageId: id, workspaceId: wsBoth, marks: [{ id: "peak", item: "wi-1", x: 0.4 }, { id: "q", item: "wi-2", x: 0.7 }] }), "an edit across two Graphs");
  assert.deepEqual((await s.call("get_visual_state", { imageId: id2 })).structuredContent.marks, before2.marks, "the second Graph is unchanged");
  refused(await s.raw("split_workspace", { source: ws0.workspaceId ?? ws0.workspace?.id, mode: "copy", commit: true }), "a copy of the Graph");

  // New Graphs: an explicit one is refused; the default new canvas is a blank image.
  refused(await s.raw("execute_module", { module: GRAPH, capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "graph" } }), "a new Graph");
  const plain = await s.call("execute_module", { module: GRAPH, capability: "plot_function", params: { expression: "x" }, newCanvas: {}, present: false });
  assert.ok(idIn(plain, "img"), "the default new canvas is an image while Graphs are read-only");

  // Nothing stored changed, and an image still takes edits.
  const after = (await s.call("get_visual_state", { imageId: id })).structuredContent;
  assert.deepEqual(after.marks, before.marks);
  assert.deepEqual(after.objects, before.objects);
  assert.equal(after.revision ?? null, before.revision ?? null);
  await s.call("present_visual", { imageId: idIn(plain, "img"), annotations: [{ id: "ok", type: "point", x: 0.5, y: 0.5 }] });
  // A Graph on the left of a paired edit, an image on the right: refused before either side changes.
  const imgBefore = (await s.call("get_visual_state", { imageId: idIn(plain, "img") })).structuredContent.marks;
  refused(await s.raw("edit_visual_canvas", { imageId: id, pairImageId: idIn(plain, "img"), marks: [{ id: "peak", x: 0.4 }, { id: "ok", side: "right", x: 0.7 }] }), "a paired edit with a Graph");
  assert.deepEqual((await s.call("get_visual_state", { imageId: idIn(plain, "img") })).structuredContent.marks, imgBefore, "the image on the right is unchanged");
  await s.stop();

  // On again: the Graph takes edits.
  s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  await s.call("present_visual", { imageId: id, annotations: [{ id: "new", type: "point", x: 0.5, y: 0.5 }] });
  assert.deepEqual((await s.labels(id)), ["new", "peak"]);
  await s.stop();
});

test("readonly: importing a bundle that carries a Graph is refused before anything is made", { timeout: 120000 }, async (t) => {
  const { createUvaService } = await import("../src/uva/service.js");
  const { createCanvasStore } = await import("../src/uva/canvas-store.js");
  const { createGraphCanvas, saveCanvas, useCanvasStore, useGraphPolicy } = await import("../src/storage.js");
  const { applyCanvasChanges } = await import("../src/canvas-state.js");
  const { createWorkspace, clearWorkspaces } = await import("../src/workspace.js");
  const { exportBundle, importBundle } = await import("../src/bundle.js");
  const storage = await mkdtemp(join(tmpdir(), "graph-ro-b-legacy-")), beta = await mkdtemp(join(tmpdir(), "graph-ro-b-uva-"));
  t.after(() => Promise.all([rm(storage, { recursive: true, force: true }), rm(beta, { recursive: true, force: true })]));
  const service = await createUvaService({ enabled: true, canvasStore: true, directory: beta, profile: "linux-process-crash-test", legacyDirectory: storage });
  const store = await createCanvasStore({ service, storageDir: storage, idleMs: 0 });
  useCanvasStore(store);
  t.after(async () => { useGraphPolicy({ readOnly: false }); await store.flush(); await store.close(); await service.close(); useCanvasStore(null); });
  clearWorkspaces();
  const g = await createGraphCanvas({ width: 600, height: 400 });
  applyCanvasChanges(g, { annotations: [{ id: "p", type: "point", x: 0.5, y: 0.5 }], resolve: (a) => a });
  await saveCanvas(g, { tool: "test" });
  const made = await createWorkspace({ items: [{ set: g.imageId }] });
  const { buffer } = await exportBundle(made.workspace.id);
  await store.flush();
  const graphs = async () => (await service.store.snapshot()).documents.filter((d) => d.kind === "graph").length;
  const before = await graphs();

  useGraphPolicy({ readOnly: true });
  await assert.rejects(importBundle(buffer, { name: "again" }), /GRAPH_READ_ONLY/);
  await assert.rejects(createGraphCanvas({}), /GRAPH_READ_ONLY/);
  await store.flush();
  assert.equal(await graphs(), before, "no Graph was made");
});
