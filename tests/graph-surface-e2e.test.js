// UVA Phase 4A-4: a Graph document (gph:) has a Visual Surface of its own, so
// the scientific calculator can sit beside it and plot onto it, as beside an image.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noPython, noBrowser } from "./helpers/widget-host.js";

const graphOf = (r) => (JSON.stringify(r.structuredContent).match(/gph:[0-9a-f]{16}/) ?? [])[0];

test("the calculator opens beside a Graph and plots onto it; the Graph's surface is its own", { skip: noPython, timeout: 120000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph", "org.estampes.cas"]);
    const made = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "graph" } });
    const graph = graphOf(made);
    assert.match(graph, /^gph:/);
    const opened = await s.call("manage_surface_panels", { imageId: graph, action: "open", module: "org.estampes.cas", panel: "calculator" });
    assert.equal(opened.structuredContent.surface.imageId ?? opened.structuredContent.imageId, graph, "shown on the Graph, not on a new blank canvas");
    const nb = opened.structuredContent.surface.panels.find((p) => p.kind === "calculator").notebook;
    assert.match(nb, /^nb:/);

    const state = await s.call("get_surface_state", { imageId: graph });
    assert.ok(state.structuredContent.panels.some((p) => p.kind === "calculator" && p.open), "the Graph's surface has the calculator");
    const cas = (capability, params) => s.call("surface_cas", { imageId: graph, capability, params: { notebook: nb, ...params } });
    const calc = await cas("calculate", { operation: "differentiate", text: "x^3", variable: "x" });
    const plotted = await cas("plot_result", { cell: calc.structuredContent.data.cell.cellId, domain: [-2, 2] });
    assert.ok(plotted.structuredContent.objects.some((o) => o.type === "function-plot" && /x\*\*2|x\^2/.test(JSON.stringify(o))), JSON.stringify(plotted.structuredContent.objects).slice(0, 400));
    const back = await s.call("get_visual_state", { imageId: graph });
    assert.ok(JSON.stringify(back.structuredContent).includes("function-plot"), "the plot is on the Graph");

    // A new canvas has its own surface: the Graph's calculator is not there.
    const blank = await s.call("manage_surface_panels", { action: "open", module: "org.estampes.cas", panel: "calculator" });
    const other = blank.structuredContent.surface?.imageId ?? blank.structuredContent.imageId;
    assert.match(other, /^gph:/);
    assert.notEqual(other, graph);
    const otherNb = blank.structuredContent.surface.panels.find((p) => p.kind === "calculator").notebook;
    assert.notEqual(otherNb, nb);
  } finally { await s.close(); }
});

test("in the widget, a Graph shows its own calculator panel next to its vector axes", { skip: noPython || noBrowser, timeout: 120000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph", "org.estampes.cas"]);
    const made = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: { kind: "graph" } });
    const graph = graphOf(made);
    const ui = await s.open({ imageId: graph, result: () => s.call("manage_surface_panels", { imageId: graph, action: "open", module: "org.estampes.cas", panel: "calculator" }) });
    await ui.frame.locator(".calc").waitFor({ timeout: 30000 });
    const inner = ui.page.frames().find((f) => f !== ui.page.mainFrame());
    await inner.waitForFunction(() => document.querySelector('#surface rect[data-base="solid"]'), null, { timeout: 20000 });
    assert.equal(await inner.evaluate(() => document.querySelectorAll("#surface image").length), 0, "no image under the Graph");
    assert.ok(await inner.evaluate(() => document.querySelectorAll('#surface g[data-object]').length) > 0, "its axes and plot are vector objects");
    assert.equal(await ui.frame.locator("#wb-bar", { hasText: "工作台暫時無法使用" }).count(), 0, "no workbench error");
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});
