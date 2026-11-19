// Server errors the Visual Surface shows (RFC docs/rfc/i18n Phase 3): a known
// code becomes a sentence in the person's language; anything else keeps the
// server's own text.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { t } from "../src/i18n/index.js";

const raw = readFileSync(new URL("../public/visual-surface.html", import.meta.url), "utf8");
const start = raw.indexOf("const ERR_CODES="), end = raw.indexOf("\n", raw.indexOf("function errText("));
const load = (locale) => new Function("i18nT", raw.slice(start, end) + "\nreturn { ERR_CODES, toolError, errText };")((k, p) => t(k, p, locale));

test("a known code from structuredContent or a [CODE] tag is shown in the person's language", () => {
  const zh = load("zh-TW"), en = load("en");
  const locked = { isError: true, content: [{ type: "text", text: "Text layer is locked." }], structuredContent: { kind: "estampes.text_error", code: "LAYER_LOCKED" } };
  const err = zh.toolError(locked, "tool error");
  assert.equal(err.message, "Text layer is locked.");
  assert.equal(err.code, "LAYER_LOCKED");
  assert.equal(zh.errText(err), "這個圖層已鎖定，請先在圖層清單解除鎖定。");
  assert.equal(en.errText(err), "That layer is locked. Unlock it in the layer list first.");
  const tagged = Error('edit_visual_canvas marks[0] ("u1"): its layer is locked [LAYER_LOCKED]');
  assert.equal(en.errText(tagged), en.errText(err));
  for (const code of zh.ERR_CODES) for (const locale of ["en", "zh-TW"]) assert.notEqual(t("vs.err.code." + code, undefined, locale), "vs.err.code." + code);
});

test("other errors keep the server's text", () => {
  const { toolError, errText } = load("zh-TW");
  assert.equal(errText(toolError({ isError: true, content: [{ type: "text", text: "Nope" }], structuredContent: { code: "INVALID_TEXT" } }, "x")), "Nope");
  assert.equal(errText(toolError({ isError: true }, "tool error")), "tool error");
  assert.equal(errText(Error("Host timeout: tools/call")), "Host timeout: tools/call");
  assert.equal(errText("plain"), "plain");
});

test("every status line that shows a server error goes through errText", () => {
  assert.doesNotMatch(raw, /\{message:String\(err\.message\|\|err\)\}/);
  assert.doesNotMatch(raw, /throw Error\(r(esult)?\.content\?\.\[0\]\?\.text/);
});
