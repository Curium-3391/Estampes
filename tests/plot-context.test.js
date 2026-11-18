// UVA Phase 4A-3: the graph module reads axes and plots through one adapter
// (src/modules/plot-context.js), so a Graph document (gph:) and an old blank
// image canvas (img:) give the module the same context and the same result.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUvaService } from "../src/uva/service.js";
import { createCanvasStore } from "../src/uva/canvas-store.js";
import { createGraphCanvas, ensureImage, useCanvasStore } from "../src/storage.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { createModuleHost } from "../src/modules/index.js";
import { canvasObjects } from "../src/scene/scene-ops.js";
import { plotContext, plotContextOf, PLOT_CONTEXT_VERSION } from "../src/modules/plot-context.js";
import { run as graphRun } from "../src/builtin-modules/graph/index.js";

async function setup(t) {
  const storage = await mkdtemp(join(tmpdir(), "plotctx-legacy-")), beta = await mkdtemp(join(tmpdir(), "plotctx-uva-"));
  const service = await createUvaService({ enabled: true, canvasStore: true, directory: beta, profile: "linux-process-crash-test", legacyDirectory: storage });
  const store = await createCanvasStore({ service, storageDir: storage, idleMs: 0 });
  useCanvasStore(store);
  // The request each module run was given, to compare what the module saw.
  const seen = [];
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.10.0",
    canvases: { ensure: ensureImage, create: (o = {}) => (o.kind === "graph" ? createGraphCanvas(o) : createBlankCanvas(o)), save: async () => {} } });
  const builtin = h.runtimes.builtin;
  h.runtimes.builtin = { ...builtin, run: (...args) => { seen.push(structuredClone(args.at(-1)?.canvas ?? null)); return builtin.run(...args); } };
  const plan = await h.lifecycle.prepare("enable", "org.estampes.graph");
  await h.lifecycle.commit(plan.planId, { consent: plan.consent });
  t.after(async () => { await store.flush(); await store.close(); await service.close(); useCanvasStore(null);
    await Promise.all([rm(storage, { recursive: true, force: true }), rm(beta, { recursive: true, force: true })]); });
  return { h, seen };
}

// The same four steps on a canvas of either kind; returns the objects made.
async function steps(h, newCanvas) {
  const exec = (capability, params, canvas) => h.router.execute({ module: "org.estampes.graph", capability, params, ...(canvas ? { canvas } : { newCanvas }) });
  const first = await exec("plot_function", { expression: "sin(x)" });
  const id = first.entry.imageId;
  await exec("plot_function", { expression: "cos(x)", color: "red" }, id);
  await exec("update_plot", { object: "o2", expression: "sin(2x)", color: "green" }, id);
  await exec("set_axes", { yRange: [-3, 3], title: "trig" }, id);
  const last = await exec("plot_points", { points: [[0, 0], [1, 1]] }, id);
  return { id, objects: canvasObjects(last.entry).map(({ id: oid, type, props }) => ({ id: oid, type, props })) };
}

test("the graph module draws the same on a Graph document and on a blank image canvas", { timeout: 120000 }, async (t) => {
  const { h, seen } = await setup(t);
  const graph = await steps(h, { kind: "graph" });
  const graphSeen = seen.splice(0);
  const image = await steps(h, {});
  assert.match(graph.id, /^gph:/);
  assert.match(image.id, /^img:/);
  assert.deepEqual(graph.objects, image.objects, "same axes, plots and points on both kinds");
  assert.equal(graph.objects.find((o) => o.id === "o2").props.style.color, "green", "a plot's colour change keeps going through the adapter");

  // What the module was given: the plot context, with the kind, the same otherwise.
  const last = (list) => list.at(-1);
  assert.equal(last(graphSeen).kind, "graph");
  assert.equal(last(seen).kind, "image");
  assert.equal(last(graphSeen).plot.kind, "graph");
  const { kind: _a, ...gp } = last(graphSeen).plot, { kind: _b, ...ip } = last(seen).plot;
  assert.deepEqual(gp, ip);
  assert.equal(gp.version, PLOT_CONTEXT_VERSION);
  assert.deepEqual(gp.frames.map((f) => [f.id, f.yRange, f.title]), [["o1", [-3, 3], "trig"]]);
  assert.deepEqual(gp.plots.map((p) => [p.id, p.frame, p.expression]), [["o2", "o1", "sin(2x)"], ["o3", "o1", "cos(x)"]]);
});

test("the graph module reads axes and plots from the plot context, not from the object list", () => {
  // A context whose plot names axes the object list does not have: the module follows the plot context.
  const canvas = { kind: "graph", objects: [], plot: { version: 1, kind: "graph", frames: [{ id: "f9", xRange: [0, 1], yRange: [0, 1] }], plots: [{ id: "p4", frame: "f9", expression: "x" }] } };
  assert.deepEqual(graphRun("set_axes", { title: "t" }, { canvas }).operations, [{ op: "object.update", id: "f9", props: { title: "t" } }]);
  assert.deepEqual(graphRun("update_plot", { object: "p4", expression: "x^2" }, { canvas }).operations, [{ op: "object.update", id: "p4", props: { expression: "x^2" } }]);
  assert.match(graphRun("plot_function", { expression: "x" }, { canvas }).summary, /on axes f9/);
  assert.throws(() => graphRun("update_plot", { object: "f9", expression: "x" }, { canvas }), /not a function plot/);
});

test("plot context: built from objects when a caller gives none, and plain JSON", () => {
  const objects = [
    { id: "o1", type: "axes-2d", props: { xRange: [-1, 1], yRange: [-2, 2], xTicks: "pi", secret: 1 } },
    { id: "o2", type: "function-plot", props: { frame: "o1", expression: "x", style: { color: "red" } } },
    { id: "o3", type: "shape", props: { kind: "dots" } },
  ];
  const ctx = plotContext({ kind: "image", objects });
  assert.deepEqual(ctx, { version: 1, kind: "image", frames: [{ id: "o1", xRange: [-1, 1], yRange: [-2, 2], xTicks: "pi" }],
    plots: [{ id: "o2", frame: "o1", expression: "x", style: { color: "red" } }] });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx)), ctx);
  // A self-test passes only {objects, marks}: the module still gets a context.
  assert.deepEqual(plotContextOf({ objects, marks: [] }), ctx);
  assert.deepEqual(plotContextOf(null), { version: 1, kind: "image", frames: [], plots: [] });
});
