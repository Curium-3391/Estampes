import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { registerImage, clearImages } from "../src/image-store.js";
import { fromFrame, applyCanvasChanges, editCanvas, canvasMarks, storeUserMarks, undoCanvasEdit, redoCanvasEdit, canvasHistory, takeUserEdits } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation, replayUserAnnotation } from "../src/scene-catalog.js";
import {
  frameMatrix, mapMark, mapMarkChecked, roundTripError, markBounds, anchorOf, resolveAnchor, rotate, translate, scale, chain, ANCHOR_SPACES,
} from "../src/visual/coordinates.js";
import { hitTest, distanceToMark } from "../src/visual/hit-test.js";
import { classifyChange, HistoryConflict, HISTORY_KEEP } from "../src/visual/annotation-history.js";

beforeEach(() => clearImages());
const photo = async () => registerImage(await sharp({ create: { width: 400, height: 300, channels: 3, background: "#264" } }).png().toBuffer(), { source: "url" });
const resolve = resolveCoordinateAnnotation, resolveUser = replayUserAnnotation;
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, a + " vs " + b);

test("frameMatrix + mapMark agree with canvas-state fromFrame for every mark type", () => {
  const frames = [{ region: { x: 0.5, y: 0.2, x2: 0.7, y2: 0.6 }, width: 800, height: 1600 }, { region: { x: 0.1, y: 0.1, x2: 0.9, y2: 0.5 } }];
  const marks = [{ id: "p", type: "point", x: 0.3, y: 0.4 }, { id: "r", type: "rect", x: 0.1, y: 0.2, x2: 0.6, y2: 0.9 },
    { id: "a", type: "arrow", x: 0.2, y: 0.2, x2: 0.8, y2: 0.7 }, { id: "l", type: "polyline", x: 0, y: 0, x2: 1, y2: 1, points: [{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 0.25 }] }];
  for (const frame of frames) for (const mark of marks) {
    const raw = frame.width ? { ...mark, x: mark.x * frame.width, y: mark.y * frame.height, x2: mark.x2 === undefined ? undefined : mark.x2 * frame.width, y2: mark.y2 === undefined ? undefined : mark.y2 * frame.height,
      ...(mark.points ? { points: mark.points.map((p) => ({ x: p.x * frame.width, y: p.y * frame.height })) } : {}) } : mark;
    const a = fromFrame(raw, frame), b = mapMark(raw, frameMatrix(frame));
    for (const k of ["x", "y", "x2", "y2"]) if (a[k] !== undefined) close(a[k], b[k]);
    (a.points ?? []).forEach((p, i) => { close(p.x, b.points[i].x); close(p.y, b.points[i].y); });
  }
});

test("mapMarkChecked: exact round trip, rotation turns a rect into a closed polyline, bad matrices fail", () => {
  const around = (deg) => chain(translate(-0.5, -0.5), rotate(deg), translate(0.5, 0.5));
  const m = around(30), rect = { id: "r", type: "rect", x: 0.2, y: 0.3, x2: 0.4, y2: 0.5 };
  assert.equal(mapMarkChecked(rect, around(90)).type, "rect", "a quarter turn keeps a rect a rect");
  const out = mapMarkChecked(rect, m);
  assert.equal(out.type, "polyline");
  assert.equal(out.closed, true);
  assert.equal(out.points.length, 4);
  assert.ok(roundTripError(m, [{ x: 0.2, y: 0.3 }]) < 1e-12);
  assert.throws(() => mapMarkChecked(rect, scale(0)), /cannot be inverted/);
  assert.throws(() => mapMarkChecked(rect, translate(2, 0)), /outside the image/);
  assert.doesNotThrow(() => mapMarkChecked(rect, translate(2, 0), { allowOutside: true }));
  assert.throws(() => mapMarkChecked(rect, [1, 0, 0, 0, 1, 0, 0, 0, 1], { tolerance: -1 }), /round trip/);
});

test("anchors: normalized only; document, world and function-x are refused by name", () => {
  assert.deepEqual(ANCHOR_SPACES, ["normalized"]);
  const poly = { type: "polyline", points: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.9 }] };
  assert.deepEqual(resolveAnchor(anchorOf({ type: "point", x: 0.3, y: 0.4 })), { x: 0.3, y: 0.4, x2: 0.3, y2: 0.4 });
  assert.deepEqual(resolveAnchor(anchorOf({ type: "rect", x: 0.4, y: 0.5, x2: 0.1, y2: 0.2 })), { x: 0.1, y: 0.2, x2: 0.4, y2: 0.5 });
  assert.deepEqual(resolveAnchor(anchorOf(poly)), { x: 0.1, y: 0.2, x2: 0.5, y2: 0.9 });
  for (const space of ["document", "world", "function-x"]) assert.throws(() => resolveAnchor({ space }), /not supported yet/);
  assert.throws(() => resolveAnchor({ space: "mars" }), /Unknown anchor space/);
  assert.deepEqual(markBounds({ type: "arrow", x: 0.8, y: 0.1, x2: 0.2, y2: 0.6 }), { x: 0.2, y: 0.1, x2: 0.8, y2: 0.6 });
});

test("hit test: tolerance in pixels, nearest first, later drawn wins ties, closed highlighter fills", () => {
  const W = 400, H = 300, opts = { width: W, height: H, tolerance: 6 };
  const marks = [
    { id: "rect", type: "rect", x: 0.2, y: 0.2, x2: 0.6, y2: 0.6 },
    { id: "dot", type: "point", x: 0.4, y: 0.4 },
    { id: "line", type: "polyline", points: [{ x: 0, y: 0.9 }, { x: 1, y: 0.9 }] },
    { id: "arrow", type: "arrow", x: 0.1, y: 0.1, x2: 0.1, y2: 0.8 },
    { id: "loop", type: "polyline", pen: "highlighter", closed: true, points: [{ x: 0.7, y: 0.1 }, { x: 0.95, y: 0.1 }, { x: 0.95, y: 0.4 }, { x: 0.7, y: 0.4 }] },
  ];
  assert.deepEqual(hitTest(marks, 0.4, 0.4, opts).map((m) => m.id), ["dot", "rect"], "both at distance 0: the later one first");
  assert.deepEqual(hitTest(marks, 0.3, 0.3, opts).map((m) => m.id), ["rect"]);
  assert.deepEqual(hitTest(marks, 0.5, 0.9 + 4 / H, opts).map((m) => m.id), ["line"]);
  assert.deepEqual(hitTest(marks, 0.5, 0.9 + 9 / H, opts), []);
  assert.deepEqual(hitTest(marks, 0.1 + 5 / W, 0.5, opts).map((m) => m.id), ["arrow"]);
  assert.deepEqual(hitTest(marks, 0.8, 0.25, opts).map((m) => m.id), ["loop"], "inside a closed highlighter");
  assert.equal(distanceToMark(marks[0], 0.6 + 10 / W, 0.4, { width: W, height: H }), 10);
});

test("classifyChange names move, resize, restyle, relabel, relayer, delete and create", () => {
  const r = { id: "r", type: "rect", x: 0.1, y: 0.1, x2: 0.3, y2: 0.3, layer: "L1" };
  assert.deepEqual(classifyChange(r, { ...r, x: 0.2, x2: 0.4 }), ["move"]);
  assert.deepEqual(classifyChange(r, { ...r, x2: 0.5 }), ["resize"]);
  assert.deepEqual(classifyChange(r, { ...r, color: "red", label: "A", layer: "L2" }), ["restyle", "relabel", "relayer"]);
  assert.deepEqual(classifyChange(r, { ...r, x: 0.2, x2: 0.5, color: "red" }), ["resize", "restyle"]);
  assert.deepEqual(classifyChange(r, null), ["delete"]);
  assert.deepEqual(classifyChange(null, r), ["create"]);
  assert.deepEqual(classifyChange(r, { ...r }), []);
});

test("undo / redo of the user's edits is exact, ordered, and refuses when the mark changed or is locked", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [{ id: "ai", type: "point", x: 0.2, y: 0.2, note: "pad" }], resolve });
  storeUserMarks(entry, [{ id: "user-1", type: "rect", x: 0.1, y: 0.1, x2: 0.3, y2: 0.3, label: "YOU 1", role: "focus" }]);
  const original = structuredClone(canvasMarks(entry).find((m) => m.id === "user-1"));
  assert.deepEqual(canvasHistory(entry), { canUndo: false, canRedo: false, undoNext: null });

  editCanvas(entry, { marks: [{ id: "user-1", x: 0.2, x2: 0.4 }], resolveUser });         // move
  editCanvas(entry, { marks: [{ id: "user-1", x2: 0.6, color: "red" }], resolveUser });   // resize + restyle
  editCanvas(entry, { remove: ["ai"] });                                                    // delete an AI mark
  assert.deepEqual(canvasHistory(entry), { canUndo: true, canRedo: false, undoNext: ["delete"] });
  takeUserEdits(entry);

  assert.equal(undoCanvasEdit(entry).steps[0], "delete");
  assert.ok(canvasMarks(entry).some((m) => m.id === "ai" && m.note === "pad"), "the deleted mark is back with its note");
  undoCanvasEdit(entry); undoCanvasEdit(entry);
  assert.deepEqual(canvasMarks(entry).find((m) => m.id === "user-1"), original, "back to the exact original");
  assert.throws(() => undoCanvasEdit(entry), (e) => e instanceof HistoryConflict && /Nothing to undo/.test(e.message));
  assert.deepEqual(takeUserEdits(entry).map((e) => e.kind), ["undo-edit", "undo-edit", "undo-edit"]);

  redoCanvasEdit(entry);
  assert.equal(canvasMarks(entry).find((m) => m.id === "user-1").x, 0.2);
  // A new edit ends the redo chain.
  editCanvas(entry, { marks: [{ id: "user-1", label: "pad A" }], resolveUser });
  assert.equal(canvasHistory(entry).canRedo, false);
  assert.throws(() => redoCanvasEdit(entry), /Nothing to redo/);

  // The assistant changed the same mark since: undo refuses, nothing is overwritten.
  const stored = canvasMarks(entry).find((m) => m.id === "ai");
  entry.marks.set("ai", { ...stored, note: "changed by GPT" });
  editCanvas(entry, { remove: ["ai"] });
  entry.marks.set("ai", { ...stored, note: "new claim with the same id" });
  assert.throws(() => undoCanvasEdit(entry), (e) => e instanceof HistoryConflict && e.id === "ai" && /changed since/.test(e.message));
  assert.equal(canvasMarks(entry).find((m) => m.id === "ai").note, "new claim with the same id");

  // A locked layer blocks undo as it blocks editing.
  entry.marks.delete("ai"); canvasHistory(entry); entry.markHistory.past.pop();
  const layer = canvasMarks(entry).find((m) => m.id === "user-1").layer;
  editCanvas(entry, { marks: [{ id: "user-1", color: "blue" }], resolveUser });
  editCanvas(entry, { layers: [{ id: layer, locked: true }] });
  assert.throws(() => undoCanvasEdit(entry), /layer the user locked/);
});

test("history keeps the last HISTORY_KEEP steps", async () => {
  const entry = await photo();
  storeUserMarks(entry, [{ id: "user-1", type: "point", x: 0.1, y: 0.1, label: "YOU 1", role: "focus" }]);
  for (let i = 0; i < HISTORY_KEEP + 5; i++) editCanvas(entry, { marks: [{ id: "user-1", x: 0.1 + (i + 1) / 1000 }], resolveUser });
  assert.equal(entry.markHistory.past.length, HISTORY_KEEP);
});
