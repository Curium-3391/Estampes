// The model can open the calculator on the user's screen: beside the canvas
// they are looking at, or on a blank canvas, with the calculation it already
// made. The browser part opens the widget from exactly that tool result.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noPython, noBrowser } from "./helpers/widget-host.js";

test("manage_surface_panels shows the calculator, with or without a canvas, and attaches the model's notebook", { skip: noPython, timeout: 120000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph", "org.estampes.cas"]);
    const calc = await s.call("execute_module", { module: "org.estampes.cas", capability: "calculate", params: { operation: "differentiate", text: "sin(x^2)", variable: "x" } });
    assert.match(calc.content[0].text, /manage_surface_panels/, "the model is told how to show it");
    const notebook = calc.structuredContent.data.notebookId;
    assert.match(notebook, /^nb:[0-9a-f]{12}$/);

    // No canvas given: a new canvas is made, a Graph by default (kept behind the calculator, which fills the workbench).
    const opened = await s.call("manage_surface_panels", { action: "open", module: "org.estampes.cas", panel: "calculator", notebook });
    assert.ok(!opened.isError, JSON.stringify(opened.content));
    assert.equal(opened.structuredContent.kind, "estampes.visual_surface");
    assert.match(opened.structuredContent.imageId, /^gph:[0-9a-f]{16}$/);
    assert.equal(opened._meta["estampes/image"].background?.kind, "solid", "a Graph sends its colour, not pixels");
    const panel = opened.structuredContent.surface.panels.find((p) => p.kind === "calculator");
    assert.equal(panel.notebook, notebook, "the panel shows the notebook the model made");
    const st = (await s.call("surface_get_state", { imageId: opened.structuredContent.imageId })).structuredContent;
    assert.equal(st.layouts.desktop.placements[panel.panelId].mode, "maximized", "the calculator is what the user sees");

    // An existing canvas (a photo, an earlier plot) keeps its own id.
    const plotted = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "image" } });
    const imageId = (JSON.stringify(plotted.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    const beside = await s.call("manage_surface_panels", { imageId, action: "open", module: "org.estampes.cas", panel: "calculator" });
    assert.equal(beside.structuredContent.imageId, imageId);
    const bad = await s.call("manage_surface_panels", { imageId, action: "open", module: "org.estampes.cas", panel: "calculator", notebook: "nb:000000000000" });
    assert.equal(bad.isError, true, "an unknown notebook is refused");
  } finally { await s.close(); }
});

test("browser: the widget opened by manage_surface_panels shows the calculator with the model's cell", { skip: noPython || noBrowser, timeout: 120000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph", "org.estampes.cas"]);
    const plotted = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: { kind: "image" } });
    const imageId = (JSON.stringify(plotted.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    const calc = await s.call("execute_module", { module: "org.estampes.cas", capability: "calculate", params: { operation: "differentiate", text: "sin(x^2)", variable: "x" } });
    const notebook = calc.structuredContent.data.notebookId;
    const ui = await s.open({ imageId, result: () => s.call("manage_surface_panels", { imageId, action: "open", module: "org.estampes.cas", panel: "calculator", notebook }) });
    await ui.frame.locator(".calc").waitFor({ timeout: 30000 });
    await ui.frame.locator(".cell-plain", { hasText: "2*x*cos(x^2)" }).first().waitFor({ timeout: 15000 }).catch(async (e) => { await ui.shot("open-calculator-failure"); throw e; });
    assert.equal(await ui.frame.locator("#panel-canvas svg#surface").isVisible(), true, "the canvas is beside it");
    await ui.shot("open-calculator");
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});

test("browser: with the calculator alone, the launcher offers the Graph canvas and brings it back", { skip: noPython || noBrowser, timeout: 120000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph", "org.estampes.cas"]);
    const first = await s.call("manage_surface_panels", { action: "open", module: "org.estampes.cas", panel: "calculator" });
    const imageId = first.structuredContent.imageId;
    const twice = await s.call("manage_surface_panels", { imageId, action: "open", module: "org.estampes.cas", panel: "calculator" });
    assert.equal(twice.structuredContent.surface.panels.filter((p) => p.kind === "calculator").length, 1, "asking again does not open another window");
    const ui = await s.open({ imageId, result: () => s.call("manage_surface_panels", { imageId, action: "open", module: "org.estampes.cas", panel: "calculator" }) });
    await ui.frame.locator(".calc").waitFor({ timeout: 30000 });
    const button = ui.frame.locator(".wb-open", { hasText: "函數圖／畫布" });
    await button.waitFor({ timeout: 10000 });
    await button.click();
    await ui.frame.locator("#panel-canvas svg#surface").waitFor({ state: "visible", timeout: 10000 });
    assert.equal(await ui.frame.locator(".calc").isVisible(), true, "both are on screen");
    // The launcher re-renders after the canvas panel is shown, so wait for it.
    await ui.frame.locator(".wb-open", { hasText: "函數圖／畫布" }).waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
    assert.equal(await ui.frame.locator(".wb-open", { hasText: "函數圖／畫布" }).count(), 0, "the button goes away once the canvas is back");
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});

test("opening the Graph panel shows the Graph canvas on its own, with no empty window and no image canvas needed", { skip: noPython, timeout: 120000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph", "org.estampes.cas"]);
    // Only a Graph document exists (no image canvas): Graph is offered and opens.
    const made = await s.call("manage_surface_panels", { action: "open", module: "org.estampes.cas", panel: "calculator" });
    const graph = made.structuredContent.imageId;
    assert.match(graph, /^gph:[0-9a-f]{16}$/);
    const before = (await s.call("surface_get_state", { imageId: graph })).structuredContent;
    assert.ok(before.available.some((a) => a.kind === "graph" && a.module === "org.estampes.graph"), "Graph is listed in the surface's panels");
    assert.equal(before.layouts.desktop.placements[before.panels.find((p) => p.kind === "calculator").panelId].mode, "maximized");

    const opened = await s.call("manage_surface_panels", { imageId: graph, action: "open", module: "org.estampes.graph", panel: "graph" });
    assert.ok(!opened.isError, JSON.stringify(opened.content));
    const st = (await s.call("surface_get_state", { imageId: graph })).structuredContent;
    assert.deepEqual(st.panels.filter((p) => p.kind === "graph"), [], "Graph is the canvas panel's view, not an empty window of its own");
    for (const profile of ["desktop", "tablet", "mobile"]) {
      assert.notEqual(st.layouts[profile].placements["p:canvas"].mode, "minimized");
      assert.ok(!Object.values(st.layouts[profile].placements).some((p) => p.mode === "maximized"), "nothing stays maximized over the canvas");
    }
    assert.equal(st.layouts.mobile.active, "p:canvas");
  } finally { await s.close(); }
});
