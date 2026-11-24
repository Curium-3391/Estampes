// UVA Phase 5B-0 pinned that a CAS refresh overwrote a plot the person had
// edited by hand (a gap against OD-05, which says a refresh pauses on a
// user-edited plot). 5B-2b-3b flipped it: the calculator is a module/2
// built-in, so the core refuses to rewrite what the person edited and the
// refresh reports it. Resolving it (overwrite, fork, detach) comes with 5B-3.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noPython } from "./helpers/widget-host.js";

test("OD-05: an automatic refresh does not overwrite a plot the person edited by hand", { skip: noPython, timeout: 120000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph", "org.estampes.cas"]);
    const plotted = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "image" } });
    const imageId = (JSON.stringify(plotted.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    const opened = await s.call("surface_apply", { imageId, ops: [{ op: "open-panel", module: "org.estampes.cas", panel: "calculator" }] });
    const nb = opened.structuredContent.panels.find((p) => p.kind === "calculator").notebook;
    const cas = (capability, params) => s.call("surface_cas", { imageId, capability, params: { notebook: nb, ...params } });
    const casPlot = (r) => r.structuredContent.objects.find((o) => o.type === "function-plot" && o.module === "org.estampes.cas");

    await cas("define", { name: "f", params: ["x"], text: "2*x^2" });
    const calc = await cas("calculate", { operation: "differentiate", text: "f(x)", variable: "x" });
    const cellId = calc.structuredContent.data.cell.cellId;
    const plot = await cas("plot_result", { cell: cellId, domain: [-3, 3] });
    const objectId = casPlot(plot).id;
    assert.equal(casPlot(plot).editable.expression, "4*x");
    await cas("set_options", { autoRefresh: true });

    // The person edits the plot's formula by hand.
    const edited = await s.call("edit_scene_object", { imageId, id: objectId, props: { expression: "99*x" } });
    assert.ok(!edited.isError, JSON.stringify(edited.content));
    assert.equal(casPlot(edited).editable.expression, "99*x", "the hand edit landed");
    const seen = (await s.call("get_visual_state", { imageId })).structuredContent.objects.find((o) => o.id === objectId);
    assert.equal(seen.provenance.editedByUser, true, "and the object says the person edited it");

    // A definition change makes the cell stale and auto-refresh tries to redraw it: the person's edit is not overwritten.
    const auto = await cas("define", { name: "f", params: ["x"], text: "5*x^2" });
    assert.equal(auto.structuredContent.refresh.updated.length, 0, "the edited plot was not redrawn");
    assert.equal(auto.structuredContent.refresh.failed.length, 1, "and the refresh says so");
    assert.match(auto.structuredContent.refresh.failed[0].reason, /edited by a person/, "with the reason");
    const after = (await s.call("get_visual_state", { imageId })).structuredContent.objects.find((o) => o.id === objectId);
    assert.equal(after.props.expression, "99*x", "the hand edit is still there");
    const book = (await cas("get_notebook", { full: true })).structuredContent.data;
    assert.notEqual(book.cells.find((c) => c.cellId === cellId).links[0].status, "fresh", "the link does not claim to be fresh");
  } finally { await s.close(); }
});
