import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { defaultLayout, defaultLayouts, applyLayoutOp, clampRect, snapRect, reconcile, profileFor, LayoutSchema, LayoutError, overlaps } from "../src/surface/layout.js";
import { validateManifest, ManifestError } from "../src/modules/manifest.js";
import { manifest as casManifest } from "../src/builtin-modules/cas/index.js";

const clone = (o) => JSON.parse(JSON.stringify(o));

test("layout: defaults put the viewport left and companions right; phones get tabs", () => {
  const d = defaultLayout("desktop", ["p:canvas", "p:cas1"]);
  assert.deepEqual(d.placements["p:canvas"].rect, { x: 0, y: 0, w: 0.62, h: 1 });
  assert.equal(overlaps(d.placements["p:canvas"].rect, d.placements["p:cas1"].rect), false);
  const m = defaultLayout("mobile", ["p:canvas", "p:cas1"]);
  assert.deepEqual(m.order, ["p:canvas", "p:cas1"]);
  assert.equal(m.active, "p:canvas");
  assert.ok(LayoutSchema.parse(d) && LayoutSchema.parse(m));
});

test("layout: panels stay reachable, snap to edges and neighbours, and keep a minimum size", () => {
  assert.deepEqual(clampRect({ x: 2, y: -1, w: 0.01, h: 5 }), { x: 0.8, y: 0, w: 0.2, h: 1 });
  const snapped = snapRect({ x: 0.612, y: 0.3, w: 0.38, h: 0.4 }, [{ x: 0, y: 0, w: 0.62, h: 1 }]);
  assert.equal(snapped.x, 0.62);
  const far = snapRect({ x: 0.3, y: 0.3, w: 0.3, h: 0.3 }, []);
  assert.equal(far.x, 0.3);
});

test("layout ops: arrange, focus, minimize, reorder; invalid ops are refused and change nothing", () => {
  const ids = ["p:canvas", "p:cas1"];
  const base = defaultLayout("desktop", ids);
  const moved = applyLayoutOp(base, { op: "arrange", panelId: "p:cas1", rect: { x: 0.5, y: 0.1, w: 0.4, h: 0.6 }, dock: "free" }, ids);
  assert.equal(moved.placements["p:cas1"].mode, "floating");
  assert.ok(moved.placements["p:cas1"].z > moved.placements["p:canvas"].z);
  assert.deepEqual(base, defaultLayout("desktop", ids), "the input layout is not mutated");
  assert.equal(applyLayoutOp(moved, { op: "minimize", panelId: "p:cas1" }, ids).placements["p:cas1"].mode, "minimized");
  assert.throws(() => applyLayoutOp(base, { op: "arrange", panelId: "p:nope", rect: { x: 0, y: 0, w: 1, h: 1 } }, ids), LayoutError);
  assert.throws(() => applyLayoutOp(base, { op: "arrange", panelId: "p:cas1", rect: { x: NaN, y: 0, w: 1, h: 1 } }, ids), LayoutError);
  assert.throws(() => applyLayoutOp(base, { op: "reorder", order: ["p:canvas"] }, ids), LayoutError);
  assert.throws(() => applyLayoutOp(base, { op: "evil" }, ids), LayoutError);
  const mobile = defaultLayout("mobile", ids);
  assert.deepEqual(applyLayoutOp(mobile, { op: "reorder", order: ["p:cas1", "p:canvas"] }, ids).order, ["p:cas1", "p:canvas"]);
  assert.equal(applyLayoutOp(mobile, { op: "sheet", sheet: "full" }, ids).sheet, "full");
});

test("layout: a stored layout is reconciled with the panel list and profiles do not touch each other", () => {
  const two = defaultLayouts(["p:canvas", "p:cas1"]);
  const desktopMoved = { ...two, desktop: applyLayoutOp(two.desktop, { op: "arrange", panelId: "p:cas1", rect: { x: 0.4, y: 0.2, w: 0.5, h: 0.5 } }, ["p:canvas", "p:cas1"]) };
  const back = reconcile(desktopMoved, ["p:canvas"]);
  assert.deepEqual(Object.keys(back.desktop.placements), ["p:canvas"]);
  const again = reconcile(back, ["p:canvas", "p:cas1"]);
  assert.ok(again.mobile.order.includes("p:cas1") && again.desktop.placements["p:cas1"]);
  assert.deepEqual(desktopMoved.mobile, two.mobile, "the phone layout was not rewritten by a desktop change");
  assert.equal(profileFor(390, 800), "mobile");
  assert.equal(profileFor(768, 1024), "tablet");
  assert.equal(profileFor(1280, 720), "desktop");
  assert.equal(profileFor(0, 0), "desktop");
});

test("panel descriptors: strict, bound to real capabilities, inert when the kind is unknown", () => {
  const base = clone(casManifest);
  assert.ok(validateManifest(base, { coreVersion: "0.18.0" }));
  const bad = (edit, re) => { const m = clone(casManifest); edit(m); assert.throws(() => validateManifest(m, { coreVersion: "0.18.0" }), re); };
  bad((m) => { m.panels[0].html = "<script>alert(1)</script>"; }, /panels/);
  bad((m) => { m.panels[0].capabilityBindings = ["format_disk"]; }, /no capability/);
  bad((m) => { m.panels[0].permissions = ["network.request.approved"]; }, /not in the module's permissions|panels/);
  bad((m) => { m.panels.push(clone(m.panels[0])); }, /duplicate/);
  bad((m) => { m.panels[0].schema = "estampes.panel/2"; }, /panels/);
  const odd = clone(casManifest); odd.panels[0].kind = "hologram";
  assert.equal(validateManifest(odd, { coreVersion: "0.18.0" }).panels[0].kind, "hologram");
});

// ---- over MCP, with the real server and the real SymPy service -------------
const python = process.env.PYTHON || "python3";
const skip = spawnSync(python, ["-c", "import sympy"]).status === 0 ? false : "python3 with sympy is not installed";
async function freePort() { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
async function startServer(dir, sock) {
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_CAS_SOCKET: sock, ESTAMPES_ALLOW_OPEN: "1", ESTAMPES_REQUIRE_KEY: "0" }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { if ((await fetch("http://127.0.0.1:" + port + "/")).ok) break; } catch {} await sleep(100); }
  const client = new Client({ name: "surface-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp")));
  return { handle, client, port };
}
const textOf = (r) => r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const call = (c, name, args) => c.callTool({ name, arguments: args });

test("surface over MCP: panels, calculator, plot, layouts per profile, restart", { skip, timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-surface-"));
  const sock = join(dir, "cas.sock");
  const cas = spawn(python, ["-m", "estampes_cas"], { cwd: "cas-service", env: { ...process.env, ESTAMPES_CAS_SOCKET: sock, PYTHONPATH: "cas-service" }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await access(sock); break; } catch { await sleep(100); } }
  let s = await startServer(dir, sock);
  try {
    const tools = Object.fromEntries((await s.client.listTools()).tools.map((t) => [t.name, t]));
    for (const n of ["surface_get_state", "surface_apply", "surface_cas"]) assert.deepEqual(tools[n]._meta.ui.visibility, ["app"], n);
    for (const n of ["get_surface_state", "manage_surface_panels"]) assert.notDeepEqual(tools[n]._meta?.ui?.visibility, ["app"], n);

    const health = await (await fetch("http://127.0.0.1:" + s.port + "/healthz")).json();
    assert.equal(health.cas.available, true);

    // Enable Graph and the calculator the way the user does, in the Store.
    for (const id of ["org.estampes.graph", "org.estampes.cas"]) {
      const prep = await call(s.client, "prepare_module_change", { action: "enable", module: id });
      const done = await call(s.client, "store_commit_plan", { planId: prep.structuredContent.plan.planId, consent: prep._meta["estampes/consent"].consent });
      assert.equal(done.structuredContent.result.state, "enabled");
    }
    const plotted = await call(s.client, "execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x^2" }, newCanvas: {} });
    const imageId = (JSON.stringify(plotted.structuredContent).match(/img:[0-9a-f]{16}/) ?? [])[0];
    assert.ok(imageId, "a blank canvas was made");

    let st = (await call(s.client, "surface_get_state", { imageId })).structuredContent;
    assert.deepEqual(st.panels.map((p) => p.panelId), ["p:canvas"]);
    assert.ok(st.available.some((a) => a.module === "org.estampes.cas" && a.enabled && a.kind === "calculator"));

    // Open the calculator next to the viewport.
    const opened = await call(s.client, "surface_apply", { imageId, ops: [{ op: "open-panel", module: "org.estampes.cas", panel: "calculator" }], idempotencyKey: "k-open" });
    st = opened.structuredContent;
    const calc = st.panels.find((p) => p.kind === "calculator");
    assert.ok(calc.open && /^nb:[0-9a-f]{12}$/.test(calc.notebook));
    assert.equal(st.layouts.desktop.placements[calc.panelId].dock, "right");
    assert.ok(st.layouts.mobile.order.includes(calc.panelId));
    const replay = await call(s.client, "surface_apply", { imageId, ops: [{ op: "open-panel", module: "org.estampes.cas", panel: "calculator" }], idempotencyKey: "k-open" });
    assert.equal(replay.structuredContent.panels.filter((p) => p.kind === "calculator").length, 1, "an idempotent replay does not open a second calculator");
    const again = await call(s.client, "surface_apply", { imageId, ops: [{ op: "open-panel", module: "org.estampes.cas", panel: "calculator" }, { op: "open-panel", module: "org.estampes.cas", panel: "calculator" }] });
    assert.equal(again.isError, true, "more instances than maxInstances are refused");

    // Type sin(x^2), differentiate, plot it.
    const calcRes = await call(s.client, "surface_cas", { imageId, capability: "calculate", params: { operation: "differentiate", text: "sin(x^2)", variable: "x", notebook: calc.notebook } });
    const cell = calcRes.structuredContent.data.cell;
    assert.equal(cell.result.plain, "2*x*cos(x^2)");
    const plot = await call(s.client, "surface_cas", { imageId, capability: "plot_result", params: { notebook: calc.notebook, cell: cell.cellId, domain: [-3, 3] } });
    assert.equal(plot.isError, undefined);
    assert.ok(plot.structuredContent.objects.some((o) => o.type === "function-plot" && o.editable.expression === "2*x*cos(x^2)" && o.module === "org.estampes.cas"));
    assert.ok(plot.structuredContent.objects.some((o) => o.editable?.expression === "x^2" && o.module === "org.estampes.graph"), "the plot that was already there is untouched");

    // The model reads the same state, without screenshots.
    const model = (await call(s.client, "get_surface_state", { imageId })).structuredContent;
    const mcell = Object.values(model.notebooks)[0].cells[0];
    assert.equal(mcell.result.plain, "2*x*cos(x^2)");
    assert.equal(mcell.state, "fresh");
    assert.equal(mcell.links[0].status, "fresh");

    // Phone layout is separate from the desktop layout.
    const rev = (await call(s.client, "surface_get_state", { imageId })).structuredContent.revision;
    const moved = await call(s.client, "surface_apply", { imageId, expectedRevision: rev, ops: [{ op: "layout", profile: "desktop", layout: { op: "arrange", panelId: calc.panelId, rect: { x: 0.5, y: 0.1, w: 0.4, h: 0.6 }, dock: "free" } }] });
    assert.equal(moved.structuredContent.layouts.desktop.placements[calc.panelId].mode, "floating");
    assert.deepEqual(moved.structuredContent.layouts.mobile.order, st.layouts.mobile.order);
    const stale = await call(s.client, "surface_apply", { imageId, expectedRevision: rev, ops: [{ op: "layout", profile: "desktop", layout: { op: "focus", panelId: calc.panelId } }] });
    assert.equal(stale.isError, true);
    assert.match(textOf(stale), /changed since revision/);

    // Closing a panel keeps its notebook; restarting the server keeps everything.
    await call(s.client, "surface_apply", { imageId, ops: [{ op: "close-panel", panelId: calc.panelId }] });
    s.handle.kill("SIGTERM"); await sleep(500);
    s = await startServer(dir, sock);
    const after = (await call(s.client, "surface_get_state", { imageId })).structuredContent;
    const kept = after.panels.find((p) => p.panelId === calc.panelId);
    assert.equal(kept.open, false);
    assert.equal(kept.notebook, calc.notebook);
    const reopen = await call(s.client, "manage_surface_panels", { imageId, action: "open", module: "org.estampes.cas", panel: "calculator" });
    const nbs = (await call(s.client, "get_surface_state", { imageId })).structuredContent.notebooks;
    assert.equal(Object.values(nbs)[0].cells[0].result.plain, "2*x*cos(x^2)");
    assert.equal(reopen.structuredContent.panels.find((p) => p.panelId === calc.panelId).open, true);

    // A disabled module cannot be used from a panel.
    const dis = await call(s.client, "prepare_module_change", { action: "disable", module: "org.estampes.cas" });
    await call(s.client, "store_commit_plan", { planId: dis.structuredContent.plan.planId, consent: dis._meta["estampes/consent"].consent });
    const blocked = await call(s.client, "surface_cas", { imageId, capability: "calculate", params: { operation: "evaluate", text: "1+1" } });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /Only the user can enable|disabled/);
  } finally {
    s.handle.kill("SIGKILL"); cas.kill("SIGKILL");
  }
});
