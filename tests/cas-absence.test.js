// #174 step 3: the rest of Estampes keeps working when the calculator is off, missing or its service is down, and the calculator says
// plainly what it lacks when Graph is off. The calculator service is a fake; the module host, router and notebooks are real.
// (Bindings going "unavailable" and back are covered in surface-refresh-unavailable.test.js and derived-module-flow.test.js.)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { canvasObjects } from "../src/scene/scene-ops.js";
import { ensureImage } from "../src/storage.js";
import { createNotebooks } from "../src/cas/notebooks.js";
import { configure } from "../src/builtin-modules/cas/index.js";

const CAS = "org.estampes.cas", GRAPH = "org.estampes.graph";
let down = false;
const client = {
  async health() { return { engine: { name: "fake", version: "0" }, operations: [], limits: {} }; },
  async parse(input) { return { text: input.text, ast: { node: "number", value: "1" } }; },
  async compute() {
    if (down) throw new Error("the calculator is not reachable");
    return { status: "exact", exact: { plain: "2*x", latex: "2x", ast: { node: "mul", args: [{ node: "integer", value: "2" }, { node: "symbol", name: "x" }] } }, engine: { name: "fake", version: "0" } };
  },
};
async function setup({ service = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "estampes-absent-"));
  configure(service ? { client, notebooks: createNotebooks({ dir: join(dir, "nb") }) } : { client: null, notebooks: null });
  const h = await createModuleHost({ storageDir: dir, coreVersion: "0.18.0", canvases: { ensure: ensureImage, create: createBlankCanvas, save: async () => {} } });
  const change = async (action, id) => { const plan = await h.lifecycle.prepare(action, id); return h.lifecycle.commit(plan.planId, { consent: plan.consent }); };
  const run = (module, capability, params, extra = {}) => h.router.execute({ module, capability, params, ...extra });
  const plot = async () => (await run(GRAPH, "plot_function", { expression: "x^2" }, { newCanvas: {} })).entry;
  const cell = async () => { const c = await run(CAS, "calculate", { operation: "differentiate", text: "x^2", variable: "x" }); return { notebook: c.data.notebookId, cell: c.data.cell.cellId }; };
  return { h, change, run, plot, cell };
}

test("with the calculator never enabled, Graph and canvases work as before", async () => {
  const s = await setup();
  await s.change("enable", GRAPH);
  const entry = await s.plot();
  assert.equal(canvasObjects(entry).filter((o) => o.type === "function-plot").length, 1);
  await assert.rejects(s.run(CAS, "calculate", { operation: "evaluate", text: "1+1" }), /Only the user can enable/);
  assert.equal(s.h.registry.get(CAS).record.state, "available");
});

test("with no calculator service on the server, the host starts, Graph works and a calculator action says why it cannot", async () => {
  const s = await setup({ service: false });
  await s.change("enable", GRAPH); await s.change("enable", CAS);
  assert.equal(canvasObjects(await s.plot()).length > 0, true);
  await assert.rejects(s.run(CAS, "calculate", { operation: "evaluate", text: "1+1" }), /calculator service is not configured/);
});

test("with Graph off, the calculator still calculates and says plainly that drawing needs Graph; nothing is drawn", async () => {
  const s = await setup();
  await s.change("enable", CAS);
  const c = await s.cell();
  await assert.rejects(s.run(CAS, "plot_result", c, { newCanvas: {} }), (e) => e.code === "unavailable" && /org\.estampes\.graph/.test(e.message));
  await s.change("enable", GRAPH);
  const plotted = await s.run(CAS, "plot_result", c, { newCanvas: {} });
  assert.equal(canvasObjects(plotted.entry).filter((o) => o.type === "function-plot").length, 1);
});

test("disabling the calculator leaves a plot it drew in place; Graph still draws on that canvas; enabling it again works", async () => {
  const s = await setup();
  await s.change("enable", GRAPH); await s.change("enable", CAS);
  const c = await s.cell();
  const plotted = await s.run(CAS, "plot_result", c, { newCanvas: {} });
  const id = canvasObjects(plotted.entry).find((o) => o.type === "function-plot").id;
  await s.change("disable", CAS);
  // The plot is the calculator's object (modules change only their own), so Graph does not edit it; it stays, and Graph can add to the canvas.
  const more = await s.run(GRAPH, "plot_function", { expression: "x" }, { canvas: plotted.entry.imageId });
  const plots = canvasObjects(more.entry).filter((o) => o.type === "function-plot");
  assert.equal(plots.length, 2);
  assert.ok(plots.some((o) => o.id === id), "the calculator's plot is still there");
  await assert.rejects(s.run(CAS, "calculate", { operation: "evaluate", text: "1+1" }), /Only the user can enable|disabled/);
  await s.change("enable", CAS);
  assert.equal((await s.run(CAS, "calculate", { operation: "evaluate", text: "1+1" })).data.cell.result.plain, "2*x");
});

test("when the calculator service goes down and returns, only calculator actions fail, and they recover", async () => {
  const s = await setup();
  await s.change("enable", GRAPH); await s.change("enable", CAS);
  const c = await s.cell();
  down = true;
  try {
    await assert.rejects(s.run(CAS, "calculate", { operation: "evaluate", text: "1+1", notebook: c.notebook }), /not reachable|calculator/);
    assert.equal(canvasObjects(await s.plot()).length > 0, true, "Graph is unaffected");
  } finally { down = false; }
  assert.ok((await s.run(CAS, "calculate", { operation: "evaluate", text: "1+1" })).data.cell, "works again once the service is back");
});

test("a host built without the calculator module at all starts and runs Graph", async () => {
  const graph = await import("../src/builtin-modules/graph/index.js");
  const dir = await mkdtemp(join(tmpdir(), "estampes-removed-"));
  const h = await createModuleHost({ storageDir: dir, coreVersion: "0.18.0", builtins: [graph], canvases: { ensure: ensureImage, create: createBlankCanvas, save: async () => {} } });
  assert.ok(!h.registry.get(CAS), "no calculator module is registered");
  const plan = await h.lifecycle.prepare("enable", GRAPH);
  await h.lifecycle.commit(plan.planId, { consent: plan.consent });
  const out = await h.router.execute({ module: GRAPH, capability: "plot_function", params: { expression: "x" }, newCanvas: {} });
  assert.equal(canvasObjects(out.entry).filter((o) => o.type === "function-plot").length, 1);
});
