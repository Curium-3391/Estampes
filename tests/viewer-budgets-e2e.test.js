// UVA Phase 3C: request, size and cleanup budgets for 1, 2 and 5 viewers on one document.
// Budgets that fail the test are deterministic counts. Timings are only printed, because
// they depend on the machine. Fake host in headless Chromium; real ChatGPT/Claude hosts are unverified.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noPython, noBrowser } from "./helpers/widget-host.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 2000;

async function openDoc(s) {
  await s.enable(["org.estampes.graph"]);
  const r = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: { kind: "image" } });
  const id = (JSON.stringify(r.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
  const ui = await s.open({ imageId: id });
  await ui.frame.locator("#surface").first().waitFor({ timeout: 20000 });
  const inner = ui.page.frames().find((f) => f !== ui.page.mainFrame());
  await inner.waitForFunction(() => window.estampesSurface.viewers()[0].documentRef(), null, { timeout: 20000 });
  await inner.evaluate(() => window.estampesSurface.pollNow());
  return { id, ui, inner };
}

// Counts the listeners that viewers add to long-lived targets (document, window, shadow roots) and live timers.
// The host request guard (12 s, one per host call, expires by itself) is not a viewer timer and is left out.
const instrument = (inner) => inner.evaluate(() => {
  if (window.__live) return;
  const live = (window.__live = { targets: new Map(), timers: new Set(), frames: new Set() });
  const fnIds = new WeakMap(); let next = 1;
  const long = (t) => t === document || t === window || t instanceof ShadowRoot;
  const key = (type, fn, o) => `${type}|${fnIds.get(fn) ?? (fnIds.set(fn, next++), fnIds.get(fn))}|${o === true || !!o?.capture}`;
  const add = EventTarget.prototype.addEventListener, del = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, o) {
    if (long(this) && fn) { if (!live.targets.has(this)) live.targets.set(this, new Set()); live.targets.get(this).add(key(type, fn, o)); }
    return add.call(this, type, fn, o);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, o) {
    if (long(this) && fn) live.targets.get(this)?.delete(key(type, fn, o));
    return del.call(this, type, fn, o);
  };
  const st = window.setTimeout, ct = window.clearTimeout;
  window.setTimeout = (fn, ms, ...a) => { const id = st(() => { live.timers.delete(id); fn(...a); }, ms); if (ms !== 12000) live.timers.add(id); return id; };
  window.clearTimeout = (id) => { live.timers.delete(id); return ct(id); };
  const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (fn) => { const id = raf((t) => { live.frames.delete(id); fn(t); }); live.frames.add(id); return id; };
  window.cancelAnimationFrame = (id) => { live.frames.delete(id); return caf(id); };
});
const counts = (inner) => inner.evaluate(() => {
  let listeners = 0;
  for (const set of window.__live.targets.values()) listeners += set.size;
  return { listeners, timers: window.__live.timers.size, frames: window.__live.frames.size, viewers: window.estampesSurface.viewers().length };
});

for (const n of [1, 2, 5]) {
  test(`${n} viewer(s) on one document: at most one poll per round and a small unchanged answer`, { skip: noPython || noBrowser, timeout: 90000 }, async () => {
    const s = await startStack();
    try {
      const { id, ui, inner } = await openDoc(s);
      const res = await s.call("present_visual", { imageId: id });
      const t0 = Date.now();
      await inner.evaluate(async ([extra, r]) => {
        for (let i = 0; i < extra; i++) { const v = window.estampesSurface.mountViewer(document.querySelector("#wb-area")); v.feed(r); }
      }, [n - 1, res]);
      await inner.waitForFunction((k) => window.estampesSurface.viewers().length === k && window.estampesSurface.viewers().every((v) => v.documentRef()), n, { timeout: 20000 });
      await inner.evaluate(() => window.estampesSurface.pollNow());
      console.log(`# ${n} viewer(s): mounted and bound in ${Date.now() - t0} ms (fake host, report only)`);

      // Idle window: the scheduler may poll once per POLL_MS however many viewers there are.
      await wait(300);
      const windowMs = 6200;
      const before = ui.net.polls;
      await wait(windowMs);
      const polls = ui.net.polls - before;
      const budget = Math.ceil(windowMs / POLL_MS) + 1;
      console.log(`# ${n} viewer(s): ${polls} poll(s) in ${windowMs} ms (budget ${budget})`);
      assert.ok(polls <= budget, `${polls} polls in ${windowMs} ms for ${n} viewers, budget ${budget}`);

      // An unchanged poll does not carry the snapshot, whatever the viewer count.
      await inner.evaluate(() => window.estampesSurface.pollNow());
      await wait(200);
      console.log(`# ${n} viewer(s): unchanged poll response ${ui.net.last} characters`);
      assert.ok(ui.net.last < 1500, `unchanged poll answer ${ui.net.last} characters`);

      // A change reaches every viewer; the time is reported, not asserted.
      const t1 = Date.now();
      await s.call("present_visual", { imageId: id, annotations: [{ id: "b1", type: "rect", x: 0.2, y: 0.2, x2: 0.3, y2: 0.4, label: "b1" }], findings: [{ id: "b1", note: "n b1" }] });
      for (let i = 0; i < 40; i++) {
        await inner.evaluate(() => window.estampesSurface.pollNow());
        if (await inner.evaluate(() => window.estampesSurface.viewers().every((v) => v.scope.querySelectorAll(".finding-row").length === 1))) break;
        await wait(100);
      }
      assert.equal(await inner.evaluate(() => window.estampesSurface.viewers().every((v) => v.scope.querySelectorAll(".finding-row").length === 1)), true, "every viewer shows the change");
      console.log(`# ${n} viewer(s): change visible in all viewers after ${Date.now() - t1} ms (report only)`);
      console.log(`# ${n} viewer(s): snapshot-bearing poll response ${ui.net.bytes} characters cumulative (report only)`);
      assert.deepEqual(ui.errors, [], "no page errors");
    } finally { await s.close(); }
  });
}

test("opening and closing a viewer 20 times returns listeners, timers and bindings to baseline", { skip: noPython || noBrowser, timeout: 90000 }, async () => {
  const s = await startStack();
  try {
    const { id, ui, inner } = await openDoc(s);
    await instrument(inner);
    const res = await s.call("present_visual", { imageId: id });
    await inner.evaluate(() => window.estampesSurface.pollNow());
    await wait(300);
    const base = await counts(inner);
    for (let i = 0; i < 20; i++) {
      await inner.evaluate(async (r) => {
        const v = window.estampesSurface.mountViewer(document.querySelector("#wb-area"));
        v.feed(r);
        await window.estampesSurface.pollNow();
        v.dispose();
      }, res);
    }
    await inner.evaluate(() => window.estampesSurface.pollNow());
    await wait(400);
    const after = await counts(inner);
    console.log(`# baseline ${JSON.stringify(base)} after 20 cycles ${JSON.stringify(after)}`);
    assert.equal(after.viewers, base.viewers, "viewer count");
    assert.equal(after.listeners, base.listeners, "listeners on document, window and viewer roots");
    assert.ok(after.timers <= base.timers + 1, `timers ${after.timers} vs baseline ${base.timers}`);
    assert.ok(after.frames <= base.frames + 1, `animation frames ${after.frames} vs baseline ${base.frames}`);
    assert.deepEqual(ui.errors, [], "no page errors");
  } finally { await s.close(); }
});
