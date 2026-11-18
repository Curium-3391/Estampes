#!/usr/bin/env node
// Round-trip check of the backup/restore procedure in docs/BACKUP-RESTORE.md.
// Everything happens in temporary folders; nothing of yours is touched and no
// Docker is needed:
//   node scripts/verify-backup-restore.mjs
// A server keeps its data in two roots: the storage folder (/data in Docker)
// and the UVA store (/uva-beta in Docker), where canvases, images,
// workspaces, surfaces and notebooks live by default. A backup must hold
// both. The check runs twice: once while recent changes are still durable
// pending records in the storage folder, and once after they were committed
// into the UVA store and the pending records removed.
// 1. start a server on fresh roots A (and the SymPy service, if python3 with
//    sympy is installed),
// 2. make canvases, layers, marks (GPT's and a user's), a link and its
//    review, a workspace, enabled modules, a calculator panel with a notebook
//    cell and a plot,
// 3. stop it, pack both roots of A into one archive with tar exactly as the
//    docs do, unpack into empty roots B,
// 4. start a different server on B and compare what it reports with what A
//    reported.
// It checks the data format round trip. It does not run Docker volumes.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, access, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { imageIdOf } from "../src/image-store.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.PYTHON || "python3";
const hasCas = spawnSync(python, ["-c", "import sympy"]).status === 0;
const results = [];
let scenario = "";
const check = (name, ok, detail = "") => { name = scenario + name; results.push({ name, ok }); console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "  " + detail)); };

async function freePort() { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
// The two roots, named as in Docker: data (the storage folder) and uva-beta.
async function startServer(root2, sock, idleSec) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: join(root2, "data"), ESTAMPES_UVA_DIR: join(root2, "uva-beta"),
    ESTAMPES_CANVAS_STORE: "uva", ESTAMPES_UVA_MIRROR_IDLE_SEC: String(idleSec), ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0",
    // The production profile also insists on a local ext4/XFS mount, which a
    // temporary folder may not be; this one keeps the same fsync barriers.
    ESTAMPES_UVA_BETA_PROFILE: process.env.ESTAMPES_UVA_BETA_PROFILE || "linux-process-crash-test" };
  delete env.ESTAMPES_UVA_BETA_DIR;
  if (sock) env.ESTAMPES_CAS_SOCKET = sock;
  const handle = spawn(process.execPath, ["server.js"], { cwd: root, env, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/healthz")).ok) break; } catch {} await sleep(100); }
  const client = new Client({ name: "backup-check", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(name + ": " + r.content?.[0]?.text); return r; };
  const stop = async () => { await client.close().catch(() => {}); handle.kill("SIGTERM"); await new Promise((r) => handle.once("exit", r)); };
  return { call, stop };
}
async function storedImage(dir, w, h, colour) {
  const bytes = await sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();
  const id = imageIdOf(bytes), folder = join(dir, "images", id.slice(4));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "source"), bytes);
  await writeFile(join(folder, "meta.json"), JSON.stringify({ imageId: id, source: "backup-check" }));
  return id;
}
// Drop fields that legitimately differ between two reads (clock values).
const stable = (o) => JSON.parse(JSON.stringify(o, (k, v) => (/(^|[a-z])(At|Ms|Time|time|ts)$|^(generatedAt|now|elapsed)/.test(k) ? undefined : v)));
// Key order carries no meaning (the UVA store keeps documents in canonical,
// sorted-key form), so values compare with sorted keys.
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const same = (a, b) => JSON.stringify(sorted(stable(a))) === JSON.stringify(sorted(stable(b)));

const pendingRecords = async (dir) => (await readdir(join(dir, "data", "uva-pending")).catch(() => [])).filter((n) => n.endsWith(".json"));
const sock = join(await mkdtemp(join(tmpdir(), "estampes-backup-cas-")), "cas.sock");
let cas = null;
if (hasCas) {
  cas = spawn(python, ["-m", "estampes_cas"], { cwd: join(root, "cas-service"), env: { ...process.env, ESTAMPES_CAS_SOCKET: sock, PYTHONPATH: join(root, "cas-service") }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await access(sock); break; } catch { await sleep(100); } }
} else console.log("note: python3 with sympy not found; the calculator part is skipped");

// committed: true waits until every change is committed into the UVA store
// (no pending record left in the storage folder) before the backup.
async function runScenario({ committed }) {
  scenario = committed ? "[committed] " : "[pending]   ";
  const work = await mkdtemp(join(tmpdir(), "estampes-backup-"));
  const A = join(work, "server-a"), B = join(work, "server-b"), archive = join(work, "estampes.tgz");
  // The UVA root must be private to the server's user (mode 700), as the
  // Docker image's /uva-beta is.
  for (const r of [A, B]) { await mkdir(join(r, "data"), { recursive: true }); await mkdir(join(r, "uva-beta"), { mode: 0o700 }); }
  // Pending records are committed after this idle time; an hour (the maximum) keeps them pending.
  const idle = committed ? 0 : 3600;
  let s1, s2;
  try {
    const photo = await storedImage(join(A, "data"), 1200, 800, "#1f5c3a"), left = await storedImage(join(A, "data"), 900, 600, "#555"), right = await storedImage(join(A, "data"), 900, 600, "#aaa");
    s1 = await startServer(A, hasCas ? sock : null, idle);
    const box = (id, x, side) => ({ id, type: "rect", x, y: 0.1, x2: x + 0.1, y2: 0.25, label: id, ...(side ? { side } : {}) });
    await s1.call("present_visual", { imageId: photo, verify: false, layer: "parts", annotations: [box("R12", 0.1), box("R13", 0.3)], findings: [{ id: "R12", note: "brown resistor", confidence: "medium" }] });
    await s1.call("present_visual", { imageId: photo, verify: false, layer: "second", annotations: [box("U1", 0.6)] });
    await s1.call("validate_visual_annotations", { imageId: photo, annotations: [{ id: "user-1", type: "point", x: 0.5, y: 0.5, label: "mine" }] });
    await s1.call("present_visual", { imageId: left, pairImageId: right, verify: false, annotations: [box("a", 0.1, "left"), box("b", 0.1, "right")], links: [{ id: "k1", left: "a", right: "b", confidence: "low" }] });
    await s1.call("review_visual_link", { imageId: left, pairImageId: right, linkId: "k1", review: "confirmed" });
    const ws = (await s1.call("create_workspace", { canvases: [photo, left, right], name: "backup check" })).structuredContent.workspaceId;
    let surface = null;
    if (hasCas) {
      for (const id of ["org.estampes.graph", "org.estampes.cas"]) {
        const prep = await s1.call("prepare_module_change", { action: "enable", module: id });
        await s1.call("store_commit_plan", { planId: prep.structuredContent.plan.planId, consent: prep._meta["estampes/consent"].consent });
      }
      const plotted = await s1.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: { kind: "image" } });
      surface = (JSON.stringify(plotted.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
      const opened = await s1.call("surface_apply", { imageId: surface, ops: [{ op: "open-panel", module: "org.estampes.cas", panel: "calculator" }] });
      const nb = opened.structuredContent.panels.find((p) => p.kind === "calculator").notebook;
      const cell = (await s1.call("surface_cas", { imageId: surface, capability: "calculate", params: { operation: "differentiate", text: "sin(x^2)", variable: "x", notebook: nb } })).structuredContent.data.cell;
      await s1.call("surface_cas", { imageId: surface, capability: "plot_result", params: { notebook: nb, cell: cell.cellId, domain: [-3, 3] } });
    }
    const read = async (s) => ({
      photo: (await s.call("get_visual_state", { imageId: photo })).structuredContent,
      pair: (await s.call("get_visual_state", { imageId: left, pairImageId: right })).structuredContent,
      workspace: (await s.call("get_workspace_state", { workspace: ws })).structuredContent,
      modules: (await s.call("list_modules", {})).structuredContent,
      surface: surface ? (await s.call("get_surface_state", { imageId: surface })).structuredContent : null,
      canvas: surface ? (await s.call("get_visual_state", { imageId: surface })).structuredContent : null,
    });
    const before = await read(s1);
    check("the UVA store is in use (not the legacy fallback)", (await readdir(join(A, "uva-beta"))).length > 0);
    if (committed) {
      for (let i = 0; i < 600 && (await pendingRecords(A)).length; i++) await sleep(100);
      check("every change was committed into the UVA store before the backup", !(await pendingRecords(A)).length);
    } else check("recent changes are still pending records at backup time", (await pendingRecords(A)).length > 0);
    await s1.stop(); s1 = null;

    // One archive of both roots, as in the docs: tar -C <parent> data uva-beta.
    const pack = spawnSync("tar", ["czf", archive, "-C", A, "data", "uva-beta"]);
    check("backup archive of both roots created", pack.status === 0, String(pack.stderr));
    const unpack = spawnSync("tar", ["xzf", archive, "-C", B]);
    check("archive unpacks into empty roots", unpack.status === 0, String(unpack.stderr));

    s2 = await startServer(B, hasCas ? sock : null, idle);
    const after = await read(s2);
    check("canvas: marks, layers, findings, user mark", same(before.photo, after.photo));
    check("paired view: marks and the confirmed link", same(before.pair, after.pair));
    check("workspace: items, placement, totals", same(before.workspace, after.workspace));
    check("module state (enabled modules)", same(before.modules, after.modules));
    if (hasCas) {
      check("surface: open panels and layouts", same(before.surface, after.surface));
      check("calculator notebook: cell, result, plot link", Object.keys(before.surface.notebooks ?? {}).length > 0 && same(before.surface.notebooks, after.surface.notebooks));
      check("plot canvas: scene objects", same(before.canvas, after.canvas));
    }
    const has = (o, text) => JSON.stringify(o).includes(text);
    check("the data compared is not empty", has(before.photo, "brown resistor") && has(before.photo, "user-1") && has(before.pair, "confirmed") && before.workspace.items?.length === 3);
    check("the comparison can tell two canvases apart", !same(before.photo, before.pair));
    await s2.stop(); s2 = null;
    // The archive without the UVA root is not a backup: a server on it
    // must not show the canvases (this is what the old docs produced).
    if (committed) {
      const C = join(work, "server-c");
      await mkdir(join(C, "uva-beta"), { recursive: true, mode: 0o700 });
      await mkdir(join(C, "data"));
      spawnSync("tar", ["xzf", archive, "-C", C, "data"]);
      const s3 = await startServer(C, null, idle);
      let lost = false;
      try { lost = !same(before.photo, (await s3.call("get_visual_state", { imageId: photo })).structuredContent); } catch { lost = true; }
      await s3.stop();
      check("a backup of the storage folder alone misses committed work (so both roots are required)", lost);
    }
  } catch (e) {
    check("verification ran to the end", false, String(e?.stack ?? e));
  } finally {
    await s1?.stop().catch(() => {}); await s2?.stop().catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}

try {
  await runScenario({ committed: false });
  await runScenario({ committed: true });
} finally { cas?.kill(); }
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
