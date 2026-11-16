// Browser runtime cases for the polling widget (UVA Phase 3, 3B-2): offline, redelivery of the
// same result, two viewers on one document, and what an unchanged poll costs.
// (Fake host, not live ChatGPT or Claude.)
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noPython, noBrowser } from "./helpers/widget-host.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const plot = async (s, expression) => {
  const r = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression }, newCanvas: {} });
  return (JSON.stringify(r.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
};
const mark = (id, x) => ({ imageId: undefined, annotations: [{ id, type: "rect", x, y: 0.2, x2: x + 0.1, y2: 0.4, label: id }], findings: [{ id, note: "n " + id }] });
async function openPolled(s, expression = "x^2") {
  await s.enable(["org.estampes.graph"]);
  const id = await plot(s, expression);
  const ui = await s.open({ imageId: id });
  await ui.frame.locator("#surface").first().waitFor({ timeout: 20000 });
  const inner = ui.page.frames().find((f) => f !== ui.page.mainFrame());
  await inner.waitForFunction(() => window.estampesSurface.viewers()[0].documentRef(), null, { timeout: 20000 });
  await inner.evaluate(() => window.estampesSurface.pollNow());
  return { id, ui, inner, rows: () => inner.evaluate(() => document.querySelectorAll(".finding-row").length) };
}

test("offline keeps the last snapshot, says so, and recovers on its own", { skip: noPython || noBrowser, timeout: 60000 }, async () => {
  const s = await startStack();
  try {
    const { id, ui, inner, rows } = await openPolled(s);
    await s.call("present_visual", { ...mark("ai-1", 0.2), imageId: id });
    await inner.evaluate(() => window.estampesSurface.pollNow());
    assert.equal(await rows(), 1);

    ui.net.offline = true;
    await s.call("present_visual", { ...mark("ai-2", 0.5), imageId: id });
    await inner.evaluate(() => window.estampesSurface.pollNow());
    assert.equal(await rows(), 1, "the last snapshot stays on screen");
    assert.equal(await inner.evaluate(() => document.querySelector("#surface").closest("[data-offline]") !== null || document.querySelector("[data-offline]") !== null), true, "the viewer is marked offline");
    const visible = () => inner.evaluate(() => { const n = document.querySelector("#offline-note"); return !!n && !n.hidden && /連不上伺服器/.test(n.textContent); });
    assert.equal(await visible(), true, "a visible offline note");
    // Normal canvas use rewrites the status line; the offline note must stay.
    await inner.evaluate(() => { document.querySelector("#status").textContent = "選取了 ai-1"; });
    await inner.evaluate(() => window.estampesSurface.pollNow());
    assert.equal(await visible(), true, "the note survives status messages");

    ui.net.offline = false;
    await inner.evaluate(() => window.estampesSurface.pollNow());
    assert.equal(await rows(), 2, "back online, the missed change arrives");
    assert.equal(await visible(), false, "the note goes away once back online");
  } finally { await s.close(); }
});

test("two viewers on one document share one poll and both see the change", { skip: noPython || noBrowser, timeout: 60000 }, async () => {
  const s = await startStack();
  try {
    const { id, ui, inner } = await openPolled(s);
    const res = await s.call("present_visual", { imageId: id });
    await inner.evaluate((r) => { window.__extra = window.estampesSurface.mountViewer(document.querySelector("#wb-area")); window.__extra.feed(r); }, res);
    await inner.waitForFunction(() => window.__extra.documentRef(), null, { timeout: 20000 });
    await inner.evaluate(() => window.estampesSurface.pollNow());
    const count = () => inner.evaluate(() => [window.estampesSurface.viewers()[0], window.__extra].map((v) => v.scope.querySelectorAll(".finding-row").length));
    assert.deepEqual(await count(), [0, 0]);
    await s.call("present_visual", { ...mark("ai-1", 0.2), imageId: id });
    const before = ui.net.polls;
    await inner.evaluate(() => window.estampesSurface.pollNow());
    assert.equal(ui.net.polls - before, 1, "one request serves both viewers");
    assert.deepEqual(await count(), [1, 1]);
  } finally { await s.close(); }
});

test("the same result delivered again keeps the camera and does not duplicate marks; an unchanged poll is small", { skip: noPython || noBrowser, timeout: 60000 }, async () => {
  const s = await startStack();
  try {
    const { id, ui, inner, rows } = await openPolled(s);
    const r = await s.call("present_visual", { ...mark("ai-1", 0.2), imageId: id });
    await inner.evaluate(() => window.estampesSurface.pollNow());
    await inner.evaluate(() => document.querySelector("#zoom-in").click());
    await wait(300);
    const view = await inner.evaluate(() => document.querySelector("#surface").getAttribute("viewBox"));
    for (let i = 0; i < 2; i++) await inner.evaluate((x) => window.estampesSurface.viewers()[0].feed(x), { structuredContent: r.structuredContent, _meta: r._meta, content: r.content });
    await wait(300);
    assert.equal(await rows(), 1, "no duplicate marks");
    assert.equal(await inner.evaluate(() => document.querySelector("#surface").getAttribute("viewBox")), view, "the camera did not move");

    // What an unchanged poll costs (measured, printed; the bound only catches a regression to full snapshots).
    await inner.evaluate(() => window.estampesSurface.pollNow());
    await inner.evaluate(() => window.estampesSurface.pollNow());
    console.log(`# unchanged poll response: ${ui.net.last} characters`);
    assert.ok(ui.net.last < 1500, `an unchanged poll must not carry the snapshot (${ui.net.last} characters)`);
  } finally { await s.close(); }
});
