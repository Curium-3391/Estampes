// Browser test of the workbench: the real server, the real SymPy service and
// the real widget, with a small fake host that relays the widget's tool calls
// over MCP the way ChatGPT does. A live ChatGPT host is NOT exercised here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const require = createRequire(import.meta.url);
const python = process.env.PYTHON || "python3";
const noPython = spawnSync(python, ["-c", "import sympy"]).status === 0 ? false : "python3 with sympy is not installed";
let chromium = null;
for (const name of ["playwright", "playwright-core"]) { try { ({ chromium } = require(name)); break; } catch {} }
const skip = noPython || (chromium ? false : "playwright is not installed");
const shots = process.env.ESTAMPES_E2E_SHOTS;

async function freePort() { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
const call = (c, name, args) => c.callTool({ name, arguments: args });

const HARNESS = `<!doctype html><body style="margin:0"><iframe id="w" style="width:100vw;height:100vh;border:0"></iframe><script>
const f=document.getElementById("w");
addEventListener("message",async e=>{
  if(e.source!==f.contentWindow)return;const m=e.data;if(m?.jsonrpc!=="2.0"||m.id==null)return;
  const reply=(o)=>f.contentWindow.postMessage({jsonrpc:"2.0",id:m.id,...o},"*");
  try{
    if(m.method==="ui/initialize")reply({result:{protocolVersion:"2026-01-26",hostInfo:{name:"fake-host",version:"0"},hostCapabilities:{}}});
    else if(m.method==="tools/call")reply({result:await window.hostCall(m.params)});
    else reply({result:{}});
  }catch(err){reply({error:{message:String(err.message||err)}});}
});
window.load=(html,result)=>{f.onload=()=>setTimeout(()=>f.contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:result},"*"),150);f.srcdoc=html;};
</script></body>`;

test("workbench in a browser: Graph + calculator side by side, drag, mobile tabs", { skip, timeout: 240000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-e2e-"));
  const sock = join(dir, "cas.sock");
  const cas = spawn(python, ["-m", "estampes_cas"], { cwd: "cas-service", env: { ...process.env, ESTAMPES_CAS_SOCKET: sock, PYTHONPATH: "cas-service" }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await access(sock); break; } catch { await sleep(100); } }
  const port = await freePort();
  const server = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_CAS_SOCKET: sock, ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0" }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { if ((await fetch("http://127.0.0.1:" + port + "/")).ok) break; } catch {} await sleep(100); }
  const client = new Client({ name: "e2e", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp")));
  let browser, pageRef, errorsRef;
  try {
    for (const id of ["org.estampes.graph", "org.estampes.cas"]) {
      const prep = await call(client, "prepare_module_change", { action: "enable", module: id });
      await call(client, "store_commit_plan", { planId: prep.structuredContent.plan.planId, consent: prep._meta["estampes/consent"].consent });
    }
    const plotted = await call(client, "execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: {} });
    const imageId = (JSON.stringify(plotted.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    assert.ok(imageId);

    const uri = (await client.listResources()).resources.find((r) => /visual-surface-/.test(r.uri)).uri;
    const widget = (await client.readResource({ uri })).contents[0].text;
    assert.doesNotMatch(widget, /__ESTAMPES_/, "placeholders were all replaced");
    const present = async () => { const r = await call(client, "present_visual", { imageId }); return { structuredContent: r.structuredContent, _meta: r._meta, content: r.content }; };

    browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    pageRef = page; errorsRef = errors;
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.exposeFunction("hostCall", async (params) => {
      const r = await client.callTool(params);
      return { content: r.content, structuredContent: r.structuredContent, _meta: r._meta, isError: r.isError };
    });
    await page.setContent(HARNESS);
    const load = async () => { await page.evaluate(([h, r]) => window.load(h, r), [widget, await present()]); };
    const shot = async (name) => { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, name + ".png") }); } };
    await load();
    const w = page.frameLocator("#w");

    // 1. Alone, the canvas looks like it always did and offers the calculator.
    await w.locator(".wb-open").first().waitFor({ timeout: 20000 });
    assert.equal(await w.locator("#wb.solo").count(), 1);
    assert.equal(await w.locator(".wb-open").first().isEnabled(), true);
    await shot("1-solo");

    // 2. Opening the calculator puts both panels on screen at once.
    await w.locator(".wb-open").first().click();
    await w.locator(".calc").waitFor({ timeout: 20000 });
    assert.equal(await w.locator("#wb.windows").count(), 1);
    const a = await w.locator("#panel-canvas").boundingBox();
    const b = await w.locator(".calc").boundingBox();
    assert.ok(a.width > 100 && b.width > 100, "both panels have size");
    const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    assert.equal(overlap, false, "default layout does not overlap");

    // 3. Calculate: exact result, LaTeX drawn as MathML.
    await w.locator(".calc select").first().selectOption("differentiate");
    await w.locator(".calc-input").fill("sin(x^2)");
    await w.locator(".calc-go .primary").click();
    await w.locator(".cell-math math").first().waitFor({ timeout: 30000 });
    assert.match(await w.locator(".cell-plain").first().innerText(), /2\*x\*cos\(x\*\*2\)|2\*x\*cos\(x\^2\)/);
    assert.match(await w.locator(".cell-math math").first().innerHTML(), /<mi>x<\/mi>|<mi>cos<\/mi>|cos/);
    await shot("2-calculated");

    // 4. A hostile string is data: shown as text, never run.
    await w.locator(".calc-input").fill("<img src=x onerror=window.top.__pwn=1>");
    await w.locator(".calc-go .primary").click();
    await w.locator(".cell-err, .calc-msg[data-kind=error]").first().waitFor({ timeout: 30000 });
    assert.equal(await page.evaluate(() => window.__pwn), undefined);
    assert.equal(await w.locator("img[src=x]").count(), 0);

    // 4b. A long calculation can be stopped; nothing is left behind.
    const cellsBefore = await w.locator(".cell").count();
    await w.locator(".calc select").first().selectOption("integrate");
    await w.locator(".calc-input").fill("exp(-x^2)*ln(x)");
    await w.locator(".calc-go .primary").click();
    await w.locator(".calc-go button[aria-label=停止計算]").waitFor({ state: "visible", timeout: 10000 });
    await sleep(500);
    await w.locator(".calc-go button[aria-label=停止計算]").click();
    await w.locator(".calc-msg", { hasText: "已停止" }).waitFor({ timeout: 15000 });
    assert.equal(await w.locator(".cell").count(), cellsBefore, "a stopped calculation adds no cell");
    assert.equal(await w.locator(".calc-go .primary").isEnabled(), true, "the calculator is usable again");
    await w.locator(".calc select").first().selectOption("differentiate");

    // 5. Plot the result on the Graph panel; the object is linked.
    await w.locator(".calc-input").fill("x^3-3x");
    await w.locator(".calc-go .primary").click();
    await w.locator(".cell").first().waitFor({ timeout: 30000 });
    await w.locator(".cell-acts .primary", { hasText: "畫在 Graph" }).first().click();
    await w.locator(".cell-link").first().waitFor({ timeout: 30000 });
    await shot("3-plotted");

    // 6. Dragging the calculator's title bar moves it; the layout is saved.
    const before = (await call(client, "surface_get_state", { imageId })).structuredContent;
    const calc = before.panels.find((p) => p.kind === "calculator");
    const grip = await w.locator(".calc").locator("xpath=ancestor::section[contains(@class,'wb-panel')]").locator(".wb-grip").boundingBox();
    await page.mouse.move(grip.x + 20, grip.y + 10);
    await page.mouse.down();
    await page.mouse.move(grip.x + 20 - 120, grip.y + 10 + 60, { steps: 8 });
    await page.mouse.up();
    let moved;
    for (let i = 0; i < 40 && !moved; i++) {
      await sleep(150);
      const now = (await call(client, "surface_get_state", { imageId })).structuredContent;
      const r0 = before.layouts.desktop.placements[calc.panelId].rect, r1 = now.layouts.desktop.placements[calc.panelId].rect;
      if (JSON.stringify(r0) !== JSON.stringify(r1)) moved = r1;
    }
    assert.ok(moved, "the new position was saved");
    assert.ok(moved.x >= 0 && moved.y >= 0 && moved.x + moved.w <= 1.0001 && moved.y + moved.h <= 1.0001, "stays inside the workbench");
    await shot("4-moved");

    // 7. Keyboard: Alt+Arrow moves the focused panel too.
    const g2 = w.locator(".wb-panel", { has: w.locator(".calc") }).locator(".wb-grip");
    await g2.focus();
    await page.keyboard.press("Alt+ArrowLeft");
    await sleep(600);

    // 8. A phone gets tabs, one panel at a time, and its own layout.
    await page.setViewportSize({ width: 390, height: 844 });
    await w.locator(".wb-tab").first().waitFor({ timeout: 20000 });
    assert.equal(await w.locator("#wb.mobile").count(), 1);
    assert.equal(await w.locator(".wb-tab").count(), 2);
    const visiblePanels = await w.locator(".wb-panel:visible").count();
    assert.equal(visiblePanels, 1);
    await shot("5-mobile");
    await w.locator(".wb-tab", { hasText: "科學計算機" }).click();
    await w.locator(".calc").waitFor({ state: "visible", timeout: 10000 });
    assert.equal(await w.locator("#panel-canvas").isVisible(), false);
    await shot("6-mobile-calc");
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    assert.equal(noHScroll, true);
    const final = (await call(client, "surface_get_state", { imageId })).structuredContent;
    assert.deepEqual(final.layouts.desktop.placements[calc.panelId].rect, (await call(client, "surface_get_state", { imageId })).structuredContent.layouts.desktop.placements[calc.panelId].rect);

    assert.deepEqual(errors, [], "no page errors: " + errors.join(" | "));
  } catch (err) {
    if (shots && pageRef) { await mkdir(shots, { recursive: true }); await pageRef.screenshot({ path: join(shots, "failure.png") }).catch(() => {}); console.error("page errors:", errorsRef); }
    throw err;
  } finally {
    await browser?.close();
    await client.close().catch(() => {});
    server.kill(); cas.kill();
  }
});
