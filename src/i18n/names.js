// Default names stored in documents (RFC docs/rfc/i18n class T5, decision D6).
//
// A name the server makes up (a layer such as "AI · #2", a copied canvas's
// layers) is stored twice on the same record:
//   name        the literal text in the server's language when it was made.
//               This is what the assistant reads and what a build without
//               this feature shows; it is always present.
//   nameKey     a catalog key from NAME_KEYS, and
//   nameParams  its parameters,
//               so a viewer's widget can say it in the viewer's language.
// A person's own text is never keyed: renaming a layer drops both fields.
// A record without nameKey is shown as its literal name, exactly as before;
// old documents are not rewritten.
//
// nameParams values are short strings, finite numbers, the author token
// ("user" or "assistant", which the viewer's language turns into a word) and
// one level of nested name (`{ name, nameKey?, nameParams? }`, for a copied
// layer that names the layer it was copied from).
import { t, CATALOGS } from "./index.js";
import { messageParams } from "./runtime.js";

export const NAME_KEYS = Object.freeze([
  "name.layer.numbered", "name.layer.imported", "name.layer.replay", "name.layer.module",
  "name.copy.original", "name.copy.image", "name.copy.marks", "name.copy.object", "name.copy.layer",
  "name.text", "name.textDup",
  "name.workspace.canvas", "name.workspace.default", "name.workspace.pair", "name.workspace.split",
]);
export const NAME_FIELDS = Object.freeze(["nameKey", "nameParams"]);
export const NAME_TEXT_MAX = 120;

const AUTHORS = ["user", "assistant"];
// Parameters that may hold another record's name: the layer a copy came from, the workspace a split came from.
const NESTED = ["layer", "name"];
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const scalar = (v) => (typeof v === "string" && v.length <= NAME_TEXT_MAX) || (typeof v === "number" && Number.isFinite(v));

// The parameter names a key's message takes, from the complete catalog.
const expectedParams = (key) => Object.keys(messageParams(CATALOGS["zh-TW"][key] ?? ""));

// A name for a record: `{ name, nameKey, nameParams }`. `params` may hold an
// `author` token and nested names made by this function. A name nested inside
// a nested name loses its key (one level only), so what is stored stays small.
export function defaultName(key, params = {}) {
  if (!NAME_KEYS.includes(key)) throw new Error("Not a default-name key: " + key);
  const stored = {}, shown = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === "author") { stored.author = v; shown.author = t("name.author." + v); continue; }
    if (isRecord(v)) {
      const flat = Object.values(v.nameParams ?? {}).every((x) => !isRecord(x));
      stored[k] = flat ? { name: v.name, ...(v.nameKey ? { nameKey: v.nameKey, nameParams: v.nameParams } : {}) } : { name: v.name };
      shown[k] = v.name;
      continue;
    }
    stored[k] = v; shown[k] = v;
  }
  return { name: t(key, shown), nameKey: key, nameParams: stored };
}

// The key fields a record may keep, or `{}`. Used where a record comes from
// outside this process (a bundle, an older file): an unknown key, a missing
// or extra parameter, or a value of the wrong kind drops the key and the
// literal name stands. Never throws.
export function cleanNameFields(rec, depth = 0) {
  const key = rec?.nameKey;
  if (typeof key !== "string" || !NAME_KEYS.includes(key)) return {};
  const params = rec.nameParams ?? {};
  if (!isRecord(params)) return {};
  const want = expectedParams(key), have = Object.keys(params);
  if (have.length !== want.length || have.some((k) => !want.includes(k))) return {};
  const clean = {};
  for (const k of have) {
    const v = params[k];
    if (k === "author") { if (!AUTHORS.includes(v)) return {}; clean.author = v; }
    else if (scalar(v)) clean[k] = v;
    else if (NESTED.includes(k) && isRecord(v) && depth < 1 && typeof v.name === "string" && v.name.length <= NAME_TEXT_MAX) clean[k] = { name: v.name, ...cleanNameFields(v, depth + 1) };
    else return {};
  }
  return { nameKey: key, nameParams: clean };
}

// A record's own fields plus its clean key fields, for copying a record.
export const withNameFields = (target, source) => { delete target.nameKey; delete target.nameParams; return Object.assign(target, cleanNameFields(source)); };

// Take a stored name apart: a plain string stays a plain name.
export const asNamed = (name) => (isRecord(name) ? name : { name: String(name ?? "") });
