// Browser test: several viewers in one widget. The page viewer sits in the
// light DOM; extra viewers mount in shadow roots. Each has its own camera,
// tool, selection and keyboard, and dispose() leaves nothing behind.
// (Fake host, not live ChatGPT or Claude.)
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noPython, noBrowser } from "./helpers/widget-host.js";

const plot = async (s, expression) => {
  const r = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression }, newCanvas: {} });
  return (JSON.stringify(r.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
};
const asResult = (r) => ({ structuredContent: r.structuredContent, _meta: r._meta, content: r.content });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(s) {
  await s.enable(["org.estampes.graph"]);
  const a = await plot(s, "x^2"), b = await plot(s, "sin(x)");
  const ui = await s.open({ imageId: a });
  await ui.frame.locator("#surface").first().waitFor({ timeout: 20000 });
  const inner = ui.page.frames().find((f) => f !== ui.page.mainFrame());
  const second = async (imageId) => {
    const res = asResult(await s.call("present_visual", { imageId }));
    await inner.evaluate((r) => { window.__extra = window.estampesSurface.mountViewer(document.querySelector("#wb-area")); window.__extra.feed(r); }, res);
  };
  const vb = (which) => inner.evaluate((w) => (w === "primary" ? document : window.__extra.scope).querySelector("#surface").getAttribute("viewBox"), which);
  const pressed = (which) => inner.evaluate((w) => [...(w === "primary" ? document : window.__extra.scope).querySelectorAll("[data-mode]")].find((x) => x.getAttribute("aria-pressed") === "true")?.dataset.mode, which);
  return { a, b, ui, inner, second, vb, pressed, host: ui.frame.locator("[data-viewer-host]") };
}

test("two viewers: independent zoom, tool and keyboard; dispose leaves nothing behind", { skip: noPython || noBrowser, timeout: 150000 }, async () => {
  const s = await startStack();
  try {
    const t = await setup(s);
    await t.second(t.b);
    await t.host.locator("#surface").waitFor({ timeout: 20000 });
    await wait(1500);
    assert.equal(await t.inner.evaluate(() => window.estampesSurface.viewers().length), 2);
    const width = async (w) => +(await t.vb(w)).split(" ")[2];

    // Zoom the extra viewer only.
    const primaryBefore = await t.vb("primary"), extraBefore = await width("extra");
    await t.host.locator("#zoom-in").click();
    await wait(400);
    assert.equal(await t.vb("primary"), primaryBefore, "the page viewer did not move");
    assert.ok((await width("extra")) < extraBefore, "the extra viewer zoomed in");
    // Zoom the page viewer: the extra camera stays.
    const extraZoomed = await t.vb("extra");
    await t.inner.evaluate(() => document.querySelector("#zoom-in").click());
    await wait(400);
    assert.notEqual(await t.vb("primary"), primaryBefore, "the page viewer zoomed");
    assert.equal(await t.vb("extra"), extraZoomed, "the extra camera is unchanged");

    // Tool choice is per viewer.
    await t.host.locator('[data-mode="rect"]').click();
    assert.equal(await t.pressed("extra"), "rect");
    assert.equal(await t.pressed("primary"), "point");

    // Keyboard: Space is claimed (preventDefault) only by the viewer it was typed in.
    // The page viewer is zoomed, the extra one is not (reset it first).
    await t.host.locator("#zoom-fit").click();
    await wait(300);
    const claimed = (where) => t.inner.evaluate((w) => {
      const target = (w === "primary" ? document : window.__extra.scope).querySelector("#surface");
      const e = new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, composed: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    }, where);
    assert.equal(await claimed("extra"), false, "a key typed in the extra viewer does not reach the zoomed page viewer");
    assert.equal(await claimed("primary"), true, "the page viewer handles its own key");

    // dispose(): its DOM is gone, it is no longer registered, late callbacks do nothing.
    await t.inner.evaluate(() => window.__extra.dispose());
    assert.equal(await t.inner.evaluate(() => window.estampesSurface.viewers().length), 1);
    assert.equal(await t.host.count(), 0, "its DOM is removed");
    assert.equal(await t.inner.evaluate(() => window.__extra.disposed), true);
    await wait(500);
    assert.deepEqual(t.ui.errors, []);
  } finally { await s.close(); }
});

test("the same image in two viewers: separate cameras, close and reopen", { skip: noPython || noBrowser, timeout: 150000 }, async () => {
  const s = await startStack();
  try {
    const t = await setup(s);
    await t.second(t.a);
    await t.host.locator("#surface").waitFor({ timeout: 20000 });
    await wait(1500);
    const fitted = await t.vb("extra");
    await t.host.locator("#zoom-in").click();
    await wait(400);
    assert.notEqual(await t.vb("extra"), fitted);
    assert.equal(await t.vb("primary"), fitted, "the page viewer shows the same image at its own fitted camera");
    await t.inner.evaluate(() => window.__extra.dispose());
    assert.equal(await t.host.count(), 0);
    await t.second(t.a);
    await t.host.locator("#surface").waitFor({ timeout: 20000 });
    await wait(1000);
    assert.equal(await t.inner.evaluate(() => window.estampesSurface.viewers().length), 2);
    assert.equal(await t.vb("extra"), fitted, "a reopened viewer starts fitted again");
    assert.deepEqual(t.ui.errors, []);
  } finally { await s.close(); }
});

test("a resize cancels a stroke in progress; a disposed viewer ignores late work", { skip: noPython || noBrowser, timeout: 150000 }, async () => {
  const s = await startStack();
  try {
    const t = await setup(s);
    await t.second(t.b);
    await t.host.locator("#surface").waitFor({ timeout: 20000 });
    await wait(1500);
    await t.host.locator('[data-mode="rect"]').click();
    const hit = t.host.locator("#hit");
    const box = await hit.boundingBox();
    await t.ui.page.mouse.move(box.x + 50, box.y + 50);
    await t.ui.page.mouse.down();
    await t.ui.page.mouse.move(box.x + 150, box.y + 120, { steps: 4 });
    const drawing = () => t.inner.evaluate(() => window.__extra.scope.querySelector("#preview").childElementCount);
    assert.ok((await drawing()) > 0, "a rectangle preview is being drawn");
    await t.inner.evaluate(() => { window.__extra.holder.style.width = "420px"; });
    await wait(500);
    assert.equal(await drawing(), 0, "the resize ended the gesture");
    await t.ui.page.mouse.up();
    // Dispose with a draw timer pending: nothing runs afterwards and nothing throws.
    await t.inner.evaluate(() => window.__extra.dispose());
    await wait(500);
    assert.deepEqual(t.ui.errors, []);
  } finally { await s.close(); }
});

test("an extra viewer on an upload canvas shows the upload prompt, not the demo canvas", { skip: noPython || noBrowser, timeout: 150000 }, async () => {
  const s = await startStack();
  try {
    const t = await setup(s);
    const res = asResult(await s.call("present_visual", { upload: true }));
    await t.inner.evaluate((r) => { window.__extra = window.estampesSurface.mountViewer(document.querySelector("#wb-area")); window.__extra.feed(r); }, res);
    const empty = t.host.locator("#upload-empty");
    await empty.waitFor({ state: "visible", timeout: 20000 });
    assert.equal(await t.host.locator("#surface").isVisible(), false, "no demo picture behind an upload canvas");
    assert.deepEqual(t.ui.errors, []);
  } finally { await s.close(); }
});

test("using an extra viewer's canvas gives it keyboard focus, so keys do not go to the page viewer", { skip: noPython || noBrowser, timeout: 150000 }, async () => {
  const s = await startStack();
  try {
    const t = await setup(s);
    await t.second(t.b);
    await t.host.locator("#surface").waitFor({ timeout: 20000 });
    await wait(1500);
    await t.inner.evaluate(() => {
      window.__keyOwners = [];
      document.addEventListener("keydown", (e) => window.__keyOwners.push(e.composedPath().some((n) => n?.hasAttribute?.("data-viewer-host")) ? "extra" : "page"), true);
    });
    const hit = t.host.locator("#hit");
    const box = await hit.boundingBox();
    await t.ui.page.mouse.click(box.x + 40, box.y + 40);
    await t.ui.page.keyboard.press("Shift");
    assert.equal(await t.inner.evaluate(() => window.__keyOwners.at(-1)), "extra", "the key was typed inside the extra viewer");
    // And clicking the page viewer's canvas moves focus back.
    const pbox = await t.inner.evaluate(() => { const r = document.querySelector("#hit").getBoundingClientRect(); return { x: r.x, y: r.y }; });
    await t.ui.frame.locator("#panel-canvas #hit").first().click({ position: { x: 40, y: 40 } });
    await t.ui.page.keyboard.press("Shift");
    assert.equal(await t.inner.evaluate(() => window.__keyOwners.at(-1)), "page", "back in the page viewer");
    assert.deepEqual(t.ui.errors, []);
  } finally { await s.close(); }
});
