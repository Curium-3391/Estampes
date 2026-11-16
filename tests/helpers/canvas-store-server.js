// Test helper: a real server.js with the UVA canvas store over the given
// storage and UVA folders, and an MCP client. Test-only.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

async function freePort() { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }

export async function startCanvasStoreServer(storage, beta, { idle = "3600", env = {} } = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), stdio: "ignore", env: { ...process.env, PORT: String(port),
    ESTAMPES_STORAGE_DIR: storage, ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0", ESTAMPES_RATE_LIMIT_PER_MIN: "0",
    ESTAMPES_UVA_BETA_DIR: beta, ESTAMPES_UVA_BETA_PROFILE: "linux-process-crash-test",
    ESTAMPES_CANVAS_STORE: "uva", ESTAMPES_UVA_MIRROR_IDLE_SEC: idle, ...env } });
  const exited = new Promise((r) => proc.once("exit", r));
  for (let i = 0; i < 300; i++) { try { if ((await fetch("http://127.0.0.1:" + port + "/")).ok) break; } catch {} await sleep(100); }
  const client = new Client({ name: "canvas-store-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp")));
  const raw = (name, args) => client.callTool({ name, arguments: args });
  const call = async (name, args) => { const r = await raw(name, args); assert.ok(!r.isError, name + ": " + JSON.stringify(r.content)); return r; };
  let stopped = false;
  const end = async (signal) => { if (stopped) return; stopped = true; await client.close().catch(() => {}); proc.kill(signal); await exited; };
  return {
    call, raw, port,
    stop: () => end("SIGTERM"),
    kill: () => end("SIGKILL"),
    async upload(color) {
      const data = (await sharp({ create: { width: 320, height: 200, channels: 3, background: color } }).png().toBuffer()).toString("base64");
      return (await call("upload_visual_image", { total: data.length, offset: 0, data, fileName: "c.png" })).structuredContent.imageId;
    },
    labels: async (imageId) => (await call("get_visual_state", { imageId })).structuredContent.marks.map((m) => m.label ?? m.id).sort(),
    async enable(...ids) {
      for (const id of ids) {
        const prep = await call("prepare_module_change", { action: "enable", module: id });
        await call("store_commit_plan", { planId: prep.structuredContent.plan.planId, consent: prep._meta["estampes/consent"].consent });
      }
    },
  };
}
