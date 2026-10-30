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
export function fillTemplate(value, params, depth = 0, response = undefined) {
  if (depth > MAX_DEPTH) throw new Error("template nested too deeply");
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, params, depth + 1, response));
  if (value && typeof value === "object") {
    if (typeof value.$response === "string" && Object.keys(value).every((k) => k === "$response" || k === "default")) {
      const found = response === undefined ? undefined : readPath(response, value.$response);
      return found !== undefined ? found : value.default;
    }
    if (typeof value.$param === "string" && Object.keys(value).every((k) => k === "$param" || k === "default")) {
      if (Object.hasOwn(params, value.$param)) return params[value.$param];
      if (Object.hasOwn(value, "default")) return value.default;
      return undefined;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const filled = fillTemplate(v, params, depth + 1, response);
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
