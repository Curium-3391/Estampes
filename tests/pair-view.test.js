import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { registerImage, clearImages } from "../src/image-store.js";

// Same bytes return the same cached canvas; each test starts clean.
beforeEach(() => clearImages());
import { applyPairChanges, pairLinks, reviewLink, canvasMarks, storeUserMarks } from "../src/canvas-state.js";
import { resolveCoordinateAnnotation as resolve } from "../src/scene-catalog.js";
import { t } from "../src/i18n/index.js";

// The widget's start-up tables (i18nMap) read the current language; one language is enough here.
const i18nMap = (keys) => Object.fromEntries(Object.entries(keys).map(([k, key]) => [k, t(key)]));

const image = async (w, h, colour) => registerImage(await sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer(), { source: "test" });
const box = (id, side, x = 0.1) => ({ id, side, type: "rect", x, y: 0.1, x2: x + 0.1, y2: 0.2 });

test("paired marks go to their own image and links join them", async () => {
  const left = await image(1600, 1000, "#fff"), right = await image(1500, 2000, "#264");
  applyPairChanges(left, right, {
    annotations: [box("s-c105", "left"), box("p-c105", "right"), box("s-u1", undefined, 0.5)],
    links: [{ id: "k1", left: "s-c105", right: "p-c105", label: "C105", confidence: "low" }], resolve,
  });
  assert.deepEqual(canvasMarks(left).map(m => m.id), ["s-c105", "s-u1"]);
  assert.deepEqual(canvasMarks(right).map(m => m.id), ["p-c105"]);
  assert.equal(canvasMarks(right)[0].side, undefined, "side is not stored on the mark");
  assert.deepEqual(pairLinks(left, right).map(l => [l.id, l.confidence, l.author]), [["k1", "low", "assistant"]]);

  // The user's verdict sticks while GPT edits the note; re-pointing clears it.
  reviewLink(left, right, "k1", "rejected");
  applyPairChanges(left, right, { links: [{ id: "k1", left: "s-c105", right: "p-c105", note: "still unsure" }], resolve });
  assert.equal(pairLinks(left, right)[0].review, "rejected");
  assert.equal(pairLinks(left, right)[0].confidence, "low");
  applyPairChanges(left, right, { annotations: [box("p-c105b", "right", 0.6)], links: [{ id: "k1", left: "s-c105", right: "p-c105b" }], resolve });
  assert.equal(pairLinks(left, right)[0].review, undefined);

  // Findings and remove find marks on either side; removing a mark drops its links.
  applyPairChanges(left, right, { findings: [{ id: "p-c105", note: "電容" }], resolve });
  assert.equal(canvasMarks(right).find(m => m.id === "p-c105").note, "電容");
  applyPairChanges(left, right, { remove: ["p-c105b"], resolve });
  assert.deepEqual(pairLinks(left, right), []);
  assert.throws(() => reviewLink(left, right, "k1", "confirmed"), /No link k1/);
});

test("a failed paired call changes neither image nor the links", async () => {
  const left = await image(800, 600, "#fff"), right = await image(600, 800, "#264");
  applyPairChanges(left, right, { annotations: [box("a", "left"), box("b", "right")], links: [{ id: "k", left: "a", right: "b" }], resolve });
  storeUserMarks(right, [{ id: "user-1", type: "point", x: 0.5, y: 0.5, label: "YOU 1" }]);
  const snap = () => JSON.stringify([canvasMarks(left), canvasMarks(right), pairLinks(left, right), left.layers, right.layers]);
  const before = snap();
  const fail = (changes, pattern) => { assert.throws(() => applyPairChanges(left, right, { ...changes, resolve }), pattern); assert.equal(snap(), before); };
  fail({ remove: ["a"], annotations: [box("c", "right")], links: [{ id: "k2", left: "c", right: "b" }] }, /links\[0\] \(link "k2"\): field left "c" is not a mark on the left image/);
  fail({ annotations: [box("x", "left"), box("a", "right")] }, /annotations\[1\] \(mark "a"\): field id is already a mark on the left image/);
  fail({ removeLinks: ["k"], findings: [{ id: "nope", note: "x" }] }, /findings\[0\] \(mark "nope"\): no such mark on either image/);
  fail({ annotations: [box("user-1", "right")] }, /field id is a mark the user drew|user-mark prefix/);
  fail({ reset: true, annotations: [{ id: "bad", type: "point", x: 2, y: 0 }] }, /Invalid/);
});

const html = readFileSync(new URL("../public/visual-surface.html", import.meta.url), "utf8");
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

test("widget maps each image's coordinates into the side-by-side canvas and back", () => {
  const start = source.indexOf("function layoutPair("), stop = source.indexOf("// Layer ids are per image");
  assert.ok(start > 0 && stop > start);
  const v = new Function("t", "i18nMap", "let VW=1000,VH=750,pair={},ws=null,frames=null;const GAP=40;const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));" +
    "const round=n=>Math.round(n*100000)/100000;\n" + source.slice(start, stop) +
    "\nreturn {layoutPair,toView,toSide,sideAt,get VW(){return VW},get VH(){return VH}};")(t, i18nMap);
  v.layoutPair(1600, 1000, 1500, 2000);
  assert.equal(v.VW, 2040); assert.equal(v.VH, 1333);
  const right = { id: "p", side: "right", type: "polyline", x: 0.2, y: 0.3, x2: 0.4, y2: 0.5, points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }] };
  const shown = v.toView(right);
  assert.ok(Math.abs(shown.x * 2040 - (1040 + 200)) < 1e-9);
  assert.equal(v.sideAt(shown), "right");
  assert.deepEqual(v.toSide(shown), right);
  // A stroke dragged past its image's edge is clamped to that image.
  const spill = v.toSide({ id: "q", side: "left", type: "rect", x: 0.4, y: 0.1, x2: 0.7, y2: 0.9 });
  assert.equal(spill.x2, 1); assert.equal(spill.y2, 1);
});

test("widget lays out a workspace, turns rotated images and maps marks back exactly", () => {
  const start = source.indexOf("function layoutPair("), stop = source.indexOf("// Layer ids are per image");
  const v = new Function("t", "i18nMap", "let VW=1000,VH=750,pair=null,frames=null;let ws={items:[{id:'wi-1'},{id:'wi-2'},{id:'wi-3'}]};const GAP=40;const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));" +
    "const round=n=>Math.round(n*100000)/100000;\n" + source.slice(start, stop) +
    "\nreturn {layoutWorkspace,toView,toSide,sideAt,framePoint,frameUV,get frames(){return frames},get VW(){return VW},get VH(){return VH}};")(t, i18nMap);
  v.layoutWorkspace([
    { id: "wi-1", width: 1536, height: 432, placement: { x: 0, y: 0, width: 1000, rotation: 0 } },
    { id: "wi-2", width: 1152, height: 1536, placement: { x: 1060, y: 0, width: 1000, rotation: 90 } },
    { id: "wi-3", width: 1323, height: 1871, placement: { x: 2500, y: 0, width: 1000, rotation: 0 } },
  ]);
  assert.equal(v.frames["wi-2"].ew, 1000 * 1536 / 1152, "a turned image is as wide as it was tall");
  assert.ok(v.VW >= 3500);
  for (const rot of [0, 90, 180, 270]) {
    const f = { ...v.frames["wi-2"], rot };
    const [X, Y] = v.framePoint(f, 0.25, 0.75), [u, w] = v.frameUV(f, X, Y);
    assert.ok(Math.abs(u - 0.25) < 1e-9 && Math.abs(w - 0.75) < 1e-9, "rotation " + rot + " maps back");
  }
  // The top-left of the PCB photo turned 90° clockwise lands at the frame's top-right.
  const tl = v.toView({ id: "a", side: "wi-2", type: "point", x: 0, y: 0 });
  assert.ok(Math.abs(tl.x * v.VW - (v.frames["wi-2"].x0 + v.frames["wi-2"].ew)) < 1e-6);
  const mark = { id: "b", side: "wi-3", type: "rect", x: 0.1, y: 0.2, x2: 0.3, y2: 0.4 };
  const shown = v.toView(mark);
  assert.equal(v.sideAt(shown), "wi-3");
  assert.deepEqual(v.toSide(shown), mark);
});

test("widget shows links with numbers, asks the user to review every unverified claim, and sends the verdict", () => {
  assert.match(html, /<ol id="links"/);
  assert.match(source, /name:"review_visual_link"/);
  assert.match(source, /name:"review_visual_finding"/);
  // Any unverified claim asks, whatever GPT's confidence; GPT's own evidence is labelled as such.
  assert.match(source, /const ask=stateOf\(l\)==="unverified"/);
  assert.match(source, /t\("vs\.claim\.unverified"/);
  assert.match(t("vs.claim.unverified", { confidence: "", source: t("vs.claim.modelOnly") }), /^僅模型自述 · 待你確認$/);
  assert.match(source, /function showEvidence\(key,e\)/);
  assert.match(source, /function reviewMessage\(list\)/);
  assert.match(source, /if\(reviewed\.length\|\|edited\.length\)chatMessage\+="\\n\\n"\+extra\(\)/);
  assert.match(source, /pairImageId:pair\.imageId/);
  assert.match(source, /if\(frames\)mark=toView\(toSide\(\{\.\.\.mark,side:sideAt\(start\)\}\)\)/);
});

test("one call cannot add the same id to both images", async () => {
  const left = await image(800, 600, "#fff"), right = await image(600, 800, "#264");
  assert.throws(() => applyPairChanges(left, right, { annotations: [box("a", "left"), box("a", "right")], resolve }),
    /annotations\[0\] \(mark "a"\): field id is also used on the right image in this call/);
  assert.equal(canvasMarks(left).length + canvasMarks(right).length, 0);
  assert.throws(() => applyPairChanges(left, right, { annotations: [box("user-9x", "left")].map(a => ({ ...a, id: "b" })),
    priorUser: [{ id: "b", side: "right", type: "point", x: 0.5, y: 0.5, author: "user" }], resolve }), /also used on the right image/);
});

test("a user send on a paired view tells GPT which image each mark is on", async () => {
  const { buildAnnotationEvent, formatAnnotationChatMessage } = await import("../src/interaction-protocol.js");
  const event = buildAnnotationEvent({
    image: { imageId: "img:aaaaaaaaaaaaaaaa", width: 1600, height: 1000 },
    pairImage: { imageId: "img:bbbbbbbbbbbbbbbb", width: 3000, height: 4000 },
    annotations: [{ id: "user-1", type: "point", x: 0.2, y: 0.3, label: "YOU 1" }, { id: "user-2", type: "point", x: 0.5, y: 0.5, label: "YOU 2", side: "right" }],
  });
  assert.deepEqual(event.annotations.map(a => a.side), ["left", "right"]);
  assert.equal(event.pair.right.id, "img:bbbbbbbbbbbbbbbb");
  const text = formatAnnotationChatMessage(event);
  // The serialized event carries side and pair, and inspection uses each side's image.
  const json = JSON.parse(text.split("\n").find(l => l.startsWith("{")));
  assert.equal(json.annotations[1].side, "right");
  assert.ok(json.pair);
  assert.match(text, /每個標記用它 side 對應的 imageId（left=img:aaaaaaaaaaaaaaaa，right=img:bbbbbbbbbbbbbbbb）/);
  assert.match(text, /pairImageId=img:bbbbbbbbbbbbbbbb/);
  assert.doesNotMatch(text, /請先用 Estampes 的 process_image 檢視 focus 標記的位置：imageId=/);
});
