import test from "node:test";
import assert from "node:assert/strict";
import { applySceneOps, canvasObjects, sceneRevision, renderedObjects, widgetObjects, SceneOpsError, serializeObjects, restoreObjects } from "../src/scene/scene-ops.js";
import { renderObject, validateProps } from "../src/scene/objects.js";
import { canvasLayers, editCanvas } from "../src/canvas-state.js";

const canvas = () => ({ imageId: "img:0123456789abcdef", width: 1600, height: 1000, marks: new Map(), layers: [] });
const mod = { author: "module", module: "org.test.mod", moduleVersion: "1.0.0", capability: "c" };
const axes = { op: "object.create", ref: "a", type: "axes-2d", props: { xRange: [-6.3, 6.3], yRange: [-1.5, 1.5] } };
const plot = (expression = "sin(x)") => ({ op: "object.create", type: "function-plot", props: { expression, frame: "$a" } });

test("scene ops: create with refs, ids assigned by the core, provenance recorded", () => {
  const e = canvas();
  const r = applySceneOps(e, [axes, plot()], mod);
  assert.deepEqual(r.created, ["o1", "o2"]);
  assert.equal(r.refs.a, "o1");
  assert.equal(sceneRevision(e), 1);
  const o = canvasObjects(e)[1];
  assert.equal(o.props.frame, "o1");
  assert.equal(o.provenance.module, "org.test.mod");
  assert.ok(canvasLayers(e).some((l) => l.id === o.layer && l.module === "org.test.mod"), "objects live in a layer named for the module");
});

test("scene ops: all or nothing, with a pointed error", () => {
  const e = canvas();
  assert.throws(() => applySceneOps(e, [axes, plot("sin(x"), plot()], mod), /operations\[1\]/);
  assert.equal(canvasObjects(e).length, 0);
  assert.equal(sceneRevision(e), 0);
  assert.throws(() => applySceneOps(e, [{ op: "object.explode", id: "o1" }], mod), /known operations/);
  assert.throws(() => applySceneOps(e, [{ op: "object.create", type: "script", props: {} }], mod), SceneOpsError);
  assert.throws(() => applySceneOps(e, [{ op: "object.create", type: "function-plot", props: { expression: "sin(x)", frame: "o9" } }], mod), /not an object/);
});

test("scene ops: a module changes only its own objects; the user changes anything", () => {
  const e = canvas();
  applySceneOps(e, [axes, plot()], mod);
  const other = { ...mod, module: "org.test.other" };
  assert.throws(() => applySceneOps(e, [{ op: "object.update", id: "o2", props: { expression: "cos(x)" } }], other), /only update its own/);
  applySceneOps(e, [{ op: "object.update", id: "o2", props: { expression: "sin(2x)" } }], mod);
  assert.equal(canvasObjects(e)[1].props.expression, "sin(2x)");
  applySceneOps(e, [{ op: "object.update", id: "o2", props: { expression: "cos(x)" } }], { author: "user" });
  assert.equal(canvasObjects(e)[1].provenance.editedByUser, true);
});

test("scene ops: optimistic concurrency, in-use frames, locked layers", () => {
  const e = canvas();
  applySceneOps(e, [axes, plot()], mod);
  assert.throws(() => applySceneOps(e, [plot("x")], mod, { expectedRevision: 0 }), (err) => err.code === "conflict");
  assert.throws(() => applySceneOps(e, [{ op: "object.delete", id: "o1" }], mod), (err) => err.code === "in-use");
  const r = applySceneOps(e, [{ op: "object.delete", id: "o1", cascade: true }], mod);
  assert.deepEqual(r.deleted.sort(), ["o1", "o2"]);
  applySceneOps(e, [axes], mod);
  editCanvas(e, { layers: [{ id: canvasObjects(e)[0].layer, locked: true }] });
  assert.throws(() => applySceneOps(e, [{ op: "object.update", id: "o3", props: { grid: false } }], { author: "user" }), (err) => err.code === "locked");
});

test("scene ops: scratch objects are not drawn for the user until published", () => {
  const e = canvas();
  applySceneOps(e, [axes, plot()], mod, { visibility: "scratch" });
  assert.equal(widgetObjects(e).length, 0);
  applySceneOps(e, [{ op: "object.publish", id: "o1" }, { op: "object.publish", id: "o2" }], mod);
  assert.equal(widgetObjects(e).length, 2);
  assert.ok(widgetObjects(e)[1].editable.expression);
});

test("scene ops: objects survive a round trip through storage form and re-render the same", () => {
  const e = canvas();
  applySceneOps(e, [axes, plot("sin(x)")], mod);
  const before = JSON.stringify(widgetObjects(e));
  const f = canvas();
  restoreObjects(f, JSON.parse(JSON.stringify(serializeObjects(e))));
  assert.equal(JSON.stringify(widgetObjects(f)), before);
});

test("renderer: a plot of sin(x) is one smooth curve through the right points; tan breaks at asymptotes", () => {
  const ax = { id: "o1", type: "axes-2d", props: validateProps("axes-2d", { xRange: [-6.3, 6.3], yRange: [-3, 3] }) };
  const lookup = (id) => (id === "o1" ? ax : null);
  const sin = renderObject({ id: "o2", type: "function-plot", props: validateProps("function-plot", { expression: "sin(x)", frame: "o1" }) }, { lookup });
  const curves = sin.primitives.filter((p) => p.k === "path");
  assert.equal(curves.length, 1);
  // sin(pi/2) = 1 must sit at the canvas y of value 1.
  const [, y] = [0, 0.9 - ((1 + 3) / 6) * 0.83];
  assert.ok(curves[0].pts.some(([px, py]) => Math.abs(py - y) < 0.002 && Math.abs(px - (0.08 + ((Math.PI / 2 + 6.3) / 12.6) * 0.88)) < 0.02));
  const tan = renderObject({ id: "o2", type: "function-plot", props: validateProps("function-plot", { expression: "tan(x)", frame: "o1" }) }, { lookup });
  assert.ok(tan.primitives.filter((p) => p.k === "path").length >= 4, "separate branches, never joined across x = pi/2");
  const gone = renderObject({ id: "o2", type: "function-plot", props: validateProps("function-plot", { expression: "x", frame: "o1" }) }, { lookup: () => null });
  assert.match(gone.info.note, /not an axes-2d/);
});

test("plot labels: Core edits follow auto expressions and preserve custom names", () => {
  const e = canvas();
  applySceneOps(e, [axes, plot()], mod);
  const labels = () => widgetObjects(e)[1].primitives.filter((p) => p.k === "text").map((p) => p.text);
  const edit = (props) => applySceneOps(e, [{ op: "object.update", id: "o2", props }], { author: "user" });
  assert.equal(canvasObjects(e)[1].props.labelMode, "auto");
  edit({ expression: "sin(2*x)" });
  assert.deepEqual(labels(), ["y = sin(2*x)"]);
  edit({ label: "實測電壓" });
  edit({ expression: "cos(x)" });
  assert.deepEqual(labels(), ["實測電壓"]);
  assert.equal(canvasObjects(e)[1].props.labelMode, "custom");
  edit({ label: "" });
  assert.deepEqual(labels(), []);
  edit({ labelMode: "auto", label: "stale" });
  assert.deepEqual(labels(), ["y = cos(x)"]);
  assert.equal(canvasObjects(e)[1].props.label, undefined);
  const saved = JSON.parse(JSON.stringify(serializeObjects(e)));
  const f = canvas();
  restoreObjects(f, saved);
  assert.deepEqual(widgetObjects(f), widgetObjects(e));
  const before = JSON.stringify(serializeObjects(e));
  const revision = sceneRevision(e);
  assert.throws(() => applySceneOps(e, [
    { op: "object.update", id: "o2", props: { label: "temporary" } },
    { op: "object.update", id: "o2", props: { labelMode: "invalid" } },
  ], { author: "user" }), /labelMode/);
  assert.equal(JSON.stringify(serializeObjects(e)), before);
  assert.equal(sceneRevision(e), revision);
  assert.deepEqual(labels(), ["y = cos(x)"]);
});

test("plot labels: legacy formula-looking and empty labels stay custom after restore", () => {
  for (const label of ["y = sin(x)", "實測電壓", ""]) {
    const e = canvas();
    applySceneOps(e, [axes, plot()], mod);
    const saved = JSON.parse(JSON.stringify(serializeObjects(e)));
    saved[1].props.label = label;
    delete saved[1].props.labelMode;
    restoreObjects(e, saved);
    applySceneOps(e, [{ op: "object.update", id: "o2", props: { expression: "sin(2*x)" } }], { author: "user" });
    assert.equal(canvasObjects(e)[1].props.labelMode, "custom");
    const labels = () => widgetObjects(e)[1].primitives.filter((p) => p.k === "text").map((p) => p.text);
    assert.deepEqual(labels(), label ? [label] : []);
    applySceneOps(e, [{ op: "object.update", id: "o2", props: { labelMode: "auto" } }], { author: "user" });
    assert.deepEqual(labels(), ["y = sin(2*x)"]);
  }
});

test("deleted axes and plots restore together with original IDs, labels and lock checks", async () => {
  const e = canvas();
  applySceneOps(e, [axes, plot()], mod);
  applySceneOps(e, [{op:"object.delete",id:"o1",cascade:true}], {author:"user"});
  assert.equal(canvasObjects(e).length,0);
  assert.equal(e.deletedObjectBatches.length,1);
  const {serializeCanvas,restoreCanvas}=await import("../src/storage.js");
  const f=canvas();restoreCanvas(f,JSON.parse(JSON.stringify(serializeCanvas(e))));
  applySceneOps(f,[{op:"object.restore"}],{author:"user"});
  assert.deepEqual(canvasObjects(f).map(o=>o.id),["o1","o2"]);
  e.layers[0].locked=true;
  assert.throws(()=>applySceneOps(e,[{op:"object.restore"}],{author:"user"}),/locked/);
  assert.equal(canvasObjects(e).length,0);
  assert.equal(e.deletedObjectBatches.length,1);
  delete e.layers[0].locked;
  applySceneOps(e,[{op:"object.restore"}],{author:"user"});
  assert.deepEqual(canvasObjects(e).map(o=>o.id),["o1","o2"]);
  assert.equal(canvasObjects(e).find(o=>o.id==="o2").props.frame,"o1");
  assert.equal(e.deletedObjectBatches.length,0);
  assert.ok(widgetObjects(e).find(o=>o.id==="o2").primitives.length);
});

test("scene ops: an update keeps how the object was created (provenance) and only moves updatedAt", () => {
  const e = canvas();
  const made = { ...mod, capability: "plot_result", method: "SymPy result cr:1 drawn by the Graph renderer" };
  applySceneOps(e, [axes, plot("x")], made, { now: "2026-01-01T00:00:00.000Z" });
  const before = canvasObjects(e)[1].provenance;
  assert.equal(before.method, made.method);
  // A refresh redraws the plot from a newer result, as the module, with a new method text.
  applySceneOps(e, [{ op: "object.update", id: "o2", props: { expression: "2*x" } }],
    { ...mod, capability: "refresh", method: "SymPy result cr:2 drawn by the Graph renderer" }, { now: "2026-01-02T00:00:00.000Z" });
  const o = canvasObjects(e)[1], after = o.provenance;
  assert.equal(o.props.expression, "2*x");
  assert.equal(after.method, before.method, "method still names the result it was created from");
  assert.equal(after.capability, "plot_result");
  assert.equal(after.createdAt, before.createdAt);
  assert.notEqual(after.updatedAt, before.updatedAt, "updatedAt moves");
});
