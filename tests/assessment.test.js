import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { registerImage, clearImages } from "../src/image-store.js";
import {
  applyCanvasChanges, applyPairChanges, pairLinks, reviewLink, reviewFinding, canvasMarks, storeUserMarks,
} from "../src/canvas-state.js";
import { resolveCoordinateAnnotation as resolve } from "../src/scene-catalog.js";
import { verificationOf, needsReview, sameRegion, cleanEvidence } from "../src/assessment.js";
import { canvasDocument } from "../src/protocol.js";
import { serializeCanvas, restoreCanvas } from "../src/storage.js";

beforeEach(() => clearImages());
const image = async (w, h, colour) => registerImage(await sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer(), { source: "test" });
const box = (id, side, x = 0.1) => ({ id, side, type: "rect", x, y: 0.1, x2: x + 0.1, y2: 0.2 });
const seen = (says, side = "left", region = [0.1, 0.1, 0.2, 0.2]) => ({ kind: "text", side, region, says });

test("confidence never verifies a claim: every unverified link waits for review", async () => {
  const left = await image(800, 600, "#fff"), right = await image(600, 800, "#264");
  applyPairChanges(left, right, {
    annotations: [box("s1", "left"), box("p1", "right")],
    links: [{ id: "k1", left: "s1", right: "p1", label: "IC502", confidence: "high",
      evidence: [seen("left reads IC502"), seen("right silkscreen IC502", "right")], ambiguities: ["part number unclear"] }], resolve,
  });
  const [link] = pairLinks(left, right);
  assert.equal(link.confidence, "high");
  assert.deepEqual(link.evidence.map((e) => [e.id, e.observer, e.image]), [["e1", "model", left.imageId], ["e2", "model", right.imageId]]);
  assert.equal(verificationOf(link), "unverified");
  assert.ok(needsReview(link), "high confidence still needs the user");
  // Only a tool's evidence (never the model's) makes a claim independently verified.
  assert.equal(verificationOf({ ...link, evidence: [...link.evidence, { observer: "tool", kind: "tool-result", image: right.imageId, says: "OCR IC502" }] }), "independently-verified");
  assert.equal(verificationOf({ ...link, review: "confirmed" }), "user-confirmed");
  const doc = canvasDocument(left, right);
  assert.equal(doc.links[0].verification.state, "unverified");
  assert.deepEqual(doc.links[0].ambiguities, ["part number unclear"]);
});

test("evidence regions are checked: inside 0..1, on an image of this view", async () => {
  const entry = await image(400, 300, "#246");
  assert.throws(() => applyCanvasChanges(entry, { annotations: [{ ...box("g"), note: "R1", evidence: [seen("x", "left", [0.5, 0.5, 0.4, 0.6])] }], resolve }),
    /annotations\[0\].*region must be/);
  assert.throws(() => applyCanvasChanges(entry, { annotations: [{ ...box("g"), note: "R1", evidence: [seen("x", "right")] }], resolve }),
    /side "right" is not an image in this view/);
  assert.deepEqual(canvasMarks(entry), [], "a refused call leaves the canvas as it was");
  assert.throws(() => cleanEvidence([{ kind: "text", says: "" }], { observer: "model", images: { left: "img:1" } }), /say what/);
});

test("a rejected link outlives its marks and cannot be re-proposed without new evidence", async () => {
  const left = await image(800, 600, "#fff"), right = await image(600, 800, "#264");
  applyPairChanges(left, right, { annotations: [box("s1", "left"), box("p1", "right")],
    links: [{ id: "k1", left: "s1", right: "p1", label: "IC501", evidence: [seen("left reads IC501")] }], resolve });
  reviewLink(left, right, "k1", "rejected", "右圖板號看不到");
  assert.equal(left.rejections.length, 1);
  assert.equal(left.rejections[0].reason, "右圖板號看不到");

  // GPT deletes the marks and draws the same pair again under new ids.
  applyPairChanges(left, right, { remove: ["s1", "p1"], resolve });
  assert.deepEqual(pairLinks(left, right), []);
  let refused = [];
  applyPairChanges(left, right, { annotations: [box("s9", "left", 0.11), box("p9", "right")],
    links: [{ id: "k9", left: "s9", right: "p9", label: "IC501", confidence: "high", evidence: [seen("left reads IC501 again")] }], resolve, refused });
  assert.deepEqual(refused.map((r) => [r.kind, r.id]), [["link", "k9"]]);
  assert.deepEqual(pairLinks(left, right), [], "the repeated link was not stored");
  assert.deepEqual(canvasMarks(left).map((m) => m.id), ["s9"], "the rest of the call still landed");

  // A new kind of evidence (the right image) lets it through, flagged.
  refused = [];
  applyPairChanges(left, right, { links: [{ id: "k9", left: "s9", right: "p9", evidence: [seen("right silkscreen IC501", "right")] }], resolve, refused });
  assert.deepEqual(refused, []);
  const [link] = pairLinks(left, right);
  assert.equal(link.previouslyRejected.reason, "右圖板號看不到");
  assert.ok(needsReview(link));

  // A pair somewhere else is not affected.
  applyPairChanges(left, right, { annotations: [box("s2", "left", 0.6), box("p2", "right", 0.6)], links: [{ id: "k2", left: "s2", right: "p2" }], resolve, refused });
  assert.deepEqual(refused, []);
});

test("withdrawing or reversing a rejection forgets it; re-pointing a link clears the verdict", async () => {
  const left = await image(800, 600, "#fff"), right = await image(600, 800, "#264");
  applyPairChanges(left, right, { annotations: [box("s1", "left"), box("p1", "right"), box("p2", "right", 0.6)],
    links: [{ id: "k1", left: "s1", right: "p1" }], resolve });
  reviewLink(left, right, "k1", "rejected");
  reviewLink(left, right, "k1", "unreviewed");
  assert.deepEqual(left.rejections, []);
  assert.equal(pairLinks(left, right)[0].review, undefined);
  reviewLink(left, right, "k1", "rejected");
  reviewLink(left, right, "k1", "confirmed");
  assert.deepEqual(left.rejections, []);
  applyPairChanges(left, right, { links: [{ id: "k1", left: "s1", right: "p2" }], resolve });
  assert.equal(pairLinks(left, right)[0].review, undefined);
});

test("a note is a claim: new wording starts fresh, a rejected note is refused at that place", async () => {
  const entry = await image(1000, 800, "#000");
  storeUserMarks(entry, [{ id: "user-1", type: "arrow", x: 0.8, y: 0.3, x2: 0.7, y2: 0.4, label: "YOU 1" }]);
  applyCanvasChanges(entry, { findings: [{ id: "user-1", note: "疑似 Rasalhague", confidence: "low",
    evidence: [{ kind: "context", region: [0.6, 0.3, 0.8, 0.5], says: "位置與周圍星群" }], ambiguities: ["未經星表定位"] }], resolve });
  let mark = canvasMarks(entry)[0];
  assert.equal(mark.author, "user", "a finding never changes who drew the mark");
  assert.equal(verificationOf(mark), "unverified");
  reviewFinding(entry, "user-1", "rejected", "銀河核心附近不是蛇夫座");
  assert.equal(verificationOf(canvasMarks(entry)[0]), "user-rejected");

  // Same words (inside a longer note) at the same place: refused, old note kept.
  let refused = [];
  applyCanvasChanges(entry, { findings: [{ id: "user-1", note: "Rasalhague（蛇夫座 α）", confidence: "high" }], resolve, refused });
  assert.deepEqual(refused.map((r) => [r.kind, r.id]), [["note", "user-1"]]);
  mark = canvasMarks(entry)[0];
  assert.equal(mark.note, "疑似 Rasalhague");
  assert.equal(mark.review, "rejected");

  // A different claim is a new claim: no verdict, no old evidence.
  refused = [];
  applyCanvasChanges(entry, { findings: [{ id: "user-1", note: "可能是 M8 附近的亮星" }], resolve, refused });
  mark = canvasMarks(entry)[0];
  assert.deepEqual(refused, []);
  assert.equal(mark.review, undefined);
  assert.equal(mark.evidence, undefined);

  // A new GPT mark with the rejected words as its label, at the same place.
  applyCanvasChanges(entry, { annotations: [{ id: "g1", type: "point", x: 0.7, y: 0.4, label: "Rasalhague", note: "這顆是 Rasalhague" }], resolve, refused });
  assert.deepEqual(refused.map((r) => r.id), ["g1"]);
  assert.equal(canvasMarks(entry).find((m) => m.id === "g1").note, undefined, "the mark is drawn without the refused note");
  assert.throws(() => reviewFinding(entry, "g1", "confirmed"), /has no note/);
});

test("rejections are stored with the canvas and come back after a restart", async () => {
  const entry = await image(400, 300, "#123");
  applyCanvasChanges(entry, { annotations: [{ ...box("g"), note: "R12" }], resolve });
  reviewFinding(entry, "g", "rejected");
  const saved = JSON.parse(JSON.stringify(serializeCanvas(entry)));
  entry.rejections = [];
  restoreCanvas(entry, saved);
  assert.equal(entry.rejections.length, 1);
  assert.equal(canvasDocument(entry).rejections[0].from.text, "R12");
});

test("same region: half overlap or the new centre inside the old box", () => {
  assert.ok(sameRegion([0.1, 0.1, 0.2, 0.2], [0.1, 0.1, 0.2, 0.2]));
  assert.ok(sameRegion([0.14, 0.14, 0.16, 0.16], [0.1, 0.1, 0.2, 0.2]));
  assert.ok(!sameRegion([0.3, 0.3, 0.4, 0.4], [0.1, 0.1, 0.2, 0.2]));
});

test("a confirmed link goes stale when an end moves, and confirming again refreshes it (#71)", async () => {
  const { editCanvas, linkIsStale } = await import("../src/canvas-state.js");
  const left = await image(800, 600, "#fff"), right = await image(600, 800, "#264");
  applyPairChanges(left, right, { annotations: [box("s1", "left"), box("p1", "right")], links: [{ id: "k1", left: "s1", right: "p1", label: "same" }], resolve });
  storeUserMarks(right, [{ id: "user-r-1", type: "rect", x: 0.4, y: 0.5, x2: 0.5, y2: 0.6, label: "YOU 1" }]);
  applyPairChanges(left, right, { links: [{ id: "k2", left: "s1", right: "user-r-1", label: "same 2" }], resolve });
  reviewLink(left, right, "k2", "confirmed");
  assert.equal(canvasDocument(left, right).links.find((l) => l.id === "k2").verification.state, "user-confirmed");
  // The user drags the right end far away: the link stays, its confirmation is stale.
  editCanvas(right, { marks: [{ id: "user-r-1", x: 0.2, y: 0.3, x2: 0.3, y2: 0.4 }], resolveUser: (m) => m });
  const k2 = pairLinks(left, right).find((l) => l.id === "k2");
  assert.ok(k2 && linkIsStale(left, right, k2));
  assert.equal(k2.stale, undefined, "staleness is shown, never stored");
  assert.equal(canvasDocument(left, right).links.find((l) => l.id === "k2").verification.state, "stale-confirmation");
  reviewLink(left, right, "k2", "confirmed");
  assert.equal(canvasDocument(left, right).links.find((l) => l.id === "k2").verification.state, "user-confirmed");
  assert.ok(needsReview({ ...pairLinks(left, right)[0], stale: true, review: "confirmed" }), "a stale confirmation is back in the review queue");
  // Withdrawing forgets the remembered geometry.
  reviewLink(left, right, "k2", "unreviewed");
  assert.equal(pairLinks(left, right).find((l) => l.id === "k2").confirmedGeometry, undefined);
});

test("a polyline end that is closed or smoothed after confirmation also goes stale (#71)", async () => {
  const { editCanvas, linkIsStale } = await import("../src/canvas-state.js");
  const left = await image(800, 600, "#fff"), right = await image(600, 800, "#264");
  applyPairChanges(left, right, { annotations: [box("s1", "left"), { id: "pl", side: "right", type: "polyline", points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.2 }, { x: 0.3, y: 0.6 }] }], links: [{ id: "k", left: "s1", right: "pl" }], resolve });
  reviewLink(left, right, "k", "confirmed");
  assert.ok(!linkIsStale(left, right, pairLinks(left, right)[0]));
  applyPairChanges(left, right, { annotations: [{ id: "pl", side: "right", type: "polyline", points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.2 }, { x: 0.3, y: 0.6 }], closed: true }], resolve });
  assert.ok(linkIsStale(left, right, pairLinks(left, right)[0]));
});
