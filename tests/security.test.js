import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveAccessKey, clientIp, exportSignature, exportAllowed, KEY_FILE } from "../src/security.js";

test("a required key is generated once, saved with mode 600 and reused; an explicit key or opt-out wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "estampes-key-"));
  const first = await resolveAccessKey({ require: true, storageDir: dir });
  assert.equal(first.source, "generated");
  assert.match(first.key, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(statSync(join(dir, KEY_FILE)).mode & 0o777, 0o600);
  const again = await resolveAccessKey({ require: true, storageDir: dir });
  assert.deepEqual([again.source, again.key], ["file", first.key]);
  assert.deepEqual(await resolveAccessKey({ configured: "mine", require: true, storageDir: dir }), { key: "mine", source: "env" });
  assert.deepEqual(await resolveAccessKey({ require: true, allowOpen: true, storageDir: dir }), { key: "", source: "open" });
  assert.deepEqual(await resolveAccessKey({}), { key: "", source: "open" });
  const memory = await resolveAccessKey({ require: true });
  assert.equal(memory.source, "memory");
  assert.ok(memory.key.length >= 32);
});

test("X-Forwarded-For counts only behind the number of proxies the operator trusts", () => {
  const req = (xff) => ({ socket: { remoteAddress: "10.0.0.2" }, headers: xff ? { "x-forwarded-for": xff } : {} });
  assert.equal(clientIp(req("1.2.3.4"), 0), "10.0.0.2");
  assert.equal(clientIp(req("6.6.6.6, 1.2.3.4"), 1), "1.2.3.4");
  assert.equal(clientIp(req("6.6.6.6, 1.2.3.4, 172.16.0.9"), 2), "1.2.3.4");
  assert.equal(clientIp(req(""), 1), "10.0.0.2");
});

test("download links are signed per image and file when a key exists", () => {
  const sig = exportSignature("k", "0123456789abcdef", "image.jpg");
  assert.equal(exportAllowed("k", "0123456789abcdef", "image.jpg", sig), true);
  assert.equal(exportAllowed("k", "0123456789abcdef", "marks.svg", sig), false);
  assert.equal(exportAllowed("k", "fedcba9876543210", "image.jpg", sig), false);
  assert.equal(exportAllowed("other", "0123456789abcdef", "image.jpg", sig), false);
  assert.equal(exportAllowed("k", "0123456789abcdef", "image.jpg", null), false);
  assert.equal(exportAllowed("", "0123456789abcdef", "image.jpg", null), true);
});

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

test("the Docker defaults start a closed server and keep its key across restarts", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "estampes-srv-"));
  const port = await freePort(), base = "http://127.0.0.1:" + port;
  const env = { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_REQUIRE_KEY: "1", ESTAMPES_ACCESS_KEY: "", ESTAMPES_ALLOW_OPEN: "" };
  const run = async () => {
    let out = "";
    const h = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    h.stdout.on("data", (b) => { out += b; }); h.stderr.on("data", (b) => { out += b; });
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/healthz")).ok) break; } catch {} await sleep(100); }
    return { h, log: () => out };
  };
  let s = await run();
  try {
    const key = readFileSync(join(dir, KEY_FILE), "utf8").trim();
    assert.match(s.log(), /generated an access key\. Connector URL: https:\/\/<your host>\/mcp\?key=/);
    assert.equal((await fetch(base + "/mcp", { method: "POST" })).status, 401);
    assert.equal((await fetch(base + "/api/v1/canvas/0123456789abcdef")).status, 401);
    assert.equal((await fetch(base + "/api/v1/canvas/0123456789abcdef?key=" + key)).status, 404);
    assert.equal((await fetch(base + "/export/0123456789abcdef/image.jpg")).status, 403);
    const sig = exportSignature(key, "0123456789abcdef", "image.jpg");
    assert.equal((await fetch(base + "/export/0123456789abcdef/image.jpg?sig=" + sig)).status, 404);
    assert.equal((await (await fetch(base + "/version")).json()).accessKeyRequired, true);
    s.h.kill(); await sleep(300);
    s = await run();
    assert.match(s.log(), /access key loaded from/);
    assert.doesNotMatch(s.log(), new RegExp(key));
    assert.equal(existsSync(join(dir, KEY_FILE)), true);
  } finally { s.h.kill(); }
});
