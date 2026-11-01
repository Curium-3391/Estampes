// The module author's walkthrough in docs/modules/QUICKSTART.md, run for real:
// init -> test -> keygen -> pack -> verify (untrusted) -> trust -> verify ->
// inbox -> install (user consent + administrator approval) -> enable -> run ->
// refused input changes nothing. Also checks that every bundled example
// manifest passes the validator and its own examples.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const cli = (storage, cwd, ...args) => spawnSync(process.execPath, [join(process.cwd(), "scripts/estampes-module.js"), ...args], { cwd, env: { ...process.env, ESTAMPES_STORAGE_DIR: storage }, encoding: "utf8" });
async function freePort() { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }

test("every bundled example module passes the validator and its own examples", async () => {
  const storage = await mkdtemp(join(tmpdir(), "estampes-ex-"));
  try {
    for (const name of await readdir("examples/modules")) {
      const r = cli(storage, process.cwd(), "test", join("examples/modules", name, "module.json"));
      assert.equal(r.status, 0, name + ": " + r.stderr + r.stdout);
      assert.match(r.stdout, /^OK /, name);
    }
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test("author walkthrough: create, test, sign, trust, install, enable, run", { timeout: 60000 }, async () => {
  const storage = await mkdtemp(join(tmpdir(), "estampes-author-store-"));
  const work = await mkdtemp(join(tmpdir(), "estampes-author-work-"));
  let handle, client;
  try {
    let r = cli(storage, work, "init", "mymodule", "org.example.labeler");
    assert.equal(r.status, 0, r.stderr);
    r = cli(storage, work, "test", "mymodule/module.json");
    assert.match(r.stdout, /^OK org\.example\.labeler 0\.1\.0: manifest valid, 1 example\(s\) passed/);
    // A broken example is caught before anything is packed.
    const manifest = JSON.parse(await readFile(join(work, "mymodule/module.json"), "utf8"));
    manifest.capabilities[0].examples.push({ description: "out of range", params: { x: 2, y: 0.1, text: "hi" } });
    await writeFile(join(work, "broken.json"), JSON.stringify(manifest));
    r = cli(storage, work, "test", "broken.json");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /self-test: add_label example\.x: must be <= 1/);

    assert.equal(cli(storage, work, "keygen", "mykey").status, 0);
    r = cli(storage, work, "pack", "mymodule/module.json", "--out", "org.example.labeler.estpkg.json", "--key", "mykey.private.pem", "--key-id", "mykey");
    assert.match(r.stdout, /signed$/m);
    r = cli(storage, work, "verify", "org.example.labeler.estpkg.json");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not trust/);
    assert.equal(cli(storage, work, "trust", "mykey", "mykey.public.pem", "Example Author", "org.example").status, 0);
    r = cli(storage, work, "verify", "org.example.labeler.estpkg.json");
    assert.match(r.stdout, /^OK org\.example\.labeler 0\.1\.0 {2}digest [0-9a-f]{64} {2}signed by Example Author \(mykey\)/);
    assert.equal(cli(storage, work, "copy", "org.example.labeler.estpkg.json").status, 0);
    assert.match(cli(storage, work, "inbox").stdout, /ok {3}org\.example\.labeler 0\.1\.0 signed by Example Author/);

    const port = await freePort();
    handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: storage, ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0" }, stdio: "ignore" });
    const base = "http://127.0.0.1:" + port;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/healthz")).ok) break; } catch {} await sleep(100); }
    client = new Client({ name: "author-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const call = async (name, args) => { const x = await client.callTool({ name, arguments: args }); assert.notEqual(x.isError, true, name + ": " + x.content?.[0]?.text); return x; };
    const confirm = async (action, module, approve) => {
      const prep = await call("prepare_module_change", { action, module });
      if (approve) {
        assert.equal(prep.structuredContent.plan.requiresAdmin, true);
        // The administrator approves on the server; the chat cannot do this.
        const a = cli(storage, work, "approve", prep.structuredContent.plan.planId);
        assert.equal(a.status, 0, a.stderr);
      }
      return (await call("store_commit_plan", { planId: prep.structuredContent.plan.planId, consent: prep._meta["estampes/consent"].consent })).structuredContent.result;
    };
    assert.equal((await confirm("install", "org.example.labeler", true)).state, "installed");
    assert.equal((await confirm("enable", "org.example.labeler", false)).state, "enabled");
    await confirm("enable", "org.estampes.graph", false);

    // add_label targets an existing canvas, so make one with Graph first.
    const plotted = await call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: {} });
    const imageId = JSON.stringify(plotted.structuredContent).match(/img:[0-9a-f]{16}/)[0];
    const ran = await call("execute_module", { module: "org.example.labeler", capability: "add_label", params: { x: 0.2, y: 0.2, text: "hello" }, canvas: imageId });
    const revision = ran.structuredContent.module.revision;
    assert.equal(ran.structuredContent.module.created.length, 1);
    const bad = await client.callTool({ name: "execute_module", arguments: { module: "org.example.labeler", capability: "add_label", params: { x: 2, y: 0.2, text: "no" }, canvas: imageId } });
    assert.equal(bad.isError, true, "input outside the schema is refused");
    const state = (await call("get_visual_state", { imageId })).structuredContent;
    assert.equal(state.objects.filter((o) => o.type === "shape").length, 1, "the refused call changed nothing");
    assert.equal([].concat(state.sceneRevisions).find((x) => x?.image === imageId)?.revision, revision, "and the scene revision did not move");
  } finally {
    await client?.close().catch(() => {});
    handle?.kill();
    await rm(storage, { recursive: true, force: true }); await rm(work, { recursive: true, force: true });
  }
});
