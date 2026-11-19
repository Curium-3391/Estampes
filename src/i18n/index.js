// Server side of the message catalogs (docs/rfc/i18n §4–5).
// Catalogs live in src/i18n/locales/<tag>.json. English is the key and
// fallback language (decision D1); en and zh-TW are complete. The locale is
// resolved per view (Phase 2): see matchLocale and widgetI18nSource.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createI18n } from "./runtime.js";
import { matchLocale as matchIn } from "./widget-runtime.js";
import { config, addConfigWarning } from "../config.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export const CATALOGS = Object.freeze(Object.fromEntries(
  readdirSync(join(HERE, "locales")).filter((f) => f.endsWith(".json")).sort()
    .map((f) => [f.slice(0, -5), Object.freeze(JSON.parse(readFileSync(join(HERE, "locales", f), "utf8")))])));

export const LOCALES = Object.freeze(Object.keys(CATALOGS));

// Tag negotiation is shared with the browser (./widget-runtime.js).
export const matchLocale = (tag) => matchIn(tag, LOCALES);

// A server-rendered page (the OAuth sign-in) has no widget runtime: take the
// first language in the browser's Accept-Language that we ship, else the
// instance default. Quality values order the list; q=0 is skipped.
export function localeFromAcceptLanguage(header) {
  const tags = String(header ?? "").split(",").slice(0, 20).map((part, i) => {
    const [tag, ...opts] = part.trim().split(";");
    const q = opts.map((o) => o.trim()).find((o) => o.startsWith("q="));
    return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1, i };
  }).filter((x) => x.tag && x.tag !== "*" && x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of tags) { const l = matchLocale(tag); if (l) return l; }
  return null;
}

// The instance default (ESTAMPES_DEFAULT_LOCALE), else English.
const configured = config.defaultLocale;
export const DEFAULT_LOCALE = configured ? matchLocale(configured) ?? "en" : "en";
if (configured && !matchLocale(configured)) {
  addConfigWarning("ESTAMPES_DEFAULT_LOCALE=" + JSON.stringify(configured) + " is not a supported language (" + LOCALES.join(", ") + "); using en");
}

const instances = new Map();
export function i18nFor(locale = DEFAULT_LOCALE) {
  const l = matchLocale(locale) ?? DEFAULT_LOCALE;
  if (!instances.has(l)) instances.set(l, createI18n(CATALOGS, l, [...new Set([DEFAULT_LOCALE, "en"])].filter((x) => x !== l)));
  return instances.get(l);
}
// Server-rendered text uses the instance default unless a caller passes the
// viewer's locale. Default names (T5) stay in the default until Phase 4.
export const t = (key, params, locale = DEFAULT_LOCALE) => i18nFor(locale).t(key, params);

// Source inlined into widget HTML at the __ESTAMPES_I18N__ placeholder: the
// runtime with its exports stripped, all catalogs, and a translator whose
// locale the widget resolves in the browser (RFC §5): the person's own pick
// (kept in this browser only, never in a canvas document) → the host's
// locale (window.openai.locale now, MCP Apps hostContext.locale once the
// widget calls i18nHost) → the instance default → en. "</" is escaped so a
// message can never close the <script>.
//   t / i18nT(key, params)   translate (i18nT is for code where a local `t` shadows it)
//   i18nLocale()             the resolved locale
//   i18nHost(tag)            report the host's locale; re-applies if it changes
//   i18nPick(tag | null)     the person's own choice; null clears it
//   i18nOnChange(fn)         re-render dynamic text after a change
//   i18nPicker()             a <label><select> language menu for the widget's header
//   i18nMap({ left: "vs.side.left" }) a table translated on every read (for start-up constants)
export function widgetI18nSource(locale = DEFAULT_LOCALE, { fromHost = config.localeFromHost } = {}) {
  const runtime = readFileSync(join(HERE, "runtime.js"), "utf8").replace(/^export\s+/gm, "");
  const safe = (v) => JSON.stringify(v).replace(/<\//g, "<\\/").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return "const { t, i18nT, i18nLocale, i18nHost, i18nPick, i18nOnChange, i18nPicker, i18nMap, i18nName } = (() => {\n" + runtime + "\n" +
    readFileSync(join(HERE, "widget-runtime.js"), "utf8").replace(/^export\s+/gm, "") +
    "\nreturn widgetI18n(" + safe(CATALOGS) + ", " + safe(locale) + ", " + safe({ fromHost, html: LANG_TAGS }) + ");\n})();";
}

// Static widget markup (docs/rfc/i18n §5). Markup outside <script>/<style>
// names its text by key and the server fills it in when the widget is
// served, so the page needs no script to show its chrome:
//   <button data-i18n="k"></button>          leading text of the element
//   <p data-i18n-html="k"></p>               trusted catalog HTML (our own catalog only)
//   <input data-i18n-placeholder="k">        also title, aria-label, alt
//   <html lang="__ESTAMPES_LANG__">          the locale's language tag
// The markers stay in the output, so the widget re-applies them in the
// browser when it resolves another locale (src/i18n/widget-runtime.js).
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escHtml = (v) => String(v).replace(/[&<>"]/g, (c) => ESC[c]);
const LANG_TAGS = { "zh-TW": "zh-Hant" };
export const htmlLang = (locale = DEFAULT_LOCALE) => LANG_TAGS[locale] ?? locale;
export function localizeHtml(html, locale = DEFAULT_LOCALE) {
  const { t: tr } = i18nFor(locale);
  return html.split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/i).map((part, i) => i % 2 ? part : part
    .replace(/\bdata-i18n-(title|aria-label|placeholder|alt)="([^"]+)"/g, (m, attr, key) => attr + '="' + escHtml(tr(key)) + '" ' + m)
    .replace(/<[a-zA-Z][^<>]*\bdata-i18n="([^"]+)"[^<>]*>/g, (tag, key) => tag + escHtml(tr(key)))
    .replace(/<[a-zA-Z][^<>]*\bdata-i18n-html="([^"]+)"[^<>]*>/g, (tag, key) => tag + tr(key))
    .replaceAll("__ESTAMPES_LANG__", htmlLang(locale))).join("");
}
