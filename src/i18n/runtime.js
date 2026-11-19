// Message runtime shared by the server and the widgets (docs/rfc/i18n §4).
// No dependencies and no imports: widgets inline this file with its `export`
// keywords stripped (src/surface/widget-source.js), the server imports it.
//
// Messages are a small subset of ICU MessageFormat:
//   {name}                                   a parameter
//   {n, plural, one {# item} other {# items}} plural, with # = the number
//   {x, select, a {...} other {...}}         select on a string
// '{' and '}' only ever delimit these; messages need no other quoting.
// Catalogs are plain objects {key: message}. A key missing in every catalog
// of the chain renders as the key itself, never as an empty string.

function parseMessage(src) {
  let i = 0;
  function parts(stopAtBrace) {
    const out = [];
    let text = "";
    while (i < src.length) {
      const ch = src[i];
      if (ch === "}" && stopAtBrace) break;
      if (ch === "{") {
        if (text) { out.push(text); text = ""; }
        i++;
        out.push(arg());
        continue;
      }
      if (ch === "#" && stopAtBrace === "plural") { if (text) { out.push(text); text = ""; } out.push({ hash: true }); i++; continue; }
      text += ch; i++;
    }
    if (text) out.push(text);
    return out;
  }
  function word() {
    while (src[i] === " ") i++;
    let w = "";
    while (i < src.length && !/[\s,{}]/.test(src[i])) w += src[i++];
    while (src[i] === " ") i++;
    return w;
  }
  function arg() {
    const name = word();
    if (src[i] === "}") { i++; return { name }; }
    if (src[i] !== ",") throw new Error("i18n: bad argument in " + JSON.stringify(src));
    i++;
    const type = word();
    if (type !== "plural" && type !== "select") throw new Error("i18n: unsupported type " + type);
    if (src[i] !== ",") throw new Error("i18n: bad " + type + " in " + JSON.stringify(src));
    i++;
    const options = {};
    for (;;) {
      const sel = word();
      if (!sel) break;
      if (src[i] !== "{") throw new Error("i18n: bad option " + sel + " in " + JSON.stringify(src));
      i++;
      options[sel] = parts(type);
      if (src[i] !== "}") throw new Error("i18n: unclosed option in " + JSON.stringify(src));
      i++;
    }
    if (src[i] !== "}") throw new Error("i18n: unclosed " + type + " in " + JSON.stringify(src));
    i++;
    if (!options.other) throw new Error("i18n: " + type + " needs an 'other' option in " + JSON.stringify(src));
    return { name, type, options };
  }
  const out = parts(false);
  return out;
}

// Parameters a message uses, with their kind, for catalog checks.
export function messageParams(src) {
  const found = {};
  const walk = (list) => { for (const p of list) if (typeof p === "object" && p.name) { found[p.name] = p.type || "text"; if (p.options) for (const o of Object.values(p.options)) walk(o); } };
  walk(parseMessage(src));
  return found;
}

export function createI18n(catalogs, locale, fallbacks = ["en"]) {
  const chain = [locale, ...fallbacks].filter((l, k, a) => l && catalogs[l] && a.indexOf(l) === k);
  const cache = new Map();
  // Plural rules follow the catalog the message came from, so an English
  // fallback still says "1 item".
  const rules = new Map();
  const pluralFor = (l) => {
    if (!rules.has(l)) { try { rules.set(l, new Intl.PluralRules(l)); } catch { rules.set(l, new Intl.PluralRules("en")); } }
    return rules.get(l);
  };
  let plural;
  const render = (list, params, n) => list.map((p) => {
    if (typeof p === "string") return p;
    if (p.hash) return String(n);
    const v = params?.[p.name];
    if (!p.type) return v === undefined || v === null ? "" : String(v);
    if (p.type === "plural") {
      const num = Number(v);
      const opt = p.options["=" + num] ?? p.options[plural.select(num)] ?? p.options.other;
      return render(opt, params, num);
    }
    return render(p.options[String(v)] ?? p.options.other, params, n);
  }).join("");
  function t(key, params) {
    for (const l of chain) {
      const src = catalogs[l][key];
      if (typeof src !== "string") continue;
      let parsed = cache.get(l + "\u0000" + key);
      if (!parsed) { parsed = parseMessage(src); cache.set(l + "\u0000" + key, parsed); }
      plural = pluralFor(l);
      return render(parsed, params);
    }
    return key;
  }
  const has = (key) => chain.some((l) => typeof catalogs[l][key] === "string");
  return { t, has, locale: chain[0] ?? locale };
}
