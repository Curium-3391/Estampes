#!/usr/bin/env node
// Round-trip check of the backup/restore procedure in docs/BACKUP-RESTORE.md.
// Everything happens in temporary folders; nothing of yours is touched and no
// Docker is needed:
//   node scripts/verify-backup-restore.mjs
// 1. start a server on a fresh storage folder A (and the SymPy service, if
//    python3 with sympy is installed),
// 2. make canvases, layers, marks (GPT's and a user's), a link and its
//    review, a workspace, enabled modules, a calculator panel with a notebook
//    cell and a plot,
// 3. stop it, pack A with tar exactly as the docs do, unpack into folder B,
// 4. start a different server on B and compare what it reports with what A
//    reported.
// It checks the data format round trip. It does not run Docker volumes.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, access, rm, readFile } from "node:fs/promises";
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
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "  " + detail)); };

async function freePort() { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
async function startServer(dir, sock) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0" };
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
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

const work = await mkdtemp(join(tmpdir(), "estampes-backup-"));
const A = join(work, "volume-a"), B = join(work, "volume-b"), archive = join(work, "estampes.tgz");
await mkdir(A); await mkdir(B);
let cas = null;
const sock = join(work, "cas.sock");
if (hasCas) {
  cas = spawn(python, ["-m", "estampes_cas"], { cwd: join(root, "cas-service"), env: { ...process.env, ESTAMPES_CAS_SOCKET: sock, PYTHONPATH: join(root, "cas-service") }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await access(sock); break; } catch { await sleep(100); } }
} else console.log("note: python3 with sympy not found; the calculator part is skipped");

let s1, s2;
try {
  const photo = await storedImage(A, 1200, 800, "#1f5c3a"), left = await storedImage(A, 900, 600, "#555"), right = await storedImage(A, 900, 600, "#aaa");
  s1 = await startServer(A, hasCas ? sock : null);
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
    const plotted = await s1.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: {} });
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
  await s1.stop(); s1 = null;

  const pack = spawnSync("tar", ["czf", archive, "-C", A, "."]);
  check("backup archive created", pack.status === 0, String(pack.stderr));
  const unpack = spawnSync("tar", ["xzf", archive, "-C", B]);
  check("archive unpacks into an empty folder", unpack.status === 0, String(unpack.stderr));

  s2 = await startServer(B, hasCas ? sock : null);
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
  const health = JSON.parse(await readFile(join(B, "images", photo.slice(4), "canvas.json"), "utf8"));
  check("restored folder holds canvas.json for the image", Array.isArray(health.layers ?? health.annotations ?? Object.keys(health)));
} catch (e) {
  check("verification ran to the end", false, String(e?.stack ?? e));
} finally {
  await s1?.stop().catch(() => {}); await s2?.stop().catch(() => {});
  cas?.kill();
  await rm(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
