// Power-loss simulation (scripts/powerloss): every crash point is rebuilt as a
// power cut could leave the folders (only fsynced bytes and directory entries
// survive) and the store must reopen with every acknowledged result. Small runs
// here; scripts/powerloss/*.mjs --profile linux-local-durable on a real ext4 or
// XFS mount is the full qualification (docs/UVA-POWERLOSS.md).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile, unlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createUvaService } from "../src/uva/service.js";

const run = promisify(execFile);
async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), "estampes-pl-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function simulate(t, script, args) {
  const dir = await folder(t), out = join(dir, "report.json");
  await run(process.execPath, [script, "--dir", dir, "--out", out, ...args], { maxBuffer: 64 * 1024 * 1024 }).catch((error) => error);
  const report = JSON.parse(await readFile(out, "utf8"));
  assert.ok(report.crashPoints > 10, "crash points checked: " + report.crashPoints);
  assert.deepEqual(report.failures, [], JSON.stringify(report.failures.slice(0, 3)));
  return report;
}

test("store: acknowledged commits survive a power cut at every checked fsync", { timeout: 600000 }, async (t) => {
  const r = await simulate(t, "scripts/powerloss/simulate.mjs", ["--commits", "4", "--points", "12", "--every-first", "1"]);
  assert.ok(r.workload.fileSyncs > 50 && r.workload.dirSyncs > 50);
});

test("server: acknowledged marks, layers and workspaces survive a power cut", { timeout: 900000 }, async (t) => {
  await simulate(t, "scripts/powerloss/server.mjs", ["--edits", "6", "--points", "10"]);
});

test("an initialization a power cut interrupted is started again, not refused", { timeout: 60000 }, async (t) => {
  const dir = await folder(t), root = join(dir, "uva");
  await mkdir(join(root, "estampes-pr1c-beta"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "assets"), { mode: 0o700 });
  await writeFile(join(root, "estampes-pr1c-beta", "storage-format.json"), "");
  const svc = await createUvaService({ enabled: true, directory: root, profile: "linux-process-crash-test", canvasStore: true });
  assert.equal(svc.store.status.state, "ready");
  await svc.close();
  // A folder with anything else in it is still refused.
  const other = join(dir, "other");
  await mkdir(other, { mode: 0o700 });
  await writeFile(join(other, "notes.txt"), "mine");
  await assert.rejects(createUvaService({ enabled: true, directory: other, profile: "linux-process-crash-test", canvasStore: true }), /Unrecognized Beta directory/);
});

test("an image whose legacy file a power cut emptied comes back from the UVA asset store", { timeout: 120000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const sharp = (await import("sharp")).default;
  const dir = await folder(t), storage = join(dir, "storage");
  const start = async () => {
    const port = await new Promise((done) => { const s = createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => done(port)); }); });
    const proc = spawn(process.execPath, ["server.js"], { stdio: "ignore", env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: storage,
      ESTAMPES_UVA_DIR: join(dir, "uva"), ESTAMPES_UVA_PROFILE: "linux-process-crash-test", ESTAMPES_CANVAS_STORE: "uva", ESTAMPES_UVA_MIRROR_IDLE_SEC: "0", ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0", ESTAMPES_RATE_LIMIT_PER_MIN: "0" } });
    for (let i = 0; i < 300; i++) { try { if ((await fetch("http://127.0.0.1:" + port + "/")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const client = new Client({ name: "pl", version: "0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp")));
    const exited = new Promise((r) => proc.once("exit", r));
    return { call: (name, args) => client.callTool({ name, arguments: args }), stop: async () => { await client.close().catch(() => {}); proc.kill("SIGKILL"); await exited; } };
  };
  let s = await start();
  const data = (await sharp({ create: { width: 160, height: 100, channels: 3, background: "#446688" } }).png().toBuffer()).toString("base64");
  const imageId = (await s.call("upload_visual_image", { total: data.length, offset: 0, data, fileName: "a.png" })).structuredContent.imageId;
  const drawn = await s.call("present_visual", { imageId, verify: false, annotations: [{ id: "k1", type: "point", x: .4, y: .4, label: "kept" }] });
  assert.ok(!drawn.isError, JSON.stringify(drawn.content));
  // Once the canvas is committed, its image is in the asset store too.
  for (let i = 0; i < 200; i++) {
    const d = (await s.call("uva_store", { action: "status" })).structuredContent?.diagnostics?.mirror?.canvasStore;
    if (d?.committed > 0 && !Object.values(d.pending ?? {}).length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await s.stop();
  const folderOf = join(storage, "images", imageId.slice(4));
  await writeFile(join(folderOf, "source"), "");
  for (const name of await readdir(folderOf)) if (name === "meta.json") await unlink(join(folderOf, name));
  s = await start();
  t.after(() => s.stop());
  const state = await s.call("get_visual_state", { imageId });
  assert.ok(!state.isError, JSON.stringify(state.content));
  assert.deepEqual(state.structuredContent.marks.map((m) => m.id), ["k1"]);
  assert.ok((await readFile(join(folderOf, "source"))).length > 0, "the legacy copy is repaired");
});
