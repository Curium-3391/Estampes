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

    // No canvas given: a blank canvas is made (kept behind the calculator, which fills the workbench).
    const opened = await s.call("manage_surface_panels", { action: "open", module: "org.estampes.cas", panel: "calculator", notebook });
    assert.ok(!opened.isError, JSON.stringify(opened.content));
    assert.equal(opened.structuredContent.kind, "estampes.visual_surface");
    assert.match(opened.structuredContent.imageId, /^img:[0-9a-f]{16}$/);
    assert.ok(opened._meta["estampes/image"], "pixels travel to the widget");
    const panel = opened.structuredContent.surface.panels.find((p) => p.kind === "calculator");
    assert.equal(panel.notebook, notebook, "the panel shows the notebook the model made");
    const st = (await s.call("surface_get_state", { imageId: opened.structuredContent.imageId })).structuredContent;
    assert.equal(st.layouts.desktop.placements[panel.panelId].mode, "maximized", "the calculator is what the user sees");

    // An existing canvas (a photo, an earlier plot) keeps its own id.
    const plotted = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: {} });
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
    const plotted = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: {} });
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
