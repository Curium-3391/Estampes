// 5B-4: plots drawn from a calculator cell before plots were tracked (a notebook link, no
// binding) are adopted when their document is opened; the link is then marked so a plot the
// person detaches is never adopted again. The calculator service is a fake; the module host,
// router, notebooks and derived flow are the real ones.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { applySceneOps } from "../src/scene/scene-ops.js";
import { ensureImage } from "../src/storage.js";
import { createNotebooks } from "../src/cas/notebooks.js";
import { configure } from "../src/builtin-modules/cas/index.js";
import { createDerivedFlow, newDerivedState } from "../src/modules/derived-flow.js";
import { bindingsOf } from "../src/documents/derived-coordinator.js";

const CAS = "org.estampes.cas";
let h, notebooks, canvases;
const client = {
  async health() { return { engine: { name: "fake", version: "0" }, operations: [], limits: {} }; },
  async parse(input) { return { text: input.text, ast: { node: "number", value: "1" } }; },
  async compute() { return { status: "exact", exact: { plain: "2*x", latex: "2x", ast: { node: "number", value: "2" } }, engine: { name: "fake", version: "0" } }; },
};
before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-cas-adopt-"));
  notebooks = createNotebooks({ dir: join(dir, "nb") });
  configure({ client, notebooks });
  canvases = { ensure: ensureImage, create: createBlankCanvas, save: async () => {} };
  h = await createModuleHost({ storageDir: dir, coreVersion: "0.18.0", canvases });
  const plan = await h.lifecycle.prepare("enable", CAS);
  await h.lifecycle.commit(plan.planId, { consent: plan.consent });
});
const flowOf = () => createDerivedFlow({ router: h.router, registry: h.registry, canvases, index: h.derivedIndex, state: newDerivedState() });

// A plot as the earlier code left it: the object on the canvas, and a link on the cell, with no binding.
async function legacy(statuses) {
  const made = await h.router.execute({ module: CAS, capability: "define", params: { name: "a", text: "1" } });
  const nb = made.data.notebookId;
  const cells = [];
  for (let i = 0; i < statuses.length; i++) cells.push((await h.router.execute({ module: CAS, capability: "calculate", params: { notebook: nb, operation: "evaluate", text: "a+" + i } })).data.cell.cellId);
  const canvas = await createBlankCanvas({});
  applySceneOps(canvas, [{ op: "object.create", type: "axes-2d", props: { xRange: [-3, 3], yRange: [-3, 3] } },
    ...statuses.map((_, i) => ({ op: "object.create", type: "function-plot", props: { frame: "o1", expression: "x+" + i } }))], { author: "module", module: CAS, capability: "plot_result" });
  await notebooks.mutate(nb, {}, (d) => {
    statuses.forEach((status, i) => { d.cells.find((c) => c.id === cells[i]).links = [{ canvas: canvas.imageId, object: "o" + (i + 2), resultId: "r" + i, expression: "x+" + i, domain: [-3, 3], status, at: "2026-01-01T00:00:00Z" }]; });
    return d;
  });
  return { nb, cells, canvas };
}
const links = async (nb) => (await notebooks.get(nb)).cells.flatMap((c) => c.links ?? []);

test("an earlier plot is adopted when its document is opened, with the state its link had, and its link is marked", { timeout: 60000 }, async () => {
  const { nb, cells, canvas } = await legacy(["fresh", "stale", "removed"]);
  const listed = await flowOf().list(canvas.imageId);
  assert.equal(listed.total, 2, "a removed link is not adopted");
  const bound = bindingsOf(canvas);
  assert.deepEqual(bound.map((b) => [b.target.id, b.state, b.source.module, b.source.capability, b.source.sourceRef]),
    [["o2", "fresh", CAS, "plot_result", nb + "/" + cells[0]], ["o3", "stale", CAS, "plot_result", nb + "/" + cells[1]]]);
  assert.deepEqual((await links(nb)).map((l) => l.bound === true), [true, true, false]);
});

test("a plot the person stops following is not adopted again, even after a restart", { timeout: 60000 }, async () => {
  const { nb, canvas } = await legacy(["fresh"]);
  const first = flowOf();
  const [b] = (await first.list(canvas.imageId)).bindings;
  await first.update({ canvas: canvas.imageId, action: "detach", binding: b.id, expectedBindingHash: b.bindingHash });
  assert.equal(bindingsOf(canvas).length, 0);
  // A new flow with fresh memory is a restart.
  assert.equal((await flowOf().list(canvas.imageId)).total, 0, "detached stays detached");
  assert.equal((await links(nb))[0].bound, true);
});

test("opening a document twice, or from two flows, makes one binding per plot", { timeout: 60000 }, async () => {
  const { canvas } = await legacy(["fresh", "fresh"]);
  await Promise.all([flowOf().list(canvas.imageId), flowOf().list(canvas.imageId), flowOf().list(canvas.imageId)]);
  await flowOf().list(canvas.imageId);
  assert.equal(bindingsOf(canvas).length, 2);
});

test("a stop-following choice survives a notebook export and import", { timeout: 60000 }, async () => {
  const { nb } = await legacy(["fresh"]);
  await notebooks.mutate(nb, {}, (d) => { d.cells.flatMap((c) => c.links)[0].bound = true; return d; });
  const copy = await notebooks.importOne(JSON.parse(JSON.stringify(notebooks.exportOne(await notebooks.get(nb)))));
  assert.deepEqual((await links(copy.id)).map((l) => l.bound), [true]);
});

test("an adoption that could not be saved leaves no binding in the cached document, and the next open adopts again", { timeout: 60000 }, async () => {
  const { nb, canvas } = await legacy(["fresh"]);
  let fail = true;
  const real = canvases.save;
  canvases.save = async (...a) => { if (fail) throw new Error("disk full"); return real(...a); };
  try {
    await flowOf().list(canvas.imageId);
    assert.equal(bindingsOf(canvas).length, 0, "rolled back");
    assert.notEqual((await links(nb))[0].bound, true, "link not marked");
    fail = false;
    assert.equal((await flowOf().list(canvas.imageId)).total, 1);
    assert.equal((await links(nb))[0].bound, true);
  } finally { canvases.save = real; }
});
