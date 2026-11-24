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
let host, notebooks, readable = true, computeDown = false, gate = null;
const client = {
  async health() { return { engine: { name: "fake", version: "0" }, operations: [], limits: {} }; },
  async parse(input) { return { text: input.text, ast: { node: "number", value: "1" } }; },
  async compute(input) {
    if (computeDown) throw new Error("the calculator is not reachable");
    if (gate) { const g = gate; gate = null; await g; }
    if (JSON.stringify(input ?? {}).includes("root")) return { status: "exact", exact: { plain: "sqrt(x - 100)", latex: "", ast: { node: "call", fn: "sqrt", args: [{ node: "add", args: [{ node: "symbol", name: "x" }, { node: "integer", value: "-100" }] }] } }, engine: { name: "fake", version: "0" } };
    return { status: "exact", exact: { plain: "2*x", latex: "2x", ast: { node: "mul", args: [{ node: "integer", value: "2" }, { node: "symbol", name: "x" }] } }, engine: { name: "fake", version: "0" } };
  },
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
  await notebooks.mutate(nb, {}, (d) => { for (const c of d.cells) for (const l of c.links ?? []) l.status = "stale"; return d; });
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
  assert.equal(await linkOf(nb), undefined, "the deleted plot's link is dropped");
  assert.equal(canvas.objects.has(object), false, "not recreated");
  const again = await refreshLinks({ host, notebooks, notebookId: nb, imageId: canvas.imageId });
  assert.equal(again.failed.length, 0, "said once");
});

test("a plot keeps its domain through a refresh, even one far from the default", async () => {
  const made = await host.router.execute({ module: CAS, capability: "define", params: { name: "r", text: "1" } });
  const nb = made.data.notebookId;
  const cell = (await host.router.execute({ module: CAS, capability: "calculate", params: { notebook: nb, operation: "evaluate", text: "root" } })).data.cell.cellId;
  const canvas = await createBlankCanvas({});
  applySceneOps(canvas, [{ op: "object.create", type: "axes-2d", props: { xRange: [90, 120], yRange: [-3, 3] } }], { author: "module", module: "org.estampes.graph", capability: "plot_function" });
  await host.router.execute({ module: CAS, capability: "plot_result", canvas: canvas.imageId, params: { notebook: nb, cell, domain: [100, 110] } });
  sourceChanged(canvas, { module: CAS });
  const r = await refreshLinks({ host, notebooks, notebookId: nb, imageId: canvas.imageId });
  assert.deepEqual(r.failed, []);
  assert.equal(r.updated.length, 1);
  assert.deepEqual(canvas.objects.get(bindingsOf(canvas)[0].target.id).props.domain, [100, 110]);
});

test("more than eight canvases are all reached by repeated refreshes", async () => {
  const made = await host.router.execute({ module: CAS, capability: "define", params: { name: "m", text: "1" } });
  const nb = made.data.notebookId;
  const cell = (await host.router.execute({ module: CAS, capability: "calculate", params: { notebook: nb, operation: "evaluate", text: "m+1" } })).data.cell.cellId;
  const canvases = [];
  for (let i = 0; i < 10; i++) {
    const c = await createBlankCanvas({});
    applySceneOps(c, [{ op: "object.create", type: "axes-2d", props: { xRange: [-3, 3], yRange: [-3, 3] } }], { author: "module", module: "org.estampes.graph", capability: "plot_function" });
    await host.router.execute({ module: CAS, capability: "plot_result", canvas: c.imageId, params: { notebook: nb, cell } });
    canvases.push(c);
  }
  // The cell changed: every link and binding is stale.
  await notebooks.mutate(nb, {}, (d) => { for (const x of d.cells) for (const l of x.links ?? []) l.status = "stale"; return d; });
  // No broadcast reached these documents: only the notebook's link record says their plots are waiting.
  const first = await refreshLinks({ host, notebooks, notebookId: nb });
  assert.equal(first.updated.length, 8);
  const second = await refreshLinks({ host, notebooks, notebookId: nb });
  assert.equal(second.updated.length, 2, "the ones left out the first time are reached now");
  assert.ok(canvases.every((c) => bindingsOf(c)[0].state === "fresh"));
});

test("a plot whose redraw failed is tried again by the next refresh", async () => {
  const { nb, canvas } = await plotted();
  await notebooks.mutate(nb, {}, (d) => { for (const c of d.cells) { c.stale = true; for (const l of c.links ?? []) l.status = "stale"; } return d; });
  computeDown = true;
  let first;
  try { first = await refreshLinks({ host, notebooks, notebookId: nb, imageId: canvas.imageId }); } finally { computeDown = false; }
  assert.equal(first.updated.length, 0);
  assert.ok(first.failed.length >= 1);
  assert.notEqual(bindingsOf(canvas)[0].state, "fresh");
  const second = await refreshLinks({ host, notebooks, notebookId: nb, imageId: canvas.imageId });
  assert.equal(second.updated.length, 1, "the plot is redrawn once the calculator is back");
  assert.equal(bindingsOf(canvas)[0].state, "fresh");
});

test("a deletion the document already noticed is still reported once, from the notebook's record", async () => {
  const { nb, canvas, object } = await plotted();
  applySceneOps(canvas, [{ op: "object.delete", id: object }], { author: "user" });
  const { createDerivedFlow } = await import("../src/modules/derived-flow.js");
  await createDerivedFlow({ router: host.router, registry: host.registry, canvases: host.canvases, index: host.derivedIndex, state: host.derivedState }).list(canvas.imageId);
  assert.equal(bindingsOf(canvas)[0].state, "removed", "the document noticed first");
  const r = await refreshLinks({ host, notebooks, notebookId: nb, imageId: canvas.imageId });
  assert.match(r.failed[0]?.reason ?? "", /was removed/);
  assert.equal(await linkOf(nb), undefined, "the deleted plot's link is dropped");
  assert.equal((await refreshLinks({ host, notebooks, notebookId: nb, imageId: canvas.imageId })).failed.length, 0, "said once");
});

test("more plots of one cell than one pass refreshes are all reached by repeated refreshes", async () => {
  const made = await host.router.execute({ module: CAS, capability: "define", params: { name: "p", text: "1" } });
  const nb = made.data.notebookId;
  const cell = (await host.router.execute({ module: CAS, capability: "calculate", params: { notebook: nb, operation: "evaluate", text: "p+1" } })).data.cell.cellId;
  const canvas = await createBlankCanvas({});
  applySceneOps(canvas, [{ op: "object.create", type: "axes-2d", props: { xRange: [-3, 3], yRange: [-3, 3] } }], { author: "module", module: "org.estampes.graph", capability: "plot_function" });
  for (let i = 0; i < 25; i++) await host.router.execute({ module: CAS, capability: "plot_result", canvas: canvas.imageId, params: { notebook: nb, cell } });
  assert.equal(bindingsOf(canvas).length, 25);
  await notebooks.mutate(nb, {}, (d) => { for (const c of d.cells) for (const l of c.links ?? []) l.status = "stale"; return d; });
  const first = await refreshLinks({ host, notebooks, notebookId: nb, imageId: canvas.imageId });
  const second = await refreshLinks({ host, notebooks, notebookId: nb, imageId: canvas.imageId });
  assert.equal(first.updated.length + second.updated.length, 25);
  assert.ok(first.updated.length < 25 && second.updated.length > 0, "needed two passes");
  assert.ok(bindingsOf(canvas).every((b) => b.state === "fresh"));
});

test("documents whose waiting plots were edited by hand do not use up the eight a refresh looks at", async () => {
  const made = await host.router.execute({ module: CAS, capability: "define", params: { name: "w", text: "1" } });
  const nb = made.data.notebookId;
  const cell = (await host.router.execute({ module: CAS, capability: "calculate", params: { notebook: nb, operation: "evaluate", text: "w+1" } })).data.cell.cellId;
  const canvases = [];
  for (let i = 0; i < 12; i++) {
    const c = await createBlankCanvas({});
    applySceneOps(c, [{ op: "object.create", type: "axes-2d", props: { xRange: [-3, 3], yRange: [-3, 3] } }], { author: "module", module: "org.estampes.graph", capability: "plot_function" });
    await host.router.execute({ module: CAS, capability: "plot_result", canvas: c.imageId, params: { notebook: nb, cell } });
    canvases.push(c);
  }
  // The first ten were edited by hand after they were drawn; the last two were not.
  for (const c of canvases.slice(0, 10)) applySceneOps(c, [{ op: "object.update", id: bindingsOf(c)[0].target.id, props: { expression: "99*x" } }], { author: "user" });
  await notebooks.mutate(nb, {}, (d) => { for (const x of d.cells) for (const l of x.links ?? []) l.status = "stale"; return d; });
  const first = await refreshLinks({ host, notebooks, notebookId: nb });
  const second = await refreshLinks({ host, notebooks, notebookId: nb });
  assert.equal(first.updated.length + second.updated.length, 2, "the two plots nobody edited were redrawn");
  assert.ok(canvases.slice(10).every((c) => bindingsOf(c)[0].state === "fresh"));
  assert.ok(canvases.slice(0, 10).every((c) => c.objects.get(bindingsOf(c)[0].target.id).props.expression === "99*x"), "the edits stand");
});

test("links carry no status of their own: a plot out of broadcast reach is still found by the cell's revision", async () => {
  const made = await host.router.execute({ module: CAS, capability: "define", params: { name: "q", text: "1" } });
  const nb = made.data.notebookId;
  const cell = (await host.router.execute({ module: CAS, capability: "calculate", params: { notebook: nb, operation: "evaluate", text: "q+1" } })).data.cell.cellId;
  const canvases = [];
  for (let i = 0; i < 10; i++) {
    const c = await createBlankCanvas({});
    applySceneOps(c, [{ op: "object.create", type: "axes-2d", props: { xRange: [-3, 3], yRange: [-3, 3] } }], { author: "module", module: "org.estampes.graph", capability: "plot_function" });
    await host.router.execute({ module: CAS, capability: "plot_result", canvas: c.imageId, params: { notebook: nb, cell } });
    canvases.push(c);
  }
  const links = async () => (await notebooks.get(nb)).cells.flatMap((c) => c.links ?? []);
  assert.ok((await links()).every((l) => l.status === undefined && l.cellRevision >= 1), "new links have a revision, not a status");
  // A real change through the module: the broadcast reaches only some of the documents.
  await host.router.execute({ module: CAS, capability: "define", params: { notebook: nb, name: "q", text: "2" } });
  assert.ok((await links()).every((l) => l.status === undefined), "a change writes no status either");
  for (let i = 0; i < 3; i++) await refreshLinks({ host, notebooks, notebookId: nb });
  assert.ok(canvases.every((c) => bindingsOf(c)[0].state === "fresh"), "every document was reached");
  assert.ok((await links()).every((l) => l.status === undefined), "a redraw writes no status");
  const cellNow = (await notebooks.get(nb)).cells[0];
  assert.ok((await links()).every((l) => l.cellRevision === cellNow.revision), "every link is at the cell's current revision");
  const again = await refreshLinks({ host, notebooks, notebookId: nb });
  assert.equal(again.updated.length, 0, "nothing left waiting");
});

test("a recompute whose cell was changed while it ran does not write its late answer over the newer one", async () => {
  const made = await host.router.execute({ module: CAS, capability: "define", params: { name: "z", text: "1" } });
  const nb = made.data.notebookId;
  const cell = (await host.router.execute({ module: CAS, capability: "calculate", params: { notebook: nb, operation: "evaluate", text: "z+1" } })).data.cell.cellId;
  await host.router.execute({ module: CAS, capability: "define", params: { notebook: nb, name: "z", text: "2" } });
  assert.equal((await notebooks.get(nb)).cells[0].stale, true);
  let open; gate = new Promise((r) => { open = r; });
  const pending = host.router.execute({ module: CAS, capability: "recompute", params: { notebook: nb, cell } });
  await new Promise((r) => setTimeout(r, 50));
  // Meanwhile the person edits the same cell.
  await host.router.execute({ module: CAS, capability: "calculate", params: { notebook: nb, cell, operation: "evaluate", text: "z+5" } });
  const revisionAfterEdit = (await notebooks.get(nb)).cells[0].revision;
  open();
  const out = await pending;
  assert.deepEqual(out.data.discarded, [cell]);
  const now = (await notebooks.get(nb)).cells[0];
  assert.equal(now.input.text, "z+5", "the newer input stays");
  assert.equal(now.revision, revisionAfterEdit, "nothing was written over it");
});
