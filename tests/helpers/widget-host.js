// Test helper: the real server (+ optional SymPy service) and a browser page
// with a fake host that relays the widget's tool calls to MCP, as ChatGPT does.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const require = createRequire(import.meta.url);
export const python = process.env.PYTHON || "python3";
export const noPython = spawnSync(python, ["-c", "import sympy"]).status === 0 ? false : "python3 with sympy is not installed";
let chromium = null;
for (const name of ["playwright", "playwright-core"]) { try { ({ chromium } = require(name)); break; } catch {} }
export const noBrowser = chromium ? false : "playwright is not installed";
export const shotsDir = process.env.ESTAMPES_E2E_SHOTS;

const HARNESS = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0"><iframe id="w" style="width:100vw;height:100vh;border:0"></iframe><script>
const f=document.getElementById("w");
window.hostLog=[];let initialized=false;
addEventListener("message",async e=>{
  if(e.source!==f.contentWindow)return;const m=e.data;if(m?.jsonrpc!=="2.0")return;
  window.hostLog.push(m.method??"response");
  if(m.method==="ui/notifications/initialized")initialized=true;
  if(m.id==null)return;
  const reply=(o)=>f.contentWindow.postMessage({jsonrpc:"2.0",id:m.id,...o},"*");
  try{
    if(m.method==="ui/initialize")reply({result:{protocolVersion:"2026-01-26",hostInfo:{name:"fake-host",version:"0"},hostCapabilities:{}}});
    // Strict hosts refuse anything before the handshake completes.
    else if(!initialized)reply({error:{message:"request before ui/notifications/initialized: "+m.method}});
    else if(m.method==="tools/call")reply({result:await window.hostCall(m.params)});
    else reply({result:{}});
  }catch(err){reply({error:{message:String(err.message||err)}});}
});
window.load=(html,result)=>{f.onload=()=>setTimeout(()=>f.contentWindow.postMessage({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:result},"*"),150);f.srcdoc=html;};
// ChatGPT-like delivery: the result is already on window.openai when the
// widget's own script starts, before any handshake.
window.loadGlobals=(html,result)=>{f.onload=null;const g="<script>window.openai="+JSON.stringify({toolOutput:result.structuredContent,toolResponseMetadata:result._meta??null}).replace(/</g,"\\\\u003c")+"<\\/script>";f.srcdoc=html.replace(/<head[^>]*>/i,m=>m+g);};
</script></body>`;

async function freePort() { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }

export async function startStack({ cas = true, env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "estampes-e2e-"));
  const sock = join(dir, "cas.sock");
  const casProc = cas ? spawn(python, ["-m", "estampes_cas"], { cwd: "cas-service", env: { ...process.env, ESTAMPES_CAS_SOCKET: sock, PYTHONPATH: "cas-service" }, stdio: "ignore" }) : null;
  if (cas) for (let i = 0; i < 100; i++) { try { await access(sock); break; } catch { await sleep(100); } }
  const port = await freePort();
  const server = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ...(cas ? { ESTAMPES_CAS_SOCKET: sock } : {}), ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0", ...env }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { if ((await fetch("http://127.0.0.1:" + port + "/")).ok) break; } catch {} await sleep(100); }
  const client = new Client({ name: "e2e", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp")));
  let browser = null;
  const call = (name, args) => client.callTool({ name, arguments: args });
  return {
    client, call, dir, port,
    async enable(ids) {
      for (const id of ids) {
        const prep = await call("prepare_module_change", { action: "enable", module: id });
        await call("store_commit_plan", { planId: prep.structuredContent.plan.planId, consent: prep._meta["estampes/consent"].consent });
      }
    },
    async widgetHtml() {
      const uri = (await client.listResources()).resources.find((r) => /visual-surface-/.test(r.uri)).uri;
      return (await client.readResource({ uri })).contents[0].text;
    },
    // Opens the widget on `imageId` the way present_visual would deliver it.
    // globals: deliver the result the way ChatGPT does (window.openai first).
    async open({ imageId, viewport = { width: 1280, height: 900 }, result = null, globals = false, touch = false }) {
      const widget = await this.widgetHtml();
      browser ??= await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
      const page = await browser.newPage({ viewport, hasTouch: touch, isMobile: touch });
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      await page.exposeFunction("hostCall", async (params) => {
        const r = await client.callTool(params);
        return { content: r.content, structuredContent: r.structuredContent, _meta: r._meta, isError: r.isError };
      });
      await page.setContent(HARNESS);
      const reload = async () => {
        const r = result ? await result() : await call("present_visual", { imageId });
        await page.evaluate(([h, res, g]) => (g ? window.loadGlobals : window.load)(h, res), [widget, { structuredContent: r.structuredContent, _meta: r._meta, content: r.content }, globals]);
      };
      await reload();
      const shot = async (name) => { if (shotsDir) { await mkdir(shotsDir, { recursive: true }); await page.screenshot({ path: join(shotsDir, name + ".png") }); } };
      return { page, frame: page.frameLocator("#w"), errors, reload, shot };
    },
    async close() { await browser?.close(); await client.close().catch(() => {}); server.kill(); casProc?.kill(); },
  };
}
