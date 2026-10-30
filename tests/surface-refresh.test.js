// Graph plots made from calculator cells follow their cells: by hand with
// refresh_links, or automatically when the notebook's autoRefresh is on.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noPython } from "./helpers/widget-host.js";

test("link refresh: stale plots are recomputed and redrawn, manually and automatically", { skip: noPython, timeout: 120000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph", "org.estampes.cas"]);
    const plotted = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: {} });
    const imageId = (JSON.stringify(plotted.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    const opened = await s.call("surface_apply", { imageId, ops: [{ op: "open-panel", module: "org.estampes.cas", panel: "calculator" }] });
    const nb = opened.structuredContent.panels.find((p) => p.kind === "calculator").notebook;
    const cas = (capability, params) => s.call("surface_cas", { imageId, capability, params: { notebook: nb, ...params } });
    const expr = (r, cellId) => r.structuredContent.objects.find((o) => o.type === "function-plot" && o.module === "org.estampes.cas")?.editable.expression;

    const d0 = await cas("define", { name: "f", params: ["x"], text: "2*x^2" });
    assert.ok(!d0.isError, JSON.stringify(d0.content));
    const calc = await cas("calculate", { operation: "differentiate", text: "f(x)", variable: "x" });
    const cellId = calc.structuredContent.data.cell.cellId;
    assert.equal(calc.structuredContent.data.cell.result.plain, "4*x");
    const plot = await cas("plot_result", { cell: cellId, domain: [-3, 3] });
    assert.equal(expr(plot), "4*x");

    // Manual: a changed definition makes the cell and its link stale; refresh_links fixes both.
    await cas("define", { name: "f", params: ["x"], text: "3*x^2" });
    let state = (await s.call("get_surface_state", { imageId })).structuredContent;
    let cell = Object.values(state.notebooks)[0].cells.find((c) => c.cellId === cellId);
    assert.equal(cell.state, "stale");
    assert.equal(cell.links[0].status, "stale");
    const refreshed = await cas("refresh_links", {});
    assert.deepEqual(refreshed.structuredContent.refresh.recomputed, [cellId]);
    assert.equal(refreshed.structuredContent.refresh.updated.length, 1);
    assert.equal(refreshed.structuredContent.refresh.failed.length, 0);
    assert.equal(expr(refreshed), "6*x");
    state = (await s.call("get_surface_state", { imageId })).structuredContent;
    cell = Object.values(state.notebooks)[0].cells.find((c) => c.cellId === cellId);
    assert.equal(cell.state, "fresh");
    assert.equal(cell.links[0].status, "fresh");
    assert.deepEqual(cell.links[0].domain, [-3, 3], "the plot keeps its domain");

    // Automatic: with autoRefresh on, a definition change redraws without another call.
    const opt = await cas("set_options", { autoRefresh: true });
    assert.equal(opt.structuredContent.data.autoRefresh, true);
    const auto = await cas("define", { name: "f", params: ["x"], text: "5*x^2" });
    assert.equal(auto.structuredContent.refresh.updated.length, 1);
    assert.equal(expr(auto), "10*x");
    state = (await s.call("get_surface_state", { imageId })).structuredContent;
    assert.equal(Object.values(state.notebooks)[0].cells.find((c) => c.cellId === cellId).links[0].status, "fresh");

    // A plot the user deleted is reported, not silently recreated.
    const objectId = (await s.call("surface_cas", { imageId, capability: "get_notebook", params: { notebook: nb, full: true } })).structuredContent.data.cells.find((c) => c.cellId === cellId).links[0].object;
    await s.call("edit_scene_object", { imageId, id: objectId, remove: true });
    const gone = await cas("define", { name: "f", params: ["x"], text: "7*x^2" });
    assert.equal(gone.structuredContent.refresh.failed.length, 1);
    assert.equal(gone.structuredContent.refresh.failed[0].object, objectId);
  } finally { await s.close(); }
});
