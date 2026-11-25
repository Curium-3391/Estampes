// #86 F2: the flow-graph renderer in the widget. FAKE HOST: the flow module is scripted by the test host (what is real is the server, the widget and
// the renderer that draws the flow and calls execute_module); the module and the flow service behind it are covered by flow-module.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noBrowser } from "./helpers/widget-host.js";

const MOD = "org.estampes.flow", FID = "fl:0123456789ab";
const ok = (data) => ({ content: [{ type: "text", text: "ok" }], structuredContent: { kind: "estampes.module_result", status: "ok", data } });
const ACTIONS = { list: "flow_list", get: "flow_get", create: "flow_create", edit: "flow_edit", undo: "flow_undo", run: "flow_run" };

function script({ valid = true, active = false } = {}) {
  const st = { rev: 1, r: 1000, fresh: false, last: null, calls: [] };
  const flow = () => ({ schema: "estampes.flow/1", nodes: [
    { id: "rc1", module: "org.example.rc", capability: "cutoff", params: { r: st.r, c: 1e-7 } },
    { id: "plot", module: "org.example.plot", capability: "response", params: { points: 50 } },
    { id: "label", module: "org.example.plot", capability: "label" }],
  edges: [{ from: { node: "rc1", port: "fc" }, to: { node: "plot", port: "fc" } }, { from: { node: "plot", port: "peak" }, to: { node: "label", port: "peak" } }] });
  const view = () => ({ id: FID, name: "RC low-pass", revision: st.rev, updatedAt: "2026-11-25T00:00:00Z", flow: flow(), valid,
    ...(valid ? { order: ["rc1", "plot", "label"], plan: Object.fromEntries(["rc1", "plot", "label"].map((n) => [n, { status: st.fresh ? "fresh" : "stale" }])) } : { errors: [{ path: "nodes[1].params", code: "missing-input", message: "plot needs fc" }] }),
    results: st.fresh ? { rc1: { status: "fresh", revision: 1, data: { fc: 1592 } }, plot: { status: "fresh", revision: 1, data: { peak: 1 } }, label: { status: "fresh", revision: 1, data: { text: "peak 1" } } } : {}, running: false });
  const intercept = async (params, call) => {
    if (params.name === "execute_module" && params.arguments.module === MOD) {
      const { capability, params: p } = params.arguments;
      st.calls.push([capability, p]);
      if (capability === "flow_list") return ok({ flows: [{ id: FID, name: "RC low-pass", revision: st.rev, nodes: 3, edges: 2, updatedAt: "2026-11-25T00:00:00Z" }] });
      if (capability === "flow_get") return ok(view());
      if (capability === "flow_edit") {
        if (p.expectedRevision !== st.rev) throw new Error("changed since revision " + p.expectedRevision);
        const op = p.ops[0];
        if (op.op === "set_params") { st.r = JSON.parse(op.paramsJson).r; st.rev++; st.fresh = false; st.last = p.commandId; }
        return ok({ commandId: p.commandId, status: "applied", ...view() });
      }
      if (capability === "flow_run") { st.fresh = true; return ok({ ok: true, ran: ["rc1", "plot", "label"], reused: [], failed: [], blocked: [], cancelled: [], resultsKept: true, ...view() }); }
      if (capability === "flow_undo") { st.r = 1000; st.rev++; return ok({ status: "applied", ...view() }); }
    }
    if (params.name === "surface_get_state") {
      const r = await call(params), sc = structuredClone(r.structuredContent), id = "p:view-flow0";
      sc.panels.push({ panelId: id, kind: "module-view", module: MOD, panel: "view-flow", view: "flow", open: true, title: "Flow", moduleState: "enabled" });
      for (const lay of Object.values(sc.layouts)) { lay.order.push(id); if (active) lay.active = id; lay.placements[id] = { mode: "normal", rect: { x: 0.3, y: 0, w: 0.7, h: 1 }, z: 5 }; }
      sc.moduleViews = { [id]: { module: MOD, view: "flow", reads: [], actions: Object.values(ACTIONS), bound: {}, instances: {}, renderer: { type: "flow-graph", schema: "estampes.renderer.flow-graph/1", payload: { actions: ACTIONS } } } };
      return { content: r.content, structuredContent: sc };
    }
    return undefined;
  };
  return { st, intercept };
}
async function open(sc, opts = {}) {
  const s = await startStack({ cas: false }); await s.enable(["org.estampes.graph"]);
  const canvas = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "graph" } });
  const imageId = (JSON.stringify(canvas.structuredContent).match(/gph:[0-9a-f]{16}/) ?? [])[0];
  assert.ok(imageId, "a canvas to hang the surface on");
  return { s, ui: await s.open({ imageId, intercept: sc.intercept, ...opts }) };
}

test("a flow is drawn in columns by dependency; a person changes an input and runs it, then undoes", { skip: noBrowser, timeout: 120000 }, async () => {
  const sc = script(), { s, ui } = await open(sc);
  try {
    await ui.frame.locator(".fv-node").first().waitFor({ timeout: 30000 });
    assert.equal(await ui.frame.locator(".fv-col").count(), 3, "rc1 -> plot -> label are three columns");
    assert.deepEqual(await ui.frame.locator(".fv-col").evaluateAll((cols) => cols.map((c) => c.querySelector(".fv-id").textContent)), ["rc1", "plot", "label"]);
    assert.equal(await ui.frame.locator(".fv-edges li").count(), 2);
    assert.match(await ui.frame.locator(".fv-edges li").first().textContent(), /rc1\.fc → plot\.fc/);
    assert.equal(await ui.frame.locator('.fv-node[data-status="stale"]').count(), 3);
    await ui.frame.locator('.fv-node[data-node="rc1"]').click();
    const r = ui.frame.getByLabel("r", { exact: true });
    await r.fill("2000"); await r.dispatchEvent("change");
    await ui.page.waitForFunction(() => document.querySelector("iframe").contentDocument.querySelector(".fv-state")?.textContent.includes("2"), null, { timeout: 10000 });
    const edit = sc.st.calls.find(([c]) => c === "flow_edit");
    assert.equal(edit[1].expectedRevision, 1);
    assert.deepEqual(edit[1].ops, [{ op: "set_params", id: "rc1", paramsJson: JSON.stringify({ r: 2000, c: 1e-7 }) }]);
    assert.match(edit[1].commandId, /^ui_/);
    await ui.frame.locator(".fv-run").click();
    await ui.frame.locator('.fv-node[data-status="fresh"]').first().waitFor({ timeout: 10000 });
    assert.equal(await ui.frame.locator('.fv-node[data-status="fresh"]').count(), 3);
    assert.match(await ui.frame.locator('.fv-node[data-node="label"] .fv-out').textContent(), /peak 1/);
    await ui.frame.getByRole("button", { name: /Undo|復原/ }).click();
    await ui.page.waitForFunction(() => document.querySelector("iframe").contentDocument.querySelector('.fv-node[data-node="rc1"]'), null, { timeout: 10000 });
    assert.ok(sc.st.calls.some(([c, p]) => c === "flow_undo" && p.of === edit[1].commandId), "undo names the edit it undoes");
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});

test("an invalid flow lists its problems and cannot be run", { skip: noBrowser, timeout: 120000 }, async () => {
  const sc = script({ valid: false }), { s, ui } = await open(sc);
  try {
    await ui.frame.locator(".fv-errors li").first().waitFor({ timeout: 30000 });
    assert.match(await ui.frame.locator(".fv-errors li").first().textContent(), /plot needs fc/);
    assert.equal(await ui.frame.locator(".fv-run").isDisabled(), true);
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});

test("on a phone-sized touch screen the flow fits without sideways scrolling", { skip: noBrowser, timeout: 120000 }, async () => {
  const sc = script({ active: true }), { s, ui } = await open(sc, { viewport: { width: 375, height: 700 }, touch: true });
  try {
    await ui.frame.locator(".fv-node").first().waitFor({ timeout: 30000 });
    const inner = ui.page.frames().find((f) => f !== ui.page.mainFrame());
    const m = await inner.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      small: [...document.querySelectorAll(".fv-node, .fv-run")].map((e) => e.getBoundingClientRect().height) }));
    assert.ok(m.over <= 1, "no horizontal overflow: " + m.over);
    assert.ok(m.small.every((x) => x >= 40), JSON.stringify(m.small));
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});
