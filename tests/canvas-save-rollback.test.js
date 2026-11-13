// A canvas save that fails must not leave the failed change in memory
// (architecture review A03): later reads would show it, and the next
// successful save would persist it although its caller was told it failed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCanvasStoreServer } from "./helpers/canvas-store-server.js";

async function folders(t) {
  const storage = await mkdtemp(join(tmpdir(), "rollback-legacy-")), beta = await mkdtemp(join(tmpdir(), "rollback-uva-"));
  t.after(() => Promise.all([rm(storage, { recursive: true, force: true }), rm(beta, { recursive: true, force: true })]));
  return { storage, beta };
}
const pendingPath = (storage, key) => join(storage, "uva-pending", key.slice(4).replace("#", "-") + ".json");
// The pending record's path becomes a non-empty directory: the next save of
// that canvas cannot be made durable and rejects.
async function breakSaves(storage, key) { await unlink(pendingPath(storage, key)).catch(() => {}); await mkdir(join(pendingPath(storage, key), "blocker"), { recursive: true }); }
const fixSaves = (storage, key) => rm(pendingPath(storage, key), { recursive: true, force: true });

test("a failed mark save is rolled back in memory and never reaches a later successful save", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  let s = await startCanvasStoreServer(storage, beta);
  t.after(() => s.kill());
  const imageId = await s.upload("#446688");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .2, y: .2, label: "one" }] });
  await breakSaves(storage, imageId);
  const failed = await s.raw("present_visual", { imageId, annotations: [{ id: "a2", type: "point", x: .4, y: .4, label: "two" }] });
  assert.equal(failed.isError, true, JSON.stringify(failed.content));
  assert.deepEqual(await s.labels(imageId), ["one"], "a read after the failure must not show the failed mark");
  await fixSaves(storage, imageId);
  await s.call("present_visual", { imageId, annotations: [{ id: "a3", type: "point", x: .6, y: .6, label: "three" }] });
  assert.deepEqual(await s.labels(imageId), ["one", "three"]);
  await s.stop();
  s = await startCanvasStoreServer(storage, beta);
  assert.deepEqual(await s.labels(imageId), ["one", "three"], "after a restart the failed mark is still absent");
  await s.stop();
});

test("a failed module run leaves no scene objects and no revision bump behind", { timeout: 120000 }, async (t) => {
  const { storage, beta } = await folders(t);
  const s = await startCanvasStoreServer(storage, beta);
  t.after(() => s.kill());
  const imageId = await s.upload("#664488");
  await s.call("present_visual", { imageId, annotations: [{ id: "a1", type: "point", x: .2, y: .2, label: "one" }] });
  await s.enable("org.estampes.graph");
  const before = (await s.call("get_visual_state", { imageId })).structuredContent;
  await breakSaves(storage, imageId);
  const failed = await s.raw("execute_module", { module: "org.estampes.graph", capability: "plot_function", canvas: imageId, params: { expression: "sin(x)" } });
  assert.equal(failed.isError, true, JSON.stringify(failed.content));
  const after = (await s.call("get_visual_state", { imageId })).structuredContent;
  assert.equal((after.objects ?? []).length, (before.objects ?? []).length, "no objects from the failed run");
  assert.equal(after.sceneRevision ?? 0, before.sceneRevision ?? 0);
  await fixSaves(storage, imageId);
  const ok = await s.call("execute_module", { module: "org.estampes.graph", capability: "plot_function", canvas: imageId, params: { expression: "cos(x)" } });
  assert.ok(ok);
  await s.stop();
});
