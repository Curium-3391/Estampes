// UVA Phase 4B-3: a bundle keeps a mark's anchor to the axes. Before, the
// import dropped it and the mark came back fixed to the page.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { clearImages, registerImage } from "../src/image-store.js";
import { useStorageDir } from "../src/storage.js";
import { applyCanvasChanges, reviewFinding } from "../src/canvas-state.js";
import { verificationOf } from "../src/assessment.js";
import { resolveCoordinateAnnotation as resolve, replayUserAnnotation } from "../src/scene-catalog.js";
import { clearWorkspaces, getWorkspace, workspaceItems } from "../src/workspace.js";
import { exportBundle, importBundle } from "../src/bundle.js";
import { applySceneOps, canvasObjects } from "../src/scene/scene-ops.js";
import { syncWorldAnchors } from "../src/visual/world-anchors.js";

beforeEach(() => { clearImages(); clearWorkspaces(); useStorageDir(""); });
const mod = { author: "module", module: "org.test.mod", moduleVersion: "1.0.0", capability: "c" };

test("export and import keep a world anchor, its place in axis units and an outside status", async () => {
  const entry = await registerImage(await sharp({ create: { width: 320, height: 200, channels: 3, background: "#eee" } }).png().toBuffer(), { source: "chat-file", fileName: "any.png" });
  applySceneOps(entry, [{ op: "object.create", type: "axes-2d", props: { xRange: [-10, 10], yRange: [-10, 10] } }], mod);
  applyCanvasChanges(entry, { annotations: [
    { id: "w", type: "point", x: 2, y: 4, anchor: { space: "world" } },
    { id: "far", type: "point", x: 8, y: 8, anchor: { space: "world" } },
  ], resolve });
  // Shrink the range so "far" is outside, as a save would.
  applySceneOps(entry, [{ op: "object.update", id: canvasObjects(entry)[0].id, props: { xRange: [-5, 5], yRange: [-5, 5] } }], mod);
  syncWorldAnchors(entry);
  const before = new Map([...entry.marks].map(([k, m]) => [k, m]));
  assert.equal(before.get("far").anchorStatus, "outside");

  const { buffer } = await exportBundle(entry.imageId);
  const r = await importBundle(buffer, { collision: "copy" });
  const [imported] = (await workspaceItems(await getWorkspace(r.workspace.id))).map((it) => it.entry);
  assert.notEqual(imported, entry);
  for (const id of ["w", "far"]) {
    const m = imported.marks.get(id);
    assert.deepEqual(m.anchor, before.get(id).anchor, id + " keeps its anchor");
    assert.equal(m.anchorStatus, before.get(id).anchorStatus);
  }
});

test("a malformed anchor in a bundle is dropped, the mark is kept", async () => {
  const entry = await registerImage(await sharp({ create: { width: 320, height: 200, channels: 3, background: "#eee" } }).png().toBuffer(), { source: "chat-file", fileName: "any.png" });
  applyCanvasChanges(entry, { annotations: [{ id: "p", type: "point", x: 0.5, y: 0.5 }], resolve });
  entry.marks.set("p", { ...entry.marks.get("p"), anchor: { space: "world", frame: "../etc", world: { x: "a" } } });
  const { buffer } = await exportBundle(entry.imageId);
  const r = await importBundle(buffer, { collision: "copy" });
  const [imported] = (await workspaceItems(await getWorkspace(r.workspace.id))).map((it) => it.entry);
  const m = imported.marks.get("p");
  assert.ok(m, "the mark is imported");
  assert.equal(m.anchor, undefined);
});

test("the marks SVG leaves outside marks undrawn but keeps them, anchor and all, for a restore", async () => {
  const { exportMarksSvg, parseMarksFile } = await import("../src/marks-file.js");
  const { importMarks } = await import("../src/canvas-state.js");
  const { cleanAnchorFields } = await import("../src/visual/world-anchors.js");
  const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#eee" } }).png().toBuffer();
  const entry = await registerImage(png, { source: "chat-file", fileName: "a.png" });
  applySceneOps(entry, [{ op: "object.create", type: "axes-2d", props: { xRange: [-10, 10], yRange: [-10, 10] } }], mod);
  applyCanvasChanges(entry, { annotations: [
    { id: "w", type: "point", x: 2, y: 4, anchor: { space: "world" } },
    { id: "far", type: "point", x: 8, y: 8, anchor: { space: "world" } },
  ], resolve });
  // A mark of the person's own too: a restore replays it through its own path.
  applyCanvasChanges(entry, { annotations: [{ id: "u", type: "point", x: 1, y: 1, anchor: { space: "world" } }], resolve: (a) => ({ ...a, author: "user" }) });
  applySceneOps(entry, [{ op: "object.update", id: canvasObjects(entry)[0].id, props: { xRange: [-5, 5], yRange: [-5, 5] } }], mod);
  syncWorldAnchors(entry);
  const svg = exportMarksSvg(entry, [...entry.marks.values()], entry.layers ?? []);
  assert.match(svg, /id="mark-w"/);
  assert.doesNotMatch(svg, /id="mark-far"/, "an outside mark is not drawn in the SVG");

  // Restore it the way present_visual({marksFile}) does: checked anchor fields, then importMarks.
  const data = parseMarksFile(Buffer.from(svg), { width: entry.width, height: entry.height });
  assert.ok(data.marks.some((m) => m.id === "far"), "the outside mark is kept in the metadata");
  const target = await registerImage(png, { source: "chat-file", fileName: "b.png" });
  applySceneOps(target, [{ op: "object.create", type: "axes-2d", props: { xRange: [-5, 5], yRange: [-5, 5] } }], mod);
  importMarks(target, data.marks.map((m) => ({ ...m, ...cleanAnchorFields(m) })), { layers: [], replayUser: replayUserAnnotation, resolve });
  for (const id of ["w", "far", "u"]) assert.deepEqual(target.marks.get(id).anchor, entry.marks.get(id).anchor, id);
  assert.equal(target.marks.get("far").anchorStatus, "outside");
});

test("axis units keep full precision on a tiny range", async () => {
  const { canvasToWorld } = await import("../src/visual/world-anchors.js");
  const axes = { type: "axes-2d", props: { xRange: [0, 1e-10], yRange: [0, 1e-10] } };
  const w = canvasToWorld({ x: 0.52, y: 0.485 }, axes);
  assert.ok(w.x > 1e-11 && w.x < 1e-10 && w.y > 1e-11 && w.y < 1e-10, JSON.stringify(w));
});

test("export and import keep a curve anchor (UVA Phase 4B-4), its invalid status and a stale confirmation", async () => {
  const entry = await registerImage(await sharp({ create: { width: 320, height: 200, channels: 3, background: "#eee" } }).png().toBuffer(), { source: "chat-file", fileName: "any.png" });
  applySceneOps(entry, [{ op: "object.create", ref: "ax", type: "axes-2d", props: { xRange: [-10, 10], yRange: [-10, 10] } },
    { op: "object.create", type: "function-plot", props: { expression: "x", frame: "$ax" } }], mod);
  const plot = canvasObjects(entry).find((o) => o.type === "function-plot");
  applyCanvasChanges(entry, { annotations: [
    { id: "c", type: "point", x: 2, y: 0, note: "on the line", anchor: { space: "function-x" } },
    { id: "gone", type: "point", x: 3, y: 0, anchor: { space: "function-x" } },
  ], resolve });
  entry.marks.set("c", { ...entry.marks.get("c"), review: "confirmed" });
  applySceneOps(entry, [{ op: "object.update", id: plot.id, props: { expression: "2*x" } }], mod);
  syncWorldAnchors(entry);
  assert.equal(entry.marks.get("c").stale, true);
  applySceneOps(entry, [{ op: "object.update", id: plot.id, props: { domain: [-2.5, 2.5] } }], mod);
  syncWorldAnchors(entry);
  const before = new Map([...entry.marks].map(([k, m]) => [k, m]));
  assert.equal(before.get("gone").anchorStatus, "invalid");

  const { buffer } = await exportBundle(entry.imageId);
  const r = await importBundle(buffer, { collision: "copy" });
  const [imported] = (await workspaceItems(await getWorkspace(r.workspace.id))).map((it) => it.entry);
  for (const id of ["c", "gone"]) {
    const m = imported.marks.get(id);
    assert.deepEqual(m.anchor, before.get(id).anchor, id + " keeps its anchor");
    assert.equal(m.anchorStatus, before.get(id).anchorStatus);
  }
  assert.equal(imported.marks.get("c").stale, true, "a stale confirmation stays stale");
  assert.equal(imported.marks.get("c").review, "confirmed");
});

test("a stale claim backed by a tool stays stale until the person confirms it; withdrawing or rejecting does not revive the old evidence", async () => {
  const entry = await registerImage(await sharp({ create: { width: 320, height: 200, channels: 3, background: "#eee" } }).png().toBuffer(), { source: "chat-file", fileName: "any.png" });
  applySceneOps(entry, [{ op: "object.create", ref: "ax", type: "axes-2d", props: { xRange: [-10, 10], yRange: [-10, 10] } },
    { op: "object.create", type: "function-plot", props: { expression: "x", frame: "$ax" } }], mod);
  const plot = canvasObjects(entry).find((o) => o.type === "function-plot");
  applyCanvasChanges(entry, { annotations: [{ id: "t", type: "point", x: 1, y: 0, note: "a root", anchor: { space: "function-x" } }], resolve });
  entry.marks.set("t", { ...entry.marks.get("t"), evidence: [{ id: "e1", kind: "tool-result", observer: "tool", image: entry.imageId, says: "solver" }] });
  assert.equal(verificationOf(entry.marks.get("t")), "independently-verified");
  applySceneOps(entry, [{ op: "object.update", id: plot.id, props: { expression: "x - 1" } }], mod);
  syncWorldAnchors(entry);
  assert.equal(verificationOf(entry.marks.get("t")), "unverified");
  for (const review of ["unreviewed", "rejected", "unreviewed"]) {
    reviewFinding(entry, "t", review);
    assert.equal(entry.marks.get("t").stale, true, review + " keeps it stale");
    assert.notEqual(verificationOf(entry.marks.get("t")), "independently-verified", review);
  }
  reviewFinding(entry, "t", "confirmed");
  assert.equal(entry.marks.get("t").stale, undefined);
  assert.equal(verificationOf(entry.marks.get("t")), "user-confirmed");
});
