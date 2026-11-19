// Server side of the message catalogs (docs/rfc/i18n §4–5).
// Catalogs live in src/i18n/locales/<tag>.json. English is the key and
// fallback language (decision D1); zh-TW is complete. During Phase 1 every
// surface is pinned to zh-TW, so what users see is exactly what it was
// before the strings moved into the catalog.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createI18n } from "./runtime.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export const CATALOGS = Object.freeze(Object.fromEntries(
  readdirSync(join(HERE, "locales")).filter((f) => f.endsWith(".json")).sort()
    .map((f) => [f.slice(0, -5), Object.freeze(JSON.parse(readFileSync(join(HERE, "locales", f), "utf8")))])));

// Phase 1: the resolved locale is always zh-TW (RFC §9). Phase 2 replaces
// this with user override → host locale → ESTAMPES_DEFAULT_LOCALE → en.
export const PINNED_LOCALE = "zh-TW";

const instances = new Map();
export function i18nFor(locale = PINNED_LOCALE) {
  if (!instances.has(locale)) instances.set(locale, createI18n(CATALOGS, locale));
  return instances.get(locale);
}
export const t = (key, params, locale = PINNED_LOCALE) => i18nFor(locale).t(key, params);

// Source inlined into widget HTML at the __ESTAMPES_I18N__ placeholder: the
// runtime with its exports stripped, the catalogs, and a `t` bound to the
// locale. "</" is escaped so a message can never close the <script>.
export function widgetI18nSource(locale = PINNED_LOCALE) {
  const runtime = readFileSync(join(HERE, "runtime.js"), "utf8").replace(/^export\s+/gm, "");
  const catalogs = JSON.stringify(CATALOGS).replace(/<\//g, "<\\/").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return "const { t, i18nLocale } = (() => {\n" + runtime +
    "\nconst i = createI18n(" + catalogs + ", " + JSON.stringify(locale) + ");\nreturn { t: i.t, i18nLocale: i.locale };\n})();";
}

// Static widget markup (docs/rfc/i18n §5). Markup outside <script>/<style>
// names its text by key and the server fills it in when the widget is
// served, so the page needs no script to show its chrome:
//   <button data-i18n="k"></button>          leading text of the element
//   <p data-i18n-html="k"></p>               trusted catalog HTML (our own catalog only)
//   <input data-i18n-placeholder="k">        also title, aria-label, alt
//   <html lang="__ESTAMPES_LANG__">          the locale's language tag
// The markers stay in the output, so a later phase can re-apply another
// locale in the browser.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escHtml = (v) => String(v).replace(/[&<>"]/g, (c) => ESC[c]);
const LANG_TAGS = { "zh-TW": "zh-Hant" };
export const htmlLang = (locale = PINNED_LOCALE) => LANG_TAGS[locale] ?? locale;
export function localizeHtml(html, locale = PINNED_LOCALE) {
  const { t: tr } = i18nFor(locale);
  return html.split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/i).map((part, i) => i % 2 ? part : part
    .replace(/\bdata-i18n-(title|aria-label|placeholder|alt)="([^"]+)"/g, (m, attr, key) => attr + '="' + escHtml(tr(key)) + '" ' + m)
    .replace(/<[a-zA-Z][^<>]*\bdata-i18n="([^"]+)"[^<>]*>/g, (tag, key) => tag + escHtml(tr(key)))
    .replace(/<[a-zA-Z][^<>]*\bdata-i18n-html="([^"]+)"[^<>]*>/g, (tag, key) => tag + tr(key))
    .replaceAll("__ESTAMPES_LANG__", htmlLang(locale))).join("");
}
