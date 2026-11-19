import test from "node:test";
import assert from "node:assert/strict";
import { gestureGroups, groupKey, recordGestureDecision } from "../src/gesture-groups.js";
import { buildAnnotationEvent, formatAnnotationChatMessage } from "../src/interaction-protocol.js";

// EST-GEST-02 regression set. Image from the report: 1536×432.
const W = 1536, H = 432;
const n = (x, y) => ({ x: x / W, y: y / H });
// A curved shaft drawn towards the lower left, ending at the report's tip.
const tip = { x: 0.57758 * W, y: 0.57669 * H };
const shaftPx = Array.from({ length: 15 }, (_, i) => {
  const t = i / 14;
  return { x: tip.x + (1 - t) * 160, y: tip.y - (1 - t) * 90 + Math.sin(t * Math.PI) * 12 };
});
const dir = (() => { const a = shaftPx[11], b = shaftPx[14], l = Math.hypot(b.x - a.x, b.y - a.y); return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; })();
const wing = (deg, len) => {
  const r = deg * Math.PI / 180, bx = -dir.x, by = -dir.y;
  return { x: tip.x + 1.2 + (bx * Math.cos(r) - by * Math.sin(r)) * len, y: tip.y + 0.8 + (bx * Math.sin(r) + by * Math.cos(r)) * len };
};
// The head as one V stroke: wing, vertex ~1.4 px from the shaft's tip, wing.
const headPx = [wing(35, 36), wing(35, 24), wing(35, 12), { x: tip.x + 1.1, y: tip.y + 0.85 }, wing(-35, 12), wing(-35, 24), wing(-35, 36)];
const poly = (id, px, extra = {}) => ({ id, type: "polyline", author: "user", points: px.map((p) => n(p.x, p.y)), ...extra });
const shaft = poly("user-fewj-2", shaftPx, { label: "YOU 2", strokeOrder: 2, relativeStartMs: 0, relativeEndMs: 640 });
const head = poly("user-fewj-3", headPx, { label: "YOU 3", strokeOrder: 3, relativeStartMs: 900, relativeEndMs: 1200 });

test("T04/T05: a two-stroke freehand arrow is one unconfirmed direction-arrow candidate", () => {
  const groups = gestureGroups([shaft, head], { width: W, height: H });
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.deepEqual(g.memberIds, ["user-fewj-2", "user-fewj-3"]);
  assert.equal(g.proposedMeaning, "direction-arrow");
  assert.equal(g.provenance, "system-inferred");
  assert.equal(g.confirmation, "unconfirmed");
  assert.ok(g.evidence.includes("arrowhead-like-geometry"));
  assert.ok(g.evidence.includes("drawn-in-quick-succession"));
  assert.equal(g.arrow.shaft, "user-fewj-2");
  assert.ok(["left", "down-left"].includes(g.arrow.direction.heading));
  assert.ok(Math.abs(g.arrow.tip.x - 0.57758) < 0.002);
});

test("the strokes stay separate, unchanged marks in the event; the group is extra metadata", () => {
  const event = buildAnnotationEvent({ image: { imageId: "img", width: W, height: H }, annotations: [shaft, head] });
  assert.equal(event.annotations.length, 2);
  assert.deepEqual(event.annotations.map((m) => m.type), ["polyline", "polyline"]);
  assert.equal(event.annotations[0].geometry.points.length, 15);
  assert.deepEqual(event.annotations[1].stroke, { order: 3, relativeStartMs: 900, relativeEndMs: 1200 });
  assert.equal(event.gestureGroups.length, 1);
  const message = formatAnnotationChatMessage(event);
  assert.match(message, /YOU 2 \+ YOU 3 -> possibly a direction arrow/);
  assert.match(message, /inferred from geometry, not confirmed by the person/);
  assert.match(message, /do not present them as what the person meant/);
});

test("T06: two lines that only cross in their middles are not grouped", () => {
  const a = { id: "a", type: "arrow", author: "user", x: 0.1, y: 0.1, x2: 0.5, y2: 0.9 };
  const b = { id: "b", type: "polyline", author: "user", points: [{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.1 }] };
  assert.deepEqual(gestureGroups([a, b], { width: W, height: H }), []);
});

test("T04 variant: strokes joined end to end without a head are a connected path, not an arrow", () => {
  const a = { id: "a", type: "polyline", author: "user", points: [{ x: 0.1, y: 0.5 }, { x: 0.3, y: 0.5 }] };
  const b = { id: "b", type: "polyline", author: "user", points: [{ x: 0.3005, y: 0.501 }, { x: 0.5, y: 0.55 }] };
  const [g] = gestureGroups([a, b], { width: W, height: H });
  assert.equal(g.proposedMeaning, "connected-path");
  assert.ok(g.evidence.includes("near-coincident-junction"));
});

test("T07: the same marks give the same groups at any resolution or display size", () => {
  const big = gestureGroups([shaft, head], { width: W, height: H });
  const small = gestureGroups([shaft, head], { width: W / 4, height: H / 4 });
  assert.deepEqual(small, big);
});

test("T08: the user's no keeps the candidate visible as rejected; the strokes are untouched", () => {
  const entry = {};
  recordGestureDecision(entry, ["user-fewj-3", "user-fewj-2"], "user-rejected");
  const [g] = gestureGroups([shaft, head], { width: W, height: H }, entry.gestureDecisions);
  assert.equal(g.confirmation, "user-rejected");
  assert.equal(shaft.points.length, 15);
  const event = buildAnnotationEvent({ image: { imageId: "img", width: W, height: H }, annotations: [shaft, head], gestureDecisions: entry.gestureDecisions });
  assert.match(formatAnnotationChatMessage(event), /the person said these are not one gesture; read them separately/);
  recordGestureDecision(entry, ["user-fewj-2", "user-fewj-3"], "unreviewed");
  assert.equal(entry.gestureDecisions.length, 0);
});

test("T09: deleting a member drops the group, including a hand-made one", () => {
  const dot = { id: "p", type: "point", author: "user", x: 0.9, y: 0.1 };
  const decisions = [{ memberIds: ["user-fewj-2", "p"], verdict: "user-confirmed" }];
  const made = gestureGroups([shaft, dot], { width: W, height: H }, decisions);
  assert.equal(made.length, 1);
  assert.equal(made[0].provenance, "user-created");
  assert.equal(made[0].confirmation, "user-confirmed");
  assert.deepEqual(gestureGroups([shaft], { width: W, height: H }, decisions), []);
  assert.deepEqual(gestureGroups([head], { width: W, height: H }), []);
});

test("assistant marks and closed loops do not start groups; keys ignore order", () => {
  const gpt = { ...head, id: "gpt-1", author: "assistant" };
  assert.deepEqual(gestureGroups([shaft, gpt], { width: W, height: H }), []);
  assert.equal(groupKey(["b", "a", "b"]), "a+b");
});

test("a head drawn as two separate wings is still an arrow; a forward continuation is not", () => {
  const w1 = poly("w1", [wing(35, 30), { x: tip.x, y: tip.y }]);
  const w2 = poly("w2", [{ x: tip.x + 0.5, y: tip.y }, wing(-35, 30)]);
  const [g] = gestureGroups([shaft, w1, w2], { width: W, height: H });
  assert.equal(g.proposedMeaning, "direction-arrow");
  assert.equal(g.memberIds.length, 3);
  const onward = poly("on", [{ x: tip.x, y: tip.y }, { x: tip.x + dir.x * 40, y: tip.y + dir.y * 40 }]);
  const [p] = gestureGroups([shaft, onward], { width: W, height: H });
  assert.notEqual(p.proposedMeaning, "direction-arrow");
});

test("acceptance 4: a loop touched by a line stays a group of unknown meaning", () => {
  const loop = { id: "loop", type: "polyline", author: "user", closed: true,
    points: Array.from({ length: 12 }, (_, i) => ({ x: 0.3 + 0.05 * Math.cos(i * Math.PI / 6), y: 0.5 + 0.15 * Math.sin(i * Math.PI / 6) })) };
  const line = { id: "line", type: "arrow", author: "user", x: 0.35, y: 0.5, x2: 0.6, y2: 0.5 };
  const [g] = gestureGroups([loop, line], { width: W, height: H });
  assert.equal(g.proposedMeaning, "unknown");
  assert.ok(g.evidence.includes("endpoint-touches-stroke"));
});

test("the canvas records stroke facts, shows candidates and sends the user's verdicts", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/visual-surface.html", import.meta.url), "utf8");
  assert.match(html, /<ol id="gestures"/);
  assert.match(html, /Object\.assign\(mark,strokeFacts\(\)\)/);
  assert.match(html, /name:"review_gesture_group"/);
  assert.match(html, /gestureDecisions:gestureDecisions\.filter/);
  assert.match(html, /t\("vs\.selection\.group"\)/);
  assert.equal((await import("../src/i18n/index.js")).t("vs.selection.group"), "和另一筆組成手勢");
  assert.match(html, /setGestures\(r\.event\.gestureGroups,\{merge:true\}\)/);
});
