// Messages the Visual Surface posts as the person (RFC docs/rfc/i18n D4):
// a sentence in the person's language, then an English block for the
// assistant that does not change with the language.
import test from "node:test";
import assert from "node:assert/strict";
import { t } from "../src/i18n/index.js";
import { reviewParts, editParts, fallbackParts, joinUserVoice } from "../src/surface/user-voice.js";
import { inlineWorkbench } from "../src/surface/widget-source.js";
import { readFileSync } from "node:fs";

const tr = (locale) => (key, params) => t(key, params, locale);
const LOCALIZED = /[　-鿿＀-￯]/;
const pair = { kind: "pair", left: "img:aaaaaaaaaaaaaaaa", right: "img:bbbbbbbbbbbbbbbb" };
const ws = { kind: "workspace", id: "ws:0123456789abcdef", items: [{ id: "wi-1", imageId: "img:1111111111111111" }, { id: "wi-2", imageId: "img:2222222222222222" }] };

test("reviews: one sentence per kind in the person's language, the same English block in every language", () => {
  const list = [
    { kind: "gesture", side: "left", labels: ["YOU 1", "YOU 2"], verdict: "user-confirmed", made: true },
    { kind: "link", label: "L1", verdict: "rejected", reason: "顏色不同", left: "a1", right: "b1" },
    { kind: "note", side: "right", label: "A3", note: "電容 C12", verdict: "confirmed" },
  ];
  const zh = reviewParts(list, pair, tr("zh-TW")), en = reviewParts(list, pair, tr("en"));
  assert.deepEqual(zh.sentences, ["我說明了哪些筆畫屬於同一個手勢（1 組）。", "我審核了你在畫布上的 2 項說法。"]);
  assert.deepEqual(en.sentences, ["I said which strokes belong to one gesture (1 group).", "I reviewed 2 of your claims on the canvas."]);
  assert.deepEqual(zh.blocks, en.blocks);
  const [gesture, review] = en.blocks;
  assert.match(gesture, /^--- Estampes stroke groups, for the assistant ---\n/);
  assert.match(gesture, /- left image YOU 1 \+ YOU 2: they grouped them into one gesture$/m);
  assert.match(review, /- link L1 \(left a1 <-> right b1\): rejected, not the same thing; their reason: "顏色不同"$/m);
  assert.match(review, /- right image mark A3 note "電容 C12": confirmed your note is right$/m);
  assert.match(review, /Take the person's verdicts as final/);
  // Only the person's own words may be in another script.
  assert.doesNotMatch(review.replace('"顏色不同"', "").replace('"電容 C12"', ""), LOCALIZED);
});

test("workspace links name each image and edits list every change", () => {
  const review = reviewParts([{ kind: "link", label: "L2", verdict: "confirmed", fromItem: "wi-1", toItem: "wi-2", left: "u1", right: "u7" }], ws, tr("en"));
  assert.match(review.blocks[0], /workspace ws:0123456789abcdef: wi-1=img:1111111111111111, wi-2=img:2222222222222222/);
  assert.match(review.blocks[0], /- link L2 \(wi-1 u1 <-> wi-2 u7\): confirmed, the same thing/);
  const edits = [
    { kind: "rename-layer", side: "wi-1", layer: "L3", from: "舊", to: "新" },
    { kind: "move-mark", side: "wi-2", id: "a4", label: "R1", author: "assistant", change: "resize" },
    { kind: "remove-mark", side: "wi-1", id: "u2", author: "user" },
    { kind: "unknown-kind", side: "wi-1" },
  ];
  const zh = editParts(edits, ws, tr("zh-TW")), en = editParts(edits, ws, tr("en"));
  assert.deepEqual(zh.sentences, ["我在畫布上手動做了 4 項修改。"]);
  assert.deepEqual(en.sentences, ["I made 4 changes on the canvas by hand."]);
  assert.deepEqual(zh.blocks, en.blocks);
  assert.match(en.blocks[0], /- wi-1 renamed layer L3 from "舊" to "新"/);
  assert.match(en.blocks[0], /- wi-2 resized your mark a4 "R1" \(they corrected its position; your note is kept/);
  assert.match(en.blocks[0], /- wi-1 deleted their mark u2$/m);
  assert.match(en.blocks[0], /- wi-1 unknown-kind$/m);
  assert.match(en.blocks[0], /present_visual \(workspaceId=ws:0123456789abcdef\)/);
  assert.deepEqual(editParts([], ws, tr("en")), { sentences: [], blocks: [] });
});

test("an unvalidated send keeps the person's words and says it was not validated", () => {
  const args = { intent: "point-out", note: "這裡漏水", replyQuote: "", canvas: { kind: "single", imageId: "img:cccccccccccccccc" }, scene: "landscape", marks: [{ id: "u1", type: "arrow", x: .1, y: .2, x2: .3, y2: .4 }] };
  const zh = fallbackParts(args, tr("zh-TW")), en = fallbackParts(args, tr("en"));
  assert.deepEqual(zh.sentences, ["我在 Estampes 畫布上做了標註（伺服器還沒驗證）：我想指出這個位置。", "補充：這裡漏水"]);
  assert.deepEqual(en.sentences, ["I annotated the Estampes canvas (not yet validated by the server): I want to point out this position.", "Note: 這裡漏水"]);
  assert.deepEqual(zh.blocks, en.blocks);
  assert.match(en.blocks[0], /the server did not validate this send\. Intent: point-out\./);
  assert.match(en.blocks[0], /an arrowhead \(x2,y2\) is what the person points at/);
  assert.match(en.blocks[0], /do not guess the previous question/);
  assert.ok(en.blocks[0].endsWith("Unvalidated marks: " + JSON.stringify(args.marks)));
  const demo = fallbackParts({ ...args, canvas: { kind: "single" } }, tr("en"));
  assert.match(demo.blocks[0], /built-in SVG demo scene id=demo:landscape/);
});

test("parts join as all sentences, a blank line, then each block; nothing to say is empty", () => {
  const a = { sentences: ["one"], blocks: ["A"] }, b = { sentences: ["two"], blocks: ["B"] };
  assert.equal(joinUserVoice(a, b), "one\ntwo\n\nA\n\nB");
  assert.equal(joinUserVoice({ sentences: [], blocks: [] }), "");
});

test("the widget inlines these builders and uses them for every message it posts as the person", () => {
  const raw = readFileSync(new URL("../public/visual-surface.html", import.meta.url), "utf8");
  assert.match(raw, /__ESTAMPES_USERVOICE__/);
  assert.doesNotMatch(raw, /i18n-ignore/);
  const served = inlineWorkbench(raw);
  assert.match(served, /const \{ reviewParts, editParts, fallbackParts, joinUserVoice \} = \(\(\) => \{/);
  assert.doesNotMatch(served, /__ESTAMPES_USERVOICE__/);
  assert.match(raw, /chatMessage=joinUserVoice\(fallbackParts\(/);
  assert.match(raw, /const extra=\(\)=>joinUserVoice\(reviewMessage\(reviewed\),editMessage\(edited\)\)/);
  const nl = readFileSync(new URL("../public/number-line.html", import.meta.url), "utf8");
  assert.match(nl, /i18nT\("msg\.numberLine\.summary",\{value\}\)\+"\\n\\n--- Estampes number line, for the assistant ---/);
});
