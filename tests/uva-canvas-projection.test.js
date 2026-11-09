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

test("canvas records are ordered by sequence number, never by clock; canvas.json is adopted only when its content is unknown", async () => {
  const { chooseCanvas, contentHash } = await import("../src/uva/canvas-store.js");
  const canvas = (label, savedAt) => ({ version: 1, imageId: "img:0123456789abcdef", width: 1, height: 1, marks: [{ id: "m", type: "point", x: 0, y: 0, label }], layers: [], links: {}, savedAt });
  const A = canvas("A", "2030-01-01T00:00:00Z"), B = canvas("B", "2000-01-01T00:00:00Z"), C = canvas("C", "1999-01-01T00:00:00Z");
  // B has the higher seq although its clock time is older.
  assert.equal(chooseCanvas({ uva: { seq: 1, legacyHash: contentHash(A), canvas: A }, pending: { seq: 2, legacyHash: contentHash(A), canvas: B } }).canvas, B);
  assert.equal(chooseCanvas({ uva: { seq: 3, legacyHash: null, canvas: A }, pending: { seq: 2, legacyHash: null, canvas: B } }).canvas, A);
  // A stale legacy copy (what canvas.json held when the record was written) is ignored and repaired.
  const stale = chooseCanvas({ uva: { seq: 2, legacyHash: contentHash(A), canvas: B }, legacy: A });
  assert.equal(stale.canvas, B); assert.equal(stale.repairLegacy, true); assert.equal(stale.adopt, false);
  // Content no record knows is a save that bypassed the server: it becomes the next seq.
  const bypass = chooseCanvas({ uva: { seq: 2, legacyHash: contentHash(A), canvas: B }, legacy: C });
  assert.equal(bypass.canvas, C); assert.equal(bypass.adopt, true); assert.equal(bypass.seq, 2);
  // No record: migration.
  assert.deepEqual(chooseCanvas({ legacy: A }), { from: "legacy", canvas: A, adopt: true, seq: 0 });
  assert.equal(chooseCanvas({}), null);
});

test("image objects are projected back to their inline PNG from the asset bytes", () => {
  const source = json(legacy());
  const mapped = mapLegacyCanvas({ ...source, objects: [] }, { ...context(), unlayeredLayerId: UNLAYERED });
  assert.equal(mapped.status, "mapped", JSON.stringify(mapped.report.issues));
  const scene = mapped.document.scenes[0], layerId = scene.layers[0].id, bytes = Buffer.from("89504e470d0a1a0a0000", "hex");
  const ref = { assetId: "asset:sha256:" + "ab".repeat(32) };
  scene.objects = [{ id: "o9", type: "image", revision: 1, layerId, visibility: "public", provenance: scene.annotations[0].provenance,
    props: { asset: ref, region: { x: 0, y: 0, x2: .5, y2: .5 }, source: "copy" } }];
  const canvas = projectCanvas(mapped.document, { unlayeredLayerId: UNLAYERED, images: new Map([[ref.assetId, bytes.toString("base64")]]) });
  assert.deepEqual(canvas.objects[0].props, { png: "data:image/png;base64," + bytes.toString("base64"), region: { x: 0, y: 0, x2: .5, y2: .5 }, source: "copy" });
  assert.throws(() => projectCanvas(mapped.document, { unlayeredLayerId: UNLAYERED }), /needs the bytes/);
});
