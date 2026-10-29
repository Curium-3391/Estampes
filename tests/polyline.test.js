import test from "node:test";
import assert from "node:assert/strict";
import { polylineWithBounds, resolveCoordinateAnnotation, replayUserAnnotation, resolveSceneAnnotation } from "../src/scene-catalog.js";
import { buildAnnotationEvent, formatAnnotationChatMessage } from "../src/interaction-protocol.js";

const trace = [{ x: 0.2, y: 0.5 }, { x: 0.3, y: 0.5 }, { x: 0.35, y: 0.42 }];

test("polylines keep their vertices and expose a bounding box", () => {
  assert.deepEqual(polylineWithBounds(trace), { points: trace, x: 0.2, y: 0.42, x2: 0.35, y2: 0.5 });
  assert.throws(() => polylineWithBounds([{ x: 0.1, y: 0.1 }]), /2 to 128/);
  assert.throws(() => polylineWithBounds(Array.from({ length: 129 }, () => ({ x: 0, y: 0 }))), /2 to 128/);
  assert.throws(() => polylineWithBounds([{ x: 0.1, y: 0.1 }, { x: 1.2, y: 0 }]), /Invalid polyline point/);
});

test("assistant and replayed user polylines resolve with provenance", () => {
  const ai = resolveCoordinateAnnotation({ id: "t1", type: "polyline", points: trace, label: "trace" });
  assert.equal(ai.author, "assistant");
  assert.equal(ai.grounding, "unverified");
  assert.deepEqual(ai.points, trace);
  assert.equal(ai.x2, 0.35);
  assert.equal(resolveSceneAnnotation("shapes", { id: "t2", type: "polyline", points: trace }).type, "polyline");
  assert.throws(() => resolveSceneAnnotation("landscape", { id: "t3", type: "polyline", targetId: "sun" }), /explicit coordinates/);
  const user = replayUserAnnotation({ id: "user-1", type: "polyline", points: trace });
  assert.equal(user.grounding, "replayed-unverified");
  assert.equal(user.y, 0.42);
});

test("user polylines become raster events GPT can follow", () => {
  const event = buildAnnotationEvent({
    image: { imageId: "img:0123456789abcdef", width: 1500, height: 2000 },
    annotations: [{ id: "user-1", type: "polyline", points: trace, label: "YOU 1" }],
    intent: "ask-about-region",
  });
  assert.equal(event.annotations[0].type, "polyline");
  assert.deepEqual(event.annotations[0].geometry.points, trace);
  assert.equal(event.annotations[0].geometry.x2, 0.35);
  assert.match(formatAnnotationChatMessage(event), /折線/);
});

test("smooth and closed flags survive for freehand curves and loops", () => {
  const loop = resolveCoordinateAnnotation({ id: "c1", type: "polyline", points: trace, smooth: true, closed: true });
  assert.equal(loop.smooth, true);
  assert.equal(loop.closed, true);
  const plain = resolveCoordinateAnnotation({ id: "c2", type: "polyline", points: trace, smooth: "yes" });
  assert.equal(plain.smooth, undefined, "only literal true is kept");
  const event = buildAnnotationEvent({
    image: { imageId: "img:0123456789abcdef", width: 10, height: 10 },
    annotations: [{ id: "user-1", type: "polyline", points: trace, smooth: true, closed: true }],
  });
  assert.equal(event.annotations[0].geometry.closed, true);
});
