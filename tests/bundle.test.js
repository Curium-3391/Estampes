import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearImages, registerImage } from "../src/image-store.js";
import { canvasMarks, applyWorkspaceChanges } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation as resolve } from "../src/scene-catalog.js";
import { useStorageDir, intakeImage, flushStorage } from "../src/storage.js";
import { commitTransfer, workspaceItems, clearWorkspaces, getWorkspace } from "../src/workspace.js";
import { exportBundle, importBundle } from "../src/bundle.js";
import { zipFiles, unzipFiles } from "../src/zip.js";
import { threeImageFixture } from "./fixtures/three-images.js";

beforeEach(() => { clearImages(); clearWorkspaces(); useStorageDir(""); });

async function mergedWorkspace() {
  const { a, b1, b2 } = await threeImageFixture(registerImage);
  const done = await commitTransfer({ source: b1.imageId + "+" + b2.imageId, target: a.imageId, mode: "link" });
  return { a, b1, b2, ws: done.workspaceId };
}
const rezip = (buffer, edit) => {
  const files = unzipFiles(buffer);
  edit(files);
  return zipFiles([...files].map(([name, data]) => ({ name, data })));
};

test("zip: round trip, and unsafe names are refused", () => {
  const buf = zipFiles([{ name: "a/b.json", data: Buffer.from("{}") }, { name: "c.bin", data: Buffer.alloc(5000, 7), store: true }]);
  const out = unzipFiles(buf);
  assert.equal(out.get("a/b.json").toString(), "{}");
  assert.equal(out.get("c.bin").length, 5000);
  assert.throws(() => zipFiles([{ name: "../evil", data: Buffer.from("x") }]));
  assert.throws(() => zipFiles([{ name: "/abs", data: Buffer.from("x") }]));
  assert.throws(() => unzipFiles(Buffer.from("not a zip at all")));
});

test("export then import into an empty server: 3 images, 29 marks, same layers, still editable", async () => {
  const { ws } = await mergedWorkspace();
  const built = await exportBundle(ws, { version: "test" });
  assert.equal(built.manifest.format, "estampes.bundle/1");
  assert.equal(built.manifest.workspace.marks, 29);
  assert.equal(JSON.stringify(built.manifest).includes("download_url"), false);

  clearImages(); clearWorkspaces();
  const r = await importBundle(built.buffer, { name: "carried" });
  assert.equal(r.verified, true, JSON.stringify({ m: r.mismatch, u: r.unsupported, w: r.warnings }));
  assert.deepEqual(r.check.totals, { items: 3, marks: 29, userMarks: 5, layerInstances: 9, links: 0 });
  const items = await workspaceItems(await getWorkspace(r.workspace.id));
  applyWorkspaceChanges(items, { findings: [{ id: "user-1r8w-2", note: "edited after import" }], resolve });
  const edited = items.flatMap((it) => canvasMarks(it.entry)).find((m) => m.id === "user-1r8w-2");
  assert.equal(edited.note, "edited after import");
  assert.equal(edited.author, "user");
});

test("importing the same bundle twice returns the same workspace and adds nothing", async () => {
  const { ws } = await mergedWorkspace();
  const { buffer } = await exportBundle(ws);
  clearImages(); clearWorkspaces();
  const one = await importBundle(buffer), two = await importBundle(buffer);
  assert.equal(two.repeated, true);
  assert.equal(two.workspace.id, one.workspace.id);
});

test("import onto a server that has the images with other marks never overwrites them", async () => {
  const { a, ws } = await mergedWorkspace();
  const { buffer } = await exportBundle(ws);
  const before = canvasMarks(a).map((m) => m.id).sort();
  applyWorkspaceChanges([{ id: "wi-1", entry: a }], { annotations: [{ id: "local-only", type: "point", x: 0.5, y: 0.5 }], resolve });
  const mine = canvasMarks(a).map((m) => m.id).sort();
  assert.equal(mine.length, before.length + 1);
  clearWorkspaces();
  const r = await importBundle(buffer);
  assert.equal(canvasMarks(a).map((m) => m.id).sort().join(), mine.join(), "the local canvas is untouched");
  assert.equal(r.summary.some((s) => s.how === "copied"), true);
  assert.equal(r.check.totals.marks, 29);
});

test("tampering, wrong format, missing files and bad marks are refused or dropped", async () => {
  const { ws } = await mergedWorkspace();
  const { buffer } = await exportBundle(ws);
  const damaged = rezip(buffer, (f) => { f.set("sets/1.json", Buffer.from(f.get("sets/1.json").toString().replace("op-0", "op-X"))); });
  await assert.rejects(importBundle(damaged), /checksum/);
  const future = rezip(buffer, (f) => { const m = JSON.parse(f.get("manifest.json")); m.format = "estampes.bundle/9"; f.set("manifest.json", Buffer.from(JSON.stringify(m))); });
  await assert.rejects(importBundle(future), /estampes\.bundle\/9/);
  const missing = rezip(buffer, (f) => { f.delete("workspace.json"); });
  await assert.rejects(importBundle(missing), /workspace\.json is missing|incomplete/);
  await assert.rejects(importBundle(Buffer.from("PK nonsense")), /./);
});

test("a bundle with an out-of-range mark keeps the rest and reports it", async () => {
  const { ws } = await mergedWorkspace();
  const { buffer } = await exportBundle(ws);
  const bad = rezip(buffer, (f) => {
    const set = JSON.parse(f.get("sets/1.json")); set.marks[0].x = 7; set.marks[1].type = "script";
    const data = Buffer.from(JSON.stringify(set)), m = JSON.parse(f.get("manifest.json"));
    const entry = m.files.find((x) => x.path === "sets/1.json");
    entry.bytes = data.length; entry.sha256 = require_sha(data);
    f.set("sets/1.json", data); f.set("manifest.json", Buffer.from(JSON.stringify(m)));
  });
  clearImages(); clearWorkspaces();
  const r = await importBundle(bad);
  assert.equal(r.verified, false);
  assert.equal(r.unsupported.length, 2);
  assert.equal(r.check.totals.marks, 27);
});

import { createHash } from "node:crypto";
const require_sha = (b) => createHash("sha256").update(b).digest("hex");

test("on disk: import persists the restored canvases and workspace", async () => {
  useStorageDir(mkdtempSync(join(tmpdir(), "estampes-bundle-")));
  const { a, b1, b2 } = await threeImageFixture(intakeImage);
  const done = await commitTransfer({ source: b1.imageId + "+" + b2.imageId, target: a.imageId, mode: "link" });
  const { buffer } = await exportBundle(done.workspaceId);
  clearImages(); clearWorkspaces();
  useStorageDir(mkdtempSync(join(tmpdir(), "estampes-bundle2-")));
  const r = await importBundle(buffer);
  await flushStorage();
  clearImages(); clearWorkspaces();
  const again = await getWorkspace(r.workspace.id);
  const items = await workspaceItems(again);
  assert.equal(items.flatMap((it) => canvasMarks(it.entry)).length, 29);
});

test("a JPEG exported without stored originals imports under its new id (working copy)", async () => {
  const sharp = (await import("sharp")).default;
  const jpg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#c33" } }).jpeg().toBuffer();
  const e = await registerImage(jpg, { source: "test" });
  applyWorkspaceChanges([{ id: "wi-1", entry: e }], { annotations: [{ id: "m", type: "point", x: 0.5, y: 0.5 }], resolve });
  const made = await (await import("../src/workspace.js")).createWorkspace({ items: [{ asset: e.imageId }] });
  const { buffer, warnings } = await exportBundle(made.workspace.id);
  assert.equal(warnings.length, 1);
  clearImages(); clearWorkspaces();
  const r = await importBundle(buffer);
  assert.equal(r.check.totals.marks, 1);
  assert.equal(r.verified, true);
});

test("same marks but different layer settings are not reused: the bundle keeps its own copy", async () => {
  const { a, ws } = await mergedWorkspace();
  const { buffer } = await exportBundle(ws);
  a.layers[0].locked = true;
  clearWorkspaces();
  const r = await importBundle(buffer);
  assert.equal(r.summary.find((s) => s.key === a.imageId).how, "copied");
});
