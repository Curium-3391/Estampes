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
  assert.match(formatAnnotationChatMessage(event), /a polyline is a path the person drew or traced/);
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

test("submission separates the focus mark from earlier context marks", () => {
  const event = buildAnnotationEvent({
    image: { imageId: "img:0123456789abcdef", width: 10, height: 10 },
    annotations: [
      { id: "user-1", type: "rect", x: 0.1, y: 0.1, x2: 0.3, y2: 0.3, label: "YOU 1", role: "context" },
      { id: "user-2", type: "rect", x: 0.5, y: 0.5, x2: 0.7, y2: 0.7, label: "YOU 2", role: "focus" },
    ],
  });
  assert.deepEqual(event.annotations.map(m => m.role), ["context", "focus"]);
  const text = formatAnnotationChatMessage(event);
  assert.match(text, /This send is about: YOU 2 \(role=focus\)/);
  assert.match(text, /Other marks \(YOU 1, role=context\)/);
  const allContext = buildAnnotationEvent({
    image: { imageId: "img:0123456789abcdef", width: 10, height: 10 },
    annotations: [{ id: "user-1", type: "point", x: 0.1, y: 0.1, role: "context" }],
  });
  assert.equal(allContext.annotations[0].role, "focus", "a submission always has a focus");
});

test("assistant findings (note, status) are kept on marks", () => {
  const m = resolveCoordinateAnnotation({ id: "a1", type: "rect", x: 0.1, y: 0.1, x2: 0.2, y2: 0.2, note: " SONY CXD2500AQ ", status: "inspected" });
  assert.equal(m.note, "SONY CXD2500AQ");
  assert.equal(m.status, "inspected");
  assert.equal(resolveCoordinateAnnotation({ id: "a2", type: "point", x: 0.1, y: 0.1, status: "verified" }).status, undefined);
  const replay = replayUserAnnotation({ id: "user-2", type: "rect", x: 0.5, y: 0.5, x2: 0.7, y2: 0.7, note: "CXD2500AQ", status: "inspected" });
  assert.equal(replay.note, "CXD2500AQ");
  assert.equal(replay.author, "user");
});

test("pen style (colour, size, highlighter) is kept and validated", () => {
  const m = resolveCoordinateAnnotation({ id: "h1", type: "rect", x: 0.1, y: 0.1, x2: 0.2, y2: 0.2, color: "yellow", size: "thick", pen: "highlighter" });
  assert.equal(m.color, "yellow");
  assert.equal(m.size, "thick");
  assert.equal(m.pen, "highlighter");
  const bad = resolveCoordinateAnnotation({ id: "h2", type: "point", x: 0.1, y: 0.1, color: "#ff0000", pen: "spray" });
  assert.equal(bad.color, undefined);
  assert.equal(bad.pen, undefined);
  const event = buildAnnotationEvent({
    image: { imageId: "img:0123456789abcdef", width: 10, height: 10 },
    annotations: [{ id: "user-1", type: "polyline", points: trace, color: "green", pen: "highlighter" }],
  });
  assert.equal(event.annotations[0].pen, "highlighter");
  assert.match(formatAnnotationChatMessage(event), /pen=highlighter is a translucent highlighter/);
});
