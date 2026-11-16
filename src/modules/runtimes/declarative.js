// Declarative modules contain no code at all: each capability is a list of
// scene operations with {"$param": "name"} placeholders (optionally
// {"$param": "name", "default": value}). The placeholders are filled from
// the already validated input; the result goes through the same scene
// operation checks as any module output. Good for symbol and template
// libraries.
const MAX_DEPTH = 16;

// Reads "a.b.0.c" from parsed JSON. Own properties only.
export function readPath(data, path) {
  let at = data;
  for (const part of String(path).split(".")) {
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, part)) return undefined;
    at = at[part];
  }
  return at;
}

// `response` (http modules only): {"$response": "path"} reads the JSON reply.
// `missing`, when given, collects $response paths that the reply lacks and
// that have no default (self-tests use it to catch typos in a mapping).
//
// Lists: an array element {"$each": <placeholder>, "do": <template>, "max": n}
// becomes one element per item of the list the placeholder gives (a
// {"$response": …} or {"$param": …}), at most `max` (default 64, at most 200).
// Inside `do`, {"$item": "a.b"} reads the current item ("." is the whole
// item) and {"$index": 1} is its position plus the given offset. Any
// placeholder can add "as": "string" to turn a number or boolean into text.
const PLACEHOLDER_KEYS = new Set(["default", "as"]);
const isPlaceholder = (value, key) => typeof value[key] === "string" && Object.keys(value).every((k) => k === key || PLACEHOLDER_KEYS.has(k));
const convert = (v, as) => (as === "string" && v !== undefined && v !== null && typeof v !== "object" ? String(v) : v);
const MAX_EACH = 200;

export function fillTemplate(value, params, depth = 0, response = undefined, missing = undefined, items = []) {
  if (depth > MAX_DEPTH) throw new Error("template nested too deeply");
  const fill = (v, d = depth + 1, it = items) => fillTemplate(v, params, d, response, missing, it);
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) {
      if (v && typeof v === "object" && !Array.isArray(v) && Object.hasOwn(v, "$each")) {
        if (!Object.keys(v).every((k) => k === "$each" || k === "do" || k === "max") || !Object.hasOwn(v, "do")) throw new Error("$each takes \"$each\", \"do\" and an optional \"max\"");
        const max = v.max === undefined ? 64 : v.max;
        if (!Number.isInteger(max) || max < 0 || max > MAX_EACH) throw new Error("$each max must be a whole number from 0 to " + MAX_EACH);
        const list = fill(v.$each);
        if (list === undefined) continue;
        if (!Array.isArray(list)) throw new Error("$each needs a list, got " + typeof list);
        list.slice(0, max).forEach((item, index) => out.push(fill(v.do, depth + 1, [...items, { item, index }])));
        continue;
      }
      out.push(fill(v));
    }
    return out;
  }
  if (value && typeof value === "object") {
    if (isPlaceholder(value, "$response")) {
      const found = response === undefined ? undefined : readPath(response, value.$response);
      if (found === undefined && !Object.hasOwn(value, "default")) missing?.push(value.$response);
      return convert(found !== undefined ? found : value.default, value.as);
    }
    if (isPlaceholder(value, "$param")) {
      if (Object.hasOwn(params, value.$param)) return convert(params[value.$param], value.as);
      if (Object.hasOwn(value, "default")) return convert(value.default, value.as);
      return undefined;
    }
    if (isPlaceholder(value, "$item")) {
      if (!items.length) throw new Error("$item is only allowed inside $each");
      const { item } = items.at(-1);
      const found = value.$item === "." ? item : readPath(item, value.$item);
      if (found === undefined && !Object.hasOwn(value, "default")) missing?.push("$item " + value.$item);
      return convert(found !== undefined ? found : value.default, value.as);
    }
    if (Number.isInteger(value.$index) && Object.keys(value).every((k) => k === "$index" || k === "as")) {
      if (!items.length) throw new Error("$index is only allowed inside $each");
      return convert(items.at(-1).index + value.$index, value.as);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const filled = fill(v);
      if (filled !== undefined) out[k] = filled;
    }
    return out;
  }
  return value;
}

export const declarativeRuntime = {
  kind: "declarative",
  async run(mod, capability, params) {
    const cap = mod.manifest.capabilities.find((c) => c.id === capability);
    return { operations: fillTemplate(cap.operations, params), summary: cap.title ?? capability, method: "declarative template" };
  },
};
