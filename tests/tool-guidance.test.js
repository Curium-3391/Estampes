// #87: the server tells the model which tools to use next, and every error
// says which Estampes tool replied, so "tools are unavailable" cannot be a
// plausible reading of a real reply.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { t } from "../src/i18n/index.js";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SERVER_INSTRUCTIONS, provenanceNote, withErrorProvenance } from "../src/tool-guidance.js";

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

test("withErrorProvenance appends a note to errors only, once, keeping the first block", () => {
  const ok = { content: [{ type: "text", text: "fine" }] };
  assert.equal(withErrorProvenance("present_visual", ok), ok);
  const err = { isError: true, content: [{ type: "text", text: "no such mark" }] };
  const out = withErrorProvenance("edit_visual_canvas", err);
  assert.equal(out.content[0].text, "no such mark", "widgets show content[0] to the user unchanged");
  assert.equal(out.content.at(-1).text, provenanceNote("edit_visual_canvas"));
  assert.equal(withErrorProvenance("edit_visual_canvas", out).content.length, 2, "idempotent");
});

test("instructions name the follow-up tools for an uploaded image and a running job", () => {
  for (const name of ["inspect_image", "present_visual", "get_module_job", "render_canvas"]) assert.match(SERVER_INSTRUCTIONS, new RegExp(name));
  assert.match(SERVER_INSTRUCTIONS, /Never tell the user a tool is unavailable/);
  assert.match(SERVER_INSTRUCTIONS, /not attempted, called and failed/);
});

test("the canvas upload message names the imageId and the tools to call on it", () => {
  const html = readFileSync(new URL("../public/visual-surface.html", import.meta.url), "utf8");
  // The widget fills the catalog message with the exact tool calls for this image.
  const at = html.indexOf('t("vs.upload.message"');
  assert.ok(at > 0);
  const call = html.slice(at, at + 400);
  assert.match(call, /inspect:"inspect_image\(\{imageId/);
  assert.match(call, /present:"present_visual\(\{imageId/);
  const msg = t("vs.upload.message", { id: "img:0", width: 1, height: 1, name: '"a.png"', inspect: "INSPECT", present: "PRESENT" });
  assert.match(msg, /^我在 Estampes 畫布上傳了一張圖片：img:0/);
  assert.match(msg, /不需要重新上傳/);
  assert.match(msg, /INSPECT[\s\S]*PRESENT/);
});

test("initialize carries the instructions and a real tool error says which tool replied", { timeout: 30000 }, async () => {
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "guidance-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    const missing = await client.callTool({ name: "present_visual", arguments: { imageId: "img:0000000000000000" } });
    assert.equal(missing.isError, true);
    assert.doesNotMatch(missing.content[0].text, /^\(Estampes/, "the tool's own message comes first");
    assert.equal(missing.content.at(-1).text, provenanceNote("present_visual"));
    const job = await client.callTool({ name: "get_module_job", arguments: { job: "job_000000000000" } });
    assert.equal(job.isError, true);
    assert.equal(job.content.at(-1).text, provenanceNote("get_module_job"));
  } finally {
    await client.close().catch(() => {});
    handle.kill();
  }
});
