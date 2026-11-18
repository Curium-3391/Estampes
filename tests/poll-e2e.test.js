// Browser test: the widget polls documents_get_changes and shows what another
// author changed, without touching the user's own unsent marks or camera.
// (Fake host, not live ChatGPT or Claude.)
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noPython, noBrowser } from "./helpers/widget-host.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const plot = async (s, expression) => {
  const r = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression }, newCanvas: { kind: "image" } });
  return (JSON.stringify(r.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
};

test("polling shows another author's change; unsent marks and the camera stay", { skip: noPython || noBrowser, timeout: 60000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph"]);
    const id = await plot(s, "x^2");
    const ui = await s.open({ imageId: id });
    await ui.frame.locator("#surface").first().waitFor({ timeout: 20000 });
    const inner = ui.page.frames().find((f) => f !== ui.page.mainFrame());

    // The first poll binds the document; wait for it to be known.
    const rev = () => inner.evaluate((i) => window.estampesSurface.documents.get(i)?.revision, id);
    await inner.waitForFunction(() => window.estampesSurface.viewers()[0].documentRef(), null, { timeout: 20000 });
    await inner.evaluate(() => window.estampesSurface.pollNow());
    const first = await rev();
    assert.ok(first, "the widget polled the document");
    const rows = () => inner.evaluate(() => document.querySelectorAll(".finding-row").length);
    assert.equal(await rows(), 0);

    // The user zooms: the camera must survive a poll.
    await inner.evaluate(() => document.querySelector("#zoom-in").click());
    await wait(300);
    const view = await inner.evaluate(() => document.querySelector("#surface").getAttribute("viewBox"));

    // Another author (the model, through the server) adds a mark with a note.
    const r = await s.call("present_visual", { imageId: id, annotations: [{ id: "ai-1", type: "rect", x: 0.2, y: 0.2, x2: 0.4, y2: 0.4, label: "A" }], findings: [{ id: "ai-1", note: "check this", status: "inspected" }] });
    assert.notEqual(r.isError, true, JSON.stringify(r.content));
    await inner.evaluate(() => window.estampesSurface.pollNow());
    const second = await rev();
    assert.ok(second.counter > first.counter, "a newer revision arrived");
    assert.equal(await rows(), 1, "the other author's mark shows up without a reload");
    assert.equal(await inner.evaluate(() => document.querySelector("#surface").getAttribute("viewBox")), view, "the camera did not move");

    // Nothing changed: the next poll keeps the revision.
    await inner.evaluate(() => window.estampesSurface.pollNow());
    assert.deepEqual(await rev(), second);

    // The scheduler runs on its own (about every 2 s).
    await s.call("present_visual", { imageId: id, annotations: [{ id: "ai-2", type: "rect", x: 0.5, y: 0.5, x2: 0.6, y2: 0.6, label: "B" }], findings: [{ id: "ai-2", note: "and this" }] });
    await wait(5000);
    assert.equal(await rows(), 2, "the poll timer picked up the second change");
  } finally { await s.close(); }
});
