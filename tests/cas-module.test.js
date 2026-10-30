import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { createCasClient } from "../src/cas/client.js";
import { createNotebooks } from "../src/cas/notebooks.js";
import { configure } from "../src/builtin-modules/cas/index.js";
import { canvasObjects } from "../src/scene/scene-ops.js";
import { astToGraph, checkPlottable } from "../src/cas/bridge.js";

const python = process.env.PYTHON || "python3";
const hasSympy = spawnSync(python, ["-c", "import sympy"]).status === 0;
const skip = hasSympy ? false : "python3 with sympy is not installed";
let proc, dir, sock, h, nbDir;
const CAS = "org.estampes.cas";

before(async () => {
  if (!hasSympy) return;
  dir = await mkdtemp(join(tmpdir(), "estampes-cas-"));
  sock = join(dir, "cas.sock");
  proc = spawn(python, ["-m", "estampes_cas"], { cwd: "cas-service", env: { ...process.env, ESTAMPES_CAS_SOCKET: sock, ESTAMPES_CAS_TIMEOUT_MS: "3000", PYTHONPATH: "cas-service" }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await access(sock); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  nbDir = join(dir, "nb");
  configure({ client: createCasClient({ socketPath: sock }), notebooks: createNotebooks({ dir: nbDir }) });
  h = await createModuleHost({ storageDir: dir, coreVersion: "0.16.0", canvases: { ensure: ensureImage, create: createBlankCanvas, save: async () => {} } });
});
after(() => { proc?.kill("SIGKILL"); });

const enable = async () => { const plan = await h.lifecycle.prepare("enable", CAS); return h.lifecycle.commit(plan.planId, { consent: plan.consent }); };
const call = (capability, params, extra = {}) => h.router.execute({ module: CAS, capability, params, ...extra });

test("cas: disabled until the user enables it", { skip }, async () => {
  await assert.rejects(call("calculate", { operation: "evaluate", text: "1+1" }), /Only the user can enable/);
  assert.equal((await enable()).result.state, "enabled");
});

test("cas: exact results come from SymPy, with LaTeX and a typed AST", { skip }, async () => {
  const r = await call("calculate", { operation: "differentiate", text: "sin(x^2)", variable: "x" });
  const cell = r.data.cell;
  assert.equal(cell.result.plain, "2*x*cos(x^2)");
  assert.equal(cell.result.status, "exact");
  assert.match(cell.result.latex, /\\cos/);
  assert.equal(cell.result.ast.node, "mul");
  assert.equal(cell.result.engine.name, "SymPy");
  const half = await call("calculate", { operation: "evaluate", latex: "\\frac{1}{3}+\\frac{1}{6}" });
  assert.equal(half.data.cell.result.plain, "1/2");
  const integral = await call("calculate", { operation: "integrate", text: "2*x" });
  assert.equal(integral.data.cell.result.plain, "x^2 + C");
});

test("cas: bad input is a cell error, the input is kept and nothing executes", { skip }, async () => {
  const r = await call("calculate", { operation: "evaluate", text: "__import__('os').system('true')" });
  assert.equal(r.data.cell.state, "error");
  assert.equal(r.data.cell.error.code, "syntax");
  assert.equal(r.data.cell.input.text, "__import__('os').system('true')");
  const big = await call("calculate", { operation: "evaluate", text: "10^100000" });
  assert.equal(big.data.cell.error.code, "resource_limit");
});

test("cas: plot_result draws a semantic function plot and links it to the cell", { skip }, async () => {
  const d = await call("calculate", { operation: "differentiate", text: "sin(x^2)", variable: "x" });
  const { notebookId } = d.data, cellId = d.data.cell.cellId;
  const plotted = await call("plot_result", { notebook: notebookId, cell: cellId, domain: [-3, 3] }, { newCanvas: {} });
  const plot = canvasObjects(plotted.entry).find((o) => o.type === "function-plot");
  assert.equal(plot.props.expression, "2*x*cos(x^2)");
  assert.equal(plot.provenance.module, CAS);
  const nb = await call("get_notebook", { notebook: notebookId });
  const link = nb.data.cells.find((c) => c.cellId === cellId).links[0];
  assert.equal(link.object, plot.id);
  assert.equal(link.status, "fresh");
  assert.equal(link.canvas, plotted.entry.imageId);
});

test("cas: editing upstream makes results and links stale, and a stale result is not plotted", { skip }, async () => {
  const f = await call("define", { name: "f", params: ["x"], text: "sin(x)" });
  const nbId = f.data.notebookId;
  const c = await call("calculate", { operation: "differentiate", text: "f(x)", variable: "x", notebook: nbId });
  assert.equal(c.data.cell.result.plain, "cos(x)");
  const plotted = await call("plot_result", { notebook: nbId, cell: c.data.cell.cellId }, { newCanvas: {} });
  const plotId = canvasObjects(plotted.entry).find((o) => o.type === "function-plot").id;
  await call("define", { name: "f", params: ["x"], text: "sin(2*x)", notebook: nbId });
  const stale = (await call("get_notebook", { notebook: nbId })).data.cells[0];
  assert.equal(stale.state, "stale");
  assert.equal(stale.links[0].status, "stale");
  await assert.rejects(call("plot_result", { notebook: nbId, cell: stale.cellId }, { newCanvas: {} }), /stale/);
  const re = await call("recompute", { notebook: nbId });
  assert.equal(re.data.cells[0].result.plain, "2*cos(2*x)");
  assert.equal(re.data.cells[0].state, "fresh");
  const again = await call("plot_result", { notebook: nbId, cell: stale.cellId, object: plotId }, { canvas: plotted.entry.imageId });
  assert.equal(canvasObjects(again.entry).find((o) => o.id === plotId).props.expression, "2*cos(2*x)");
  assert.equal(canvasObjects(again.entry).filter((o) => o.type === "function-plot").length, 1);
  assert.equal((await call("get_notebook", { notebook: nbId })).data.cells[0].links[0].status, "fresh");
});

test("cas: conditional, partial and complex results are never plotted as ordinary functions", { skip }, async () => {
  for (const [params, why] of [[{ operation: "solve", text: "sin(x)=0", domain: "real" }, /conditional/], [{ operation: "integrate", text: "x^x" }, /partial/], [{ operation: "evaluate", text: "I*x" }, /complex/]]) {
    const r = await call("calculate", params);
    await assert.rejects(call("plot_result", { notebook: r.data.notebookId, cell: r.data.cell.cellId }, { newCanvas: {} }), why);
  }
  const two = await call("calculate", { operation: "evaluate", text: "x+y" });
  await assert.rejects(call("plot_result", { notebook: two.data.notebookId, cell: two.data.cell.cellId }, { newCanvas: {} }), /several variables/);
});

test("cas: revision conflicts and idempotency keys", { skip }, async () => {
  const a = await call("calculate", { operation: "evaluate", text: "1+1", idempotencyKey: "k1" });
  const same = await call("calculate", { operation: "evaluate", text: "1+1", idempotencyKey: "k1", notebook: a.data.notebookId });
  assert.equal(same.data.replayed, true);
  assert.equal(same.data.cell.cellId, a.data.cell.cellId);
  const nb = (await call("get_notebook", { notebook: a.data.notebookId })).data;
  await call("calculate", { operation: "evaluate", text: "2+2", notebook: nb.notebookId });
  await assert.rejects(call("calculate", { operation: "evaluate", text: "3+3", notebook: nb.notebookId, expectedRevision: nb.revision }), /changed since revision/);
});

test("cas: notebooks survive a restart of the Core", { skip }, async () => {
  const r = await call("calculate", { operation: "factor", text: "x^2-4" });
  const reopened = createNotebooks({ dir: nbDir });
  const nb = await reopened.get(r.data.notebookId);
  assert.equal(nb.cells[0].result.exact.plain, "(x - 2)*(x + 2)");
});

test("cas: with no calculator service the module reports it and Core keeps working", async () => {
  configure({ client: createCasClient({ socketPath: join(tmpdir(), "no-such-estampes.sock") }) });
  try {
    const dir2 = await mkdtemp(join(tmpdir(), "estampes-cas2-"));
    const h2 = await createModuleHost({ storageDir: dir2, coreVersion: "0.16.0", canvases: { ensure: ensureImage, create: createBlankCanvas, save: async () => {} } });
    const plan = await h2.lifecycle.prepare("enable", CAS);
    await h2.lifecycle.commit(plan.planId, { consent: plan.consent });
    configure({ notebooks: createNotebooks({ dir: "" }) });
    const r = await h2.router.execute({ module: CAS, capability: "calculate", params: { operation: "evaluate", text: "1+1" } });
    assert.equal(r.data.cell.state, "error");
    assert.equal(r.data.cell.error.code, "worker_unavailable");
  } finally {
    if (hasSympy) configure({ client: createCasClient({ socketPath: sock }), notebooks: createNotebooks({ dir: nbDir }) });
  }
});

test("bridge: only real single-variable results become Graph expressions", () => {
  const x = { node: "symbol", name: "x" };
  assert.equal(astToGraph({ node: "pow", left: x, right: { node: "integer", value: "2" } }).expression, "x^2");
  assert.equal(astToGraph({ node: "mul", args: [{ node: "rational", num: "1", den: "3" }, x] }).expression, "1/3*x");
  assert.throws(() => astToGraph({ node: "constant", name: "I" }), /complex/);
  assert.throws(() => astToGraph({ node: "opaque", plain: "Si(x)" }), /cannot be drawn/);
  assert.throws(() => astToGraph({ node: "call", fn: "gamma", args: [x] }), /cannot plot/);
  assert.throws(() => checkPlottable({ status: "conditional", exact: { ast: x } }), /not an ordinary real function/);
  assert.throws(() => checkPlottable({ status: "exact", exact: { ast: { node: "call", fn: "ln", args: [{ node: "pow", left: x, right: { node: "integer", value: "2" } }, ] } } }, [-0.0, 0.0]), /no real values/);
});
