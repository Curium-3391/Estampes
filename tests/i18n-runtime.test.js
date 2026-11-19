// i18n Phase 1: the message runtime, the catalogs and how widgets get them.
// See docs/rfc/i18n/README.md §4–5 and §9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { createI18n, messageParams } from "../src/i18n/runtime.js";
import { CATALOGS, PINNED_LOCALE, t, widgetI18nSource } from "../src/i18n/index.js";
import { inlineWorkbench } from "../src/surface/widget-source.js";

const cats = {
  en: { hi: "Hello {name}", n: "{count, plural, =0 {no items} one {# item} other {# items}}", g: "{kind, select, graph {a Graph} other {an image}}", only: "English only" },
  "zh-TW": { hi: "你好 {name}", n: "{count, plural, =0 {沒有項目} other {# 個項目}}", g: "{kind, select, graph {圖形} other {圖片}}" },
};

test("messages fill parameters, plurals and selects", () => {
  const en = createI18n(cats, "en");
  assert.equal(en.t("hi", { name: "Ana" }), "Hello Ana");
  assert.equal(en.t("n", { count: 0 }), "no items");
  assert.equal(en.t("n", { count: 1 }), "1 item");
  assert.equal(en.t("n", { count: 3 }), "3 items");
  assert.equal(en.t("g", { kind: "graph" }), "a Graph");
  assert.equal(en.t("g", { kind: "x" }), "an image");
  const zh = createI18n(cats, "zh-TW");
  assert.equal(zh.t("n", { count: 1 }), "1 個項目");
  assert.equal(zh.t("hi", {}), "你好 ", "a missing parameter renders as nothing");
});

test("a missing key falls back to English, then to the key itself", () => {
  const zh = createI18n(cats, "zh-TW");
  assert.equal(zh.t("only"), "English only");
  assert.equal(zh.t("nope.key"), "nope.key");
  assert.equal(zh.has("only"), true);
  assert.equal(zh.has("nope.key"), false);
  assert.equal(createI18n(cats, "fr").locale, "en", "an unknown locale resolves to the fallback");
});

test("broken messages are refused, and their parameters can be listed", () => {
  assert.throws(() => createI18n({ en: { x: "{n, plural, one {#}}" } }, "en").t("x", { n: 1 }), /other/);
  assert.throws(() => createI18n({ en: { x: "{n, number}" } }, "en").t("x"), /unsupported/);
  assert.deepEqual(messageParams("{a} {n, plural, other {{b}}}"), { a: "text", n: "plural", b: "text" });
});

test("Phase 1 pins zh-TW, and zh-TW is the complete catalog", () => {
  assert.equal(PINNED_LOCALE, "zh-TW");
  assert.equal(t("store.tab.browse"), "瀏覽");
  for (const k of Object.keys(CATALOGS.en)) assert.ok(k in CATALOGS["zh-TW"], k);
  assert.equal(t("oauth.wrongKey", undefined, "en"), "The access key is not correct. Please try again.");
});

test("the catalog check passes: every message parses and every t(\"key\") exists", () => {
  const r = spawnSync(process.execPath, ["scripts/check-i18n.mjs", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).catalogErrors, []);
});

test("widgets get the runtime and catalogs inlined, safe inside <script>", () => {
  const html = inlineWorkbench(readFileSync(new URL("../public/module-store.html", import.meta.url), "utf8"));
  assert.ok(!html.includes("__ESTAMPES_I18N__"));
  const src = widgetI18nSource();
  assert.ok(!/<\/script/i.test(src));
  const ctx = {};
  vm.runInNewContext(src + "\nthis.out = [t('store.subtitle', { version: '1.2.3' }), i18nLocale];", ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.out)), ["模組商店 · 1.2.3", "zh-TW"]);
});
