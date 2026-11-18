// Browser test: the widget tells the host how big its content is
// (ui/notifications/size-changed), and a tiny picture still gets a usable canvas.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noBrowser } from "./helpers/widget-host.js";

test("widget reports its content size to the host and keeps a minimum canvas height", { skip: noBrowser, timeout: 60000 }, async () => {
  const stack = await startStack({ cas: false });
  try {
    const { page, frame, errors } = await stack.open({
      result: () => stack.call("present_visual", { upload: true }),
      viewport: { width: 1000, height: 900 },
    });
    await page.evaluate(() => {
      window.sizes = [];
      addEventListener("message", (e) => { if (e.data?.method === "ui/notifications/size-changed") window.sizes.push(e.data.params); });
    });
    await page.waitForFunction(() => window.sizes.length > 0, null, { timeout: 10000 });
    await page.waitForTimeout(1500); // let the widget settle
    const before = await page.evaluate(() => window.sizes.at(-1)?.height);
    assert.ok(Number.isInteger(before) && before > 0, "reported at least once: " + before);
    await frame.locator("body").evaluate((b) => { const d = document.createElement("div"); d.style.height = "400px"; b.appendChild(d); });
    await page.waitForFunction((h) => window.sizes.at(-1).height >= h + 300, before, { timeout: 10000 });
    const last = await page.evaluate(() => window.sizes.at(-1));
    assert.ok(Number.isInteger(last.width) && last.width > 0);
    assert.ok(last.height > before, `grew from ${before} to ${last.height}`);
    assert.deepEqual(errors, []);
  } finally { await stack.close(); }
});

test("the canvas has a minimum height whatever the picture's shape", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile("public/visual-surface.html", "utf8");
  assert.match(html, /#surface\{[^}]*min-height:/);
  assert.match(html, /ui\/notifications\/size-changed/);
});

test("a frame the user made big gives the canvas more room (no 820px / 640px caps)", { skip: noBrowser, timeout: 60000 }, async () => {
  const stack = await startStack({ cas: false });
  try {
    const { page, frame, errors } = await stack.open({ result: () => stack.call("present_visual", {}), viewport: { width: 1700, height: 1200 } });
    await frame.locator("#surface").waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    const m = await frame.locator("#surface").evaluate((el) => ({ w: el.getBoundingClientRect().width, max: parseFloat(getComputedStyle(el).maxHeight), vh: innerHeight }));
    assert.ok(m.w > 1000, "canvas uses the wide frame: " + m.w);
    assert.ok(m.max > 640 && m.max < m.vh, "canvas may grow with the frame height: " + JSON.stringify(m));
    assert.deepEqual(errors, []);
  } finally { await stack.close(); }
});

test("a small frame keeps the old 640px canvas limit", { skip: noBrowser, timeout: 60000 }, async () => {
  const stack = await startStack({ cas: false });
  try {
    const { page, frame } = await stack.open({ result: () => stack.call("present_visual", {}), viewport: { width: 900, height: 700 } });
    await frame.locator("#surface").waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    const max = await frame.locator("#surface").evaluate((el) => parseFloat(getComputedStyle(el).maxHeight));
    assert.equal(max, 640);
  } finally { await stack.close(); }
});

test("canvas height changes ease in, and the mark still lands under the pointer in a wide frame", { skip: noBrowser, timeout: 60000 }, async () => {
  const stack = await startStack({ cas: false });
  try {
    const { page, frame } = await stack.open({ result: () => stack.call("present_visual", {}), viewport: { width: 1700, height: 1200 } });
    await frame.locator("#surface").waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    const tr = await frame.locator("#surface").evaluate((el) => getComputedStyle(el).transitionProperty + "|" + getComputedStyle(el).transitionDuration);
    assert.match(tr, /max-height/);
    const box = await frame.locator("#surface").boundingBox();
    const px = box.x + box.width * 0.6, py = box.y + box.height * 0.4;
    await page.mouse.click(px, py);
    await page.waitForTimeout(400);
    const hit = await frame.locator("#surface").evaluate((el, [x, y]) => [...el.querySelectorAll("circle")].some((c) => { const r = c.getBoundingClientRect(); return Math.abs(r.x + r.width / 2 - x) < 3 && Math.abs(r.y + r.height / 2 - y) < 3; }), [px, py]);
    assert.ok(hit, "a mark sits under the click");
  } finally { await stack.close(); }
});
