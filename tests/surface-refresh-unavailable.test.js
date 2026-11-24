// A canvas that cannot be read during a refresh is "unavailable", not
// "deleted": its plots must stay retryable (architecture review A08). A plot
// the person deleted is reported once and not recreated. The refresh is the
// core's refresh of stale derived bindings (UVA 5B-4b); the calculator service
// is a fake, the module host, router, notebooks and derived flow are real.
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
import { refreshLinks } from "../src/surface/refresh.js";
import { bindingsOf, sourceChanged } from "../src/documents/derived-coordinator.js";

const CAS = "org.estampes.cas";
let host, notebooks, readable = true;
const client = {
  async health() { return { engine: { name: "fake", version: "0" }, operations: [], limits: {} }; },
  async parse(input) { return { text: input.text, ast: { node: "number", value: "1" } }; },
  async compute() { return { status: "exact", exact: { plain: "2*x", latex: "2x", ast: { node: "mul", args: [{ node: "integer", value: "2" }, { node: "symbol", name: "x" }] } }, engine: { name: "fake", version: "0" } }; },
};
before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-refresh-"));
  notebooks = createNotebooks({ dir: join(dir, "nb") });
  configure({ client, notebooks });
  const canvases = { ensure: async (id) => { if (!readable) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); return ensureImage(id); }, create: createBlankCanvas, save: async () => {} };
  host = await createModuleHost({ storageDir: dir, coreVersion: "0.18.0", canvases });
  const plan = await host.lifecycle.prepare("enable", CAS);
  await host.lifecycle.commit(plan.planId, { consent: plan.consent });
});

// A canvas with one plot drawn from a calculator cell, then made stale.
async function plotted() {
  const made = await host.router.execute({ module: CAS, capability: "define", params: { name: "a", text: "1" } });
  const nb = made.data.notebookId;
  const cell = (await host.router.execute({ module: CAS, capability: "calculate", params: { notebook: nb, operation: "evaluate", text: "a+1" } })).data.cell.cellId;
  const canvas = await createBlankCanvas({});
  applySceneOps(canvas, [{ op: "object.create", type: "axes-2d", props: { xRange: [-3, 3], yRange: [-3, 3] } }], { author: "module", module: "org.estampes.graph", capability: "plot_function" });
  await host.router.execute({ module: CAS, capability: "plot_result", canvas: canvas.imageId, params: { notebook: nb, cell } });
  assert.equal(bindingsOf(canvas).length, 1);
  sourceChanged(canvas, { module: CAS });
  return { nb, canvas, object: bindingsOf(canvas)[0].target.id };
}
const linkOf = async (nb) => (await notebooks.get(nb)).cells.flatMap((c) => c.links ?? [])[0];

test("a canvas read error leaves the plot stale and retryable; the next refresh redraws it", async () => {
  const { nb, canvas } = await plotted();
  readable = false;
  let first;
  try { first = await refreshLinks({ host, notebooks, notebookId: nb, imageId: canvas.imageId }); } finally { readable = true; }
  assert.equal(first.updated.length, 0);
  assert.match(first.failed[0].reason, /could not be (read|updated)/);
  assert.equal(bindingsOf(canvas)[0].state, "stale", "not marked removed");
  const second = await refreshLinks({ host, notebooks, notebookId: nb, imageId: canvas.imageId });
  assert.equal(second.updated.length, 1);
  assert.equal(bindingsOf(canvas)[0].state, "fresh");
});

test("a plot the person deleted is reported once, not recreated, and its link is not retried", async () => {
  const { nb, canvas, object } = await plotted();
  applySceneOps(canvas, [{ op: "object.delete", id: object }], { author: "user" });
  const r = await refreshLinks({ host, notebooks, notebookId: nb, imageId: canvas.imageId });
  assert.equal(r.updated.length, 0);
  assert.match(r.failed[0].reason, /was removed/);
  assert.equal((await linkOf(nb)).status, "removed");
  assert.equal(canvas.objects.has(object), false, "not recreated");
  const again = await refreshLinks({ host, notebooks, notebookId: nb, imageId: canvas.imageId });
  assert.equal(again.failed.length, 0, "said once");
});
