import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
async function start(dir) {
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_UVA_MIRROR_IDLE_SEC: "3600" }, stdio: "ignore" });
  for (let i = 0; i < 80; i++) { try { if ((await fetch("http://127.0.0.1:" + port + "/")).ok) break; } catch {} await sleep(100); }
  const client = new Client({ name: "modules-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp")));
  return { handle, client, port };
}
const text = (r) => r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

test("modules over MCP: Store, consent, enable, plot sin(x), edit, restart", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "estampes-modmcp-"));
  let s = await start(dir);
  try {
    const tools = (await s.client.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ["open_module_store", "list_modules", "get_module_capabilities", "execute_module", "prepare_module_change", "get_module_job"]) assert.ok(byName[n], n);
    const missing = await s.client.callTool({ name: "get_module_job", arguments: { job: "job_0123456789ab" } });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /no job job_0123456789ab/);
    // The Store's own tools are hidden from the model.
    for (const n of ["store_get_catalog", "store_commit_plan", "store_get_plan", "edit_scene_object"]) assert.deepEqual(byName[n]._meta.ui.visibility, ["app"], n);
    assert.ok(byName.open_module_store._meta.ui.resourceUri.startsWith("ui://estampes/module-store-"));
    const html = await s.client.readResource({ uri: byName.open_module_store._meta.ui.resourceUri });
    assert.match(html.contents[0].text, /Estampes Store/);

    const store = await s.client.callTool({ name: "open_module_store", arguments: {} });
    assert.match(text(store), /org\.estampes\.graph .*not enabled/);
    const refused = await s.client.callTool({ name: "execute_module", arguments: { module: "org.estampes.graph", capability: "plot_function", params: { expression: "sin(x)" } } });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /Only the user can enable/);

    // The model can only prepare; the consent nonce is for the widget (_meta), never in text.
    const prepared = await s.client.callTool({ name: "prepare_module_change", arguments: { action: "enable", module: "org.estampes.graph" } });
    const plan = prepared.structuredContent.plan;
    assert.equal(plan.status, "pending");
    assert.doesNotMatch(JSON.stringify([prepared.content, prepared.structuredContent]), new RegExp(prepared._meta["estampes/consent"].consent));
    const noProof = await s.client.callTool({ name: "store_commit_plan", arguments: { planId: plan.planId, consent: "x".repeat(20) } });
    assert.equal(noProof.isError, true);
    const committed = await s.client.callTool({ name: "store_commit_plan", arguments: { planId: plan.planId, consent: prepared._meta["estampes/consent"].consent } });
    assert.equal(committed.structuredContent.result.state, "enabled");

    const caps = await s.client.callTool({ name: "get_module_capabilities", arguments: { module: "org.estampes.graph" } });
    assert.ok(caps.structuredContent.capabilities.some((c) => c.id === "plot_function" && c.inputSchema.required.includes("expression")));

    const run = await s.client.callTool({ name: "execute_module", arguments: { module: "org.estampes.graph", capability: "plot_function", params: { expression: "sin(x)", domain: [-6.283185307179586, 6.283185307179586] } } });
    assert.ok(!run.isError, text(run));
    assert.ok(run.content.some((b) => b.type === "image"), "preview image for the model");
    const canvasId = run.structuredContent.imageId;
    assert.match(canvasId, /^img:[0-9a-f]{16}$/);
    assert.equal(run.structuredContent.objects.find((o) => o.type === "function-plot").props.expression, "sin(x)");
    assert.equal(run._meta["estampes/objects"].length, 2);
    assert.ok(run._meta["estampes/objects"][1].primitives.length > 0);

    // The user edits the formula in the canvas; no module code involved.
    const edited = await s.client.callTool({ name: "edit_scene_object", arguments: { imageId: canvasId, id: "o2", props: { expression: "sin(2*x)" } } });
    assert.ok(!edited.isError, text(edited));
    assert.equal(edited.structuredContent.objects[1].editable.expression, "sin(2*x)");
    assert.ok(edited.structuredContent.objects[1].primitives.some((p) => p.k === "text" && p.text === "y = sin(2*x)"));
    const hostile = await s.client.callTool({ name: "edit_scene_object", arguments: { imageId: canvasId, id: "o2", props: { expression: "constructor.constructor('x')()" } } });
    assert.equal(hostile.isError, true);

    // GPT learns about the user's edit and the objects from the canvas state.
    const visual = await s.client.callTool({ name: "get_visual_state", arguments: { imageId: canvasId } });
    assert.equal(visual.structuredContent.objects.find((o) => o.type === "function-plot").props.expression, "sin(2*x)");
    // The durable record the save was acknowledged with (the UVA store's pending copy).
    const stored = JSON.parse(await readFile(join(dir, "uva-pending", canvasId.slice(4) + ".json"), "utf8")).canvas;
    assert.equal(stored.objects.length, 2);

    // Restart: module state and the canvas come back.
    s.handle.kill(); await sleep(300);
    s = await start(dir);
    const listed = await s.client.callTool({ name: "list_modules", arguments: { state: "enabled" } });
    assert.match(text(listed), /org\.estampes\.graph/);
    const again = await s.client.callTool({ name: "execute_module", arguments: { module: "org.estampes.graph", capability: "update_plot", canvas: canvasId, params: { object: "o2", expression: "sin(3x)" } } });
    assert.ok(!again.isError, text(again));
    assert.equal(again.structuredContent.module.revision, 3);
    const custom = await s.client.callTool({ name: "execute_module", arguments: { module: "org.estampes.graph", capability: "update_plot", canvas: canvasId, params: { object: "o2", label: "實測電壓" } } });
    assert.ok(!custom.isError, text(custom));
    assert.equal(custom.structuredContent.objects.find((o) => o.id === "o2").props.labelMode, "custom");
    const auto = await s.client.callTool({ name: "execute_module", arguments: { module: "org.estampes.graph", capability: "update_plot", canvas: canvasId, params: { object: "o2", labelMode: "auto" } } });
    assert.ok(!auto.isError, text(auto));
    const disable = await s.client.callTool({ name: "prepare_module_change", arguments: { action: "disable", module: "org.estampes.graph" } });
    const disabled = await s.client.callTool({ name: "store_commit_plan", arguments: { planId: disable.structuredContent.plan.planId, consent: disable._meta["estampes/consent"].consent } });
    assert.ok(!disabled.isError, text(disabled));
    const direct = await s.client.callTool({ name: "edit_scene_object", arguments: { imageId: canvasId, id: "o2", props: { expression: "sin(4*x)" } } });
    assert.ok(!direct.isError, text(direct));
    assert.ok(direct.structuredContent.objects[1].primitives.some((p) => p.k === "text" && p.text === "y = sin(4*x)"));
    // Read-only composites continue to work with Graph disabled. Submission
    // captures both saved handwriting and widget-local visibility.
    const submitted = await s.client.callTool({ name: "validate_visual_annotations", arguments: {
      imageId: canvasId, annotations: [{ id: "user-render-1", type: "arrow", x: .2, y: .2, x2: .6, y2: .6, label: "YOU 1" }],
      hiddenLayers: [], note: "看看這段曲線", } });
    assert.ok(!submitted.isError, text(submitted));
    const request = submitted.structuredContent.event.canvasReads[0].request;
    assert.match(submitted.structuredContent.chatMessage, /render_canvas/);
    assert.doesNotMatch(submitted.structuredContent.chatMessage, /使用者的實際照片|請先用 Estampes 的 process_image/);
    const composite = await s.client.callTool({ name: "render_canvas", arguments: { ...request, region: { x: .1, y: .1, x2: .9, y2: .9 } } });
    assert.ok(!composite.isError, text(composite));
    assert.ok(composite.content.some((b) => b.type === "image"));
    assert.deepEqual(composite.structuredContent.included.objects, ["o1", "o2"]);
    assert.deepEqual(composite.structuredContent.included.marks, ["user-render-1"]);
    await s.client.callTool({ name: "edit_scene_object", arguments: { imageId: canvasId, id: "o2", props: { expression: "cos(x)" } } });
    const stale = await s.client.callTool({ name: "render_canvas", arguments: request });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.code, "STALE_CANVAS");
    const removed = await s.client.callTool({ name: "edit_scene_object", arguments: { imageId: canvasId, id: "o1", remove: true } });
    assert.ok(!removed.isError, text(removed));
    assert.equal(removed.structuredContent.objects.length, 0);
    assert.equal(removed.structuredContent.canRestoreObjects, true);
    const restored = await s.client.callTool({ name: "edit_scene_object", arguments: { imageId: canvasId, restore: true } });
    assert.ok(!restored.isError, text(restored));
    assert.deepEqual(restored.structuredContent.objects.map(o=>o.id), ["o1", "o2"]);
    assert.equal(restored.structuredContent.canRestoreObjects, false);
    const promoted = await s.client.callTool({ name: "add_image_layer", arguments: { imageId: canvasId } });
    assert.ok(!promoted.isError, text(promoted));
    assert.equal(promoted.structuredContent.baseAsObject, true);
    assert.ok(promoted.structuredContent.objects.some(o=>o.type==="image"));
    const activity = await s.client.callTool({ name: "store_get_activity", arguments: {} });
    assert.ok(activity.structuredContent.events.some((e) => e.kind === "run"));
  } finally { s.handle.kill(); }
});
