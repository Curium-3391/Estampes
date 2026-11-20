// Default names the server makes up are stored as a catalog key plus the
// literal text (RFC docs/rfc/i18n T5, D6): the key lets a viewer read the name
// in their language, the literal stays the name of record and what the
// assistant reads. The document format stays estampes.document/1.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { CATALOGS } from "../src/i18n/index.js";
import { createI18n } from "../src/i18n/runtime.js";
import { localizedName } from "../src/i18n/widget-runtime.js";
import { defaultName, cleanNameFields, NAME_KEYS } from "../src/i18n/names.js";
import { registerImage, clearImages } from "../src/image-store.js";
import { applyCanvasChanges, storeUserMarks, editCanvas, canvasLayers, canvasMarks } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation as resolve, replayUserAnnotation } from "../src/scene-catalog.js";
import { serializeCanvas, useStorageDir } from "../src/storage.js";
import { LayerSchema } from "../src/documents/schema.js";
import { mapLegacyCanvas } from "../src/documents/legacy-shadow.js";
import { projectCanvas, diffJson } from "../src/uva/canvas-projection.js";
import { hashJson } from "../src/documents/validation.js";
import { context } from "./fixtures/uva-pr1a.mjs";
import { clearWorkspaces, commitTransfer } from "../src/workspace.js";
import { exportBundle, importBundle } from "../src/bundle.js";
import { unzipFiles } from "../src/zip.js";
import { exportMarksSvg, parseMarksFile, fileLayers } from "../src/marks-file.js";
import { canvasDocument } from "../src/protocol.js";
import { threeImageFixture } from "./fixtures/three-images.js";

beforeEach(() => { clearImages(); clearWorkspaces(); useStorageDir(""); });
const photo = async () => registerImage(await sharp({ create: { width: 400, height: 300, channels: 3, background: "#468" } }).png().toBuffer(), { source: "test" });
const box = (id, x) => ({ id, type: "rect", x, y: 0.2, x2: x + 0.1, y2: 0.4 });
const tr = (locale) => { const i = createI18n(CATALOGS, locale, []); return (k, p) => i.t(k, p); };
const shown = (rec, locale) => localizedName(rec, tr(locale));

test("a default name keeps its literal text and its key, and reads in either language", () => {
  const layer = defaultName("name.layer.numbered", { author: "assistant", n: 2 });
  assert.deepEqual(layer, { name: "AI · 第2次", nameKey: "name.layer.numbered", nameParams: { author: "assistant", n: 2 } });
  assert.equal(shown(layer, "en"), "AI · #2");
  assert.equal(shown(layer, "zh-TW"), "AI · 第2次");
  const mine = defaultName("name.layer.imported", { author: "user" });
  assert.equal(shown(mine, "en"), "You · imported");
  assert.equal(shown(mine, "zh-TW"), "你 · 匯入");
  const nested = defaultName("name.copy.layer", { source: "a.png", layer: defaultName("name.layer.numbered", { author: "user", n: 1 }), n: 3 });
  assert.equal(nested.name, "複本 a.png · 你 · 第1次 3");
  assert.equal(shown(nested, "en"), "Copy of a.png · You · #1 3");
  assert.equal(shown(nested, "zh-TW"), nested.name);
  // A copy of a copy keeps its inner name as text only, so what is stored stays small.
  const deep = defaultName("name.copy.layer", { source: "b.png", layer: nested, n: 4 });
  assert.deepEqual(deep.nameParams.layer, { name: nested.name });
  assert.equal(shown(deep, "en"), "Copy of b.png · 複本 a.png · 你 · 第1次 3 4");
  for (const key of NAME_KEYS) for (const locale of ["en", "zh-TW"]) assert.ok(CATALOGS[locale][key], key + " in " + locale);
});

test("a record without a key, or with a key this build does not know, shows its literal name", () => {
  assert.equal(shown({ name: "我的圖層" }, "en"), "我的圖層");
  assert.equal(shown({ name: "AI · 第2次" }, "en"), "AI · 第2次", "an old default name is not guessed at");
  assert.equal(shown({ name: "x", nameKey: "name.from.the.future", nameParams: {} }, "en"), "x");
  assert.equal(shown({ name: "x", nameKey: "name.layer.numbered", nameParams: { author: "robot", n: 1 } }, "en").includes("name.author"), false);
  assert.equal(shown(null, "en"), "");
});

test("keys from outside are kept only when they match the catalog exactly", () => {
  const good = defaultName("name.layer.numbered", { author: "user", n: 1 });
  assert.deepEqual(cleanNameFields(good), { nameKey: good.nameKey, nameParams: good.nameParams });
  for (const bad of [
    { nameKey: "name.nope", nameParams: {} },
    { nameKey: "vs.layer.nameLabel", nameParams: {} },
    { nameKey: "name.layer.numbered", nameParams: { author: "user" } },
    { nameKey: "name.layer.numbered", nameParams: { author: "user", n: 1, extra: 1 } },
    { nameKey: "name.layer.numbered", nameParams: { author: "root", n: 1 } },
    { nameKey: "name.layer.numbered", nameParams: { author: "user", n: "1".repeat(200) } },
    { nameKey: "name.layer.numbered", nameParams: { author: "user", n: { name: "x", nameKey: "name.layer.module", nameParams: {} } } },
    { nameKey: "name.layer.numbered", nameParams: [1] },
    { nameKey: 7 }, {}, null,
  ]) assert.deepEqual(cleanNameFields(bad), {}, JSON.stringify(bad));
  assert.deepEqual(cleanNameFields({ nameKey: "name.layer.module" }), { nameKey: "name.layer.module", nameParams: {} }, "a name without parameters");
});

test("layers made without a name keep a key; named, renamed and typed ones do not", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [box("a", 0.1)], resolve });
  applyCanvasChanges(entry, { annotations: [box("b", 0.4)], layer: "第一輪", resolve });
  storeUserMarks(entry, [{ id: "user-1", type: "point", x: 0.5, y: 0.5, label: "YOU 1" }]);
  const [auto, named, mine] = canvasLayers(entry);
  assert.deepEqual([auto.name, auto.nameKey, auto.nameParams], ["AI · 第1次", "name.layer.numbered", { author: "assistant", n: 1 }]);
  assert.deepEqual([named.name, named.nameKey, named.nameParams], ["第一輪", undefined, undefined]);
  assert.deepEqual([mine.name, mine.nameKey, mine.nameParams], ["你 · 第1次", "name.layer.numbered", { author: "user", n: 1 }]);
  // Renaming to the same text changes nothing; to other text, the key goes: it is now the person's own words.
  editCanvas(entry, { layers: [{ id: auto.id, name: "AI · 第1次" }], resolveUser: replayUserAnnotation });
  assert.equal(canvasLayers(entry)[0].nameKey, "name.layer.numbered");
  editCanvas(entry, { layers: [{ id: auto.id, name: "外框" }], resolveUser: replayUserAnnotation });
  const renamed = canvasLayers(entry)[0];
  assert.deepEqual([renamed.name, "nameKey" in renamed, "nameParams" in renamed], ["外框", false, false]);
  assert.equal(shown(renamed, "en"), "外框");
});

test("the fields survive the canvas file, the UVA document and the projection back, with nothing left over", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [box("a", 0.1)], resolve });
  storeUserMarks(entry, [{ id: "user-1", type: "point", x: 0.5, y: 0.5, label: "YOU 1" }]);
  const { savedAt, ...source } = serializeCanvas(entry);
  assert.ok(source.layers.every((l) => l.nameKey), "the canvas file carries the keys");
  const UNLAYERED = "layer:00000000-0000-4000-8000-0000000000ff";
  const mapped = mapLegacyCanvas({ ...source, savedAt, imageId: context().asset.legacyImageId, width: 1600, height: 1000 }, { ...context(), unlayeredLayerId: UNLAYERED });
  assert.equal(mapped.status, "mapped", JSON.stringify(mapped.report.issues));
  const docLayers = mapped.document.scenes[0].layers.filter((l) => l.id !== UNLAYERED);
  assert.deepEqual(docLayers.map((l) => [l.name, l.nameKey, l.nameParams]), source.layers.map((l) => [l.name, l.nameKey, l.nameParams]));
  for (const l of docLayers) assert.ok(LayerSchema.safeParse(l).success);
  const projected = projectCanvas(mapped.document, { unlayeredLayerId: UNLAYERED });
  assert.deepEqual(projected.layers, source.layers, "layers come back as stored, keys included");
});

test("the document schema bounds the two fields and still refuses anything else on a layer", () => {
  const layer = { id: "L1", author: "assistant", name: "AI · 第1次", opacity: 1, visible: true, locked: false, content: [] };
  const ok = (extra) => LayerSchema.safeParse({ ...layer, ...extra }).success;
  assert.equal(ok({}), true);
  assert.equal(ok({ nameKey: "name.layer.numbered", nameParams: { author: "assistant", n: 1 } }), true);
  assert.equal(ok({ nameKey: "name.copy.layer", nameParams: { source: "a", layer: { name: "x", nameKey: "name.layer.module", nameParams: {} }, n: 1 } }), true);
  assert.equal(ok({ nameKey: "layer.numbered" }), false, "keys live under name.");
  assert.equal(ok({ nameKey: "name.layer.numbered", nameParams: { author: "x".repeat(121) } }), false);
  assert.equal(ok({ nameKey: "name.layer.numbered", nameParams: { n: Infinity } }), false);
  assert.equal(ok({ nameKey: "name.layer.numbered", nameParams: { layer: { name: "x", nameParams: { a: { name: "deeper" } } } } }), false, "one level of nesting");
  assert.equal(ok({ other: 1 }), false);
});

test("a bundle carries the keys and an import keeps them; bundle layers with a bad key keep their literal name", async () => {
  const { a, b1, b2 } = await threeImageFixture(registerImage);
  const done = await commitTransfer({ source: b1.imageId + "+" + b2.imageId, target: a.imageId, mode: "link" });
  const built = await exportBundle(done.workspaceId, { version: "test" });
  const sets = [...unzipFiles(built.buffer)].filter(([n]) => /^sets\/\d+\.json$/.test(n)).map(([, d]) => JSON.parse(d.toString()));
  const keyed = sets.flatMap((s) => s.layers).filter((l) => l.nameKey);
  assert.ok(keyed.length > 0, "the fixture has default-named layers");
  for (const l of keyed) assert.deepEqual(cleanNameFields(l), { nameKey: l.nameKey, nameParams: l.nameParams });
  clearImages(); clearWorkspaces();
  const back = await importBundle(built.buffer, { name: "carried" });
  assert.equal(back.verified, true, JSON.stringify({ m: back.mismatch, u: back.unsupported, w: back.warnings }));
  const after = await exportBundle(back.workspace.id, { version: "test" });
  const again = [...unzipFiles(after.buffer)].filter(([n]) => /^sets\/\d+\.json$/.test(n)).flatMap(([, d]) => JSON.parse(d.toString()).layers);
  const wsOf = (b) => JSON.parse([...unzipFiles(b.buffer)].find(([n]) => n === "workspace.json")[1].toString());
  assert.equal(wsOf(built).nameKey, "name.workspace.canvas", "the workspace name carries its key");
  assert.deepEqual([wsOf(after).name, "nameKey" in wsOf(after)], ["carried", false], "a name given on import is the person's own");
  clearImages(); clearWorkspaces();
  const unnamed = await importBundle(built.buffer);
  const kept = wsOf(await exportBundle(unnamed.workspace.id, { version: "test" }));
  assert.deepEqual([kept.name, kept.nameKey], [wsOf(built).name, wsOf(built).nameKey], "without a name the keyed one is kept");
  const pick = (ls) => ls.map((l) => [l.id, l.name, l.nameKey, JSON.stringify(l.nameParams)]).sort();
  assert.deepEqual(pick(again), pick(sets.flatMap((s) => s.layers)));
});

test("a marks file (SVG or visual document) keeps the key through the public import mapping", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [box("a", 0.1)], resolve });
  const layers = canvasLayers(entry), marks = canvasMarks(entry);
  const viaSvg = fileLayers(parseMarksFile(Buffer.from(exportMarksSvg(entry, marks, layers))));
  assert.deepEqual(viaSvg.map((l) => [l.name, l.nameKey, l.nameParams]), layers.map((l) => [l.name, l.nameKey, l.nameParams]));
  const doc = JSON.stringify(canvasDocument(entry));
  const viaDoc = fileLayers(parseMarksFile(Buffer.from(doc)));
  assert.deepEqual(viaDoc.map((l) => [l.name, l.nameKey]), layers.map((l) => [l.name, l.nameKey]));
  assert.ok(viaDoc.every((l) => l.nameKey), "keys survive");
});

test("workspace default names keep a key; typed, renamed and split ones behave", async () => {
  const { a, b1, b2 } = await threeImageFixture(registerImage);
  const { getWorkspace, legacyWorkspace, createWorkspace, editWorkspace, commitTransfer: transfer } = await import("../src/workspace.js");
  const legacy = await legacyWorkspace(a.imageId);
  assert.equal(legacy.nameKey, "name.workspace.canvas");
  assert.equal(shown(legacy, "en"), "Canvas " + a.imageId);
  assert.ok(legacy.name.includes(a.imageId), "the literal is the name of record");
  const made = await createWorkspace({ items: [{ asset: a.imageId, set: a.imageId }] });
  const plain = (await getWorkspace(made.workspaceId));
  assert.deepEqual([plain.name, plain.nameKey], ["工作區", "name.workspace.default"]);
  assert.equal(shown(plain, "en"), "Workspace");
  const typed = (await getWorkspace((await createWorkspace({ name: "我的", items: [] })).workspaceId));
  assert.deepEqual(["nameKey" in typed, typed.name], [false, "我的"]);
  // Same text keeps the key; other text drops it.
  await editWorkspace(plain.id, { name: plain.name });
  assert.equal((await getWorkspace(plain.id)).nameKey, "name.workspace.default");
  await editWorkspace(plain.id, { name: "新名稱" });
  const renamed = (await getWorkspace(plain.id));
  assert.deepEqual([renamed.name, "nameKey" in renamed, "nameParams" in renamed], ["新名稱", false, false]);
  // A split with no name is born keyed, with the source's name nested.
  const merged = await transfer({ source: b1.imageId + "+" + b2.imageId, target: a.imageId, mode: "link" });
  const split = await transfer({ source: merged.workspaceId, target: "new", items: ["wi-2"], mode: "copy" });
  const sp = (await getWorkspace(split.workspaceId));
  assert.equal(sp.nameKey, "name.workspace.split");
  assert.deepEqual(cleanNameFields(sp), { nameKey: sp.nameKey, nameParams: sp.nameParams });
  assert.ok(shown(sp, "en").endsWith("(split)"));
});

test("every workspace object the server hands the widget carries the name fields, and the widget keeps them", async () => {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const sites = server.match(/name: doc\.name, \.\.\.cleanNameFields\(doc\)/g) ?? [];
  assert.equal(sites.length, 3, "presentWorkspace, load_visual_canvas and the document-change snapshot");
  assert.equal(/name: doc\.name, revision/.test(server), false, "no workspace object is built from the literal alone");
  const widget = readFileSync(new URL("../public/visual-surface.html", import.meta.url), "utf8");
  assert.match(widget, /nameKey:wsArg\.nameKey/);
});
