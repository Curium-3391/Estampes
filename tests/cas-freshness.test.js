// CAS results must be bound to the notebook state they were computed in, and
// one idempotency key must make one cell even when calls overlap
// (architecture review A02). A fake calculator service lets each test hold a
// calculation open while the notebook changes.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { createNotebooks } from "../src/cas/notebooks.js";
import { configure } from "../src/builtin-modules/cas/index.js";

const CAS = "org.estampes.cas";
let h, gates = [], computeCalls = 0;
// compute() waits until the test opens its gate.
const client = {
  async health() { return { engine: { name: "fake", version: "0" }, operations: [], limits: {} }; },
  async parse(input) { return { text: input.text ?? input.latex, ast: { node: "number", value: String(input.text ?? input.latex) } }; },
  async compute() {
    computeCalls++;
    await new Promise((resolve) => gates.push(resolve));
    return { status: "exact", exact: { plain: "42", latex: "42", ast: { node: "number", value: "42" } }, engine: { name: "fake", version: "0" } };
  },
};
const openGates = () => { const g = gates; gates = []; g.forEach((r) => r()); };
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); };

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-cas-fresh-"));
  configure({ client, notebooks: createNotebooks({ dir: join(dir, "nb") }) });
  h = await createModuleHost({ storageDir: dir, coreVersion: "0.18.0", canvases: { ensure: ensureImage, create: createBlankCanvas, save: async () => {} } });
  const plan = await h.lifecycle.prepare("enable", CAS);
  await h.lifecycle.commit(plan.planId, { consent: plan.consent });
});
const call = (capability, params) => h.router.execute({ module: CAS, capability, params });

test("a result computed before a definition changed is not published as fresh", async () => {
  const nb = (await call("define", { name: "a", text: "1" })).data.notebookId;
  const pending = call("calculate", { notebook: nb, operation: "evaluate", text: "a+1" });
  await until(() => gates.length === 1);
  await call("define", { notebook: nb, name: "a", text: "2" });
  openGates();
  const cell = (await pending).data.cell;
  assert.equal(cell.state, "stale", "the definition changed while computing, so the result is stale");
  assert.match(cell.staleReason, /changed while this was being computed/);
  // Plotting refuses a stale result until it is recomputed.
  await assert.rejects(call("plot_result", { notebook: nb, cell: cell.cellId }), /stale/);
});

test("a result whose environment did not change is fresh", async () => {
  const nb = (await call("define", { name: "b", text: "1" })).data.notebookId;
  const pending = call("calculate", { notebook: nb, operation: "evaluate", text: "b+1" });
  await until(() => gates.length === 1);
  openGates();
  assert.equal((await pending).data.cell.state, "fresh");
});

test("a recompute that overlaps a definition change stays stale", async () => {
  const nb = (await call("define", { name: "c", text: "1" })).data.notebookId;
  const first = call("calculate", { notebook: nb, operation: "evaluate", text: "c+1" });
  await until(() => gates.length === 1); openGates();
  const cellId = (await first).data.cell.cellId;
  await call("define", { notebook: nb, name: "c", text: "5" });
  const re = call("recompute", { notebook: nb, cell: cellId });
  await until(() => gates.length === 1);
  await call("define", { notebook: nb, name: "c", text: "7" });
  openGates();
  await re;
  const read = (await call("get_notebook", { notebook: nb, full: true })).data;
  assert.equal(read.cells.find((c) => c.cellId === cellId).state, "stale");
});

test("overlapping calls with one idempotency key compute once and add one cell", async () => {
  const nb = (await call("define", { name: "d", text: "1" })).data.notebookId;
  const before = computeCalls;
  const one = call("calculate", { notebook: nb, operation: "evaluate", text: "d+1", idempotencyKey: "same-key" });
  const two = call("calculate", { notebook: nb, operation: "evaluate", text: "d+1", idempotencyKey: "same-key" });
  await until(() => gates.length >= 1);
  await new Promise((r) => setTimeout(r, 20));
  openGates();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(computeCalls - before, 1, "computed once");
  assert.equal(a.data.cell.cellId, b.data.cell.cellId);
  assert.equal([a, b].filter((r) => r.data.replayed).length, 1, "the second call is a replay");
  const read = (await call("get_notebook", { notebook: nb })).data;
  assert.equal(read.cells.length, 1);
});
