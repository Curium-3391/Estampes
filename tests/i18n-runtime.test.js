// i18n Phase 1: the message runtime, the catalogs and how widgets get them.
// See docs/rfc/i18n/README.md §4–5 and §9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { createI18n, messageParams } from "../src/i18n/runtime.js";
import { CATALOGS, PINNED_LOCALE, localizeHtml, t, widgetI18nSource } from "../src/i18n/index.js";
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

test("static markup is filled at serve time; scripts and styles are left alone", () => {
  const src = '<html lang="__ESTAMPES_LANG__"><style>.a{content:"data-i18n=\\"x\\""}</style>' +
    '<button data-i18n="calc.go" data-i18n-title="calc.stop.title"></button>' +
    '<p data-i18n-html="vs.help.html"></p><label data-i18n="calc.defs.nameLabel"><input data-i18n-placeholder="calc.input.example"></label>' +
    '<script>const s = \'<b data-i18n="calc.go"></b>\';</script>';
  const out = localizeHtml(src);
  assert.ok(out.startsWith('<html lang="zh-Hant">'));
  assert.ok(out.includes('<button data-i18n="calc.go" title="停止這次計算" data-i18n-title="calc.stop.title">計算</button>'));
  assert.ok(out.includes("<strong>金色＝AI</strong>"), "trusted catalog HTML is inserted as HTML");
  assert.ok(out.includes('<label data-i18n="calc.defs.nameLabel">名稱<input placeholder="例如 " data-i18n-placeholder'), "leading text, then the existing children");
  assert.ok(out.includes('<b data-i18n="calc.go"></b>'), "script content untouched");
  assert.ok(out.includes('content:"data-i18n=\\"x\\""'), "style content untouched");
  assert.equal(localizeHtml('<i data-i18n-title="x.y" title="a"></i>').includes('title="x.y"'), true, "a missing key shows the key");
  assert.equal(localizeHtml('<i data-i18n="calc.chip.assumption"></i>'), '<i data-i18n="calc.chip.assumption">：</i>');
});

test("served widgets have no i18n placeholders left and every marker resolves", () => {
  for (const f of ["visual-surface.html", "module-store.html"]) {
    const html = inlineWorkbench(readFileSync(new URL("../public/" + f, import.meta.url), "utf8"));
    assert.ok(!/__ESTAMPES_(I18N|LANG)__/.test(html), f);
    for (const m of html.split("<script")[0].matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) assert.ok(m[1] in CATALOGS["zh-TW"], f + ": " + m[1]);
  }
});
