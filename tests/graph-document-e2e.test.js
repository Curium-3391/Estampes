// UVA Phase 4A-2: Graph documents through the real server and its MCP tools.
// execute_module(newCanvas: {kind: "graph"}) makes a gph: document with no
// image; canvas tools take it, pixel tools refuse it and name render_canvas.
// Since 4A-4d a newCanvas without kind is a Graph too; kind image keeps the blank image.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCanvasStoreServer } from "./helpers/canvas-store-server.js";

async function folders(t) {
  const storage = await mkdtemp(join(tmpdir(), "graph-e2e-legacy-")), beta = await mkdtemp(join(tmpdir(), "graph-e2e-uva-"));
  t.after(() => Promise.all([rm(storage, { recursive: true, force: true }), rm(beta, { recursive: true, force: true })]));
  return { storage, beta };
}
const list = async (dir) => (await readdir(dir, { recursive: true }).catch(() => [])).sort();
const GRAPH = "org.estampes.graph";
const newGraph = async (s, expression = "x^2", extra = {}) => {
  const r = await s.call("execute_module", { module: GRAPH, capability: "plot_function", params: { expression }, newCanvas: { kind: "graph", ...extra }, present: false });
  const id = r.structuredContent.imageId ?? (JSON.stringify(r.structuredContent).match(/gph:[0-9a-f]{16}/) ?? [])[0];
  assert.match(id, /^gph:[0-9a-f]{16}$/);
  return { id, result: r };
};

test("a Graph made by the graph module has no image, takes marks and edits, renders from its colour, and survives a restart", { timeout: 180000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  t.after(() => s.kill());
  await s.enable(GRAPH);
  // An image first, so the asset folder is not empty and a new asset would show.
  await s.upload("#335577");
  const assets = await list(join(beta, "assets")), images = await list(join(storage, "images"));
  assert.ok(assets.length > 0);

  const { id } = await newGraph(s, "sin(x)", { color: "#FBF8F1", width: 900, height: 600 });
  await s.call("present_visual", { imageId: id, annotations: [{ id: "peak", type: "point", x: .3, y: .25, label: "peak" }, { id: "box", type: "rect", x: .5, y: .5, x2: .7, y2: .8, label: "box" }] });
  // The user's own edit from the widget: relabel the AI's box (allowed since #82).
  await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "box", label: "renamed" }] });
  const state = (await s.call("get_visual_state", { imageId: id })).structuredContent;
  assert.deepEqual(state.marks.map((m) => m.label).sort(), ["peak", "renamed"]);
  assert.ok((state.objects ?? []).some((o) => o.type === "axes-2d"), "the module's axes are on the Graph");

  const render = await s.call("render_canvas", { imageId: id });
  const meta = render.structuredContent?.metadata ?? render.structuredContent;
  assert.equal(JSON.stringify(meta).includes('"sourceKind":"solid"'), true, JSON.stringify(meta).slice(0, 300));

  assert.deepEqual(await list(join(beta, "assets")), assets, "no asset for the Graph");
  assert.deepEqual(await list(join(storage, "images")), images, "no image file for the Graph");

  await s.stop();
  s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  assert.deepEqual(await s.labels(id), ["peak", "renamed"], "the Graph comes back after a restart");
  const again = (await s.call("get_visual_state", { imageId: id })).structuredContent;
  assert.ok((again.objects ?? []).some((o) => o.type === "axes-2d"));
  assert.deepEqual(await list(join(beta, "assets")), assets);
  await s.stop();
});

test("pixel tools refuse a Graph and point to render_canvas; two Graphs stay apart; the default new canvas is a Graph, kind image a blank image", { timeout: 180000 }, async (t) => {
  const { storage, beta } = await folders(t);
  const s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  t.after(() => s.kill());
  await s.enable(GRAPH);
  const a = await newGraph(s, "x^2"), b = await newGraph(s, "x^3");
  assert.notEqual(a.id, b.id);
  await s.call("present_visual", { imageId: a.id, annotations: [{ id: "only-a", type: "point", x: .5, y: .5, label: "only-a" }] });
  assert.deepEqual(await s.labels(a.id), ["only-a"]);
  assert.deepEqual(await s.labels(b.id), []);

  for (const [name, args] of [["inspect_image", { imageId: a.id }], ["process_image", { imageId: a.id, ops: [{ op: "grayscale" }] }],
    ["measure_image", { imageId: a.id }], ["detect_features", { imageId: a.id }], ["load_visual_pixels", { imageId: a.id }]]) {
    const r = await s.raw(name, args);
    assert.equal(r.isError, true, name + " must refuse a Graph");
    assert.match(JSON.stringify(r.content), /render_canvas/, name + ": " + JSON.stringify(r.content).slice(0, 300));
  }

  const image = await s.upload("#335577");
  const pair = await s.raw("present_visual", { imageId: a.id, pairImageId: image, annotations: [{ id: "x", type: "point", x: .2, y: .2 }] });
  assert.equal(pair.isError, true, "a Graph is not one side of a paired view yet");
  assert.match(JSON.stringify(pair.content), /paired view/);
  assert.deepEqual(await s.labels(a.id), ["only-a"], "the refused pair changed nothing");
  const viewed = await s.raw("present_visual", { imageId: a.id, annotations: [{ id: "y", type: "point", x: .3, y: .3 }], views: [{ label: "v", ops: [{ op: "grayscale" }] }] });
  assert.equal(viewed.isError, true, "a Graph has no processed views");
  assert.match(JSON.stringify(viewed.content), /render_canvas/);
  assert.deepEqual(await s.labels(a.id), ["only-a"], "the refused views changed nothing");

  const byDefault = await s.call("execute_module", { module: GRAPH, capability: "plot_function", params: { expression: "x" }, newCanvas: {}, present: false });
  assert.match(JSON.stringify(byDefault.structuredContent), /gph:[0-9a-f]{16}/, "without kind the new canvas is a Graph");
  const plain = await s.call("execute_module", { module: GRAPH, capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "image" }, present: false });
  assert.match(JSON.stringify(plain.structuredContent), /img:[0-9a-f]{16}/, "kind image is the blank image");
  const bad = await s.raw("execute_module", { module: GRAPH, capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "graph", background: "paper" } });
  assert.equal(bad.isError, true, "background names an image canvas's paper, not a Graph colour");
  await s.stop();
});

// Every tool argument that names a canvas or an image is listed here as taking
// a Graph (gph:) or not. A new tool, or a changed pattern, fails this test until
// it is classified: a tool that reads pixels must not quietly take a Graph, and
// a canvas tool must not quietly refuse one.
const TAKES_GRAPH = ["commands_get_status.documentId", "create_workspace.canvases", "edit_workspace.canvases", "documents_get_changes.documents", "edit_canvas_text.imageId", "edit_scene_object.imageId",
  "edit_visual_canvas.imageId", "edit_visual_layers.imageId", "execute_module.canvas", "get_visual_layers.imageId", "get_visual_state.imageId",
  "get_surface_state.imageId", "manage_surface_panels.imageId", "surface_apply.imageId", "surface_cas.imageId", "surface_get_state.imageId",
  "load_visual_canvas.imageId", "present_visual.imageId", "render_canvas.imageId", "review_gesture_group.imageId", "review_visual_finding.imageId",
  "review_visual_link.imageId", "validate_visual_annotations.imageId"];
// Pixel tools and paired views (the right side is an image).
const IMAGE_ONLY = ["add_image_layer.imageId", "add_image_layer.sourceImageId", "assess_image.imageId", "calibrate_scale.imageId", 
  "detect_features.imageId", "edit_visual_canvas.pairImageId", "get_derived_view.imageId",
  "get_visual_state.pairImageId", "inspect_image.imageId", "load_visual_canvas.pairImageId", "load_visual_pixels.imageId", "load_visual_region.imageId",
  "measure_image.imageId", "overlay_grid.imageId", "present_visual.pairImageId", "process_image.imageId",
  "register_images.imageId", "register_images.otherImageId", "review_visual_link.pairImageId",
  "validate_visual_annotations.pairImageId"];

test("every tool argument naming a canvas or image is classified as taking a Graph or not", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  const s = await startCanvasStoreServer(storage, beta);
  t.after(() => s.kill());
  const { tools } = await s.client.listTools();
  const takes = [], refuses = [];
  for (const tool of tools) for (const [name, schema] of Object.entries(tool.inputSchema?.properties ?? {})) {
    const patterns = [...JSON.stringify(schema).matchAll(/"pattern":("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1])).filter((p) => p.includes("img"));
    if (!patterns.length) continue;
    const graph = patterns.some((p) => new RegExp(p).test("gph:0123456789abcdef"));
    (graph ? takes : refuses).push(tool.name + "." + name);
  }
  assert.deepEqual(takes.sort(), [...TAKES_GRAPH].sort(), "arguments that take a Graph");
  assert.deepEqual(refuses.sort(), [...IMAGE_ONLY].sort(), "arguments that take only an image");
  await s.stop();
});

test("with a public URL, an image gets download links and a Graph gets none that would not resolve", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  const s = await startCanvasStoreServer(storage, beta, { env: { PUBLIC_BASE_URL: "https://estampes.example.test" } });
  t.after(() => s.kill());
  await s.enable(GRAPH);
  const image = await s.upload("#335577");
  assert.ok((await s.call("present_visual", { imageId: image })).structuredContent.exports?.image, "an image keeps its links");
  const { id } = await newGraph(s);
  const shown = await s.call("present_visual", { imageId: id });
  assert.equal(shown.structuredContent.exports, undefined);
  assert.doesNotMatch(JSON.stringify(shown), /\/export\/[0-9a-f]{16}\//, "no image or marks link for a Graph");
  await s.stop();
});

test("Graphs sit in a workspace beside an image: marks per item, restart, bundles, refused pairs", { timeout: 180000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  t.after(() => s.kill());
  await s.enable(GRAPH);
  const image = await s.upload("#335577");
  const graphs = [(await newGraph(s, "x^2")).id, (await newGraph(s, "sin(x)", { color: "#FBF8F1" })).id, (await newGraph(s, "x^3")).id];
  const made = await s.call("create_workspace", { name: "mixed", canvases: [...graphs, image] });
  const wsId = made.structuredContent.workspaceId;
  assert.match(wsId, /^ws:/);
  const shown = await s.call("present_visual", { workspaceId: wsId, annotations: [
    { id: "g1", item: "wi-1", type: "point", x: .2, y: .3, label: "on graph 1" },
    { id: "g3", item: "wi-3", type: "rect", x: .1, y: .1, x2: .3, y2: .3, label: "on graph 3" },
    { id: "im", item: "wi-4", type: "point", x: .5, y: .5, label: "on image" }] });
  const items = shown.structuredContent.workspace.items;
  assert.deepEqual(items.map((it) => it.imageId), [...graphs, image]);
  // Each mark lands on its own canvas, and a Graph item shows its axes.
  assert.deepEqual(await s.labels(graphs[0]), ["on graph 1"]);
  assert.deepEqual(await s.labels(graphs[1]), []);
  assert.deepEqual(await s.labels(graphs[2]), ["on graph 3"]);
  assert.deepEqual(await s.labels(image), ["on image"]);
  const px = shown._meta["estampes/items"];
  assert.deepEqual(px.slice(0, 3).map((p) => p.background?.kind), ["solid", "solid", "solid"], "Graph items come as their colour");
  assert.equal(px[1].background.color, "#fbf8f1");
  assert.ok(px.slice(0, 3).every((p) => p.objects.some((o) => o.type === "axes-2d")), "and with their axes");

  // A Graph alone, as a workspace source ("from"), and an edit that adds a Graph.
  const fromGraph = await s.call("create_workspace", { from: [graphs[1]] });
  assert.deepEqual(fromGraph.structuredContent.items.map((it) => it.set), [graphs[1]]);
  const added = await s.call("edit_workspace", { workspaceId: wsId, canvases: [(await newGraph(s, "x")).id], expectedRevision: shown.structuredContent.workspace.revision });
  assert.equal(added.structuredContent.items.length, 5);

  // Not yet: a Graph in a paired view. Refused, and makes nothing.
  const pair = await s.raw("create_workspace", { from: [graphs[0] + "+" + image] });
  assert.equal(pair.isError, true);
  assert.match(JSON.stringify(pair.content), /paired view needs two images/);
  // A bundle carries the Graphs as data (no image file for them), the image as its file.
  const bundle = await s.call("export_workspace_bundle", { workspace: wsId });
  const kinds = bundle.structuredContent.manifest.assets.map((a) => a.kind ?? "image");
  assert.deepEqual(kinds.sort(), ["graph", "graph", "graph", "graph", "image"]);

  await s.stop();
  s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  const back = await s.call("present_visual", { workspaceId: wsId });
  assert.deepEqual(back.structuredContent.workspace.items.slice(0, 4).map((it) => it.imageId), [...graphs, image], "the workspace comes back after a restart");
  assert.deepEqual(await s.labels(graphs[2]), ["on graph 3"]);
  await s.stop();
});

test("a copy of a Graph is a Graph of its own: same axes and marks, then edited apart, and back after a restart", { timeout: 180000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  t.after(() => s.kill());
  await s.enable(GRAPH);
  const image = await s.upload("#335577");
  const { id: graph } = await newGraph(s, "x^2", { color: "#FBF8F1" });
  await s.call("present_visual", { imageId: graph, annotations: [{ id: "p", type: "point", x: .4, y: .6, label: "on the original" }] });
  const preview = await s.call("merge_workspaces", { target: image, source: graph, mode: "copy" });
  const merged = await s.call("merge_workspaces", { target: image, source: graph, mode: "copy", commit: true, previewId: preview.structuredContent.previewId });
  const wsId = merged.structuredContent.workspaceId;
  const { items } = (await s.call("get_workspace_state", { workspace: wsId })).structuredContent;
  const item = items.find((it) => it.set.startsWith(graph + "#c"));
  assert.ok(item, "the workspace holds a copy of the Graph: " + JSON.stringify(items));
  const copyKey = item.set;
  // A copy's marks, as the workspace document lists them.
  const copyLabels = async () => (await s.call("get_workspace_state", { workspace: wsId })).structuredContent.sets
    .find((set) => set.key === copyKey).marks.map((m) => m.label ?? m.id).sort();
  assert.match(copyKey, /^gph:[0-9a-f]{16}#c[0-9a-f]{8,16}$/);
  assert.deepEqual(await copyLabels(), ["on the original"], "the copy starts with the Graph's marks");

  const shown = await s.call("present_visual", { workspaceId: wsId, annotations: [{ id: "q", item: item.id, type: "point", x: .1, y: .1, label: "on the copy" }] });
  assert.deepEqual((await copyLabels()).sort(), ["on the copy", "on the original"]);
  assert.deepEqual(await s.labels(graph), ["on the original"], "a mark on the copy leaves the Graph as it was");
  const px = shown._meta["estampes/items"].find((p) => p.id === item.id);
  assert.equal(px.background?.kind, "solid", "the copy is drawn as its colour, not an image");
  assert.equal(px.background.color, "#fbf8f1");
  assert.ok(px.objects.some((o) => o.type === "axes-2d"), "with the Graph's vector axes");
  const pixels = await s.raw("inspect_image", { imageId: copyKey });
  assert.equal(pixels.isError, true, "a pixel tool refuses the copy too");

  await s.stop();
  s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  assert.deepEqual((await copyLabels()).sort(), ["on the copy", "on the original"], "the copy comes back after a restart");
  const back = await s.call("present_visual", { workspaceId: wsId });
  assert.ok(back.structuredContent.workspace.items.some((it) => it.set === copyKey));
  await s.stop();
});
