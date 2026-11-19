import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

async function start(env) {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ...env }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) return { base, handle }; } catch {} await sleep(100); }
  handle.kill();
  throw new Error("server failed to start");
}

test("server icon: advertised in initialize as a URL and served without a key", { timeout: 30000 }, async () => {
  const { base, handle } = await start({ ESTAMPES_ACCESS_KEY: "s3cret" });
  try {
    const png = readFileSync("public/estampes-icon.png");
    for (const path of ["/icon.png", "/favicon.ico"]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
    }
    const res = await fetch(base + "/mcp?key=s3cret", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "icon-test", version: "0" } } }) });
    const text = await res.text();
    const info = JSON.parse(text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:") && l.includes("serverInfo")).slice(5) : text).result.serverInfo;
    assert.equal(info.name, "estampes");
    assert.equal(info.icons.length, 1);
    assert.equal(info.icons[0].mimeType, "image/png");
    assert.equal(info.icons[0].src, base + "/icon.png");
    assert.deepEqual(Buffer.from(await (await fetch(info.icons[0].src)).arrayBuffer()), png);
  } finally { handle.kill(); }
});
