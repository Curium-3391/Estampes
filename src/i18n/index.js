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
