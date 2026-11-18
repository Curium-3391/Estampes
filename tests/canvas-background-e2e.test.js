// UVA Phase 4A-1 in the widget: a canvas whose base is a solid colour is drawn
// as a vector rect, with no <image> anywhere, and the Graph axes stay vector.
// (Fake host in headless Chromium; real ChatGPT/Claude hosts are unverified.)
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noPython, noBrowser } from "./helpers/widget-host.js";

test("a solid background is a rect, not an image; Graph axes are paths and text", { skip: noPython || noBrowser, timeout: 60000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph"]);
    const r = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: {} });
    const id = (JSON.stringify(r.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    const solid = async () => {
      const res = await s.call("present_visual", { imageId: id });
      const img = res._meta["estampes/image"];
      return { ...res, _meta: { ...res._meta, "estampes/image": { background: { kind: "solid", color: "#123456" }, width: img.width, height: img.height } } };
    };
    const ui = await s.open({ imageId: id, result: solid, quietPoll: true });
    await ui.frame.locator("#surface").first().waitFor({ timeout: 20000 });
    const inner = ui.page.frames().find((f) => f !== ui.page.mainFrame());
    await inner.waitForFunction(() => document.querySelector('#surface rect[data-base="solid"]'), null, { timeout: 20000 });
    const seen = await inner.evaluate(() => {
      const svg = document.querySelector("#surface");
      const base = svg.querySelector('rect[data-base="solid"]');
      const objects = [...svg.querySelectorAll("[data-object]")];
      return {
        fill: base.getAttribute("fill"),
        images: svg.querySelectorAll("image").length,
        objectTags: [...new Set(objects.flatMap((g) => [...g.children].map((c) => c.tagName)))],
        objects: objects.length,
        status: document.querySelector("#status").textContent,
      };
    });
    assert.equal(seen.fill, "#123456");
    assert.equal(seen.images, 0, "no <image> element on the canvas");
    assert.ok(seen.objects >= 2, "axes and plot are drawn");
    for (const tag of seen.objectTags) assert.ok(["path", "text", "circle"].includes(tag), "object drawn as " + tag);
    assert.doesNotMatch(seen.status, /照片資料無法載入|正在重新載入/);
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});

test("a Graph document (gph:) opens in the widget on its colour, with its marks, and is polled as itself", { skip: noPython || noBrowser, timeout: 60000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph"]);
    const r = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: { kind: "graph", color: "#fbf8f1" } });
    const id = (JSON.stringify(r.structuredContent).match(/gph:[0-9a-f]{16}/) ?? [])[0];
    assert.ok(id, "a Graph id");
    const ui = await s.open({ imageId: id });
    await ui.frame.locator("#surface").first().waitFor({ timeout: 20000 });
    const inner = ui.page.frames().find((f) => f !== ui.page.mainFrame());
    await inner.waitForFunction(() => document.querySelector('#surface rect[data-base="solid"]'), null, { timeout: 20000 });
    await s.call("present_visual", { imageId: id, annotations: [{ id: "g1", type: "rect", x: .2, y: .2, x2: .4, y2: .4, label: "g1" }], findings: [{ id: "g1", note: "on a Graph" }] });
    for (let i = 0; i < 40 && !(await inner.evaluate(() => document.querySelectorAll(".finding-row").length)); i++) {
      await inner.evaluate(() => window.estampesSurface?.pollNow?.());
      await new Promise((ok) => setTimeout(ok, 150));
    }
    const seen = await inner.evaluate(() => ({
      fill: document.querySelector('#surface rect[data-base="solid"]').getAttribute("fill"),
      images: document.querySelectorAll("#surface image").length,
      rows: document.querySelectorAll(".finding-row").length,
      ref: JSON.stringify(window.estampesSurface?.viewers()[0]?.documentRef() ?? null),
    }));
    assert.equal(seen.fill, "#fbf8f1");
    assert.equal(seen.images, 0, "no <image> element");
    assert.equal(seen.rows, 1, "the mark reached the widget through its poll");
    assert.match(seen.ref, new RegExp(id.replace(":", ":")), "the viewer is bound to the Graph, not to another canvas");
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});

test("switching the widget from an image to a Graph drops the image's download links", { skip: noPython || noBrowser, timeout: 90000 }, async () => {
  const s = await startStack({ env: { PUBLIC_BASE_URL: "https://estampes.example.test" } });
  try {
    await s.enable(["org.estampes.graph"]);
    const img = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: {} });
    const imageId = (JSON.stringify(img.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    const ui = await s.open({ imageId });
    await ui.frame.locator("#surface").first().waitFor({ timeout: 20000 });
    const inner = ui.page.frames().find((f) => f !== ui.page.mainFrame());
    await inner.waitForFunction(() => !document.querySelector("#export-image").hidden, null, { timeout: 20000 });
    const g = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: { kind: "graph" } });
    const shown = await s.call("present_visual", { imageId: (JSON.stringify(g.structuredContent).match(/gph:[0-9a-f]{16}/) ?? [])[0] });
    await inner.evaluate((r) => window.estampesSurface.viewers()[0].feed(r), { structuredContent: shown.structuredContent, _meta: shown._meta, content: shown.content });
    await inner.waitForFunction(() => document.querySelector('#surface rect[data-base="solid"]'), null, { timeout: 20000 });
    assert.deepEqual(await inner.evaluate(() => [document.querySelector("#export-image").hidden, document.querySelector("#export-marks").hidden]), [true, true],
      "the Graph shows no download buttons that would fetch the previous image");
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});

test("switching from an image with the calculator in front to a Graph shows the Graph's canvas, not a dead workbench", { skip: noPython || noBrowser, timeout: 120000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph", "org.estampes.cas"]);
    const first = await s.call("manage_surface_panels", { action: "open", module: "org.estampes.cas", panel: "calculator" });
    const imageId = first.structuredContent.imageId;
    const ui = await s.open({ imageId, result: () => s.call("manage_surface_panels", { imageId, action: "open", module: "org.estampes.cas", panel: "calculator" }) });
    await ui.frame.locator(".calc").waitFor({ timeout: 30000 });
    const inner = ui.page.frames().find((f) => f !== ui.page.mainFrame());
    const g = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: { kind: "graph" } });
    const shown = await s.call("present_visual", { imageId: (JSON.stringify(g.structuredContent).match(/gph:[0-9a-f]{16}/) ?? [])[0] });
    await inner.evaluate((r) => window.estampesSurface.viewers()[0].feed(r), { structuredContent: shown.structuredContent, _meta: shown._meta, content: shown.content });
    await inner.waitForFunction(() => document.querySelector('#surface rect[data-base="solid"]'), null, { timeout: 20000 });
    await ui.frame.locator("#panel-canvas svg#surface").waitFor({ state: "visible", timeout: 10000 });
    assert.equal(await ui.frame.locator(".calc").count(), 0, "the previous image's calculator is not left in front of the Graph");
    assert.equal(await ui.frame.locator('[data-panel="p:canvas"] .wb-head').isVisible(), false, "no window controls that would act on a surface the Graph does not have");
    assert.equal(await ui.frame.locator("#wb-bar", { hasText: "工作台暫時無法使用" }).count(), 0, "no workbench error for a Graph");
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});
