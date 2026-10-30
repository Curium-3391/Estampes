import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { registerImage, clearImages } from "../src/image-store.js";

// Same bytes return the same cached canvas; each test starts clean.
beforeEach(() => clearImages());
import { applyCanvasChanges, canvasMarks, canvasLayers, storeUserMarks, fromFrame } from "../src/canvas-state.js";
import { renderVerification, marksRegion } from "../src/mark-render.js";
import { resolveCoordinateAnnotation } from "../src/scene-catalog.js";

const photo = async () => registerImage(await sharp({ create: { width: 400, height: 300, channels: 3, background: "#264" } })
  .png().toBuffer(), { source: "url" });
const resolve = resolveCoordinateAnnotation;

test("crop coordinates convert back to the full image", () => {
  const frame = { region: { x: 0.5, y: 0.2, x2: 0.7, y2: 0.6 }, width: 800, height: 1600 };
  const m = fromFrame({ id: "t", type: "polyline", points: [{ x: 0, y: 0 }, { x: 400, y: 1600 }] }, frame);
  assert.deepEqual(m.points.map(p => [+p.x.toFixed(6), +p.y.toFixed(6)]), [[0.5, 0.2], [0.6, 0.6]]);
  const n = fromFrame({ id: "r", type: "rect", x: 0.5, y: 0.5, x2: 1, y2: 1 }, { region: frame.region });
  assert.deepEqual([n.x, n.y, n.x2, n.y2].map(v => +v.toFixed(6)), [0.6, 0.4, 0.7, 0.6]);
});

test("marks persist with stable ids: add, edit, comment, remove", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [{ id: "chip", type: "rect", x: 0.1, y: 0.1, x2: 0.3, y2: 0.3, note: "first" }], resolve });
  storeUserMarks(entry, [{ id: "user-ab-1", type: "point", x: 0.5, y: 0.5, label: "YOU 1", role: "focus" }]);
  // Editing by id keeps the old note; findings comment on the user's mark.
  const changed = applyCanvasChanges(entry, {
    annotations: [{ id: "chip", type: "rect", x: 0.12, y: 0.1, x2: 0.3, y2: 0.3 }],
    findings: [{ id: "user-ab-1", note: "CXD2500AQ", status: "inspected" }], resolve,
  });
  assert.deepEqual(changed, ["chip", "user-ab-1"]);
  const [chip, user] = canvasMarks(entry);
  assert.equal(chip.x, 0.12);
  assert.equal(chip.note, "first");
  assert.equal(user.author, "user");
  assert.equal(user.role, undefined, "submission role is not stored");
  assert.equal(user.note, "CXD2500AQ");
  assert.throws(() => applyCanvasChanges(entry, { annotations: [{ id: "user-ab-1", type: "point", x: 0, y: 0 }], resolve }), /annotations\[0\] \(mark "user-ab-1"\): field id is a mark the user drew/);
  assert.throws(() => applyCanvasChanges(entry, { findings: [{ id: "nope", note: "x" }], resolve }), /findings\[0\] \(mark "nope"\): no such mark/);
  applyCanvasChanges(entry, { remove: ["chip"], resolve });
  assert.deepEqual(canvasMarks(entry).map(m => m.id), ["user-ab-1"]);
  applyCanvasChanges(entry, { reset: true, resolve });
  assert.equal(canvasMarks(entry).length, 0);
  assert.throws(() => applyCanvasChanges(entry, { annotations: [{ id: "far", type: "point", x: 2, y: 0.5 }], resolve }), /Invalid/);
});

test("verification image shows the crop with and without the marks", async () => {
  const entry = await photo();
  applyCanvasChanges(entry, { annotations: [
    { id: "a", type: "rect", x: 0.4, y: 0.4, x2: 0.5, y2: 0.6, color: "red" },
    { id: "b", type: "polyline", points: [{ x: 0.45, y: 0.5 }, { x: 0.6, y: 0.55 }], pen: "highlighter" },
  ], resolve });
  const v = await renderVerification(entry, canvasMarks(entry), ["a"]);
  assert.equal(v.mimeType, "image/jpeg");
  assert.deepEqual(v.numbers, [{ n: 1, id: "a", label: undefined }]);
  assert.ok(v.region.x <= 0.4 && v.region.x2 >= 0.5 && v.region.y <= 0.4 && v.region.y2 >= 0.6);
  const meta = await sharp(v.data).metadata();
  assert.equal(v.layout, "side-by-side");
  assert.ok(meta.width > meta.height, "two panels side by side");
  // Left panel is untouched photo; the right panel has the red outline.
  const { data, info } = await sharp(v.data).raw().toBuffer({ resolveWithObject: true });
  const half = (info.width - 8) / 2, rowY = Math.round(info.height / 2);
  let redLeft = 0, redRight = 0;
  for (let x = 0; x < info.width; x++) {
    const i = (rowY * info.width + x) * info.channels;
    if (data[i] - data[i + 1] > 60) x < half ? redLeft++ : redRight++;
  }
  assert.equal(redLeft, 0);
  assert.ok(redRight > 0);
  assert.deepEqual(marksRegion([{ x: 0.5, y: 0.5 }]), { x: 0.46, y: 0.46, x2: 0.54, y2: 0.54 });
});

test("each send and each GPT drawing call becomes one layer", async () => {
  const entry = await photo();
  const box = (id, x) => ({ id, type: "rect", x, y: 0.1, x2: x + 0.1, y2: 0.2 });
  applyCanvasChanges(entry, { annotations: [box("a", 0.1), box("b", 0.3)], resolve });
  const first = storeUserMarks(entry, [{ id: "u1", type: "point", x: 0.5, y: 0.5 }]);
  // A later send re-sends u1 as context: it keeps its layer, only u2 is new.
  const second = storeUserMarks(entry, [{ id: "u1", type: "point", x: 0.5, y: 0.5, role: "context" }, { id: "u2", type: "point", x: 0.6, y: 0.5 }]);
  assert.equal(storeUserMarks(entry, [{ id: "u2", type: "point", x: 0.6, y: 0.5 }]), null);
  applyCanvasChanges(entry, { annotations: [box("c", 0.5)], layer: "電源", resolve });
  // Editing keeps a mark's layer; naming an existing layer adds to it.
  applyCanvasChanges(entry, { annotations: [box("a", 0.12)], resolve });
  applyCanvasChanges(entry, { annotations: [box("d", 0.7)], layer: "電源", resolve });
  const byId = Object.fromEntries(canvasMarks(entry).map(m => [m.id, m.layer]));
  assert.deepEqual(byId, { a: "L1", b: "L1", u1: first.id, u2: second.id, c: "L4", d: "L4" });
  assert.deepEqual(canvasLayers(entry).map(l => [l.id, l.author, l.name, l.count]), [
    ["L1", "assistant", "GPT · 第1次", 2], ["L2", "user", "你 · 第1次", 1], ["L3", "user", "你 · 第2次", 1], ["L4", "assistant", "電源", 2],
  ]);
  // Moving a mark out empties its layer, which then drops from the list.
  applyCanvasChanges(entry, { annotations: [box("a", 0.1), box("b", 0.3)], layer: "電源", resolve });
  assert.deepEqual(canvasLayers(entry).map(l => l.id), ["L2", "L3", "L4"]);
  applyCanvasChanges(entry, { reset: true, annotations: [box("z", 0.1)], resolve });
  assert.deepEqual(canvasLayers(entry).map(l => [l.id, l.name]), [["L1", "GPT · 第1次"]]);
});

// Live trial 2026-10-29 (img:298756bcc232f6bd): after the user sent three
// arrows, every present_visual call failed with "User-authored mark must be
// passed via priorUserAnnotations" because GPT labelled its own trace
// "YOU 3 → C105 上端"; the label check rejected any label starting "YOU ".
test("GPT can add a trace about user marks after several rounds; nothing is lost", async () => {
  const entry = await photo();
  // Round 1: user box + point, GPT pin-1 arrow and trace, findings on the box.
  storeUserMarks(entry, [
    { id: "user-1-1", type: "rect", x: 0.1, y: 0.1, x2: 0.3, y2: 0.3, label: "YOU 1" },
    { id: "user-1-2", type: "point", x: 0.5, y: 0.5, label: "YOU 2" },
  ]);
  applyCanvasChanges(entry, { annotations: [
    { id: "pin1", type: "arrow", x: 0.6, y: 0.6, x2: 0.5, y2: 0.5, label: "pin 1" },
    { id: "trace1", type: "polyline", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.25 }] },
  ], findings: [{ id: "user-1-1", note: "IC", status: "inspected" }], resolve });
  // Round 2: user adds three arrows (the widget re-sends old marks as context).
  const arrows = [
    { id: "user-8347-1", type: "arrow", x: 0.37933, y: 0.1538, x2: 0.43128, y2: 0.11185, label: "YOU 3" },
    { id: "user-8347-2", type: "arrow", x: 0.39665, y: 0.18408, x2: 0.46416, y2: 0.16131, label: "YOU 4" },
    { id: "user-8347-3", type: "arrow", x: 0.58415, y: 0.12634, x2: 0.52657, y2: 0.14652, label: "YOU 5" },
  ];
  storeUserMarks(entry, [
    { id: "user-1-1", type: "rect", x: 0.1, y: 0.1, x2: 0.3, y2: 0.3, label: "YOU 1", role: "context" },
    { id: "user-1-2", type: "point", x: 0.5, y: 0.5, label: "YOU 2", role: "context" },
    ...arrows.map(a => ({ ...a, role: "focus" })),
  ]);
  const before = JSON.stringify(canvasMarks(entry));
  // A failing call (bad finding id) changes nothing, not even its valid parts.
  assert.throws(() => applyCanvasChanges(entry, {
    remove: ["pin1"], annotations: [{ id: "t", type: "point", x: 0.5, y: 0.5 }], findings: [{ id: "user-9", note: "x" }], resolve,
  }), /findings\[0\] \(mark "user-9"\)/);
  assert.equal(JSON.stringify(canvasMarks(entry)), before);
  // Round 2 answer: red trace labelled after the user's arrow, findings on the
  // arrows, and the arrows replayed by id (no duplicates).
  const changed = applyCanvasChanges(entry, {
    annotations: [{ id: "trace-3-c105", type: "polyline", color: "red", size: "fine", label: "YOU 3 → C105 上端",
      note: "可見銅箔通往 C105 上端。", status: "inspected",
      points: [{ x: 0.43157, y: 0.11168 }, { x: 0.43288, y: 0.12449 }, { x: 0.45982, y: 0.15929 }] }],
    findings: arrows.map((a, i) => ({ id: a.id, note: i < 2 ? "相連" : "未相連", status: "inspected" })),
    priorUser: arrows.map(a => ({ ...a, author: "user", grounding: "replayed-unverified" })),
    resolve,
  });
  assert.deepEqual(changed, ["trace-3-c105", ...arrows.map(a => a.id)]);
  // Reopening the canvas: 8 marks, each with its author, user geometry intact.
  const marks = Object.fromEntries(canvasMarks(entry).map(m => [m.id, m]));
  assert.equal(Object.keys(marks).length, 8);
  assert.deepEqual(Object.entries(marks).filter(([, m]) => m.author === "user").map(([id]) => id).sort(),
    ["user-1-1", "user-1-2", ...arrows.map(a => a.id)].sort());
  assert.equal(marks["trace-3-c105"].author, "assistant");
  assert.equal(marks["trace-3-c105"].color, "red");
  for (const a of arrows) {
    const m = marks[a.id];
    assert.deepEqual([m.x, m.y, m.x2, m.y2, m.label, m.grounding], [a.x, a.y, a.x2, a.y2, a.label, "user-pointer"]);
    assert.equal(m.status, "inspected");
  }
  assert.equal(marks["user-1-1"].note, "IC");
  // Provenance still protected: user ids and bare user labels are refused.
  assert.throws(() => applyCanvasChanges(entry, { annotations: [{ id: "user-8347-1", type: "point", x: 0.1, y: 0.1 }], resolve }),
    /annotations\[0\] \(mark "user-8347-1"\): field id is a mark the user drew/);
  assert.throws(() => applyCanvasChanges(entry, { annotations: [{ id: "user-new", type: "point", x: 0.1, y: 0.1 }], resolve }),
    /field id uses the user-mark prefix/);
  assert.throws(() => applyCanvasChanges(entry, { annotations: [{ id: "fake", type: "point", x: 0.1, y: 0.1, label: "YOU 6" }], resolve }),
    /field label "YOU 6" is the user-mark label form/);
});
