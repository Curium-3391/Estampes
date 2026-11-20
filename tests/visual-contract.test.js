import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { registerImage, clearImages } from "../src/image-store.js";
import { applyCanvasChanges, editCanvas, canvasMarks, canvasLayers, storeUserMarks, claimOf, LAYER_NAME_MAX } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation, replayUserAnnotation } from "../src/scene-catalog.js";
import {
  ANNOTATION_FIELDS, ANNOTATION_FIELD_NAMES, CLAIM_FIELDS, unknownFields, geometryChanged, pickFields, withoutClaim,
  MARK_TYPES, MARK_COLORS,
} from "../src/visual/annotation-contract.js";
import {
  LAYER_FIELDS, layerOpacity, newLayerRecord, applyLayerEdit, reorderLayers, LAYER_NAME_MAX as CONTRACT_NAME_MAX,
} from "../src/visual/layer-contract.js";

beforeEach(() => clearImages());
const photo = async () => registerImage(await sharp({ create: { width: 400, height: 300, channels: 3, background: "#264" } }).png().toBuffer(), { source: "url" });
const resolve = resolveCoordinateAnnotation;
const hash = (v) => createHash("sha256").update(JSON.stringify(v, Object.keys(v).sort())).digest("hex");

test("every field a stored mark carries is named by the annotation contract, each in one group", () => {
  const all = Object.values(ANNOTATION_FIELDS).flat();
  assert.equal(new Set(all).size, all.length, "a field belongs to exactly one group");
  assert.deepEqual(MARK_TYPES, ["point", "rect", "arrow", "polyline"]);
  assert.ok(MARK_COLORS.includes("gold"));
  for (const k of CLAIM_FIELDS) assert.ok(ANNOTATION_FIELD_NAMES.has(k), k);
});

test("a rich mark (style, note, evidence, review) loses no field through add, edit and finding", async () => {
  const entry = await photo();
  const evidence = [{ kind: "pixels", side: "left", region: [0.1, 0.1, 0.3, 0.3], says: "tin-plated pad" }];
  applyCanvasChanges(entry, {
    annotations: [{ id: "trace", type: "polyline", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }, { x: 0.3, y: 0.2 }], smooth: true, closed: true,
      label: "VCC", color: "red", size: "thin", pen: "highlighter", note: "power rail", status: "uncertain", confidence: "high", evidence }],
    resolve, images: { left: entry.imageId },
  });
  const first = canvasMarks(entry)[0];
  assert.deepEqual(unknownFields(first), [], "contract names every stored field");
  for (const k of ["id", "type", "label", "points", "smooth", "closed", "color", "size", "pen", "note", "status", "confidence", "evidence", "author", "grounding", "layer", "findingUpdatedAt"]) {
    assert.notEqual(first[k], undefined, k);
  }
  // Editing only the colour keeps every other field byte for byte.
  applyCanvasChanges(entry, { annotations: [{ id: "trace", type: "polyline", points: first.points, smooth: true, closed: true, color: "blue" }], resolve, images: { left: entry.imageId } });
  const second = canvasMarks(entry)[0];
  const { color: _c, ...before } = first, { color: c2, ...after } = second;
  assert.equal(c2, "blue");
  assert.deepEqual(after, before);
});

test("claim helpers split a mark into claim and the rest without loss", () => {
  const m = { id: "a", type: "point", x: 0.5, y: 0.5, note: "n", confidence: "low", evidence: [1], review: "confirmed", reviewReason: "ok", ambiguities: ["x"], previouslyRejected: { at: "t" } };
  assert.deepEqual(Object.keys(claimOf(m)).sort(), [...CLAIM_FIELDS].sort());
  assert.deepEqual({ ...withoutClaim(m), ...claimOf(m) }, m);
  assert.deepEqual(claimOf(null), {});
});

test("geometryChanged ignores style, label and flags; sees bounds and vertices", () => {
  const a = { x: 0.1, y: 0.1, x2: 0.2, y2: 0.2, color: "red", points: [{ x: 0, y: 0 }] };
  assert.equal(geometryChanged(a, { ...a, color: "blue", label: "x", smooth: true }), false);
  assert.equal(geometryChanged(a, { ...a, x2: 0.3 }), true);
  assert.equal(geometryChanged(a, { ...a, points: [{ x: 0, y: 0.1 }] }), true);
  assert.deepEqual(pickFields({ id: "a", x: 1, color: "red", note: "n" }, "geometry", "style"), { x: 1, color: "red" });
});

test("layer contract: ids, default names, opacity steps, edits and ordering", () => {
  assert.equal(LAYER_NAME_MAX, CONTRACT_NAME_MAX);
  assert.deepEqual(LAYER_FIELDS, ["id", "author", "name", "nameKey", "nameParams", "module", "locked", "opacity", "visible"]);
  const layers = [];
  layers.push(newLayerRecord(layers, "assistant"));
  layers.push(newLayerRecord(layers, "user"));
  layers.push(newLayerRecord(layers, "assistant", "Named"));
  layers.push(newLayerRecord(layers, "assistant"));
  assert.deepEqual(layers.map((l) => [l.id, l.name]), [["L1", "AI · 第1次"], ["L2", "你 · 第1次"], ["L3", "Named"], ["L4", "AI · 第3次"]]);
  assert.equal(layerOpacity(0.123), 0.1);
  assert.equal(layerOpacity(7), 1);
  assert.equal(layerOpacity(-1), 0);

  const l = { id: "L1", author: "assistant", name: "A" };
  assert.deepEqual(applyLayerEdit(l, { name: "  B  ", locked: true, opacity: 0.5 }), [
    { kind: "rename-layer", layer: "L1", from: "A", to: "B" }, { kind: "lock-layer", layer: "L1" }]);
  assert.deepEqual(l, { id: "L1", author: "assistant", name: "B", locked: true, opacity: 0.5 });
  applyLayerEdit(l, { locked: false, opacity: 1 });
  assert.deepEqual(l, { id: "L1", author: "assistant", name: "B" });
  assert.throws(() => applyLayerEdit(l, { name: "   " }), /name is empty/);
  assert.equal(applyLayerEdit(l, { name: "x".repeat(99) }).length, 1);
  assert.equal(l.name.length, LAYER_NAME_MAX);

  assert.deepEqual(reorderLayers(layers, ["L3", "L1"]).map((x) => x.id), ["L3", "L1", "L2", "L4"]);
  assert.throws(() => reorderLayers(layers, ["L3", "L3"]), /unknown or repeated/);
  assert.throws(() => reorderLayers(layers, ["L9"]), /unknown or repeated/);
});

test("canvas edits go through the layer contract: rename, lock, fade, reorder, with the same messages", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [{ id: "a", type: "point", x: 0.2, y: 0.2 }], resolve });
  storeUserMarks(entry, [{ id: "user-1", type: "point", x: 0.5, y: 0.5, label: "YOU 1", role: "focus" }]);
  const [ai, user] = canvasLayers(entry);
  const edits = editCanvas(entry, { layers: [{ id: ai.id, name: "Traces", locked: true, opacity: 0.4 }], order: [user.id] });
  assert.deepEqual(edits.map((e) => e.kind), ["rename-layer", "lock-layer", "reorder-layers"]);
  assert.deepEqual(canvasLayers(entry).map((l) => l.id), [user.id, ai.id]);
  assert.equal(canvasLayers(entry)[1].opacity, 0.4);
  assert.throws(() => editCanvas(entry, { layers: [{ id: "L99", name: "x" }] }), /edit_visual_canvas layers\[0\] \("L99"\): no such layer/);
  assert.throws(() => editCanvas(entry, { layers: [{ id: ai.id, name: " " }] }), /layers\[0\] \("L1"\): name is empty/);
  assert.throws(() => editCanvas(entry, { order: ["L1", "L1"] }), /order\[0\] \("L1,L1"\): unknown or repeated layer id/);
  assert.throws(() => editCanvas(entry, { remove: ["a"] }), /its layer is locked/);
  // The user's own mark: moving it is "edited"; restyling is not.
  const resolveUser = (m) => replayUserAnnotation(m);
  editCanvas(entry, { marks: [{ id: "user-1", color: "red" }], resolveUser });
  assert.equal(canvasMarks(entry).find((m) => m.id === "user-1").edited, undefined);
  editCanvas(entry, { marks: [{ id: "user-1", x: 0.6 }], resolveUser });
  assert.equal(canvasMarks(entry).find((m) => m.id === "user-1").edited, true);
});
