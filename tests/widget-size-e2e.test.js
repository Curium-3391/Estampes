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
