// UVA Phase 4B-3: marks anchored to a Graph's axes ("world") follow the data;
// marks anchored to the document stay on the page (OD-02 default). The axes
// range, a canvas resize and the camera are three different things.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCanvasStoreServer } from "./helpers/canvas-store-server.js";
import { frameOf } from "../src/scene/objects.js";

const GRAPH = "org.estampes.graph";
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const idIn = (r) => (JSON.stringify(r.structuredContent).match(/gph:[0-9a-f]{16}/) ?? [])[0];

async function graphServer(t) {
  const storage = await mkdtemp(join(tmpdir(), "graph-world-legacy-")), beta = await mkdtemp(join(tmpdir(), "graph-world-uva-"));
  const s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  // One hook, in this order: the server must be gone before its folders are.
  t.after(async () => { await s.kill(); await Promise.all([rm(storage, { recursive: true, force: true }), rm(beta, { recursive: true, force: true })]); });
  await s.enable(GRAPH);
  return { s, storage, beta };
}
const setAxes = (s, id, xRange, yRange) => s.call("execute_module", { module: GRAPH, capability: "set_axes", canvas: id, params: { xRange, yRange }, present: false });
const state = async (s, id) => (await s.call("get_visual_state", { imageId: id })).structuredContent;
const markOf = async (s, id, markId) => (await state(s, id)).marks.find((m) => m.id === markId);
const axesOf = async (s, id) => (await state(s, id)).objects.find((o) => o.type === "axes-2d");

test("a world mark follows the axes range; a document mark stays on the page; outside the range it is kept but not shown", { timeout: 180000 }, async (t) => {
  let { s, storage, beta } = await graphServer(t);
  const id = idIn(await s.call("execute_module", { module: GRAPH, capability: "set_axes", params: { xRange: [-10, 10], yRange: [-10, 10] }, newCanvas: { kind: "graph" }, present: false }));
  await s.call("present_visual", { imageId: id, annotations: [
    { id: "w", type: "point", x: 2, y: 4, label: "(2, 4)", anchor: { space: "world" } },
    { id: "box", type: "rect", x: -4, y: -2, x2: 4, y2: 2, label: "box", anchor: { space: "world" } },
    { id: "d", type: "point", x: 0.25, y: 0.25, label: "page" },
  ] });
  let axes = await axesOf(s, id), f = frameOf(axes);
  let w = await markOf(s, id, "w");
  assert.deepEqual(w.anchor, { space: "world", frame: axes.id, world: { x: 2, y: 4 }, status: "ok" });
  let [cx, cy] = f.toCanvas(2, 4);
  assert.ok(near(w.geometry.x, cx) && near(w.geometry.y, cy), "drawn where (2, 4) is on the axes: " + JSON.stringify(w.geometry));
  assert.equal((await markOf(s, id, "d")).anchor, undefined, "a document mark says nothing extra");

  // Zoom the axes in: the world marks move with the data, the page mark does not.
  await setAxes(s, id, [-5, 5], [-5, 5]);
  axes = await axesOf(s, id); f = frameOf(axes);
  w = await markOf(s, id, "w");
  [cx, cy] = f.toCanvas(2, 4);
  assert.ok(near(w.geometry.x, cx) && near(w.geometry.y, cy), "followed the new range: " + JSON.stringify(w.geometry));
  const box = await markOf(s, id, "box"), [bx, by] = f.toCanvas(-4, -2), [bx2, by2] = f.toCanvas(4, 2);
  assert.ok(near(box.geometry.x, bx) && near(box.geometry.y, by) && near(box.geometry.x2, bx2) && near(box.geometry.y2, by2), JSON.stringify(box.geometry));
  const d = await markOf(s, id, "d");
  assert.deepEqual([d.geometry.x, d.geometry.y], [0.25, 0.25], "the page mark stayed");

  // A range that leaves (2, 4) out: kept, flagged, not drawn.
  await setAxes(s, id, [-5, 5], [-1, 1]);
  w = await markOf(s, id, "w");
  assert.equal(w.anchor.status, "outside");
  assert.deepEqual(w.anchor.world, { x: 2, y: 4 }, "its world place is kept");
  const rendered = (await s.call("render_canvas", { imageId: id })).structuredContent.included;
  assert.equal(rendered.marks.includes("w"), false, "an outside mark is not drawn");
  assert.equal(rendered.marks.includes("d"), true);

  // Restart, then widen the range again: it comes back where (2, 4) is.
  await s.stop();
  s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  t.after(() => s.kill());
  assert.equal((await markOf(s, id, "w")).anchor.status, "outside", "the status survives a restart");
  await setAxes(s, id, [-10, 10], [-10, 10]);
  axes = await axesOf(s, id); f = frameOf(axes);
  w = await markOf(s, id, "w");
  [cx, cy] = f.toCanvas(2, 4);
  assert.equal(w.anchor.status, "ok");
  assert.ok(near(w.geometry.x, cx) && near(w.geometry.y, cy), JSON.stringify(w.geometry));
  // Stop it here: the after-hooks remove its folders first.
  await s.stop();
});

test("moving a world mark on the canvas moves its world place; switching anchors keeps the mark where it is", { timeout: 180000 }, async (t) => {
  const { s } = await graphServer(t);
  const id = idIn(await s.call("execute_module", { module: GRAPH, capability: "set_axes", params: { xRange: [0, 10], yRange: [0, 10] }, newCanvas: { kind: "graph" }, present: false }));
  await s.call("present_visual", { imageId: id, annotations: [{ id: "w", type: "point", x: 5, y: 5, anchor: { space: "world" } }, { id: "d", type: "point", x: 0.3, y: 0.3 }] });
  let axes = await axesOf(s, id), f = frameOf(axes);
  // The person drags the world mark to where (8, 2) is.
  const [tx, ty] = f.toCanvas(8, 2);
  await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "w", x: tx, y: ty }] });
  let w = await markOf(s, id, "w");
  assert.ok(near(w.anchor.world.x, 8, 1e-6) && near(w.anchor.world.y, 2, 1e-6), JSON.stringify(w.anchor));

  // The person attaches the page mark to the axes: same place, now in axis units.
  const before = (await markOf(s, id, "d")).geometry;
  const r = await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "d", anchor: { space: "world" } }] });
  let d = await markOf(s, id, "d");
  assert.deepEqual(d.geometry, before, "attaching does not move it");
  const [wx, wy] = f.toFrame(0.3, 0.3);
  assert.ok(near(d.anchor.world.x, wx, 1e-6) && near(d.anchor.world.y, wy, 1e-6));
  assert.ok(JSON.stringify(r.structuredContent ?? {}).length > 0);
  // The model is told what the person did.
  const told = (await s.call("present_visual", { imageId: id })).content.map((c) => c.text ?? "").join(" ");
  assert.match(told, /attached (their|YOUR) mark d to the axes/);

  // Detach the world mark: it stays put, then ignores the axes.
  await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "w", anchor: { space: "document" } }] });
  w = await markOf(s, id, "w");
  assert.equal(w.anchor, undefined);
  await setAxes(s, id, [0, 20], [0, 20]);
  const w2 = await markOf(s, id, "w");
  assert.deepEqual(w2.geometry, w.geometry, "a detached mark stays on the page");
  d = await markOf(s, id, "d");
  const [dx, dy] = frameOf(await axesOf(s, id)).toCanvas(wx, wy);
  assert.ok(near(d.geometry.x, dx) && near(d.geometry.y, dy), "the attached mark followed the axes");
});

test("model input: world coordinates outside the axes or with no axes are refused; a coordinateFrame cannot be mixed in", { timeout: 120000 }, async (t) => {
  const { s } = await graphServer(t);
  const id = idIn(await s.call("execute_module", { module: GRAPH, capability: "set_axes", params: { xRange: [-1, 1], yRange: [-1, 1] }, newCanvas: { kind: "graph" }, present: false }));
  const out = await s.raw("present_visual", { imageId: id, annotations: [{ id: "far", type: "point", x: 5, y: 0, anchor: { space: "world" } }] });
  assert.equal(out.isError, true); assert.match(JSON.stringify(out.content), /outside the axes range/);
  const bad = await s.raw("present_visual", { imageId: id, annotations: [{ id: "x", type: "point", x: 0, y: 0, anchor: { space: "world", frame: "o99" } }] });
  assert.equal(bad.isError, true); assert.match(JSON.stringify(bad.content), /not an axes object/);
  const neg = await s.raw("present_visual", { imageId: id, annotations: [{ id: "n", type: "point", x: -0.5, y: 0.5 }] });
  assert.equal(neg.isError, true, "a negative canvas coordinate is still refused");
  assert.deepEqual((await state(s, id)).marks, []);
});

test("moving the axes region on the page moves a world mark with it; deleting the axes leaves it in place as invalid", { timeout: 120000 }, async (t) => {
  const { s } = await graphServer(t);
  const id = idIn(await s.call("execute_module", { module: GRAPH, capability: "set_axes", params: { xRange: [0, 10], yRange: [0, 10] }, newCanvas: { kind: "graph" }, present: false }));
  await s.call("present_visual", { imageId: id, annotations: [{ id: "w", type: "point", x: 5, y: 5, anchor: { space: "world" } }] });
  const axes = await axesOf(s, id);
  await s.call("edit_scene_object", { imageId: id, id: axes.id, props: { region: { x: .2, y: .2, x2: .6, y2: .7 } } });
  const moved = await axesOf(s, id), [cx, cy] = frameOf(moved).toCanvas(5, 5);
  let w = await markOf(s, id, "w");
  assert.ok(near(w.geometry.x, cx) && near(w.geometry.y, cy), "followed the region: " + JSON.stringify(w.geometry));
  assert.ok(near(w.geometry.x, 0.4) && near(w.geometry.y, 0.45), JSON.stringify(w.geometry));

  await s.call("edit_scene_object", { imageId: id, id: axes.id, remove: true });
  w = await markOf(s, id, "w");
  assert.equal(w.anchor.status, "invalid");
  assert.ok(near(w.geometry.x, cx) && near(w.geometry.y, cy), "it stays where it was");
});

test("undo: moving a world mark and switching its anchor are both undone exactly", { timeout: 120000 }, async (t) => {
  const { s } = await graphServer(t);
  const id = idIn(await s.call("execute_module", { module: GRAPH, capability: "set_axes", params: { xRange: [0, 10], yRange: [0, 10] }, newCanvas: { kind: "graph" }, present: false }));
  await s.call("present_visual", { imageId: id, annotations: [{ id: "w", type: "point", x: 5, y: 5, anchor: { space: "world" } }, { id: "d", type: "point", x: 0.3, y: 0.3 }] });
  const f = frameOf(await axesOf(s, id)), [tx, ty] = f.toCanvas(8, 2);
  const w0 = await markOf(s, id, "w");
  await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "w", x: tx, y: ty }] });
  const undo = () => s.raw("edit_visual_canvas", { imageId: id, history: { action: "undo" } });
  let r = await undo();
  assert.ok(!r.isError, "undo right after a move: " + JSON.stringify(r.content));
  let w = await markOf(s, id, "w");
  assert.deepEqual(w.anchor, w0.anchor, "back at (5, 5) in axis units");
  assert.deepEqual(w.geometry, w0.geometry);

  // Pin the page mark to the axes, then undo it: back on the page.
  await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "d", anchor: { space: "world" } }] });
  assert.equal((await markOf(s, id, "d")).anchor?.space, "world");
  r = await undo();
  assert.ok(!r.isError, "undo an anchor switch: " + JSON.stringify(r.content));
  assert.equal((await markOf(s, id, "d")).anchor, undefined, "on the page again");
});

test("a world mark cannot be dragged or pinned outside the axes range; tiny ranges are compared at their own scale", { timeout: 120000 }, async (t) => {
  const { s } = await graphServer(t);
  const id = idIn(await s.call("execute_module", { module: GRAPH, capability: "set_axes", params: { xRange: [0, 10], yRange: [0, 10] }, newCanvas: { kind: "graph" }, present: false }));
  await s.call("present_visual", { imageId: id, annotations: [{ id: "w", type: "point", x: 5, y: 5, anchor: { space: "world" } }, { id: "d", type: "point", x: 0.99, y: 0.5 }] });
  const before = await markOf(s, id, "w");
  // Canvas x 0.99 is right of the axes region (x up to 0.96): about x = 10.3 in axis units.
  const drag = await s.raw("edit_visual_canvas", { imageId: id, marks: [{ id: "w", x: 0.99, y: 0.5 }] });
  assert.equal(drag.isError, true); assert.match(JSON.stringify(drag.content), /OUTSIDE_AXES/);
  assert.deepEqual(await markOf(s, id, "w"), before, "the refused drag changed nothing");
  const pin = await s.raw("edit_visual_canvas", { imageId: id, marks: [{ id: "d", anchor: { space: "world" } }] });
  assert.equal(pin.isError, true); assert.match(JSON.stringify(pin.content), /OUTSIDE_AXES/);
  assert.equal((await markOf(s, id, "d")).anchor, undefined);
  // The assistant re-places its world mark there in canvas units: kept, flagged outside, not drawn.
  await s.call("present_visual", { imageId: id, annotations: [{ id: "w", type: "point", x: 0.99, y: 0.5 }] });
  assert.equal((await markOf(s, id, "w")).anchor.status, "outside");
  assert.equal((await s.call("render_canvas", { imageId: id })).structuredContent.included.marks.includes("w"), false);

  // Tiny ranges: a point at 5e-11 is outside [0, 1e-11], not "inside within 1e-9".
  await setAxes(s, id, [0, 1e-10], [0, 1e-10]);
  await s.call("present_visual", { imageId: id, annotations: [{ id: "tiny", type: "point", x: 5e-11, y: 5e-11, anchor: { space: "world" } },
    // Just past 1e-11: it would still fall inside the canvas, so only a range-relative tolerance tells it is outside.
    { id: "edge", type: "point", x: 1.02e-11, y: 5e-12, anchor: { space: "world" } }] });
  const placed = await markOf(s, id, "tiny");
  await setAxes(s, id, [0, 1e-11], [0, 1e-11]);
  const tiny = await markOf(s, id, "tiny");
  assert.equal(tiny.anchor.status, "outside");
  assert.deepEqual(tiny.geometry, placed.geometry, "kept where it was, inside the canvas");
  assert.equal((await markOf(s, id, "edge")).anchor.status, "outside", "just past the range is outside");
});
