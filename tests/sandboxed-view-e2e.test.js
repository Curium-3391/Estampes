// U3: the sandboxed-web renderer in the widget. FAKE HOST: the module is scripted by the test host (its files are served the way the server's ui.get
// serves them, in chunks); what is real is the server, the widget, the frame it builds, and the estampes.ui/1 channel. Chromium only.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { startStack, noBrowser } from "./helpers/widget-host.js";

const MOD = "org.example.sandboxed";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const HTML = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head><body><p id="out">waiting</p><button id="save">save</button><img id="pic" src="dot.png"><script src="app.js"></script></body></html>';
const CSS = "#out{color:rgb(1,2,3)}";
const JS = `
window.__go = (u) => { location.href = u; };
window.__csp = [];
document.addEventListener("securitypolicyviolation", (e) => window.__csp.push({ dir: e.violatedDirective }));
try { window.__evalAtLoad = String(eval("1+1")); } catch (e) { window.__evalAtLoad = "blocked"; }
estampes.on("init", (m) => { window.__init = m; document.getElementById("out").textContent = "init:" + (m.data ? m.data.text : "none") + ":" + m.locale; });
estampes.on("changed", (m) => { window.__changed = (window.__changed || []).concat([m]); document.getElementById("out").textContent = "changed:" + m.data.text + (m.own ? ":own" : ""); });
document.getElementById("save").onclick = () => estampes.action("save", { id: window.__init.instance && window.__init.instance.id, revision: window.__init.revision, data: "from-frame" }).then((r) => { window.__result = r; }, (e) => { window.__error = e.code; });
window.__probe = async () => {
  const out = {};
  try { out.parent = String(window.top.document.title); } catch (e) { out.parent = "blocked"; }
  try { out.cookie = typeof document.cookie; } catch (e) { out.cookie = "blocked"; }
  try { localStorage.setItem("a", "b"); out.storage = localStorage.getItem("a"); } catch (e) { out.storage = "blocked"; }
  try { out.sw = "serviceWorker" in navigator ? "present" : "absent"; } catch (e) { out.sw = "blocked"; }
  try { await fetch("http://127.0.0.1:1/", { mode: "no-cors" }); out.fetch = "allowed"; } catch (e) { out.fetch = "blocked"; }
  try { out.eval = String(eval("1+1")); } catch (e) { out.eval = "blocked"; }
  try { const w = new Worker("data:text/javascript,1"); out.worker = await new Promise((r) => { w.onerror = () => r("blocked"); w.onmessage = () => r("ran"); setTimeout(() => r("silent"), 500); }); } catch (e) { out.worker = "blocked"; }
  try { out.frame = String(!!document.body.appendChild(Object.assign(document.createElement("iframe"), { src: "data:text/html,x" })).contentWindow && await new Promise((r) => setTimeout(() => r(window.__csp.some((v) => v.dir.startsWith("frame-src")) ? "blocked" : "allowed"), 300))); } catch (e) { out.frame = "blocked"; }
  out.violations = [...new Set(window.__csp.map((v) => v.dir.split(" ")[0]))].sort();
  return out;
};
estampes.ready();
`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const FILES = { "ui/index.html": Buffer.from(HTML), "ui/app.js": Buffer.from(JS), "ui/app.css": Buffer.from(CSS), "ui/dot.png": PNG };
const ok = (data) => ({ content: [{ type: "text", text: "ok" }], structuredContent: { kind: "estampes.module_result", status: "ok", data } });
const PAYLOAD = { entry: "ui/index.html", assets: ["ui/app.js", "ui/app.css", "ui/dot.png"], shims: ["memory-storage", "no-service-worker"], state: { model: "doc", report: { action: "save", path: "/text", minIntervalMs: 500 } } };

function script({ files = FILES, shims = PAYLOAD.shims, tamper = null, enabled = true, interval = PAYLOAD.state.report.minIntervalMs, slowSave = 0 } = {}) {
  const inst = { id: "md:0123456789ab", revision: 1, value: { text: "one" } };
  const calls = [];
  const meta = Object.entries(files).map(([path, b]) => ({ path, bytes: b.length, sha256: sha(b) }));
  const intercept = async (params, call) => {
    if (params.name === "execute_module" && params.arguments.module === MOD) {
      const { capability, params: p } = params.arguments;
      calls.push([capability, p]);
      if (capability === "ui.get") {
        let b = tamper?.[p.path] ?? files[p.path];
        if (!b) throw new Error("no UI file");
        const chunk = b.subarray(p.offset, p.offset + 97);
        return ok({ path: p.path, size: b.length, sha256: sha(b), offset: p.offset, chunk: chunk.toString("base64"), done: p.offset + chunk.length >= b.length });
      }
      if (capability === "models.get") return ok({ instance: { ...inst, value: { ...inst.value } } });
      if (capability === "save") {
        if (slowSave) await new Promise((r) => setTimeout(r, slowSave));
        if (p.revision !== undefined && p.revision !== inst.revision) throw new Error("conflict");
        inst.value.text = p.data ?? p.text; inst.revision++;
        return ok({ saved: true });
      }
    }
    if (params.name === "surface_get_state") {
      const r = await call(params), sc = structuredClone(r.structuredContent), id = "p:view-sv0";
      sc.panels.push({ panelId: id, kind: "module-view", module: MOD, panel: "view-sv", view: "sv", open: true, title: "Web view", moduleState: enabled ? "enabled" : "disabled" });
      for (const lay of Object.values(sc.layouts)) { lay.order.push(id); lay.placements[id] = { mode: "normal", rect: { x: 0.2, y: 0, w: 0.8, h: 1 }, z: 5 }; }
      sc.moduleViews = { [id]: { module: MOD, view: "sv", title: "Web view", reads: ["doc"], actions: ["save"], bound: { doc: inst.id }, instances: { doc: [inst.id] },
        renderer: { type: "sandboxed-web", schema: "estampes.renderer.sandboxed-web/1", payload: { ...PAYLOAD, shims, state: { ...PAYLOAD.state, report: { ...PAYLOAD.state.report, minIntervalMs: interval } } } }, frame: { capability: "ui.get", entry: "ui/index.html", files: meta } } };
      return { content: r.content, structuredContent: sc };
    }
    return undefined;
  };
  return { inst, calls, intercept };
}
async function openIt(s, sc) {
  await s.enable(["org.estampes.graph"]);
  const canvas = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "graph" } });
  const imageId = (JSON.stringify(canvas.structuredContent).match(/gph:[0-9a-f]{16}/) ?? [])[0];
  assert.ok(imageId);
  return s.open({ imageId, intercept: sc.intercept });
}
const inner = (ui) => ui.page.frames().find((f) => f.parentFrame() && f.parentFrame() !== ui.page.mainFrame());

test("a module's own page runs in an isolated frame, gets its data at init, and its action changes the stored data", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const sc = script();
    const ui = await openIt(s, sc);
    await ui.frame.locator("iframe.sv-frame").waitFor({ timeout: 30000 });
    // The frame is exactly allow-scripts; the host chose that, not the module.
    assert.equal(await ui.frame.locator("iframe.sv-frame").getAttribute("sandbox"), "allow-scripts");
    await ui.page.waitForFunction(() => { const w = document.querySelector("iframe"); const f = w.contentDocument.querySelector("iframe.sv-frame"); return f && f.contentDocument === null; }, null, { timeout: 5000 }); // opaque origin: the widget cannot reach into it either
    const f = inner(ui);
    await f.waitForFunction(() => document.getElementById("out").textContent.startsWith("init:one"), null, { timeout: 15000 });
    assert.match(await f.locator("#out").textContent(), /^init:one:/);
    assert.equal(await f.evaluate(() => getComputedStyle(document.getElementById("out")).color), "rgb(1, 2, 3)", "styles named by the page are inlined");
    assert.equal(await f.evaluate(() => document.getElementById("pic").naturalWidth), 1, "images named by the page are inlined as data");
    assert.deepEqual(await f.evaluate(() => ({ a: window.__init.view, b: window.__init.revision, c: window.__init.instance.id, d: window.__init.actions })), { a: "sv", b: 1, c: sc.inst.id, d: ["save"] });
    // Isolation, as the module itself sees it.
    const probe = await f.evaluate(() => window.__probe());
    assert.equal(await f.evaluate(() => window.__evalAtLoad), "blocked", "eval is not allowed by the frame's CSP");
    assert.deepEqual({ ...probe, eval: undefined }, { parent: "blocked", cookie: "blocked", storage: "b", sw: "absent", fetch: "blocked", eval: undefined, worker: "blocked", frame: "blocked", violations: probe.violations });
    for (const dir of ["connect-src", "worker-src", "frame-src"]) assert.ok(probe.violations.includes(dir), dir + " was enforced: " + probe.violations);
    // An action is the view's own capability through execute_module, and the new revision comes back as `changed`.
    await f.click("#save");
    await f.waitForFunction(() => document.getElementById("out").textContent === "changed:from-frame:own", null, { timeout: 15000 });
    assert.deepEqual(sc.calls.filter(([c]) => c === "save").map(([, p]) => p), [{ id: sc.inst.id, revision: 1, data: "from-frame" }]);
    assert.equal(await f.evaluate(() => window.__result.type), "result");
    // A change made elsewhere reaches the frame at the next refresh.
    sc.inst.value.text = "elsewhere"; sc.inst.revision++;
    await f.waitForFunction(() => document.getElementById("out").textContent === "changed:elsewhere", null, { timeout: 20000 });
    assert.deepEqual(ui.errors.filter((e) => !/Content Security Policy|Refused to|Failed to load|ERR_/i.test(e)), []);
  } finally { await s.close(); }
});

test("the frame can ask only for its own view's actions; unknown, oversized and flooding messages are dropped and counted", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const sc = script();
    const ui = await openIt(s, sc);
    await ui.frame.locator("iframe.sv-frame").waitFor({ timeout: 30000 });
    const f = inner(ui);
    await f.waitForFunction(() => window.__init, null, { timeout: 15000 });
    const before = sc.calls.length;
    const err = await f.evaluate(async () => { try { await estampes.action("models.get", { model: "doc", id: "md:0123456789ab" }); return "allowed"; } catch (e) { return e.code; } });
    assert.equal(err, "not-allowed");
    assert.equal(await f.evaluate(async () => { try { await estampes.action("delete_everything", {}); return "allowed"; } catch (e) { return e.code; } }), "not-allowed");
    assert.equal(sc.calls.length, before, "no module call is made for an action the view does not have");
    // The raw channel: the frame cannot post anything else to the host, and cannot make the host call anything.
    const dropped = async () => JSON.parse(await ui.frame.locator(".sv").getAttribute("data-dropped"));
    assert.ok((await dropped()).denied >= 2);
    await f.evaluate(() => { for (let i = 0; i < 200; i++) estampes.report({ text: "x" + i }); });
    await f.evaluate(() => { estampes.report({ text: "y".repeat(70000) }); });
    await ui.page.waitForTimeout(300);
    const d = await dropped();
    assert.ok(d.rate >= 100, "a flood is dropped: " + JSON.stringify(d));
    assert.ok(d.size >= 1 || d.rate >= 100, "an oversized message is dropped: " + JSON.stringify(d));
  } finally { await s.close(); }
});

test("reports are throttled and written only through the view's own action, with the revision the frame saw", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const sc = script();
    const ui = await openIt(s, sc);
    await ui.frame.locator("iframe.sv-frame").waitFor({ timeout: 30000 });
    const f = inner(ui);
    await f.waitForFunction(() => window.__init, null, { timeout: 15000 });
    await f.evaluate(() => { for (let i = 0; i < 5; i++) estampes.report({ text: "r" + i }); });
    await ui.page.waitForFunction(() => true);
    await new Promise((r) => setTimeout(r, 2500));
    const saves = sc.calls.filter(([c]) => c === "save").map(([, p]) => p);
    assert.ok(saves.length >= 1 && saves.length <= 2, "throttled: " + JSON.stringify(saves));
    assert.deepEqual(saves[0], { data: "r0", id: sc.inst.id, revision: 1 });
    assert.equal(sc.inst.value.text, "r4");
  } finally { await s.close(); }
});

test("bytes that do not match the digest the server named are not loaded", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const sc = script({ tamper: { "ui/app.js": Buffer.from(JS + "\n// changed after the digest was made") } });
    const ui = await openIt(s, sc);
    await ui.frame.locator(".sv-status[data-kind=error]").waitFor({ timeout: 30000 });
    assert.match(await ui.frame.locator(".sv-status").textContent(), /ui\/app\.js/);
    assert.equal(await ui.frame.locator("iframe.sv-frame").count(), 0, "no frame was made");
  } finally { await s.close(); }
});

test("a disabled module shows a note and loads nothing; stopping a view disposes its frame", { skip: noBrowser, timeout: 120000 }, async () => {
  for (const enabled of [false, true]) {
    const s = await startStack({ cas: false });
    try {
      const sc = script({ enabled });
      const ui = await openIt(s, sc);
      if (!enabled) {
        await ui.frame.locator(".mv-note, .sv .wb-note").first().waitFor({ timeout: 30000 });
        assert.equal(await ui.frame.locator("iframe.sv-frame").count(), 0);
        assert.equal(sc.calls.filter(([c]) => c === "ui.get").length, 0, "no file is fetched");
      } else {
        await ui.frame.locator("iframe.sv-frame").waitFor({ timeout: 30000 });
        await ui.frame.locator(".sv-stop").click();
        await ui.frame.locator(".sv-reload").waitFor();
        assert.equal(await ui.frame.locator("iframe.sv-frame").count(), 0);
        await ui.frame.locator(".sv-reload").click();
        await ui.frame.locator("iframe.sv-frame").waitFor({ timeout: 15000 });
      }
    } finally { await s.close(); }
  }
});

test("a frame cannot send data out by navigating itself, and a frame that navigates anyway is stopped", { skip: noBrowser, timeout: 120000 }, async () => {
  const hits = [];
  const sink = createServer((req, res) => { hits.push(req.url); res.end("x"); });
  await new Promise((r) => sink.listen(0, "127.0.0.1", r));
  const s = await startStack({ cas: false });
  try {
    const sc = script();
    const ui = await openIt(s, sc);
    await ui.frame.locator("iframe.sv-frame").waitFor({ timeout: 30000 });
    const f = inner(ui);
    await f.waitForFunction(() => window.__init, null, { timeout: 15000 });
    await f.evaluate((u) => { window.__go(u); }, "http://127.0.0.1:" + sink.address().port + "/leak?d=" + encodeURIComponent("one"));
    await ui.page.waitForTimeout(1500);
    assert.deepEqual(hits, [], "the destination was never asked");
    await ui.frame.locator(".sv-reload").waitFor({ timeout: 10000 });
    assert.equal(await ui.frame.locator("iframe.sv-frame").count(), 0, "the frame that tried to leave its page was stopped");
    assert.match(await ui.frame.locator(".sv .mv-note").textContent(), /leave its page|離開自己的頁面/);
  } finally { sink.close(); await s.close(); }
});

test("a report keeps the revision the frame saw: an edit made elsewhere makes it a refused conflict, not an overwrite", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const sc = script({ interval: 15000 });
    const ui = await openIt(s, sc);
    await ui.frame.locator("iframe.sv-frame").waitFor({ timeout: 30000 });
    const f = inner(ui);
    await f.waitForFunction(() => window.__init, null, { timeout: 15000 });
    await f.evaluate(() => estampes.report({ text: "first" }));       // goes at once (nothing reported before)
    await f.waitForFunction(() => document.getElementById("out").textContent === "changed:first:own", null, { timeout: 15000 });
    await f.evaluate(() => estampes.report({ text: "second" }));      // waits in the throttle window, based on the revision after "first"
    sc.inst.value.text = "edited elsewhere"; sc.inst.revision++;      // someone else changes the data meanwhile
    await f.waitForFunction(() => document.getElementById("out").textContent === "changed:edited elsewhere", null, { timeout: 20000 });
    await ui.frame.locator(".sv-status[data-kind=error]").waitFor({ timeout: 30000 });
    const saves = sc.calls.filter(([c]) => c === "save").map(([, p]) => p);
    assert.equal(saves.length, 2);
    assert.equal(saves[1].revision, 2, "the report carried the revision it was based on, not the newer one");
    assert.equal(sc.inst.value.text, "edited elsewhere", "the other edit was not overwritten");
  } finally { await s.close(); }
});

test("stopping a view cancels the actions still waiting behind a slow one", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const sc = script({ slowSave: 1500 });
    const ui = await openIt(s, sc);
    await ui.frame.locator("iframe.sv-frame").waitFor({ timeout: 30000 });
    const f = inner(ui);
    await f.waitForFunction(() => window.__init, null, { timeout: 15000 });
    await f.evaluate(() => { for (let i = 0; i < 3; i++) estampes.action("save", { data: "a" + i }).catch(() => {}); });
    await ui.page.waitForTimeout(300);
    await ui.frame.locator(".sv-stop").click();
    await ui.page.waitForTimeout(5000);
    assert.equal(sc.calls.filter(([c]) => c === "save").length, 1, "only the action already running finished; the queued ones never ran");
  } finally { await s.close(); }
});

test("a package script with CRLF line endings runs: the hash covers the text the frame will execute", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const crlf = { ...FILES, "ui/app.js": Buffer.from(JS.replace(/\n/g, "\r\n")), "ui/app.css": Buffer.from(CSS + "\r\n") };
    const sc = script({ files: crlf });
    const ui = await openIt(s, sc);
    await ui.frame.locator("iframe.sv-frame").waitFor({ timeout: 30000 });
    await inner(ui).waitForFunction(() => window.__init, null, { timeout: 15000 });
  } finally { await s.close(); }
});

test("a report that waits behind this frame's own slow save is based on that save, not on the old revision", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false });
  try {
    const sc = script({ interval: 500, slowSave: 1800 });
    const ui = await openIt(s, sc);
    await ui.frame.locator("iframe.sv-frame").waitFor({ timeout: 30000 });
    const f = inner(ui);
    await f.waitForFunction(() => window.__init, null, { timeout: 15000 });
    await f.evaluate(() => estampes.report({ text: "A" }));
    await ui.page.waitForTimeout(900);                                // the save of A is still running; the throttle window has passed
    await f.evaluate(() => estampes.report({ text: "B" }));
    await f.waitForFunction(() => document.getElementById("out").textContent.startsWith("changed:B"), null, { timeout: 30000 });
    const saves = sc.calls.filter(([c]) => c === "save").map(([, p]) => p);
    assert.deepEqual(saves.map((p) => [p.data, p.revision]), [["A", 1], ["B", 2]]);
    assert.equal(sc.inst.value.text, "B");
  } finally { await s.close(); }
});
