// UVA 5B-3c: the widget shows a derived object's state and offers the person's
// choices (update, preview, overwrite, stop following), each sent with the hash
// it was shown. Real server, real calculator service, fake host; not a real
// ChatGPT/Claude host.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noPython, noBrowser } from "./helpers/widget-host.js";

const CAS = "org.estampes.cas";
// Longer than the old 300-character cut: the preview must still end with the part that differs.
const LONG = "99*x" + "+x".repeat(90) + "+88";
test("the widget updates a stale plot, and overwrites a hand edit only after a preview", { skip: noPython || noBrowser, timeout: 240000 }, async () => {
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
    const plot = await cas("plot_result", { cell: calc.structuredContent.data.cell.cellId, domain: [-3, 3] });
    const objectId = plot.structuredContent.objects.find((o) => o.type === "function-plot" && o.module === CAS).id;
    const expr = async () => (await s.call("get_visual_state", { imageId })).structuredContent.objects.find((o) => o.id === objectId).props.expression;
    const state = async () => (await s.call("get_derived_bindings", { canvas: imageId })).structuredContent.bindings[0].state;

    const ui = await s.open({ imageId });
    await ui.page.waitForFunction(() => window.hostLog.includes("ui/notifications/initialized"));
    const block = ui.frame.locator("#objects [data-derived]");
    await block.waitFor();
    assert.equal(await block.getAttribute("data-state"), "fresh");

    // Someone is typing in the plot's editor when the source changes: the page keeps the typing.
    const typing = ui.frame.locator("#objects .obj[data-object] input.expr").first();
    await typing.fill("77*x");
    await cas("define", { name: "f", params: ["x"], text: "4*x^2" });
    await ui.page.waitForTimeout(6500);
    assert.equal(await typing.inputValue(), "77*x", "an unapplied edit survives the background refresh");
    await ui.reload();
    // The cell changes: the page shows it, and "更新" redraws the plot.
    await cas("define", { name: "f", params: ["x"], text: "5*x^2" });
    // The page is not reloaded: it reads the bindings again by itself.
    await ui.frame.locator('#objects [data-derived][data-state="stale"]').waitFor();
    // A preview of a stale object offers no overwrite (that is for a conflict); the normal update stays.
    await ui.frame.locator("#objects [data-derived] button", { hasText: "預覽變更" }).click();
    await ui.frame.locator("#objects [data-derived] code").first().waitFor();
    assert.equal(await ui.frame.locator("#objects [data-derived] button", { hasText: "覆蓋" }).count(), 0);
    await ui.frame.locator("#objects [data-derived] button", { hasText: "更新" }).click();
    await ui.frame.locator('#objects [data-derived][data-state="fresh"]').waitFor();
    assert.equal(await expr(), "10*x");

    // A hand edit, then the source changes again: conflict, with no overwrite button until a preview.
    await s.call("edit_scene_object", { imageId, id: objectId, props: { expression: LONG, labelMode: "custom", label: "y".repeat(70) + "END" } });
    await cas("define", { name: "f", params: ["x"], text: "3*x^2" });
    await s.call("update_derived", { canvas: imageId, action: "refresh-stale" });
    assert.equal(await state(), "conflict");
    await ui.frame.locator('#objects [data-derived][data-state="conflict"]').waitFor();
    assert.equal(await ui.frame.locator("#objects [data-derived] button", { hasText: "覆蓋" }).count(), 0, "no overwrite before a preview");
    await ui.frame.locator("#objects [data-derived] button", { hasText: "預覽變更" }).click();
    const overwrite = ui.frame.locator("#objects [data-derived] button", { hasText: "覆蓋" });
    await overwrite.waitFor();
    assert.match(await ui.frame.locator("#objects [data-derived] code").first().innerText(), /END/, "it shows the object as it is, to the end of its properties (more than 300 characters)");
    assert.equal(await expr(), LONG, "the preview changed nothing");
    await overwrite.click();
    await ui.frame.locator('#objects [data-derived][data-state="fresh"]').waitFor();
    assert.equal(await expr(), "6*x");

    // Stop following: the object stays, the block goes away.
    await ui.frame.locator("#objects [data-derived] button", { hasText: "停止連動" }).click();
    await ui.frame.locator("#objects [data-derived]").waitFor({ state: "detached" });
    assert.equal(await expr(), "6*x");
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});
