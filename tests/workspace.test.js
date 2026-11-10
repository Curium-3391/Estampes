import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearImages, registerImage } from "../src/image-store.js";
import { canvasMarks, applyWorkspaceChanges, applyPairChanges, pairLinks, workspaceLinks, reviewWorkspaceLink } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation as resolve } from "../src/scene-catalog.js";
import { useStorageDir, useRecords, useCanvasStore, intakeImage, flushStorage } from "../src/storage.js";
import {
  resolveRef, previewTransfer, commitTransfer, createWorkspace, editWorkspace, undoChange, workspaceItems, workspaceDocument,
  clearWorkspaces, getWorkspace, ensureSet,
} from "../src/workspace.js";
import { threeImageFixture } from "./fixtures/three-images.js";

let dir;
beforeEach(() => { clearImages(); clearWorkspaces(); useStorageDir(""); });
const ids = (entry) => canvasMarks(entry).map((m) => m.id).sort();

test("legacy adapter: a single and a paired canvas read as workspaces without changes", async () => {
  const { a, b1, b2 } = await threeImageFixture(registerImage);
  const single = await resolveRef(a.imageId), pair = await resolveRef(b1.imageId + "+" + b2.imageId);
  assert.equal(single.legacy, true);
  assert.deepEqual(single.doc.items.map((it) => [it.id, it.set]), [["wi-1", a.imageId]]);
  assert.deepEqual(pair.doc.items.map((it) => it.asset), [b1.imageId, b2.imageId]);
  const doc = await workspaceDocument(pair.doc);
  assert.deepEqual(doc.check.totals, { items: 2, marks: 4, userMarks: 2, layerInstances: 4, links: 0 });
  assert.equal(doc.items[1].placement.x > doc.items[0].placement.x, true, "the right image sits to the right");
});

test("merge B into A: 3 images, 29 editable marks, 9 layer instances; A and B untouched (PORT-01, MC-05..MC-09)", async () => {
  const { a, b1, b2 } = await threeImageFixture(registerImage);
  const before = [ids(a), ids(b1), ids(b2)];
  const { previewId, plan } = await previewTransfer({ source: b1.imageId + "+" + b2.imageId, target: a.imageId, mode: "link" });
  assert.deepEqual(plan.result, { items: 3, marks: 29, userMarks: 5, layerInstances: 9 });
  assert.equal(plan.target.createsWorkspace, true);
  assert.equal(plan.add.length, 2);
  assert.deepEqual([ids(a), ids(b1), ids(b2)], before, "a preview changes nothing");

  const done = await commitTransfer({ previewId, key: "merge-1" });
  assert.equal(done.verified, true);
  assert.equal(done.created, true);
  assert.deepEqual(done.check.totals, { items: 3, marks: 29, userMarks: 5, layerInstances: 9, links: 0 });
  assert.deepEqual([ids(a), ids(b1), ids(b2)], before, "source canvases keep every mark");

  // The PCB circle and the PDF point are the same marks, editable from the workspace.
  const ws = await getWorkspace(done.workspaceId);
  const items = await workspaceItems(ws);
  assert.deepEqual(items.map((it) => it.entry), [a, b1, b2], "linked items are the canvases themselves");
  const byItem = Object.fromEntries(items.map((it) => [it.entry.imageId, it.id]));
  applyWorkspaceChanges(items, { findings: [{ id: "user-1r8w-2", note: "這一區是電源" }, { id: "user-1r8w-1", item: byItem[b2.imageId], note: "相鄰" }], resolve });
  assert.equal(canvasMarks(b1).find((m) => m.id === "user-1r8w-2").note, "這一區是電源", "a linked edit shows in the paired canvas");
  assert.equal(canvasMarks(b2).find((m) => m.id === "user-1r8w-1").author, "user");

  // Retrying with the same key returns the first result; merging again adds nothing.
  const again = await commitTransfer({ previewId, key: "merge-1" });
  assert.equal(again.repeated, true);
  assert.equal(again.workspaceId, done.workspaceId);
  const twice = await commitTransfer({ source: b1.imageId + "+" + b2.imageId, target: done.workspaceId, mode: "link" });
  assert.equal(twice.check.totals.items, 3, "MC-10: no duplicate images");
  assert.equal(twice.skipped.length, 2);
});

test("a stale preview is refused and a failed change leaves documents alone", async () => {
  const { a, b1, b2 } = await threeImageFixture(registerImage);
  const made = await createWorkspace({ name: "三圖", items: [{ asset: a.imageId }, { asset: b1.imageId }] });
  const { previewId } = await previewTransfer({ source: b2.imageId, target: made.workspace.id });
  await editWorkspace(made.workspace.id, { arrange: [{ item: "wi-1", label: "電路圖" }] });
  await assert.rejects(commitTransfer({ previewId }), /changed since the preview/);
  await assert.rejects(editWorkspace(made.workspace.id, { expectedRevision: 0, name: "x" }), /changed \(revision 1, expected 0\)/);
  await assert.rejects(editWorkspace(made.workspace.id, { add: [{ asset: b2.imageId }], remove: ["wi-9"] }), /no item "wi-9"/);
  const ws = await getWorkspace(made.workspace.id);
  assert.equal(ws.items.length, 2);
  assert.equal(ws.name, "三圖");
});

test("split with copy: the copy changes independently and remembers its source (PORT-02, PORT-03)", async () => {
  const { a, b1, b2 } = await threeImageFixture(registerImage);
  const merged = await commitTransfer({ source: b1.imageId + "+" + b2.imageId, target: a.imageId });
  const split = await commitTransfer({ source: merged.workspaceId, target: "new", items: ["wi-2"], mode: "copy", name: "只有 PCB" });
  assert.equal(split.verified, true);
  assert.deepEqual(split.check.totals, { items: 1, marks: 2, userMarks: 1, layerInstances: 2, links: 0 });
  const [copy] = await workspaceItems(await getWorkspace(split.workspaceId));
  assert.notEqual(copy.entry, b1);
  assert.match(copy.item.set, /^img:[0-9a-f]{16}#c[0-9a-f]+$/);
  assert.equal(copy.entry.width, b1.width, "a copy shares the image");
  applyWorkspaceChanges([copy], { findings: [{ id: "user-1r8w-2", note: "副本的說明" }], remove: ["pcb-source"], resolve });
  assert.equal(canvasMarks(b1).find((m) => m.id === "user-1r8w-2").note, undefined, "the original is not changed");
  assert.deepEqual(ids(b1), ["pcb-source", "user-1r8w-2"]);
  assert.deepEqual(canvasMarks(copy.entry).find((m) => m.id === "user-1r8w-2").derivedFrom, { set: b1.imageId, mark: "user-1r8w-2" });
  assert.equal((await getWorkspace(merged.workspaceId)).items.length, 3, "split keeps the source by default");
  const again = await commitTransfer({ source: merged.workspaceId, target: split.workspaceId, items: ["wi-2"], mode: "copy" });
  assert.equal(again.skipped.length, 1, "a second copy into the same workspace is skipped");
});

test("move then undo: items return, nothing is deleted (PORT-05, PORT-17)", async () => {
  const { a, b1, b2 } = await threeImageFixture(registerImage);
  const merged = await commitTransfer({ source: b1.imageId + "+" + b2.imageId, target: a.imageId });
  const other = await createWorkspace({ name: "空白" });
  const moved = await commitTransfer({ source: merged.workspaceId, target: other.workspace.id, items: ["wi-3"], removeFromSource: true });
  assert.deepEqual((await getWorkspace(merged.workspaceId)).items.map((it) => it.asset), [a.imageId, b1.imageId]);
  assert.deepEqual((await getWorkspace(other.workspace.id)).items.map((it) => it.asset), [b2.imageId]);
  await assert.rejects(commitTransfer({ source: a.imageId, target: "new", removeFromSource: true }), /keeps its images/);
  const undone = await undoChange(other.workspace.id, moved.undoToken);
  assert.equal(undone.workspaces.length, 2);
  assert.deepEqual((await getWorkspace(merged.workspaceId)).items.map((it) => it.asset), [a.imageId, b1.imageId, b2.imageId]);
  assert.deepEqual((await getWorkspace(other.workspace.id)).items, []);
  assert.deepEqual(ids(b2), ["pdf-p5-source", "user-1r8w-1"]);
  // Detach, then undo the creation of a workspace.
  const detached = await editWorkspace(merged.workspaceId, { remove: ["wi-1"] });
  assert.equal(detached.check.totals.items, 2);
  assert.equal(canvasMarks(a).length, 25, "detaching keeps the canvas");
  await undoChange(merged.workspaceId, detached.undoToken);
  assert.equal((await getWorkspace(merged.workspaceId)).items.length, 3);
  // The detach is undone, so the earlier merge is the latest change again and can be undone too.
  await undoChange(merged.workspaceId, merged.undoToken);
  await assert.rejects(getWorkspace(merged.workspaceId), /removed by an undo/);
  const fresh = await createWorkspace({ items: [{ asset: a.imageId }] });
  await undoChange(fresh.workspace.id, fresh.undoToken);
  await assert.rejects(getWorkspace(fresh.workspace.id), /removed by an undo/);
});

test("links join marks across items and are shared with paired views", async () => {
  const { a, b1, b2 } = await threeImageFixture(registerImage);
  applyPairChanges(b1, b2, { links: [{ id: "k-src", left: "pcb-source", right: "pdf-p5-source", confidence: "low" }], resolve });
  const merged = await commitTransfer({ source: b1.imageId + "+" + b2.imageId, target: a.imageId });
  const items = await workspaceItems(await getWorkspace(merged.workspaceId));
  assert.deepEqual(workspaceLinks(items).map((l) => [l.id, l.fromItem, l.from, l.toItem, l.to]), [["k-src", "wi-2", "pcb-source", "wi-3", "pdf-p5-source"]]);
  applyWorkspaceChanges(items, { links: [{ id: "k-op", fromItem: "wi-3", from: "user-1r8w-1", toItem: "wi-1", to: "op-0", confidence: "medium" }], resolve });
  assert.deepEqual(pairLinks(b2, a).map((l) => [l.left, l.right]), [["user-1r8w-1", "op-0"]], "stored like a paired-view link");
  // Reviewing from the other direction finds the same link.
  const { link } = reviewWorkspaceLink(items, { fromItem: "wi-1", toItem: "wi-3", id: "k-op" }, "confirmed");
  assert.equal(link.review, "confirmed");
  assert.throws(() => applyWorkspaceChanges(items, { links: [{ id: "k2", fromItem: "wi-1", from: "nope", toItem: "wi-2", to: "pcb-source" }], resolve }), /not a mark on item wi-1/);
  assert.throws(() => applyWorkspaceChanges(items, { findings: [{ id: "op-0", item: "wi-9", note: "x" }], resolve }), /not an item of this workspace/);
  // Copying both ends copies the link onto the copies.
  const split = await commitTransfer({ source: merged.workspaceId, target: "new", items: ["wi-2", "wi-3"], mode: "copy" });
  assert.equal(split.check.totals.links, 1);
  assert.equal(split.plan.links.leftBehind, 1, "the link to the Op-Amp image stays behind");
});

test("workspaces, copies and links survive a restart with storage (PORT-12)", async () => {
  dir = mkdtempSync(join(tmpdir(), "estampes-ws-"));
  useStorageDir(dir);
  const { a, b1, b2 } = await threeImageFixture(intakeImage);
  const { saveCanvas } = await import("../src/storage.js");
  for (const e of [a, b1, b2]) await saveCanvas(e, { tool: "test" });
  const merged = await commitTransfer({ source: b1.imageId + "+" + b2.imageId, target: a.imageId });
  const split = await commitTransfer({ source: merged.workspaceId, target: "new", items: ["wi-2"], mode: "copy" });
  const [copy] = await workspaceItems(await getWorkspace(split.workspaceId));
  applyWorkspaceChanges([copy], { findings: [{ id: "pcb-source", note: "副本" }], resolve });
  await saveCanvas(copy.entry, { tool: "test" });
  await flushStorage();
  assert.ok(existsSync(join(dir, "workspaces", merged.workspaceId.slice(3) + ".json")));
  assert.ok(existsSync(join(dir, "images", b1.imageId.slice(4), "sets", copy.entry.setId + ".json")));
  assert.equal(JSON.parse(readFileSync(join(dir, "images", b1.imageId.slice(4), "canvas.json"), "utf8")).marks.find((m) => m.id === "pcb-source").note, undefined);

  clearImages(); clearWorkspaces();
  const doc = await workspaceDocument(await getWorkspace(merged.workspaceId));
  assert.deepEqual(doc.check.totals, { items: 3, marks: 29, userMarks: 5, layerInstances: 9, links: 0 });
  assert.equal(doc.sets.find((s) => s.asset === b1.imageId).marks.find((m) => m.id === "user-1r8w-2").provenance.author, "user");
  const back = await ensureSet(copy.item.set);
  assert.equal(canvasMarks(back).find((m) => m.id === "pcb-source").note, "副本");
  assert.equal(back.derivedFrom.set, b1.imageId);
});

test("review fixes: retry after a stale preview, annotation changes stale a preview, successive undo, duplicate picks", async () => {
  const { a, b1, b2 } = await threeImageFixture(registerImage);
  const first = await commitTransfer({ source: b1.imageId, target: a.imageId, mode: "link" });
  const ws = first.workspaceId;
  // Merge into the existing workspace, retry with the same key after the commit made the preview stale.
  const prev = await previewTransfer({ source: b2.imageId, target: ws, mode: "link" });
  const one = await commitTransfer({ previewId: prev.previewId, key: "k-stale" });
  const again = await commitTransfer({ previewId: prev.previewId, key: "k-stale" });
  assert.equal(again.repeated, true);
  assert.equal(again.workspaceId, one.workspaceId);
  // Annotation edits after a preview make it stale.
  const p2 = await previewTransfer({ source: a.imageId, target: "new", mode: "copy" });
  const items = await workspaceItems(await getWorkspace(ws));
  applyWorkspaceChanges(items, { annotations: [{ id: "late", type: "point", x: 0.5, y: 0.5 }], resolve });
  await assert.rejects(commitTransfer({ previewId: p2.previewId }), /changed since the preview/);
  // Undo two successive changes in order.
  const e1 = await editWorkspace(ws, { arrange: [{ item: "wi-1", label: "one" }] });
  const e2 = await editWorkspace(ws, { arrange: [{ item: "wi-1", label: "two" }] });
  await undoChange(ws, e2.undoToken);
  await undoChange(ws, e1.undoToken);
  // Duplicate identifiers for one item add it once.
  const dup = await previewTransfer({ source: b1.imageId + "+" + b2.imageId, target: "new", items: ["wi-1", b1.imageId], mode: "link" });
  assert.equal(dup.plan.add.length, 1);
});

test("a change that could not be saved is not acknowledged; a retry with the same key runs again", async () => {
  const held = new Map(); let down = true;
  useRecords({
    write: async (kind, id, doc) => { if (down) throw new Error("store unavailable"); held.set(id, structuredClone(doc)); return 1; },
    read: async (kind, id) => held.get(id) ?? null, list: async () => [...held.keys()], log: async () => [],
  });
  try {
    await assert.rejects(createWorkspace({ name: "W", key: "k-retry" }), /store unavailable/);
    assert.equal(held.size, 0);
    down = false;
    const done = await createWorkspace({ name: "W", key: "k-retry" });
    assert.notEqual(done.repeated, true, "the failed attempt left no replay record behind");
    assert.equal(held.size, 1, "the retry was saved");
    const again = await createWorkspace({ name: "W", key: "k-retry" });
    assert.equal(again.repeated, true);
  } finally { useRecords(null); }
});

test("bytes that are not an image never become a stored asset", async () => {
  const stored = [];
  useCanvasStore({ read: async () => null, write: async () => 1, putImage: async (b) => { stored.push(b); }, imageBytes: async () => null, note() {} });
  try {
    await assert.rejects(intakeImage(Buffer.from("not an image at all"), { source: "upload" }), /not a supported image/);
    assert.equal(stored.length, 0, "nothing was installed");
  } finally { useCanvasStore(null); }
});

test("a caller that arrives while an image is being restored waits for its saved canvas", async () => {
  const bytes = (await threeImageFixture(registerImage)).a.sourceBytes;
  clearImages();
  let release;
  const gate = new Promise((r) => { release = r; });
  useCanvasStore({ read: async () => null, write: async () => 1, putImage: async () => { await gate; }, imageBytes: async () => null, note() {} });
  try {
    const first = intakeImage(bytes, { source: "upload" });
    await new Promise((r) => setTimeout(r, 20));
    let settled = false;
    const second = intakeImage(bytes, { source: "upload" }).then((e) => { settled = true; return e; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settled, false, "the second caller waits for the first load");
    release();
    assert.equal((await second).imageId, (await first).imageId);
  } finally { release(); useCanvasStore(null); }
});

test("a move where only one of the two workspaces could be saved leaves neither half-changed", async () => {
  const held = new Map(); let failFor = null;
  useRecords({
    write: async (kind, id, doc) => { if (id === failFor) throw new Error("store unavailable"); held.set(id, structuredClone(doc)); return 1; },
    read: async (kind, id) => held.get(id) ?? null, list: async () => [...held.keys()], log: async () => [],
  });
  try {
    const { a, b1, b2 } = await threeImageFixture(registerImage);
    const merged = await commitTransfer({ source: b1.imageId + "+" + b2.imageId, target: a.imageId });
    const other = await createWorkspace({ name: "B" });
    failFor = other.workspace.id;
    await assert.rejects(commitTransfer({ source: merged.workspaceId, target: other.workspace.id, items: ["wi-3"], removeFromSource: true, key: "k-move" }), /store unavailable/);
    assert.equal(held.get(merged.workspaceId).items.length, 3, "the source's saved record is back to what it was");
    assert.deepEqual((held.get(merged.workspaceId).keys ?? []).filter((k) => k.key === "k-move"), []);
    failFor = null;
    const done = await commitTransfer({ source: merged.workspaceId, target: other.workspace.id, items: ["wi-3"], removeFromSource: true, key: "k-move" });
    assert.notEqual(done.repeated, true);
    assert.equal(held.get(other.workspace.id).items.length, 1);
  } finally { useRecords(null); }
});
