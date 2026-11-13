// Bundle import collision must compare the whole persisted canvas, scene
// objects included (architecture review A05). Before, a canvas whose Graph
// had changed since the export was "reused" and reported verified:true while
// it still showed the local Graph.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { clearImages, registerImage } from "../src/image-store.js";
import { useStorageDir, ensureImage } from "../src/storage.js";
import { applyCanvasChanges } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation as resolve } from "../src/scene-catalog.js";
import { clearWorkspaces, getWorkspace, workspaceItems } from "../src/workspace.js";
import { exportBundle, importBundle } from "../src/bundle.js";
import { applySceneOps, canvasObjects } from "../src/scene/scene-ops.js";

beforeEach(() => { clearImages(); clearWorkspaces(); useStorageDir(""); });

const mod = { author: "module", module: "org.test.mod", moduleVersion: "1.0.0", capability: "c" };
const png = () => sharp({ create: { width: 320, height: 200, channels: 3, background: "#eee" } }).png().toBuffer();
async function graphCanvas({ withMark = true } = {}) {
  const entry = await registerImage(await png(), { source: "chat-file", fileName: "any.png" });
  if (withMark) applyCanvasChanges(entry, { annotations: [{ id: "m1", type: "point", x: 0.5, y: 0.5 }], layer: "notes", resolve });
  applySceneOps(entry, [{ op: "object.create", ref: "a", type: "axes-2d", props: { xRange: [-10, 10], yRange: [-1, 1] } },
    { op: "object.create", type: "function-plot", props: { expression: "sin(x)", frame: "$a" } }], mod);
  return entry;
}
const xRangeOf = (entry) => canvasObjects(entry).find((o) => o.type === "axes-2d").props.xRange;
async function importedEntries(r) {
  return (await workspaceItems(await getWorkspace(r.workspace.id))).map((it) => it.entry);
}

test("a canvas whose scene objects changed since export is copied, not reused, and the copy holds the bundle's Graph", async () => {
  const entry = await graphCanvas();
  const { buffer } = await exportBundle(entry.imageId);
  applySceneOps(entry, [{ op: "object.update", id: "o1", props: { xRange: [-77, 77] } }], mod);
  const r = await importBundle(buffer, { collision: "reuse" });
  assert.equal(r.summary[0].how, "copied");
  assert.equal(r.verified, true, JSON.stringify({ m: r.mismatch, u: r.unsupported }));
  const [imported] = await importedEntries(r);
  assert.notEqual(imported, entry);
  assert.deepEqual(xRangeOf(imported), [-10, 10]);
  assert.deepEqual(xRangeOf(await ensureImage(entry.imageId)), [-77, 77], "the local canvas is never overwritten");
});

test("an identical canvas, scene objects included, is reused and verified", async () => {
  const entry = await graphCanvas();
  const { buffer } = await exportBundle(entry.imageId);
  const r = await importBundle(buffer, { collision: "reuse" });
  assert.equal(r.summary[0].how, "reused");
  assert.equal(r.verified, true, JSON.stringify({ m: r.mismatch, u: r.unsupported }));
});

test("a canvas holding only scene objects is not treated as empty: a restore never replaces its Graph", async () => {
  const entry = await graphCanvas({ withMark: false });
  const { buffer } = await exportBundle(entry.imageId);
  applySceneOps(entry, [{ op: "object.update", id: "o1", props: { xRange: [-77, 77] } }], mod);
  const r = await importBundle(buffer, { collision: "reuse" });
  assert.equal(r.summary[0].how, "copied");
  assert.deepEqual(xRangeOf(await ensureImage(entry.imageId)), [-77, 77]);
  const [imported] = await importedEntries(r);
  assert.deepEqual(xRangeOf(imported), [-10, 10]);
});

test("into an empty server, a restored canvas carries the bundle's scene objects and is verified", async () => {
  const entry = await graphCanvas();
  const { buffer } = await exportBundle(entry.imageId);
  clearImages(); clearWorkspaces();
  const r = await importBundle(buffer);
  assert.equal(r.summary[0].how, "restored");
  assert.equal(r.verified, true, JSON.stringify({ m: r.mismatch, u: r.unsupported }));
  const [imported] = await importedEntries(r);
  assert.deepEqual(xRangeOf(imported), [-10, 10]);
  assert.equal(canvasObjects(imported).length, 2);
});

test("links compare by content: a relabelled link with the same count is not reused", async () => {
  const { applyPairChanges } = await import("../src/canvas-state.js");
  const img = async (c) => registerImage(await sharp({ create: { width: 200, height: 200, channels: 3, background: c } }).png().toBuffer(), { source: "test" });
  const left = await img("#fff"), right = await img("#264");
  const box = (id, side, x = 0.1) => ({ id, side, type: "rect", x, y: 0.1, x2: x + 0.1, y2: 0.2 });
  applyPairChanges(left, right, { annotations: [box("a", "left"), box("b", "right"), box("b2", "right", 0.5)],
    links: [{ id: "k1", left: "a", right: "b", label: "C1" }], layer: "pairs", resolve });
  const { buffer } = await exportBundle(left.imageId + "+" + right.imageId);
  const same = await importBundle(buffer, { collision: "reuse" });
  assert.deepEqual(same.summary.map((s) => s.how), ["reused", "reused"], "unchanged canvases are reused");
  // Same number of links, different meaning: the link now joins another mark.
  applyPairChanges(left, right, { links: [{ id: "k1", left: "a", right: "b2", label: "C1" }], resolve });
  const changed = await importBundle(buffer, { collision: "reuse", name: "again" });
  assert.equal(changed.summary.find((s) => s.key === left.imageId).how, "copied");
});
