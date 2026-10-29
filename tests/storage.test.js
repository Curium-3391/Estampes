import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { clearImages, hasImage } from "../src/image-store.js";
import { applyCanvasChanges, applyPairChanges, canvasMarks, canvasLayers, pairLinks, reviewLink, storeUserMarks } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation as resolve } from "../src/scene-catalog.js";
import { useStorageDir, intakeImage, ensureImage, saveCanvas, flushStorage, readHistory, checkStorage } from "../src/storage.js";

const png = (colour) => sharp({ create: { width: 300, height: 200, channels: 3, background: colour } }).png().toBuffer();
const box = (id, x, side) => ({ id, type: "rect", x, y: 0.2, x2: x + 0.1, y2: 0.4, ...(side ? { side } : {}) });
let dir;
beforeEach(() => { clearImages(); dir = mkdtempSync(join(tmpdir(), "estampes-store-")); useStorageDir(dir); });

test("a canvas survives the memory cache being emptied (restart or eviction)", async () => {
  assert.deepEqual(await checkStorage(), { enabled: true, dir });
  const bytes = await png("#246");
  const entry = await intakeImage(bytes, { source: "chat-file", fileName: "board.png" });
  const changed = applyCanvasChanges(entry, { annotations: [box("chip", 0.1)], layer: "電源", resolve });
  await saveCanvas(entry, { tool: "present_visual", changed });
  storeUserMarks(entry, [{ id: "user-1", type: "point", x: 0.5, y: 0.5, label: "YOU 1" }]);
  await saveCanvas(entry, { tool: "validate_visual_annotations", author: "user", changed: ["user-1"] });
  await flushStorage();

  const folder = join(dir, "images", entry.imageId.slice(4));
  assert.deepEqual(readFileSync(join(folder, "source")), bytes);
  assert.equal(JSON.parse(readFileSync(join(folder, "meta.json"), "utf8")).fileName, "board.png");
  assert.match(readFileSync(join(folder, "marks.svg"), "utf8"), /inkscape:label="電源"/);

  clearImages();
  assert.equal(hasImage(entry.imageId), false);
  const back = await ensureImage(entry.imageId);
  assert.notEqual(back, entry);
  assert.deepEqual(canvasMarks(back).map((m) => [m.id, m.author]), [["chip", "assistant"], ["user-1", "user"]]);
  assert.deepEqual(canvasLayers(back).map((l) => l.name), ["電源", "你 · 第1次"]);
  const history = await readHistory(entry.imageId);
  assert.deepEqual(history.map((h) => [h.tool, h.author, h.changed]), [["present_visual", "assistant", ["chip"]], ["validate_visual_annotations", "user", ["user-1"]]]);

  // The same file attached again in a new chat brings the canvas back too.
  clearImages();
  const again = await intakeImage(bytes, { source: "chat-file" });
  assert.equal(canvasMarks(again).length, 2);
});

test("paired links and the user's review are stored with the left image", async () => {
  const left = await intakeImage(await png("#fff"), { source: "url" });
  const right = await intakeImage(await png("#0a0"), { source: "url" });
  applyPairChanges(left, right, { annotations: [box("s", 0.1, "left"), box("p", 0.5, "right")],
    links: [{ id: "k", left: "s", right: "p", confidence: "low" }], resolve });
  reviewLink(left, right, "k", "confirmed");
  await Promise.all([saveCanvas(left, { tool: "t" }), saveCanvas(right, { tool: "t" })]);
  clearImages();
  const [l, r] = [await ensureImage(left.imageId), await ensureImage(right.imageId)];
  assert.deepEqual(pairLinks(l, r).map((k) => [k.id, k.review]), [["k", "confirmed"]]);
});

test("without a storage dir nothing touches the disk and unknown ids still fail clearly", async () => {
  useStorageDir("");
  const entry = await intakeImage(await png("#123"), { source: "url" });
  await saveCanvas(entry, { tool: "t" });
  assert.equal(existsSync(join(dir, "images")), false);
  clearImages();
  await assert.rejects(ensureImage(entry.imageId), /load_image again/);
  useStorageDir(dir);
  await assert.rejects(ensureImage("img:0000000000000000"), /load_image again/);
  await assert.rejects(ensureImage("../../etc"), /load_image again/);
});
