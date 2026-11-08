// canvas.json -> UVA document -> canvas.json must give back the same canvas,
// and the part the document structure does not carry (the residual) must stay
// small for ordinary canvases.
import test from "node:test";
import assert from "node:assert/strict";
import { legacy, context, asset } from "./fixtures/uva-pr1a.mjs";
import { mapLegacyCanvas } from "../src/documents/legacy-shadow.js";
import { hashJson } from "../src/documents/validation.js";
import { projectCanvas, diffJson, applyPatch } from "../src/uva/canvas-projection.js";
import { applyCanvasChanges, storeUserMarks, editCanvas } from "../src/canvas-state.js";
import { serializeCanvas } from "../src/storage.js";
import { resolveCoordinateAnnotation as resolve } from "../src/scene-catalog.js";

const UNLAYERED = "layer:00000000-0000-4000-8000-0000000000ff";
const strip = ({ savedAt, ...rest }) => rest;
const json = (v) => JSON.parse(JSON.stringify(v));
function roundTrip(source) {
  const mapped = mapLegacyCanvas(source, { ...context(), unlayeredLayerId: UNLAYERED });
  assert.equal(mapped.status, "mapped", JSON.stringify(mapped.report.issues));
  const projected = projectCanvas(mapped.document, { unlayeredLayerId: UNLAYERED }), residual = diffJson(projected, strip(source));
  assert.equal(hashJson(applyPatch(projected, residual)), hashJson(strip(source)));
  return residual;
}

test("patches reproduce any JSON value and leave both inputs untouched", () => {
  const cases = [
    [1, 2], [{ a: 1 }, { a: 1, b: [1, 2] }], [{ a: 1, b: 2 }, { b: 3 }], [[{ id: "x", v: 1 }, { id: "y" }], [{ id: "y", w: 2 }, { id: "z" }]],
    [[1, 2], [2, 1]], [{ a: [{ id: "x" }] }, { a: null }], [null, { a: 1 }], [{ ["__proto__"]: 1 }, JSON.parse('{"__proto__":{"polluted":true}}')],
    [[{ id: "dup" }, { id: "dup" }], [{ id: "dup" }]], [{ v: 1, o: 2, d: 3 }, { v: 2, ids: [1] }],
  ];
  for (const [a, b] of cases) {
    const before = JSON.stringify([a, b]), patch = diffJson(a, b);
    assert.equal(hashJson(applyPatch(a, patch)), hashJson(b), JSON.stringify([a, b]));
    assert.equal(JSON.stringify([a, b]), before);
  }
  assert.equal({}.polluted, undefined);
  assert.equal(diffJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), undefined);
});

test("the rich legacy fixture round-trips; only archived legacy fields are left over", () => {
  // The fixture leaves layer defaults out and spells a default grounding, which the
  // document cannot tell apart from the defaults: that is all that is left over.
  const residual = roundTrip(legacy());
  assert.ok(JSON.stringify(residual).length < 600, JSON.stringify(residual));
});

test("canvases made by the real canvas code need no residual for marks and layers", () => {
  const entry = { imageId: asset().legacyImageId, width: 1600, height: 1000 };
  applyCanvasChanges(entry, { layer: "第一輪", annotations: [
    { id: "a1", type: "rect", x: .1, y: .2, x2: .4, y2: .5, label: "first", color: "red" },
    { id: "a2", type: "point", x: .7, y: .7, note: "maybe", confidence: "low", status: "candidate" },
    { id: "a3", type: "polyline", points: [{ x: .1, y: .1 }, { x: .2, y: .3 }, { x: .4, y: .2 }], smooth: true },
  ], resolve });
  storeUserMarks(entry, [{ id: "user-ab-1", author: "user", type: "arrow", x: .2, y: .2, x2: .6, y2: .6, color: "blue", strokeOrder: 1, relativeStartMs: 0, relativeEndMs: 300, pointerType: "mouse" }]);
  const canvas = json(serializeCanvas(entry)), residual = roundTrip(canvas);
  assert.equal(residual?.o?.marks, undefined, JSON.stringify(residual?.o?.marks));
  assert.equal(residual?.o?.layers, undefined, JSON.stringify(residual?.o?.layers));
  // A user edit is an archived audit record, carried exactly.
  editCanvas(entry, { marks: [{ id: "user-ab-1", x: .15 }], remove: ["a2"], resolveUser: (m) => m });
  roundTrip(json(serializeCanvas(entry)));
});

test("odd legacy marks (no author, no layer, role hints, unknown fields) still come back exactly", () => {
  const source = legacy();
  delete source.marks[1].author;
  delete source.marks[1].layer;
  source.marks[1].role = "question";
  source.marks[1].somethingNew = { kept: true };
  source.marks.push({ id: "bare", type: "point", x: .5, y: .5 });
  source.userEdits = [{ at: "2026-11-01T00:00:00Z", id: "ai", change: "moved" }];
  source.sceneRevision = 7;
  source.objectSeq = 3;
  const residual = roundTrip(source);
  assert.ok(residual, "archived fields need a residual");
});
