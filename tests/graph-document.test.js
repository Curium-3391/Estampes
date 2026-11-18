// UVA Phase 4A-2: a Graph document (gph:<hex>) is a canvas with no image. It is
// stored in the UVA canvas store only: no image bytes, no asset, no image file.
// In-process, over real store folders; the tools that create Graphs come later.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import sharp from "sharp";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUvaService } from "../src/uva/service.js";
import { createCanvasStore } from "../src/uva/canvas-store.js";
import { createGraphCanvas, ensureImage, saveCanvas, serializeCanvas, useCanvasStore, readMeta } from "../src/storage.js";
import { applyCanvasChanges } from "../src/canvas-state.js";
import { applySceneOps } from "../src/scene/scene-ops.js";
import { renderCanvas } from "../src/scene/canvas-render.js";
import { isGraphId, forgetGraph, graphSpec } from "../src/visual/graph-docs.js";

const resolve = (a) => a;
async function folders(t) {
  const storage = await mkdtemp(join(tmpdir(), "graph-legacy-")), beta = await mkdtemp(join(tmpdir(), "graph-uva-"));
  t.after(() => Promise.all([rm(storage, { recursive: true, force: true }), rm(beta, { recursive: true, force: true })]));
  return { storage, beta };
}
async function open({ storage, beta }) {
  const service = await createUvaService({ enabled: true, canvasStore: true, directory: beta, profile: "linux-process-crash-test", legacyDirectory: storage });
  const store = await createCanvasStore({ service, storageDir: storage, idleMs: 0 });
  useCanvasStore(store);
  return { service, store, async close() { await store.flush(); await store.close(); await service.close(); useCanvasStore(null); } };
}
const files = async (dir, sub) => (await readdir(join(dir, sub), { recursive: true }).catch(() => [])).sort();
const graphDocs = async (service) => (await service.store.snapshot()).documents.filter((d) => d.kind === "graph" && d.extensions?.["estampes.beta:mirror"]);

test("three Graphs write no image asset and no image file, and come back after a restart", { timeout: 120000 }, async (t) => {
  const dirs = await folders(t);
  let s = await open(dirs);
  t.after(() => s.close().catch(() => {}));
  const assetsBefore = await files(dirs.beta, "assets");
  const graphs = [];
  for (const [i, color] of ["#ffffff", "#fbf8f1", "#123456"].entries()) {
    const g = await createGraphCanvas({ width: 800 + i * 100, height: 500, color, title: "g" + i });
    assert.ok(isGraphId(g.imageId), g.imageId);
    assert.equal(g.pixels, null);
    applyCanvasChanges(g, { annotations: [
      { id: "r" + i, type: "rect", x: .1, y: .2, x2: .4, y2: .5, label: "box " + i },
      { id: "p" + i, type: "point", x: .7, y: .3 },
      { id: "l" + i, type: "polyline", points: [{ x: .1, y: .9 }, { x: .5, y: .6 }, { x: .9, y: .9 }] },
    ], resolve });
    applySceneOps(g, [
      { op: "object.create", type: "axes-2d", props: { xRange: [-3, 3], yRange: [-2, 2], title: "t" + i } },
      { op: "object.create", type: "function-plot", props: { frame: "o1", expression: "sin(x)", label: "sin" } },
    ], { author: "assistant" });
    await saveCanvas(g, { tool: "test" });
    graphs.push({ id: g.imageId, color, canvas: JSON.parse(JSON.stringify(serializeCanvas(g))) });
  }
  await s.store.flush();
  assert.deepEqual(await files(dirs.beta, "assets"), assetsBefore, "no asset was written for a Graph");
  assert.deepEqual(await files(dirs.storage, "images"), [], "no image file was written");
  const docs = await graphDocs(s.service);
  assert.equal(docs.length, 3);
  for (const d of docs) {
    const scene = d.scenes[0];
    assert.equal(scene.background.kind, "solid");
    assert.equal(d.provenance.legacySetKey, undefined, "a Graph is not named as a legacy image");
    assert.ok(scene.annotations.length === 3 && scene.annotations.every((a) => a.anchor.space === "document"), "marks are anchored to the document");
    const rect = scene.annotations.find((a) => a.type === "rect");
    assert.ok(Math.abs(rect.geometry.x - .1 * scene.extent.width) < 1e-9, "document units");
    assert.equal(JSON.stringify(d).includes("asset:sha256"), false, "no asset reference");
  }
  await s.close();

  s = await open(dirs);
  for (const g of graphs) {
    forgetGraph(g.id);
    const e = await ensureImage(g.id);
    assert.equal(e.kind, "graph");
    assert.deepEqual(e.background, { kind: "solid", color: g.color });
    const back = JSON.parse(JSON.stringify(serializeCanvas(e)));
    delete back.savedAt; delete g.canvas.savedAt;
    assert.deepEqual(back, g.canvas, "the canvas comes back exactly");
    const meta = await readMeta(g.id);
    assert.equal(meta.kind, "graph");
    const r = await renderCanvas(e, { maxSide: 300 });
    assert.equal(r.metadata.sourceKind, "solid", "rendered from its colour, without pixels");
  }
  assert.deepEqual(await files(dirs.beta, "assets"), assetsBefore, "restoring wrote no asset either");
});

test("two Graphs never change each other", { timeout: 120000 }, async (t) => {
  const dirs = await folders(t);
  const s = await open(dirs);
  t.after(() => s.close().catch(() => {}));
  const a = await createGraphCanvas(), b = await createGraphCanvas();
  assert.notEqual(a.imageId, b.imageId);
  applyCanvasChanges(a, { annotations: [{ id: "only-a", type: "point", x: .5, y: .5 }], resolve });
  await saveCanvas(a, { tool: "test" });
  await s.store.flush();
  forgetGraph(a.imageId); forgetGraph(b.imageId);
  assert.equal((await ensureImage(a.imageId)).marks.size, 1);
  assert.equal((await ensureImage(b.imageId)).marks.size, 0);
});

test("without the UVA canvas store a Graph is refused, not kept somewhere else", async () => {
  useCanvasStore(null);
  await assert.rejects(createGraphCanvas(), /UVA canvas store/);
  await assert.rejects(ensureImage("gph:0123456789abcdef"), /UVA canvas store/);
});

test("a Graph's size and colour are checked", () => {
  assert.throws(() => graphSpec({ width: 10 }), /200 to 4096/);
  assert.throws(() => graphSpec({ color: "red" }), /#rrggbb/);
  assert.throws(() => graphSpec({ color: ["#123456"] }), /#rrggbb/);
  assert.deepEqual(graphSpec({ color: "#ABCDEF" }), { width: 1600, height: 1000, color: "#abcdef", title: null });
});

test("a Graph edit still pending at shutdown is committed on the next start", { timeout: 120000 }, async (t) => {
  const dirs = await folders(t);
  const service = await createUvaService({ enabled: true, canvasStore: true, directory: dirs.beta, profile: "linux-process-crash-test", legacyDirectory: dirs.storage });
  // A long idle time: the edit stays pending when the store stops.
  const store = await createCanvasStore({ service, storageDir: dirs.storage, idleMs: 600000, maxWaitMs: 600000 });
  useCanvasStore(store);
  const g = await createGraphCanvas({ color: "#fbf8f1" });
  applyCanvasChanges(g, { annotations: [{ id: "late", type: "point", x: .25, y: .75 }], resolve });
  await saveCanvas(g, { tool: "test" });
  await store.close(); await service.close(); useCanvasStore(null);
  const pending = (await readdir(join(dirs.storage, "uva-pending"))).filter((n) => n.endsWith(".json"));
  assert.deepEqual(pending, ["gph-" + g.imageId.slice(4) + ".json"], "a Graph's pending file never shares an image's name");

  const s = await open(dirs);
  t.after(() => s.close().catch(() => {}));
  assert.ok(s.store.recovered.includes(g.imageId));
  await s.store.flush();
  forgetGraph(g.imageId);
  const back = await ensureImage(g.imageId);
  assert.deepEqual([...back.marks.keys()], ["late"]);
  assert.equal((await graphDocs(s.service)).length, 1);
});

test("the UVA render action draws a Graph on its colour with its marks in place", { timeout: 120000 }, async (t) => {
  const dirs = await folders(t);
  const s = await open(dirs);
  t.after(() => s.close().catch(() => {}));
  const g = await createGraphCanvas({ width: 800, height: 500, color: "#123456" });
  applyCanvasChanges(g, { annotations: [{ id: "dot", type: "point", x: .7, y: .3, color: "red" }], resolve });
  await saveCanvas(g, { tool: "test" });
  await s.store.flush();
  const [doc] = await graphDocs(s.service);
  const out = await s.service.dispatch({ action: "render", documentId: doc.id }, "assistant");
  const { data, info } = await sharp(Buffer.from(out.preview.data, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
  assert.deepEqual([info.width, info.height], [800, 500]);
  assert.deepEqual(px(5, 5), [0x12, 0x34, 0x56], "the Graph's colour, not white");
  assert.notDeepEqual(px(560, 150), [0x12, 0x34, 0x56], "the mark is drawn where it is, in document units");
});

test("links from one Graph to another survive a save and a restore", { timeout: 120000 }, async (t) => {
  const dirs = await folders(t);
  let s = await open(dirs);
  t.after(() => s.close().catch(() => {}));
  const a = await createGraphCanvas(), b = await createGraphCanvas();
  applyCanvasChanges(a, { annotations: [{ id: "left", type: "point", x: .2, y: .2 }], resolve });
  applyCanvasChanges(b, { annotations: [{ id: "right", type: "point", x: .8, y: .8 }], resolve });
  a.pairLinks = new Map([[b.imageId, new Map([["k1", { id: "k1", left: "left", right: "right", label: "same peak" }]])]]);
  await saveCanvas(a, { tool: "test" });
  await saveCanvas(b, { tool: "test" });
  await s.close();
  s = await open(dirs);
  forgetGraph(a.imageId);
  const back = await ensureImage(a.imageId);
  assert.deepEqual([...back.pairLinks.keys()], [b.imageId]);
  assert.equal(back.pairLinks.get(b.imageId).get("k1").label, "same peak");
});
