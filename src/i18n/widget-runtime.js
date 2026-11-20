// Browser side of locale selection (docs/rfc/i18n §5). The server inlines
// this file, with its exports stripped, into every widget next to
// runtime.js and the catalogs (see widgetI18nSource in ./index.js). It has no
// imports so that it runs as-is in the page; the server imports matchLocale
// from here so both sides negotiate tags the same way.

// Negotiate a BCP 47 tag to one of `locales`: the exact tag, then
// script/region equivalents (zh-Hant, zh-HK, zh-MO → zh-TW), then the bare
// language when nothing contradicts it (en-GB → en; zh → zh-TW, but zh-Hans,
// zh-CN and zh-SG never become zh-TW). Returns null when nothing fits.
export function matchLocale(tag, locales) {
  if (typeof tag !== "string") return null;
  const want = tag.trim().replace(/_/g, "-").toLowerCase();
  if (!/^[a-z]{2,8}(-[a-z0-9]{1,8})*$/.test(want)) return null;
  const exact = locales.find((l) => l.toLowerCase() === want);
  if (exact) return exact;
  const parts = want.split("-");
  if (parts[0] === "zh") {
    const simplified = parts.some((p) => p === "hans" || p === "cn" || p === "sg" || p === "my");
    return !simplified && locales.includes("zh-TW") ? "zh-TW" : null;
  }
  return locales.find((l) => l.toLowerCase() === parts[0]) ?? null;
}

// A record's default name in the viewer's language (RFC docs/rfc/i18n T5,
// D6; src/i18n/names.js writes the fields). A record made from a catalog key
// carries `nameKey` and `nameParams` next to its literal `name`; `render` is
// a translator for the viewer's locale. Anything else (a name the person
// typed, a record from before this existed, a key this build's catalog lacks)
// shows its literal `name`. The record itself is never changed.
export function localizedName(rec, render, depth = 0) {
  if (!rec || typeof rec !== "object") return String(rec ?? "");
  const key = rec.nameKey;
  if (typeof key !== "string" || !key || depth > 1) return String(rec.name ?? "");
  const params = {};
  for (const [k, v] of Object.entries(rec.nameParams && typeof rec.nameParams === "object" ? rec.nameParams : {})) {
    if (k === "author" && (v === "user" || v === "assistant")) params[k] = render("name.author." + v);
    else if (v && typeof v === "object") params[k] = localizedName(v, render, depth + 1);
    else params[k] = v;
  }
  const out = render(key, params);
  return out === key ? String(rec.name ?? "") : out;
}

// The widget's translator. Resolution, first match wins: the person's own
// pick (localStorage, this browser only; never written into a canvas
// document, which is shared) → the host's locale → the instance default the
// server rendered with → en. `createI18n` comes from runtime.js.
export function widgetI18n(catalogs, instanceDefault, options = {}) {
  const locales = Object.keys(catalogs);
  const KEY = "estampes.locale";
  const fromHost = options.fromHost !== false;
  const htmlTags = options.html ?? {};
  const store = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
  const def = matchLocale(instanceDefault, locales) ?? "en";
  let picked = (() => { try { return matchLocale(store?.getItem(KEY), locales); } catch { return null; } })();
  let host = null;
  if (fromHost) { try { host = matchLocale(globalThis.openai?.locale, locales); } catch { host = null; } }
  const make = (l) => createI18n(catalogs, l, [def, "en"].filter((x, k, a) => x !== l && a.indexOf(x) === k));
  const listeners = new Set();
  let current = def, inst = make(def);

  // Re-apply the server's data-i18n markers in the page, in <template>
  // contents (cloned later) and in open shadow roots. Only text that still
  // shows the previous locale's message is replaced, so a status line the
  // page has since rewritten is left alone.
  function apply(prev) {
    const doc = globalThis.document;
    if (!doc?.querySelectorAll) return;
    doc.documentElement.lang = htmlTags[current] ?? current;
    doc.documentElement.dir = "ltr";
    const roots = [doc];
    for (let r = 0; r < roots.length && r < 200; r++) {
      const root = roots[r];
      for (const el of root.querySelectorAll("[data-i18n]")) {
        const key = el.getAttribute("data-i18n"), was = prev.t(key), now = inst.t(key);
        const first = el.firstChild;
        if (first && first.nodeType === 3) { if (first.nodeValue === was) first.nodeValue = now; }
        else if (!was) el.insertBefore(doc.createTextNode(now), first);
      }
      for (const el of root.querySelectorAll("[data-i18n-html]")) {
        const key = el.getAttribute("data-i18n-html");
        if (el.innerHTML === prev.t(key)) el.innerHTML = inst.t(key);
      }
      for (const attr of ["title", "aria-label", "placeholder", "alt"]) {
        for (const el of root.querySelectorAll("[data-i18n-" + attr + "]")) {
          const key = el.getAttribute("data-i18n-" + attr);
          if (el.getAttribute(attr) === prev.t(key)) el.setAttribute(attr, inst.t(key));
        }
      }
      for (const tpl of root.querySelectorAll("template")) if (tpl.content) roots.push(tpl.content);
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  function update() {
    const next = picked ?? host ?? def;
    if (next === current) return;
    const prev = inst;
    current = next; inst = make(next);
    apply(prev);
    for (const f of [...listeners]) { try { f(current); } catch { /* one view's re-render must not stop the others */ } }
  }
  update();

  const translate = (key, params) => inst.t(key, params);
  function pick(tag) {
    picked = tag == null || tag === "" ? null : matchLocale(tag, locales);
    try { if (picked) store?.setItem(KEY, picked); else store?.removeItem(KEY); } catch { /* storage may be blocked */ }
    update();
    return current;
  }
  return {
    t: translate,
    i18nT: translate,
    i18nLocale: () => current,
    // A host that sends no locale changes nothing; one we cannot match
    // drops the earlier host language, so the instance default applies.
    i18nHost(tag) { if (fromHost && typeof tag === "string" && tag) { host = matchLocale(tag, locales); update(); } return current; },
    i18nPick: pick,
    i18nOnChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // A record's default name in the current locale (see localizedName).
    i18nName: (rec) => localizedName(rec, translate),
    // A lookup table whose values are message keys, read in the current
    // locale on every access: i18nMap({ low: "store.risk.low" }).low.
    // Use it for tables built once at start-up, which would otherwise keep
    // the first language.
    i18nMap(keys) {
      return new Proxy(keys, {
        get: (o, k) => (typeof k === "string" && Object.hasOwn(o, k) ? inst.t(o[k]) : undefined),
        getOwnPropertyDescriptor: (o, k) => (Object.hasOwn(o, k) ? { value: inst.t(o[k]), enumerable: true, configurable: true, writable: false } : undefined),
      });
    },
    // A language menu: "Automatic" (host, then instance default) plus each
    // shipped language under its own name. The choice stays in this browser.
    i18nPicker() {
      const doc = globalThis.document;
      const label = doc.createElement("label");
      label.className = "estampes-lang";
      const caption = doc.createElement("span");
      const select = doc.createElement("select");
      const auto = doc.createElement("option");
      auto.value = "";
      select.append(auto);
      for (const l of locales) {
        const o = doc.createElement("option");
        o.value = l; o.lang = htmlTags[l] ?? l; o.textContent = catalogs[l]["i18n.autonym"] ?? l;
        select.append(o);
      }
      const sync = () => {
        caption.textContent = inst.t("i18n.picker.label") + " ";
        auto.textContent = inst.t("i18n.picker.auto");
        select.value = picked ?? "";
      };
      select.addEventListener("change", () => { pick(select.value || null); sync(); });
      listeners.add(sync);
      sync();
      label.append(caption, select);
      return label;
    },
  };
}
