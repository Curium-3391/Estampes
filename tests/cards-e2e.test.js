// Browser test: fact sheets (info-card objects) are grouped per module, fold open
// and closed, can be hidden by the module or the user, and come back from a list.
// (Fake host, not live ChatGPT; the cards are injected into the widget's data.)
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noBrowser } from "./helpers/widget-host.js";

test("info cards in a browser: per-module groups, fold, hide and bring back", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    await s.enable(["org.estampes.graph"]);
    const made = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: {} });
    const imageId = (JSON.stringify(made.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    const card = (id, module, title, shown) => ({ id, type: "info-card", layer: null, module, primitives: [],
      card: { title, ...(shown === undefined ? {} : { shown }), rows: [{ label: "中心", value: "(1, 2)" }, { label: "連結", value: "開啟", href: "https://example.org/a" }, { label: "壞連結", value: "x", href: "javascript:alert(1)" }] } });
    // The cards are added to the host result by hand (the server does not have them), so the poll must not replace them.
    const ui = await s.open({ imageId, quietPoll: true, result: async () => {
      const r = await s.call("present_visual", { imageId });
      r._meta["estampes/objects"] = [...(r._meta["estampes/objects"] ?? []), card("o901", "org.example.astro", "解算結果"), card("o902", "org.example.astro", "進階資料", false), card("o903", "org.example.ocr", "文字辨識")];
      return r;
    } });
    await ui.frame.locator("details", { hasText: "解算結果" }).first().waitFor({ timeout: 20000 });
    const text = async () => (await ui.frame.locator("body").innerText());
    let t = await text();
    assert.match(t, /org\.example\.astro · 1 張資訊卡/, "one group per module, only shown cards counted");
    assert.match(t, /org\.example\.ocr · 1 張資訊卡/);
    assert.match(t, /已隱藏的資訊卡（1）/, "the card the module hid is listed, not shown");
    assert.ok(!(await ui.frame.locator("details", { hasText: "進階資料" }).first().locator("summary strong").count()), "hidden card has no folded card");

    const first = ui.frame.locator("details", { hasText: "解算結果" }).first();
    assert.equal(await first.evaluate((e) => e.open), false, "cards start folded");
    await first.locator("summary strong").click();
    assert.equal(await first.evaluate((e) => e.open), true, "and unfold");
    const links = first.locator("a");
    assert.equal(await links.count(), 1, "only the https link becomes a link");
    assert.equal(await links.first().getAttribute("rel"), "noopener noreferrer");

    // The user hides a card, then brings both back from the list.
    await first.locator("summary button", { hasText: "隱藏" }).click();
    await ui.frame.getByText("已隱藏的資訊卡（2）").waitFor({ timeout: 10000 });
    await ui.frame.locator("details", { hasText: "已隱藏的資訊卡" }).first().locator("summary").click();
    await ui.frame.getByRole("button", { name: /顯示：「進階資料」/ }).click();
    await ui.frame.getByText("org.example.astro · 1 張資訊卡").waitFor({ timeout: 10000 });
    t = await text();
    assert.match(t, /已隱藏的資訊卡（1）/);
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});
