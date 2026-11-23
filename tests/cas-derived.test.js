// 5B-2b-3b: a plot made from a calculator cell is a derived object like any
// other module's: the core records it, the calculator tells it when a cell
// changed, and refreshing goes through the calculator's declared capability.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noPython } from "./helpers/widget-host.js";

const CAS = "org.estampes.cas";
test("a calculator plot is recorded as derived, goes stale when its cell changes, and refreshes through refresh_plot", { skip: noPython, timeout: 120000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph", CAS]);
    const plotted = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "image" } });
    const imageId = (JSON.stringify(plotted.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    const opened = await s.call("surface_apply", { imageId, ops: [{ op: "open-panel", module: CAS, panel: "calculator" }] });
    const nb = opened.structuredContent.panels.find((p) => p.kind === "calculator").notebook;
    const cas = (capability, params) => s.call("surface_cas", { imageId, capability, params: { notebook: nb, ...params } });
    await cas("define", { name: "f", params: ["x"], text: "2*x^2" });
    const calc = await cas("calculate", { operation: "differentiate", text: "f(x)", variable: "x" });
    const cellId = calc.structuredContent.data.cell.cellId;
    const plot = await cas("plot_result", { cell: cellId, domain: [-3, 3] });
    const objectId = plot.structuredContent.objects.find((o) => o.type === "function-plot" && o.module === CAS).id;

    const list = async () => (await s.call("get_derived_bindings", { canvas: imageId })).structuredContent;
    let b = (await list()).bindings;
    assert.equal(b.length, 1, "the plot is recorded as derived");
    const firstRevision = b[0].sourceRevision;
    assert.deepEqual([b[0].module, b[0].capability, b[0].object, b[0].state], [CAS, "plot_result", objectId, "fresh"]);

    // The definition changes: the calculator broadcasts, the core marks the plot stale (autoRefresh is off).
    await cas("define", { name: "f", params: ["x"], text: "5*x^2" });
    b = (await list()).bindings;
    assert.equal(b[0].state, "stale");

    // Refreshing goes through the declared refresh capability and the plot follows the cell.
    const done = await s.call("update_derived", { canvas: imageId, action: "refresh-stale" });
    assert.equal(done.structuredContent.result.refreshed.length, 1, JSON.stringify(done.structuredContent.result));
    const seen = (await s.call("get_visual_state", { imageId })).structuredContent.objects.find((o) => o.id === objectId);
    assert.equal(seen.props.expression, "10*x");
    const now = (await list()).bindings[0];
    assert.equal(now.state, "fresh");
    assert.ok(now.sourceRevision > firstRevision, "the binding records the cell revision it was redrawn from");

    // A hand edit pauses the next refresh as a conflict; nothing is overwritten.
    await s.call("edit_scene_object", { imageId, id: objectId, props: { expression: "99*x" } });
    await cas("define", { name: "f", params: ["x"], text: "3*x^2" });
    const paused = await s.call("update_derived", { canvas: imageId, action: "refresh-stale" });
    assert.equal(paused.structuredContent.result.paused.length, 1, JSON.stringify(paused.structuredContent.result));
    const kept = (await s.call("get_visual_state", { imageId })).structuredContent.objects.find((o) => o.id === objectId);
    assert.equal(kept.props.expression, "99*x");
    assert.equal((await list()).bindings[0].state, "conflict");

    // Overwriting that edit needs a preview first; the preview changes nothing.
    const row = (await list()).bindings[0];
    const blind = await s.call("update_derived", { canvas: imageId, action: "overwrite", binding: row.id, expectedBindingHash: row.bindingHash });
    assert.equal(blind.isError, true, "no overwrite without a preview");
    const pv = await s.call("update_derived", { canvas: imageId, action: "preview", binding: row.id });
    assert.ok(!pv.isError, JSON.stringify(pv.content));
    const shown = pv.structuredContent.result;
    assert.match(shown.wouldWrite, /3\*x\^2|6\*x/);
    assert.match(shown.current, /99\*x/);
    assert.equal((await s.call("get_visual_state", { imageId })).structuredContent.objects.find((o) => o.id === objectId).props.expression, "99*x");
    const over = await s.call("update_derived", { canvas: imageId, action: "overwrite", binding: row.id, expectedBindingHash: row.bindingHash, previewToken: shown.previewToken });
    assert.ok(!over.isError, JSON.stringify(over.content));
    assert.equal((await s.call("get_visual_state", { imageId })).structuredContent.objects.find((o) => o.id === objectId).props.expression, "6*x");
    assert.equal((await list()).bindings[0].state, "fresh");
  } finally { await s.close(); }
});
