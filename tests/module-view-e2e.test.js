// #85 V2-3: the declarative renderer in the widget. FAKE HOST: the module is scripted by the test host (the server runs no module
// with a view yet); what is real is the server, the widget, and the renderer that draws the view's tree and calls execute_module.
import test from "node:test";
import assert from "node:assert/strict";
import { startStack, noBrowser } from "./helpers/widget-host.js";

const MOD = "org.example.logic";
const ROOT = { type: "stack", children: [
  { type: "toggle", label: "A", model: "fa", path: "/a", action: "set", params: { id: { $: "instance" }, field: "a", on: { $: "value" } } },
  { type: "toggle", label: "B", model: "fa", path: "/b", action: "set", params: { id: { $: "instance" }, field: "b", on: { $: "value" } } },
  { type: "toggle", label: "Cin", model: "fa", path: "/cin", action: "set", params: { id: { $: "instance" }, field: "cin", on: { $: "value" } } },
  { type: "readout", label: "Sum", model: "fa", path: "/sum", format: "bit" },
  { type: "readout", label: "Cout", model: "fa", path: "/cout", format: "bit" }] };
const ok = (data) => ({ content: [{ type: "text", text: "ok" }], structuredContent: { kind: "estampes.module_result", status: "ok", data } });

function script({ enabled = true, unavailable = false } = {}) {
  const inst = { id: "md:0123456789ab", revision: 1, value: { a: false, b: false, cin: false, sum: 0, cout: 0 } };
  const calls = [];
  const intercept = async (params, call) => {
    if (params.name === "execute_module" && params.arguments.module === MOD) {
      const { capability, params: p } = params.arguments;
      calls.push([capability, p]);
      if (capability === "models.get") return ok({ instance: { ...inst, value: { ...inst.value } } });
      if (capability === "set") {
        if (p.id !== inst.id) throw new Error("wrong instance");
        inst.value[p.field] = p.on; inst.revision++;
        const n = Number(inst.value.a) + Number(inst.value.b) + Number(inst.value.cin);
        inst.value.sum = n & 1; inst.value.cout = n >> 1;
        return ok({ instance: inst.id });
      }
    }
    if (params.name === "surface_get_state") {
      const r = await call(params), sc = structuredClone(r.structuredContent), id = "p:view-fa0";
      sc.panels.push({ panelId: id, kind: "module-view", module: MOD, panel: "view-fa", view: "fa", open: true, title: "Full adder", moduleState: enabled ? "enabled" : "disabled" });
      for (const lay of Object.values(sc.layouts)) { lay.order.push(id); lay.placements[id] = { mode: "normal", rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, z: 5 }; }
      sc.moduleViews = { [id]: unavailable ? { unavailable: true, reads: [] } : { module: MOD, view: "fa", reads: ["fa"], actions: ["set"], bound: { fa: inst.id }, instances: { fa: [inst.id] }, renderer: { type: "declarative", schema: "estampes.renderer.declarative/1", payload: { root: ROOT } } } };
      return { content: r.content, structuredContent: sc };
    }
    return undefined;
  };
  return { inst, calls, intercept };
}
test("a full adder drawn from a declarative tree: all eight input combinations read back through the module", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false }); await s.enable(["org.estampes.graph"]);
  try {
    const sc = script();
    const canvas = (await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "graph" } }).catch(() => null));
    const imageId = (JSON.stringify(canvas?.structuredContent ?? {}).match(/gph:[0-9a-f]{16}/) ?? [])[0];
    assert.ok(imageId, "a canvas to hang the surface on");
    const ui = await s.open({ imageId, intercept: sc.intercept });
    const view = ui.frame.locator(".mv");
    await view.waitFor({ timeout: 30000 });
    assert.equal(await ui.frame.locator(".mv output").count(), 2);
    for (let n = 0; n < 8; n++) {
      for (const [i, label] of ["A", "B", "Cin"].entries()) {
        const want = Boolean((n >> i) & 1), box = ui.frame.getByLabel(label, { exact: true });
        if ((await box.isChecked()) !== want) { await box.setChecked(want); await ui.frame.locator('.mv[aria-busy="false"]').waitFor(); await ui.page.waitForFunction(([l, w]) => { const f = document.querySelector("iframe").contentDocument; return [...f.querySelectorAll(".mv label")].find((x) => x.textContent === l)?.control.checked === w; }, [label, want]); }
      }
      const ones = (n & 1) + ((n >> 1) & 1) + ((n >> 2) & 1);
      await ui.page.waitForFunction(([sum, cout]) => { const o = [...document.querySelector("iframe").contentDocument.querySelectorAll(".mv output")].map((x) => x.textContent); return o[0] === String(sum) && o[1] === String(cout); }, [ones & 1, ones >> 1], { timeout: 10000 });
    }
    assert.ok(sc.calls.some(([c]) => c === "models.get"), "values come from models.get");
    assert.ok(sc.calls.filter(([c]) => c === "set").every(([, p]) => p.id === sc.inst.id && typeof p.on === "boolean"), "actions carry the bound instance and the new value");
    assert.deepEqual(ui.errors, []);
  } finally { await s.close(); }
});

test("a disabled module or an unavailable view shows a note and no controls", { skip: noBrowser, timeout: 120000 }, async () => {
  for (const opts of [{ enabled: false }, { unavailable: true }]) {
    const s = await startStack({ cas: false }); await s.enable(["org.estampes.graph"]);
    try {
      const sc = script(opts);
      const canvas = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "graph" } });
      const imageId = (JSON.stringify(canvas.structuredContent).match(/gph:[0-9a-f]{16}/) ?? [])[0];
      const ui = await s.open({ imageId, intercept: sc.intercept });
      await ui.frame.locator(".mv-note").first().waitFor({ timeout: 30000 });
      assert.equal(await ui.frame.locator(".mv input, .mv select, .mv .mv-btn").count(), 0);
      assert.equal(sc.calls.length, 0, "no module call is made");
      assert.deepEqual(ui.errors, []);
    } finally { await s.close(); }
  }
});

test("a change made elsewhere shows after the refresh button", { skip: noBrowser, timeout: 120000 }, async () => {
  const s = await startStack({ cas: false }); await s.enable(["org.estampes.graph"]);
  try {
    const sc = script();
    const canvas = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", params: { expression: "x" }, newCanvas: { kind: "graph" } });
    const imageId = (JSON.stringify(canvas.structuredContent).match(/gph:[0-9a-f]{16}/) ?? [])[0];
    const ui = await s.open({ imageId, intercept: sc.intercept });
    await ui.frame.locator(".mv output").first().waitFor({ timeout: 30000 });
    sc.inst.value.sum = 1; sc.inst.revision++;
    await ui.frame.locator(".mv-refresh").click();
    await ui.page.waitForFunction(() => document.querySelector("iframe").contentDocument.querySelector(".mv output")?.textContent === "1", null, { timeout: 10000 });
  } finally { await s.close(); }
});
