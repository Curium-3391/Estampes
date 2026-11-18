// A deliberately small JSON Schema subset for module capability inputs.
// Manifests come from module authors, so a schema may only use the
// keywords listed here (anything else is refused when the manifest is
// checked), and validation never fetches, never evaluates patterns from
// the network and never recurses deeper than MAX_DEPTH.
export const SCHEMA_KEYWORDS = new Set([
  "type", "description", "title", "properties", "required", "additionalProperties", "items",
  "enum", "const", "default", "examples", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "oneOf",
]);
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const MAX_DEPTH = 8, MAX_PATTERN = 200;

// Check that a schema only uses the subset, and that objects are closed
// (additionalProperties: false) and strings bounded (maxLength), so a
// capability can never be fed unbounded input.
export function checkSchema(schema, path = "inputSchema", depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(path + ": nested too deeply");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(path + ": must be an object");
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYWORDS.has(key)) throw new Error(path + ": keyword " + JSON.stringify(key) + " is not supported");
  if (schema.oneOf) {
    if (!Array.isArray(schema.oneOf) || !schema.oneOf.length || schema.oneOf.length > 8) throw new Error(path + ".oneOf: 1 to 8 schemas");
    schema.oneOf.forEach((s, i) => checkSchema(s, path + ".oneOf[" + i + "]", depth + 1));
    return;
  }
  if (schema.const === undefined && !schema.enum) {
    if (!TYPES.has(schema.type)) throw new Error(path + ".type: one of " + [...TYPES].join(", "));
  }
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 64)) throw new Error(path + ".enum: 1 to 64 values");
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) throw new Error(path + ": objects must set additionalProperties: false");
    const props = schema.properties ?? {};
    if (typeof props !== "object" || Object.keys(props).length > 64) throw new Error(path + ".properties: at most 64");
    for (const [k, s] of Object.entries(props)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new Error(path + ".properties: bad name " + JSON.stringify(k));
      checkSchema(s, path + ".properties." + k, depth + 1);
    }
    for (const r of schema.required ?? []) if (!Object.hasOwn(props, r)) throw new Error(path + ".required: " + r + " is not a property");
  }
  if (schema.type === "array") {
    if (!Number.isInteger(schema.maxItems) || schema.maxItems > 10000) throw new Error(path + ": arrays must set maxItems (at most 10000)");
    if (!schema.items) throw new Error(path + ": arrays must set items");
    checkSchema(schema.items, path + ".items", depth + 1);
  }
  if (schema.type === "string" && schema.enum === undefined && schema.const === undefined) {
    if (!Number.isInteger(schema.maxLength) || schema.maxLength > 20000) throw new Error(path + ": strings must set maxLength (at most 20000)");
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string" || schema.pattern.length > MAX_PATTERN) throw new Error(path + ".pattern: at most " + MAX_PATTERN + " characters");
    // Nested quantifiers like (a+)+ can take exponential time.
    if (/\([^)]*[+*][^)]*\)[+*{]/.test(schema.pattern)) throw new Error(path + ".pattern: nested quantifiers are not allowed");
    try { new RegExp(schema.pattern, "u"); } catch { throw new Error(path + ".pattern: not a valid regular expression"); }
  }
}

const typeOf = (v) => v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Validate and return a copy with defaults filled in. Throws with the path
// of the first problem.
export function validateValue(schema, value, path = "params", depth = 0) {
  if (depth > MAX_DEPTH + 1) throw new Error(path + ": nested too deeply");
  if (schema.oneOf) {
    const errors = [];
    for (const s of schema.oneOf) { try { return validateValue(s, value, path, depth + 1); } catch (e) { errors.push(e.message); } }
    throw new Error(path + ": matches none of the allowed forms (" + errors[0] + ")");
  }
  if (schema.const !== undefined && !same(value, schema.const)) throw new Error(path + ": must be " + JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.some((e) => same(e, value))) throw new Error(path + ": must be one of " + schema.enum.map((e) => JSON.stringify(e)).join(", "));
  const t = typeOf(value);
  if (schema.type && !(schema.type === t || (schema.type === "number" && t === "integer"))) throw new Error(path + ": expected " + schema.type + ", got " + t);
  if (t === "number" || t === "integer") {
    if (!Number.isFinite(value)) throw new Error(path + ": must be finite");
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(path + ": must be >= " + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(path + ": must be <= " + schema.maximum);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) throw new Error(path + ": must be > " + schema.exclusiveMinimum);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) throw new Error(path + ": must be < " + schema.exclusiveMaximum);
  }
  if (t === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(path + ": at least " + schema.minLength + (schema.minLength === 1 ? " character" : " characters"));
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(path + ": at most " + schema.maxLength + (schema.maxLength === 1 ? " character" : " characters"));
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) throw new Error(path + ": does not match " + schema.pattern);
  }
  if (t === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(path + ": at least " + schema.minItems + (schema.minItems === 1 ? " item" : " items"));
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(path + ": at most " + schema.maxItems + (schema.maxItems === 1 ? " item" : " items"));
    return schema.items ? value.map((v, i) => validateValue(schema.items, v, path + "[" + i + "]", depth + 1)) : [...value];
  }
  if (t === "object") {
    const props = schema.properties ?? {}, out = {};
    for (const k of Object.keys(value)) {
      if (!Object.hasOwn(props, k)) {
        if (schema.additionalProperties === false) throw new Error(path + ": unknown field " + JSON.stringify(k));
        continue;
      }
      out[k] = validateValue(props[k], value[k], path + "." + k, depth + 1);
    }
    for (const r of schema.required ?? []) if (!Object.hasOwn(out, r)) throw new Error(path + "." + r + ": required");
    for (const [k, s] of Object.entries(props)) if (!Object.hasOwn(out, k) && s.default !== undefined) out[k] = structuredClone(s.default);
    return out;
  }
  return value;
}
