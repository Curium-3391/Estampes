import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { imageIdOf } from "../src/image-store.js";

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

// Images are placed in the storage folder, as if loaded in an earlier session.
async function storedImage(dir, w, h, colour) {
  const bytes = await sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();
  const id = imageIdOf(bytes), folder = join(dir, "images", id.slice(4));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "source"), bytes);
  await writeFile(join(folder, "meta.json"), JSON.stringify({ imageId: id, source: "test" }));
  return id;
}

test("claims over MCP: unverified until the user reviews, a rejection refuses the repeat", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-claims-"));
  const left = await storedImage(dir, 800, 600, "#fff"), right = await storedImage(dir, 600, 800, "#264");
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "claims-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  const box = (id, side, x = 0.1) => ({ id, side, type: "rect", x, y: 0.1, x2: x + 0.1, y2: 0.2 });
  const call = (args) => client.callTool({ name: "present_visual", arguments: { imageId: left, pairImageId: right, verify: false, ...args } });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.find((t) => t.name === "review_visual_finding")?._meta?.ui?.visibility, ["app"], "verdicts come only from the canvas");

    const first = await call({ annotations: [box("s1", "left"), box("p1", "right")], links: [{ id: "k1", left: "s1", right: "p1", label: "IC501", confidence: "high",
      evidence: [{ kind: "text", region: [0.1, 0.1, 0.2, 0.2], says: "left reads IC501" }], ambiguities: ["right board number not read"] }] });
    assert.notEqual(first.isError, true, first.content?.[0]?.text);
    const text = first.content[0].text;
    assert.match(text, /k1 "IC501": left s1 <-> right p1 \[high, evidence model 1 tool 0, UNVERIFIED; unresolved: right board number not read\]/);
    assert.match(text, /1 link\(s\) are UNVERIFIED/);
    assert.deepEqual(first.structuredContent.links[0].claim, { verification: "unverified", confidence: "high", evidence: { model: 1, tool: 0, user: 0 }, ambiguities: ["right board number not read"] });
    assert.equal(first._meta["estampes/links"][0].evidence[0].image, left, "the widget gets each piece of evidence");

    const review = await client.callTool({ name: "review_visual_link", arguments: { imageId: left, pairImageId: right, linkId: "k1", review: "rejected", reason: "右圖板號看不到" } });
    assert.equal(review.structuredContent.link.verification, "user-rejected");

    const again = await call({ remove: ["s1", "p1"], annotations: [box("s2", "left"), box("p2", "right")], links: [{ id: "k2", left: "s2", right: "p2", label: "IC501" }] });
    assert.notEqual(again.isError, true, again.content?.[0]?.text);
    assert.match(again.content[0].text, /REFUSED .*link k2 \(user's reason: 右圖板號看不到\)/);
    assert.match(again.content[0].text, /The user REJECTED these claims/);
    assert.deepEqual(again.structuredContent.links, []);

    const state = await client.callTool({ name: "get_visual_state", arguments: { imageId: left, pairImageId: right } });
    const doc = JSON.parse(state.content[0].text.slice(state.content[0].text.indexOf("{")));
    assert.equal(doc.protocol, "estampes.visual/2");
    assert.equal(doc.rejections[0].reason, "右圖板號看不到");
  } finally {
    await client.close().catch(() => {});
    handle.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
