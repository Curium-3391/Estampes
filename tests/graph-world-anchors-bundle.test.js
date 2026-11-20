// UVA Phase 4B-3: a bundle keeps a mark's anchor to the axes. Before, the
// import dropped it and the mark came back fixed to the page.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { clearImages, registerImage } from "../src/image-store.js";
import { useStorageDir } from "../src/storage.js";
import { applyCanvasChanges } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation as resolve } from "../src/scene-catalog.js";
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
