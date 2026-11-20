// i18n Phase 1: the message runtime, the catalogs and how widgets get them.
// See docs/rfc/i18n/README.md §4–5 and §9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { createI18n, messageParams } from "../src/i18n/runtime.js";
import { CATALOGS, DEFAULT_LOCALE, matchLocale, localeFromAcceptLanguage, localizeHtml, t, widgetI18nSource } from "../src/i18n/index.js";
import { widgetI18n, matchLocale as matchIn } from "../src/i18n/widget-runtime.js";
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

test("the tests run with the zh-TW default, and zh-TW is the complete catalog", () => {
  assert.equal(DEFAULT_LOCALE, "zh-TW", "tests/helpers/locale.mjs sets ESTAMPES_DEFAULT_LOCALE");
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
  vm.runInNewContext(src + "\nthis.out = [t('store.subtitle', { version: '1.2.3' }), i18nLocale()];", ctx);
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
  for (const f of ["visual-surface.html", "module-store.html", "number-line.html", "visual-evidence.html"]) {
    const html = inlineWorkbench(readFileSync(new URL("../public/" + f, import.meta.url), "utf8"));
    assert.ok(!/__ESTAMPES_(I18N|LANG)__/.test(html), f);
    for (const m of html.split("<script")[0].matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) assert.ok(m[1] in CATALOGS["zh-TW"], f + ": " + m[1]);
  }
});

test("server-side default names and permission text are unchanged while pinned to zh-TW", async () => {
  const { newLayerRecord, AUTHOR_NAME } = await import("../src/visual/layer-contract.js");
  const { describePermission } = await import("../src/modules/permissions.js");
  assert.deepEqual(AUTHOR_NAME, { user: "你", assistant: "AI" });
  assert.equal(newLayerRecord([{ id: "L1", author: "assistant" }], "assistant").name, "AI · 第2次");
  assert.equal(t("name.layer.imported", { author: "你" }), "你 · 匯入");
  assert.equal(t("name.copy.image", { source: "a.png" }), "複本 a.png · 圖片");
  assert.equal(t("name.workspace.pair", { left: "img:a", right: "img:b" }), "對照 img:a + img:b");
  assert.equal(t("name.workspace.split", { name: "工作區" }), "工作區（拆出）");
  assert.deepEqual(describePermission("cas.compute"), { id: "cas.compute", risk: "medium",
    zh: "使用本機的 SymPy 計算服務（只傳送算式，不連外網）", en: "Use the local SymPy calculator service (sends only expressions; no internet)" });
  assert.deepEqual(describePermission("nope"), { id: "nope", risk: "high", zh: "未知權限", en: "Unknown permission" });
});

test("tags negotiate to a shipped locale the same way on server and widget", () => {
  const cases = { en: "en", "en-GB": "en", EN_us: "en", "zh-TW": "zh-TW", "zh-Hant": "zh-TW", "zh-HK": "zh-TW", "zh-MO": "zh-TW", zh: "zh-TW",
    "zh-CN": null, "zh-Hans": null, "zh-Hans-TW": null, "zh-SG": null, fr: null, "": null, "en US": null, "<x>": null };
  for (const [tag, want] of Object.entries(cases)) assert.equal(matchLocale(tag), want, tag);
  assert.equal(matchLocale(undefined), null);
  assert.equal(t("name.layer.numbered", { author: "AI", n: 2 }, "en"), "AI · #2");
  assert.equal(t("name.layer.numbered", { author: "AI", n: 2 }, "fr"), "AI · 第2次", "an unsupported locale uses the instance default");
});

test("the server reads ESTAMPES_DEFAULT_LOCALE, warns on a bad value and defaults to English", () => {
  const probe = (value) => spawnSync(process.execPath, ["--input-type=module", "-e",
    "const { DEFAULT_LOCALE, t } = await import('./src/i18n/index.js'); const { configWarnings } = await import('./src/config.js');" +
    "console.log(JSON.stringify([DEFAULT_LOCALE, t('name.author.user'), configWarnings()]))"],
    { encoding: "utf8", env: { ...process.env, ESTAMPES_DEFAULT_LOCALE: value } });
  const run = (value) => JSON.parse(probe(value).stdout);
  assert.deepEqual(run("").slice(0, 2), ["en", "You"]);
  assert.deepEqual(run("zh-Hant").slice(0, 2), ["zh-TW", "你"]);
  const [locale, , warnings] = run("tlh");
  assert.equal(locale, "en");
  assert.match(warnings.join("\n"), /ESTAMPES_DEFAULT_LOCALE="tlh" is not a supported language/);
});

// A tiny DOM for the widget runtime: enough for the marker re-apply.
function fakeDom(html) {
  const els = [];
  const text = (v) => ({ nodeType: 3, nodeValue: v });
  const el = (attrs, kids = []) => { const e = { attrs, childNodes: kids, innerHTML: attrs.inner ?? "",
    get firstChild() { return this.childNodes[0] ?? null; },
    getAttribute(n) { return this.attrs[n] ?? null; }, setAttribute(n, v) { this.attrs[n] = v; },
    insertBefore(n) { this.childNodes.unshift(n); } }; els.push(e); return e; };
  const doc = { documentElement: { lang: html, dir: "" }, createTextNode: text,
    querySelectorAll(sel) { const a = sel.slice(1, -1); return els.filter((e) => a in e.attrs); } };
  return { doc, el, text };
}

test("the widget resolves pick > host > instance default and re-applies static text it still owns", () => {
  const { doc, el, text } = fakeDom("zh-Hant");
  const button = el({ "data-i18n": "calc.go" }, [text("計算")]);
  const status = el({ "data-i18n": "vs.status.text" }, [text("已連線，可以任意點選或拖曳標註。")]);
  const input = el({ "data-i18n-placeholder": "calc.input.label", placeholder: "算式" });
  const help = el({ "data-i18n-html": "vs.help.html", inner: CATALOGS["zh-TW"]["vs.help.html"] });
  const saved = new Map();
  const ctx = { document: doc, localStorage: { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k) } };
  const run = (opts, extra = {}) => vm.runInNewContext("(" + widgetI18n.toString().replace(/createI18n/g, "__create") + ")(catalogs, def, opts)",
    { ...ctx, ...extra, catalogs: CATALOGS, def: "zh-TW", opts, __create: createI18n, matchLocale: matchIn });
  const w = run({ html: { "zh-TW": "zh-Hant" } });
  assert.equal(w.i18nLocale(), "zh-TW", "no host locale yet: the instance default");
  const seen = [];
  w.i18nOnChange((l) => seen.push(l));
  assert.equal(w.i18nHost("en-US"), "en");
  assert.deepEqual(seen, ["en"]);
  assert.equal(doc.documentElement.lang, "en");
  assert.equal(button.firstChild.nodeValue, "Compute");
  assert.equal(status.firstChild.nodeValue, "已連線，可以任意點選或拖曳標註。", "text the page rewrote is left alone");
  assert.equal(input.attrs.placeholder, "Expression");
  assert.equal(help.innerHTML, CATALOGS.en["vs.help.html"]);
  assert.equal(w.t("calc.go"), "Compute");
  assert.equal(w.i18nPick("zh-TW"), "zh-TW", "the person's pick beats the host");
  assert.equal(saved.get("estampes.locale"), "zh-TW");
  assert.equal(button.firstChild.nodeValue, "計算");
  assert.equal(w.i18nHost("en"), "zh-TW");
  assert.equal(w.i18nPick(null), "en", "clearing the pick falls back to the host");
  assert.equal(w.i18nHost(undefined), "en", "a host message without a locale keeps the host language");
  assert.equal(w.i18nHost("fr"), "zh-TW", "an unsupported host language falls back to the instance default");
  assert.equal(saved.has("estampes.locale"), false);
  // A remembered pick and window.openai.locale apply before anything renders; fromHost: false ignores the host.
  saved.set("estampes.locale", "en");
  assert.equal(run({}).i18nLocale(), "en");
  saved.clear();
  assert.equal(run({}, { openai: { locale: "en-GB" } }).i18nLocale(), "en");
  const pinned = run({ fromHost: false }, { openai: { locale: "en-GB" } });
  assert.equal(pinned.i18nLocale(), "zh-TW");
  assert.equal(pinned.i18nHost("en"), "zh-TW");
  assert.equal(pinned.i18nPick("en"), "en", "a pick still works when host detection is off");
});

test("start-up tables and the language menu follow a later language change", () => {
  const { doc } = fakeDom("zh-Hant");
  const made = [];
  doc.createElement = (tag) => { const e = { tag, children: [], listeners: {}, value: "", textContent: "",
    append(...k) { this.children.push(...k); }, addEventListener(type, fn) { this.listeners[type] = fn; } }; made.push(e); return e; };
  const saved = new Map();
  const w = vm.runInNewContext("(" + widgetI18n.toString().replace(/createI18n/g, "__create") + ")(catalogs, def, opts)",
    { document: doc, localStorage: { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k) },
      catalogs: CATALOGS, def: "zh-TW", opts: { html: { "zh-TW": "zh-Hant" } }, __create: createI18n, matchLocale: matchIn });
  const sides = w.i18nMap({ left: "vs.side.left" });
  assert.equal(sides.left, CATALOGS["zh-TW"]["vs.side.left"]);
  assert.equal(sides.nope, undefined);
  assert.deepEqual(Object.keys(sides), ["left"]);
  const label = w.i18nPicker();
  const [caption, select] = label.children;
  const options = select.children;
  assert.deepEqual(options.map((o) => o.value), ["", "en", "zh-TW"]);
  assert.deepEqual(options.slice(1).map((o) => [o.lang, o.textContent]), [["en", "English"], ["zh-Hant", "繁體中文"]], "each language under its own name");
  assert.equal(caption.textContent, "語言 ");
  select.value = "en"; select.listeners.change();
  assert.equal(w.i18nLocale(), "en");
  assert.equal(saved.get("estampes.locale"), "en");
  assert.equal(sides.left, CATALOGS.en["vs.side.left"], "the table reads the new language");
  assert.equal(caption.textContent, "Language ");
  assert.equal(options[0].textContent, "Automatic (chat app)");
  select.value = ""; select.listeners.change();
  assert.equal(w.i18nLocale(), "zh-TW", "Automatic clears the pick");
  assert.equal(saved.has("estampes.locale"), false);
  assert.equal(select.value, "");
});

test("the sign-in page follows the browser's Accept-Language", () => {
  assert.equal(localeFromAcceptLanguage("fr-CA,fr;q=0.9,en-US;q=0.8,en;q=0.7"), "en");
  assert.equal(localeFromAcceptLanguage("zh-CN;q=0.9, zh-HK;q=0.5, en;q=0.4"), "zh-TW", "zh-CN is skipped, zh-HK is Traditional");
  assert.equal(localeFromAcceptLanguage("en;q=0, zh-TW;q=0.1"), "zh-TW", "q=0 means not acceptable");
  assert.equal(localeFromAcceptLanguage("*, fr"), null);
  assert.equal(localeFromAcceptLanguage(undefined), null);
  assert.equal(localeFromAcceptLanguage("fr,".repeat(30) + "en"), null, "only the first 20 entries are read");
});
