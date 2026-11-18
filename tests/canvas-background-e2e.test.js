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
