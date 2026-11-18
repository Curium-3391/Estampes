// Browser runtime cases for the polling widget (UVA Phase 3, 3B-2): offline, redelivery of the
// same result, two viewers on one document, and what an unchanged poll costs.
// (Fake host, not live ChatGPT or Claude.)
import test from "node:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startStack, noPython, noBrowser } from "./helpers/widget-host.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const plot = async (s, expression) => {
  const r = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression }, newCanvas: { kind: "image" } });
  return (JSON.stringify(r.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
};
const mark = (id, x) => ({ imageId: undefined, annotations: [{ id, type: "rect", x, y: 0.2, x2: x + 0.1, y2: 0.4, label: id }], findings: [{ id, note: "n " + id }] });
const until = async (inner, fn, arg, what) => {
  for (let i = 0; i < 40; i++) {
    await inner.evaluate(() => window.estampesSurface.pollNow());
    if (await inner.evaluate(fn, arg)) return;
    await wait(150);
  }
  assert.fail("timed out waiting for " + what);
};
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
    await until(inner, () => document.querySelectorAll(".finding-row").length === 1, null, "the first mark");

    ui.net.offline = true;
    await s.call("present_visual", { ...mark("ai-2", 0.5), imageId: id });
    await until(inner, () => { const n = document.querySelector("#offline-note"); return !!n && !n.hidden; }, null, "the offline note");
    assert.equal(await rows(), 1, "the last snapshot stays on screen");
    assert.equal(await inner.evaluate(() => document.querySelector("#surface").closest("[data-offline]") !== null || document.querySelector("[data-offline]") !== null), true, "the viewer is marked offline");
    const visible = () => inner.evaluate(() => { const n = document.querySelector("#offline-note"); return !!n && !n.hidden && /連不上伺服器/.test(n.textContent); });
    assert.equal(await visible(), true, "a visible offline note");
    // Normal canvas use rewrites the status line; the offline note must stay.
    await inner.evaluate(() => { document.querySelector("#status").textContent = "選取了 ai-1"; });
    await inner.evaluate(() => window.estampesSurface.pollNow());
    assert.equal(await visible(), true, "the note survives status messages");

    ui.net.offline = false;
    await until(inner, () => document.querySelectorAll(".finding-row").length === 2, null, "the missed change after recovery");
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
    await until(inner, () => [window.estampesSurface.viewers()[0], window.__extra].every((v) => v.scope.querySelectorAll(".finding-row").length === 1), null, "both viewers to show the change");
    assert.deepEqual(await count(), [1, 1]);
    // One poll round is one request however many viewers share the document (the timer may add or skip a round).
    await wait(100);
    const before = ui.net.polls;
    await inner.evaluate(() => window.estampesSurface.pollNow());
    assert.ok(ui.net.polls - before <= 1, "one request serves both viewers");
  } finally { await s.close(); }
});

test("the same result delivered again keeps the camera and does not duplicate marks; an unchanged poll is small", { skip: noPython || noBrowser, timeout: 60000 }, async () => {
  const s = await startStack();
  try {
    const { id, ui, inner, rows } = await openPolled(s);
    const r = await s.call("present_visual", { ...mark("ai-1", 0.2), imageId: id });
    await until(inner, () => document.querySelectorAll(".finding-row").length === 1, null, "the mark");
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

test("a lost answer to a layer edit: the widget asks by command id and sends the same id again; the server applies it once", { skip: noPython || noBrowser, timeout: 60000 }, async () => {
  const s = await startStack();
  try {
    const { id, ui, inner } = await openPolled(s);
    await s.call("present_visual", { ...mark("ai-1", 0.2), imageId: id });
    await until(inner, () => !!document.querySelector('button[data-act="lock"]'), null, "the layer controls");
    ui.net.dropReplyOnce = "edit_visual_canvas";
    await inner.evaluate(() => document.querySelector('button[data-act="lock"]').click());
    await wait(500);
    assert.equal(ui.net.sent.length, 2, "sent twice");
    assert.ok(ui.net.sent[0] && ui.net.sent[0] === ui.net.sent[1], "with the same command id");
    const status = (await s.call("commands_get_status", { documentId: id, commandIds: [ui.net.sent[0]] })).structuredContent.commands[0];
    assert.equal(status.status, "applied");
    const history = (await s.call("get_visual_state", { imageId: id, history: 50 })).structuredContent.history ?? [];
    assert.equal(history.filter((l) => l.commandId === ui.net.sent[0]).length, 1, "one change-log line for the command");
    const layers = (await s.call("get_visual_layers", { imageId: id })).structuredContent;
    assert.equal(JSON.stringify(layers).includes('"locked":true'), true, "the layer is locked");
  } finally { await s.close(); }
});

test("edits are sent one at a time: a newer edit waits while an older one is being retried", { skip: noPython || noBrowser, timeout: 60000 }, async () => {
  const s = await startStack();
  try {
    const { id, ui, inner } = await openPolled(s);
    await s.call("present_visual", { ...mark("ai-1", 0.2), imageId: id });
    await until(inner, () => !!document.querySelector('button[data-act="lock"]'), null, "the layer controls");
    // The first edit loses its answer; a second edit is started before its retry has finished.
    ui.net.dropReplyOnce = "edit_visual_canvas";
    await inner.evaluate(() => {
      const first = document.querySelector('button[data-act="lock"]');
      first.click();
      const hide = document.querySelector('button[data-act="hide"], button[data-act="vis"]');
      (hide ?? first).click();
    });
    await wait(1500);
    const ids = ui.net.sent;
    assert.ok(ids.length >= 3, "first sent twice, then the second one: " + JSON.stringify(ids));
    assert.equal(ids[0], ids[1], "the retry reuses the id");
    assert.notEqual(ids[2], ids[0], "the next edit comes after, with its own id");
  } finally { await s.close(); }
});

test("recreating the widget from an old tool result restores the newer canvas from the server and creates nothing", { skip: noPython || noBrowser, timeout: 60000 }, async () => {
  const s = await startStack();
  try {
    await s.enable(["org.estampes.graph"]);
    const id = await plot(s, "x^2");
    // The result the host delivered when the widget was first built (before any mark existed).
    const first = await s.call("present_visual", { imageId: id });
    const ui = await s.open({ imageId: id, result: async () => first });
    await ui.frame.locator("#surface").first().waitFor({ timeout: 20000 });
    let inner = ui.page.frames().find((f) => f !== ui.page.mainFrame());
    await inner.waitForFunction(() => window.estampesSurface.viewers()[0].documentRef(), null, { timeout: 20000 });
    await s.call("present_visual", { ...mark("ai-1", 0.2), imageId: id });
    await inner.evaluate(() => window.estampesSurface.pollNow());
    await until(inner, () => document.querySelectorAll(".finding-row").length === 1, null, "the first mark");
    const logLines = async () => ((await s.call("get_visual_state", { imageId: id, history: 100 })).structuredContent.history ?? []).length;
    // Every directory in the storage root (images, canvases, documents): recreation must not add one.
    const docs = async () => JSON.stringify((await readdir(s.dir, { recursive: true, withFileTypes: true })).filter((e) => e.isDirectory() && !/uva-pending|\.tmp/.test(join(e.parentPath ?? e.path, e.name))).map((e) => join(e.parentPath ?? e.path, e.name).slice(s.dir.length)).sort());
    const before = await logLines(), docsBefore = await docs();
    assert.ok(before > 0 && JSON.parse(docsBefore).length > 0, "the checks read something");

    // The host throws the widget away and builds a new one from the same OLD tool result.
    await ui.reload();
    await ui.frame.locator("#surface").first().waitFor({ timeout: 20000 });
    inner = ui.page.frames().find((f) => f !== ui.page.mainFrame());
    await inner.waitForFunction(() => window.estampesSurface?.viewers()[0]?.documentRef(), null, { timeout: 20000 });
    await inner.evaluate(() => window.estampesSurface.pollNow());
    await until(inner, () => document.querySelectorAll(".finding-row").length === 1, null, "the newer mark after recreation");

    assert.equal(await logLines(), before, "recreating the widget wrote nothing to the canvas history");
    assert.equal(await docs(), docsBefore, "and created no document");
    assert.deepEqual(ui.net.sent, [], "and sent no edit");
  } finally { await s.close(); }
});
