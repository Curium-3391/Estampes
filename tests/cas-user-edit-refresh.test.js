// UVA Phase 5B-0: pins what a CAS refresh does today to a plot the person has
// edited by hand. OD-05 (approved) says a refresh must pause on a user-edited
// plot; until 5B-2 lands it does not, and this file records that, so that the
// change in 5B-2 is a visible, deliberate flip of the assertions marked GAP.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noPython } from "./helpers/widget-host.js";

test("GAP (OD-05): an automatic refresh overwrites a plot the person edited by hand", { skip: noPython, timeout: 120000 }, async () => {
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

    // A definition change makes the cell stale and auto-refresh redraws it.
    const auto = await cas("define", { name: "f", params: ["x"], text: "5*x^2" });
    assert.equal(auto.structuredContent.refresh.failed.length, 0, "GAP: nothing is reported as paused");
    assert.equal(auto.structuredContent.refresh.updated.length, 1, "GAP: the edited plot was redrawn");
    assert.equal(casPlot(auto).editable.expression, "10*x", "GAP: the hand edit is gone");
    const book = (await cas("get_notebook", { full: true })).structuredContent.data;
    assert.equal(book.cells.find((c) => c.cellId === cellId).links[0].status, "fresh", "GAP: the link says fresh, with no sign of a conflict");
  } finally { await s.close(); }
});
