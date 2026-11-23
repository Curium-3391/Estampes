// 5B-2a: a canvas carries derived bindings next to its links. They map into the
// document's bindings, project back unchanged, survive the canvas record on disk,
// and a copy starts without them. Nothing here names a module or an object type.
import test from "node:test";
import assert from "node:assert/strict";
import { legacy, context } from "./fixtures/uva-pr1a.mjs";
import { mapLegacyCanvas } from "../src/documents/legacy-shadow.js";
import { hashJson } from "../src/documents/validation.js";
import { projectCanvas, diffJson, applyPatch } from "../src/uva/canvas-projection.js";
import { serializeCanvas, restoreCanvas } from "../src/storage.js";
import { forkFromData } from "../src/workspace.js";

const UNLAYERED = "layer:00000000-0000-4000-8000-0000000000ff";
const HASH = "a".repeat(64);
const strip = ({ savedAt, ...rest }) => rest;
const json = (v) => JSON.parse(JSON.stringify(v));
const local = (over = {}) => ({
  id: "bind:11111111-1111-4111-8111-111111111111", kind: "derived", version: 1,
  source: { module: "com.example.demo.producer", capability: "make", sourceRef: "anything the module likes", sourceRevision: 3, inputsHash: HASH },
  target: { id: "o1" }, lastApplied: { objectRevision: 1, contentHash: HASH, sourceRevision: 3 }, policy: "pause-on-user-edit", state: "fresh", ...over,
});
const withDerived = (...list) => ({ ...legacy(), derived: list });
function map(source) { return mapLegacyCanvas(source, { ...context(), unlayeredLayerId: UNLAYERED }); }

test("a derived binding on the canvas becomes a document binding and projects back unchanged", () => {
  const source = withDerived(local());
  const mapped = map(source);
  assert.equal(mapped.status, "mapped", JSON.stringify(mapped.report.issues));
  const [b] = mapped.document.bindings.filter((x) => x.kind === "derived");
  assert.equal(b.target.kind, "object");
  assert.equal(b.target.id, "o1");
  assert.equal(b.target.documentId, mapped.document.id);
  assert.equal(b.target.sceneId, mapped.document.scenes[0].id);
  const projected = projectCanvas(mapped.document, { unlayeredLayerId: UNLAYERED });
  assert.deepEqual(projected.derived, [local()]);
  // The whole canvas still comes back exactly.
  const residual = diffJson(projected, strip(source));
  assert.equal(hashJson(applyPatch(projected, residual)), hashJson(strip(source)));
  assert.equal(residual?.o?.derived, undefined, "the derived bindings are carried by the document, not left over");
});

test("a canvas with no derived bindings projects with no derived field", () => {
  const mapped = map(legacy());
  assert.equal(mapped.document.bindings.some((x) => x.kind === "derived"), false);
  assert.equal("derived" in projectCanvas(mapped.document, { unlayeredLayerId: UNLAYERED }), false);
});

test("an unreadable or dangling binding stays in the raw record and does not block the canvas", () => {
  const cases = [
    local({ target: { id: "o9" } }),            // live, but its object is gone
    local({ version: 2 }),                                   // a version this build does not know
    local({ unexpected: true }),                             // a field the schema does not have
    { id: "not-a-binding" },
  ];
  for (const bad of cases) {
    const source = withDerived(bad);
    const mapped = map(source);
    assert.equal(mapped.status, "mapped", JSON.stringify(bad));
    assert.equal(mapped.document.bindings.some((x) => x.kind === "derived"), false);
    assert.ok(mapped.report.issues.some((i) => i.code === "ARCHIVED_LEGACY_FIELD" && i.path[0] === "derived"));
    const projected = projectCanvas(mapped.document, { unlayeredLayerId: UNLAYERED });
    assert.equal(hashJson(applyPatch(projected, diffJson(projected, strip(source)))), hashJson(strip(source)), "the raw entry comes back verbatim");
  }
});

test("a removed binding may name an object that is gone; the same id twice keeps the first", () => {
  const gone = local({ target: { id: "o9" }, state: "removed", reason: "the object no longer exists" });
  const mapped = map(withDerived(gone, local({ id: gone.id })));
  assert.equal(mapped.status, "mapped", JSON.stringify(mapped.report.issues));
  const kept = mapped.document.bindings.filter((x) => x.kind === "derived");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].state, "removed");
});

test("the canvas record on disk keeps derived bindings, and a copy starts without them", () => {
  const entry = { imageId: legacy().imageId, width: 1600, height: 1000 };
  restoreCanvas(entry, { ...legacy(), derived: [local()] });
  assert.deepEqual(entry.derived, [local()]);
  assert.deepEqual(json(serializeCanvas(entry)).derived, [local()]);
  entry.derived = [];
  assert.equal("derived" in json(serializeCanvas(entry)), false, "an empty list is not written");
  restoreCanvas(entry, { ...legacy(), derived: [local(), 5, null, [1]] });
  assert.equal(entry.derived.length, 1, "entries that are not records are dropped on load");
});

test("a copy of a canvas never shows its original's bindings, even though it shares the original as prototype", () => {
  const base = { imageId: legacy().imageId, width: 1600, height: 1000, derived: [local()] };
  const copy = forkFromData(base, { ...legacy(), imageId: base.imageId, setId: "c0123456789a" });
  assert.deepEqual(copy.derived, []);
  assert.equal("derived" in json(serializeCanvas(copy)), false);
  assert.deepEqual(base.derived, [local()], "the original keeps its own");
});
