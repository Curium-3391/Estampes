// UVA Phase 4B-4: a mark pinned to a function plot at an x value follows the
// curve when the formula, the domain or the axes change. When the curve is
// gone or not defined at its x, the mark keeps its place and is flagged
// invalid until it is pinned again or pinned to the page. A confirmed claim
// about a mark whose curve was re-defined becomes a stale confirmation.
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
  const storage = await mkdtemp(join(tmpdir(), "graph-fn-legacy-")), beta = await mkdtemp(join(tmpdir(), "graph-fn-uva-"));
  const s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  t.after(async () => { await s.kill(); await Promise.all([rm(storage, { recursive: true, force: true }), rm(beta, { recursive: true, force: true })]); });
  await s.enable(GRAPH);
  return { s, storage, beta };
}
const ok = async (s, name, args) => { const r = await s.call(name, args); assert.ok(!r.isError, name + ": " + JSON.stringify(r.content)); return r.structuredContent; };
const state = async (s, id) => (await s.call("get_visual_state", { imageId: id })).structuredContent;
const markOf = async (s, id, markId) => (await state(s, id)).marks.find((m) => m.id === markId);
const axesOf = async (s, id) => (await state(s, id)).objects.find((o) => o.type === "axes-2d");
const plots = async (s, id) => (await state(s, id)).objects.filter((o) => o.type === "function-plot");
const updatePlot = (s, id, params) => ok(s, "execute_module", { module: GRAPH, capability: "update_plot", canvas: id, params, present: false });
async function graphWith(s, expression, more = []) {
  const id = idIn(await s.call("execute_module", { module: GRAPH, capability: "plot_function", params: { expression }, newCanvas: { kind: "graph" }, present: false }));
  for (const e of more) await ok(s, "execute_module", { module: GRAPH, capability: "plot_function", canvas: id, params: { expression: e }, present: false });
  await ok(s, "execute_module", { module: GRAPH, capability: "set_axes", canvas: id, params: { xRange: [-10, 10], yRange: [-10, 10] }, present: false });
  return id;
}
const at = async (s, id, x, y) => { const [cx, cy] = frameOf(await axesOf(s, id)).toCanvas(x, y); return { x: cx, y: cy }; };

test("a mark pinned to a curve follows the formula, the domain and the axes", { timeout: 180000 }, async (t) => {
  let { s, storage, beta } = await graphServer(t);
  const id = await graphWith(s, "x");
  const [plot] = await plots(s, id);
  // The model gives axis units; the first point is put on the curve at x = 2.
  await ok(s, "present_visual", { imageId: id, annotations: [
    { id: "p", type: "point", x: 2, y: 0, label: "on y = x", anchor: { space: "function-x" } },
    { id: "box", type: "rect", x: 3, y: 4, x2: 5, y2: 5, label: "above", anchor: { space: "function-x", plot: plot.id } },
  ] });
  let p = await markOf(s, id, "p"), q = await at(s, id, 2, 2);
  assert.deepEqual({ space: p.anchor.space, plot: p.anchor.plot, x: p.anchor.x, status: p.anchor.status }, { space: "function-x", plot: plot.id, x: 2, status: "ok" });
  assert.ok(near(p.geometry.x, q.x) && near(p.geometry.y, q.y), "on the curve at (2, 2): " + JSON.stringify(p.geometry));
  // The rect keeps its shape; its first corner sits on the curve at (3, 3).
  const box = await markOf(s, id, "box"), b0 = await at(s, id, 3, 3), b1 = await at(s, id, 5, 4);
  assert.ok(near(box.geometry.x, b0.x) && near(box.geometry.y, b0.y) && near(box.geometry.x2, b1.x) && near(box.geometry.y2, b1.y), JSON.stringify(box.geometry));

  // A new formula: the mark moves to (2, f(2)).
  await updatePlot(s, id, { object: plot.id, expression: "x^2" });
  p = await markOf(s, id, "p"); q = await at(s, id, 2, 4);
  assert.ok(near(p.geometry.x, q.x) && near(p.geometry.y, q.y), "moved to (2, 4): " + JSON.stringify(p.geometry));
  assert.equal(p.anchor.status, "ok");

  // A new axes range: still on the curve.
  await ok(s, "execute_module", { module: GRAPH, capability: "set_axes", canvas: id, params: { xRange: [-5, 5], yRange: [-5, 5] }, present: false });
  p = await markOf(s, id, "p"); q = await at(s, id, 2, 4);
  assert.ok(near(p.geometry.x, q.x) && near(p.geometry.y, q.y), JSON.stringify(p.geometry));
  // A range that leaves (2, 4) out: not drawn.
  await ok(s, "execute_module", { module: GRAPH, capability: "set_axes", canvas: id, params: { yRange: [-1, 1] }, present: false });
  assert.equal((await markOf(s, id, "p")).anchor.status, "outside");
  assert.equal((await s.call("render_canvas", { imageId: id })).structuredContent.included.marks.includes("p"), false);
  await ok(s, "execute_module", { module: GRAPH, capability: "set_axes", canvas: id, params: { yRange: [-5, 5] }, present: false });

  // Without an explicit domain, an axes x range that leaves x = 2 out only hides it.
  await ok(s, "execute_module", { module: GRAPH, capability: "set_axes", canvas: id, params: { xRange: [-1, 1] }, present: false });
  assert.equal((await markOf(s, id, "p")).anchor.status, "outside", "out of view, not a lost anchor");
  await ok(s, "execute_module", { module: GRAPH, capability: "set_axes", canvas: id, params: { xRange: [-5, 5] }, present: false });
  assert.equal((await markOf(s, id, "p")).anchor.status, "ok");

  // A domain that leaves x = 2 out: invalid, kept where it was, still drawn.
  const before = (await markOf(s, id, "p")).geometry;
  await updatePlot(s, id, { object: plot.id, domain: [-1, 1] });
  p = await markOf(s, id, "p");
  assert.equal(p.anchor.status, "invalid");
  assert.deepEqual(p.geometry, before, "an invalid mark stays where it was");
  assert.equal((await s.call("render_canvas", { imageId: id })).structuredContent.included.marks.includes("p"), true, "an invalid mark is still drawn");

  // Survives a restart; the domain coming back brings it back to the curve.
  await s.stop();
  s = await startCanvasStoreServer(storage, beta, { idle: "0" });
  t.after(() => s.kill());
  assert.equal((await markOf(s, id, "p")).anchor.status, "invalid");
  await updatePlot(s, id, { object: plot.id, domain: [-5, 5] });
  p = await markOf(s, id, "p"); q = await at(s, id, 2, 4);
  assert.equal(p.anchor.status, "ok");
  assert.ok(near(p.geometry.x, q.x) && near(p.geometry.y, q.y), JSON.stringify(p.geometry));
  await s.stop();
});

test("a deleted curve leaves its marks invalid in place; pinning again or to the page fixes them", { timeout: 180000 }, async (t) => {
  const { s } = await graphServer(t);
  const id = await graphWith(s, "x", ["x + 5"]);
  const [line, upper] = await plots(s, id);
  await ok(s, "present_visual", { imageId: id, annotations: [
    { id: "a", type: "point", x: 1, y: 0, label: "a", anchor: { space: "function-x", plot: line.id } },
    { id: "b", type: "point", x: 2, y: 0, label: "b", anchor: { space: "function-x", plot: line.id } },
  ] });
  const before = (await markOf(s, id, "a")).geometry;
  await ok(s, "edit_scene_object", { imageId: id, id: line.id, remove: true });
  for (const m of ["a", "b"]) {
    const mark = await markOf(s, id, m);
    assert.equal(mark.anchor.status, "invalid", m);
  }
  assert.deepEqual((await markOf(s, id, "a")).geometry, before, "kept where it was");

  // Pin again: the curve nearest at its x (y = x + 5 is the only one left).
  let r = await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "a", anchor: { space: "function-x" } }] });
  assert.ok(!r.isError, JSON.stringify(r.content));
  let a = await markOf(s, id, "a");
  assert.equal(a.anchor.status, "ok");
  assert.equal(a.anchor.plot, upper.id);
  assert.deepEqual(a.geometry, before, "pinning keeps the mark where it is (as an offset from the curve)");
  await updatePlot(s, id, { object: upper.id, expression: "x + 6" });
  a = await markOf(s, id, "a");
  const p0 = await at(s, id, 1, 1), p1 = await at(s, id, 1, 2);
  assert.ok(near(a.geometry.x, p0.x) && near(a.geometry.y, before.y + (p1.y - p0.y)), "follows the curve by its offset: " + JSON.stringify(a.geometry));

  // Pinned again to the same plot after its domain left x out: undo brings back the lost anchor.
  const c0 = (await markOf(s, id, "a")).anchor;
  await updatePlot(s, id, { object: upper.id, domain: [-0.5, 0.5] });
  assert.equal((await markOf(s, id, "a")).anchor.status, "invalid");
  await ok(s, "execute_module", { module: GRAPH, capability: "set_axes", canvas: id, params: { xRange: [-0.5, 0.5] }, present: false });
  await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "a", anchor: { space: "function-x", plot: upper.id } }] });
  const repinned = await markOf(s, id, "a");
  assert.equal(repinned.anchor.status, "ok", JSON.stringify(repinned.anchor));
  assert.notEqual(repinned.anchor.x, c0.x);
  r = await s.call("edit_visual_canvas", { imageId: id, history: { action: "undo" } });
  const back = await markOf(s, id, "a");
  assert.equal(back.anchor.status, "invalid", "undo restores the lost anchor");
  assert.equal(back.anchor.x, c0.x);
  await ok(s, "execute_module", { module: GRAPH, capability: "set_axes", canvas: id, params: { xRange: [-10, 10] }, present: false });

  // Detach: a page mark at its current place.
  const placeB = (await markOf(s, id, "b")).geometry;
  r = await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "b", anchor: { space: "document" } }] });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const b = await markOf(s, id, "b");
  assert.equal(b.anchor, undefined);
  assert.deepEqual(b.geometry, placeB);

  // Undo the detach: invalid again (the curve is still gone).
  r = await s.call("edit_visual_canvas", { imageId: id, history: { action: "undo" } });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const undone = await markOf(s, id, "b");
  assert.equal(undone.anchor.space, "function-x");
  assert.equal(undone.anchor.status, "invalid");
});

test("pinning is refused where no curve passes, and a pinned mark cannot be dragged off its curve", { timeout: 180000 }, async (t) => {
  const { s } = await graphServer(t);
  const id = await graphWith(s, "x");
  await ok(s, "execute_module", { module: GRAPH, capability: "update_plot", canvas: id, params: { object: (await plots(s, id))[0].id, domain: [-1, 1] }, present: false });
  const far = await at(s, id, 5, 5), near0 = await at(s, id, 0, 0);
  await ok(s, "present_visual", { imageId: id, annotations: [
    { id: "far", type: "point", x: far.x, y: far.y },
    { id: "ok", type: "point", x: near0.x, y: near0.y - 0.02 },
  ] });
  let r = await s.raw("edit_visual_canvas", { imageId: id, marks: [{ id: "far", anchor: { space: "function-x" } }] });
  assert.ok(r.isError, "no curve at x = 5");
  assert.match(JSON.stringify(r.content), /NO_CURVE/);
  // The model cannot place one where the curve is not defined either.
  r = await s.raw("present_visual", { imageId: id, annotations: [{ id: "m", type: "point", x: 5, y: 0, anchor: { space: "function-x" } }] });
  assert.ok(r.isError);
  assert.match(JSON.stringify(r.content), /not defined at x = 5/);

  r = await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "ok", anchor: { space: "function-x" } }] });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const pinned = await markOf(s, id, "ok");
  assert.ok(near(pinned.anchor.x, 0, 1e-6), JSON.stringify(pinned.anchor));
  // Moving it along the curve's domain re-pins it at the new x; moving it past the domain is refused.
  const inside = await at(s, id, 0.5, 0.5);
  r = await s.call("edit_visual_canvas", { imageId: id, marks: [{ id: "ok", x: inside.x, y: inside.y }] });
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.ok(near((await markOf(s, id, "ok")).anchor.x, 0.5, 1e-6));
  r = await s.raw("edit_visual_canvas", { imageId: id, marks: [{ id: "ok", x: far.x, y: far.y }] });
  assert.ok(r.isError);
  assert.match(JSON.stringify(r.content), /OFF_CURVE/);
});

test("a confirmed claim on a pinned mark becomes a stale confirmation when its curve is re-defined, not when the axes change", { timeout: 180000 }, async (t) => {
  const { s } = await graphServer(t);
  const id = await graphWith(s, "x");
  const [plot] = await plots(s, id);
  await ok(s, "present_visual", { imageId: id, annotations: [
    { id: "root", type: "point", x: 0, y: 0, label: "root", note: "the root of f", anchor: { space: "function-x" } },
  ] });
  let r = await s.call("review_visual_finding", { imageId: id, markId: "root", review: "confirmed" });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const verification = async () => (await markOf(s, id, "root")).finding?.verification?.state;
  assert.equal(await verification(), "user-confirmed");
  await ok(s, "execute_module", { module: GRAPH, capability: "set_axes", canvas: id, params: { xRange: [-5, 5] }, present: false });
  assert.equal(await verification(), "user-confirmed", "a new range does not change what the claim is about");
  await updatePlot(s, id, { object: plot.id, expression: "x + 1" });
  assert.equal(await verification(), "stale-confirmation");
  // The user confirms again: no longer stale.
  r = await s.call("review_visual_finding", { imageId: id, markId: "root", review: "confirmed" });
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.equal(await verification(), "user-confirmed");
});
