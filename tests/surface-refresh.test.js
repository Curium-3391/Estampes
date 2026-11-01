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

    // Turning auto-refresh on redraws plots that were already stale; the model's own
    // changes (execute_module) trigger it too, and so do plots on another canvas.
    await cas("set_options", { autoRefresh: false });
    const other = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: {} });
    const otherId = (JSON.stringify(other.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    const calc2 = await cas("calculate", { operation: "differentiate", text: "f(x)", variable: "x" });
    const cell2 = calc2.structuredContent.data.cell.cellId;
    await cas("plot_result", { cell: cell2 });
    await s.call("surface_cas", { imageId: otherId, capability: "plot_result", params: { notebook: nb, cell: cell2 } });
    await cas("define", { name: "f", params: ["x"], text: "11*x^2" });
    const turnedOn = await cas("set_options", { autoRefresh: true });
    assert.ok(turnedOn.structuredContent.refresh.updated.length >= 2, "enabling it redraws the plots that were waiting, on both canvases");
    assert.equal(turnedOn.structuredContent.refresh.remaining, 0);
    const onOther = (await s.call("get_surface_state", { imageId: otherId })).structuredContent;
    assert.ok(onOther, "the other canvas still has a surface");
    const viaModel = await s.call("execute_module", { module: "org.estampes.cas", capability: "define", params: { notebook: nb, name: "f", params: ["x"], text: "13*x^2", by: "model" } });
    assert.ok(!viaModel.isError, JSON.stringify(viaModel.content));
    assert.match(viaModel.content[0].text, /Auto-refresh: recomputed \d+ cell\(s\), redrew \d+ Graph plot/, "the model's change is followed up too");
    const book = (await cas("get_notebook", { full: true })).structuredContent.data;
    assert.ok(book.cells.every((c) => c.state === "fresh" && (c.links ?? []).every((l) => l.status === "fresh" || l.status === "removed")), "nothing is left stale after a model-side change");
  } finally { await s.close(); }
});
