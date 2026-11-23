// UVA 5B-3b: a bundle carries derived bindings. They come in as `unresolved`
// (the module's sourceRef points at a source that may not exist here under
// that name), only for objects that arrive with them, and a restart keeps them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUvaService } from "../src/uva/service.js";
import { createCanvasStore } from "../src/uva/canvas-store.js";
import { createGraphCanvas, ensureImage, saveCanvas, useCanvasStore } from "../src/storage.js";
import { applySceneOps } from "../src/scene/scene-ops.js";
import { createWorkspace, clearWorkspaces, getWorkspace, workspaceItems } from "../src/workspace.js";
import { exportBundle, importBundle } from "../src/bundle.js";
import { unzipFiles, zipFiles } from "../src/zip.js";
import { register, bindingsOf, act, bindingHashOf } from "../src/documents/derived-coordinator.js";

const MOD = "org.example.producer";
const hash = "a".repeat(64);
async function open(t) {
  const storage = await mkdtemp(join(tmpdir(), "derived-bundle-l-")), beta = await mkdtemp(join(tmpdir(), "derived-bundle-u-"));
  t.after(() => Promise.all([rm(storage, { recursive: true, force: true }), rm(beta, { recursive: true, force: true })]));
  const boot = async () => {
    const service = await createUvaService({ enabled: true, canvasStore: true, directory: beta, profile: "linux-process-crash-test", legacyDirectory: storage });
    const store = await createCanvasStore({ service, storageDir: storage, idleMs: 0 });
    useCanvasStore(store);
    return { service, store, async close() { await store.flush(); await store.close(); await service.close(); useCanvasStore(null); } };
  };
  return boot;
}
async function source() {
  const g = await createGraphCanvas({ width: 900, height: 600, color: "#fbf8f1", title: "g" });
  applySceneOps(g, [
    { op: "object.create", type: "axes-2d", props: { xRange: [-3, 3], yRange: [-1, 9] } },
    { op: "object.create", type: "function-plot", props: { frame: "o1", expression: "x^2" } },
  ], { author: "assistant" });
  const binding = register(g, { source: { module: MOD, capability: "make", sourceRef: "book1/cell2", sourceRevision: 3, inputsHash: hash }, objectId: "o2" });
  await saveCanvas(g, { tool: "test" });
  return { g, binding };
}

test("an exported bundle carries bindings and the import makes them unresolved, then reattach works", { timeout: 120000 }, async (t) => {
  clearWorkspaces();
  const boot = await open(t);
  let s = await boot();
  t.after(() => s.close().catch(() => {}));
  const { g, binding } = await source();
  const made = await createWorkspace({ name: "b", items: [{ set: g.imageId }] });
  const { buffer } = await exportBundle(made.workspace.id);
  const body = JSON.parse(new TextDecoder().decode(unzipFiles(buffer).get("sets/1.json")));
  assert.equal(body.derived?.length, 1, "the set file carries the binding");

  const r = await importBundle(buffer, { name: "carried" });
  assert.equal(r.verified, true, JSON.stringify({ m: r.mismatch, w: r.warnings }));
  assert.ok(r.warnings.some((w) => /unresolved/.test(w)), "the import says so");
  const [imported] = (await workspaceItems(await getWorkspace(r.workspace.id))).map((it) => it.entry);
  assert.notEqual(imported.imageId, g.imageId);
  const [b] = bindingsOf(imported);
  assert.deepEqual([b.state, b.target.id, b.source.module, b.source.sourceRef, b.id], ["unresolved", "o2", MOD, "book1/cell2", binding.id]);
  assert.equal(bindingsOf(g)[0].state, "fresh", "the original is untouched");

  // It survives a restart and a person can reattach it.
  await s.close();
  s = await boot();
  const back = await ensureImage(imported.imageId);
  assert.equal(bindingsOf(back)[0].state, "unresolved");
  const done = await act(back, bindingsOf(back)[0].id, "reattach", { expectedBindingHash: bindingHashOf(bindingsOf(back)[0]), target: "o2" });
  const next = done.binding;
  assert.equal(next.state, "stale");
});

test("bindings that name nothing in the bundle, repeat, or are malformed are left out with a warning", { timeout: 120000 }, async (t) => {
  clearWorkspaces();
  const boot = await open(t);
  const s = await boot();
  t.after(() => s.close().catch(() => {}));
  const { g, binding } = await source();
  const made = await createWorkspace({ name: "b2", items: [{ set: g.imageId }] });
  const { buffer } = await exportBundle(made.workspace.id);
  const files = unzipFiles(buffer);
  const set = JSON.parse(new TextDecoder().decode(files.get("sets/1.json")));
  set.derived = [
    { ...binding, id: "bind:11111111-1111-4111-8111-111111111111", target: { id: "o99" } },
    { ...binding, source: { ...binding.source, sourceRef: "x".repeat(300) } },
    { junk: true }, "text",
    binding, binding,
  ];
  // The manifest lists file hashes, so tampering with a set needs the manifest to follow.
  const r = await importBundle(rebuild(files, set), { name: "tampered" });
  const [imported] = (await workspaceItems(await getWorkspace(r.workspace.id))).map((it) => it.entry);
  assert.equal(bindingsOf(imported).length, 1, "only the one valid binding is kept");
  assert.ok(r.warnings.some((w) => /not imported/.test(w)));
});

function rebuild(files, set) {
  // Re-signs the bundle: recompute the file hash in the manifest for the changed set.
  const enc = new TextEncoder();
  const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
  const data = enc.encode(JSON.stringify(set));
  const f = manifest.files.find((x) => x.path === "sets/1.json");
  f.sha256 = createHash("sha256").update(data).digest("hex"); f.bytes = data.length;
  const out = [...files].filter(([n]) => n !== "manifest.json" && n !== "sets/1.json").map(([name, d]) => ({ name, data: d }));
  return zipFiles([{ name: "manifest.json", data: enc.encode(JSON.stringify(manifest)) }, { name: "sets/1.json", data }, ...out]);
}
import { createHash } from "node:crypto";
