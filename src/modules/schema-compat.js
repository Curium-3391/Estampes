// #86 F1: can a value that fits schema `from` always be given to a place that wants schema `to`? Used to type-check an edge of a Flow
// (one capability's output field to another's input field) before anything runs. Both schemas are in the bounded subset of json-schema.js.
// The answer is conservative: `ok: false` means "not proven", never "known to fail", and it names where and why. No module is named here.
import { validateValue } from "./json-schema.js";

const NUMERIC = new Set(["integer", "number"]);
const fits = (to, value) => { try { validateValue(to, value, "value"); return true; } catch { return false; } };
const no = (path, reason) => ({ ok: false, path, reason });
const OK = { ok: true };

export function assignable(from, to, path = "value", depth = 0) {
  if (depth > 10) return no(path, "nested too deeply to compare");
  if (!from || !to || typeof from !== "object" || typeof to !== "object") return no(path, "a schema is missing");
  if (from.oneOf) { for (const [i, alt] of from.oneOf.entries()) { const r = assignable(alt, to, path + ".oneOf[" + i + "]", depth + 1); if (!r.ok) return r; } return OK; }
  if (to.oneOf) {
    const tried = to.oneOf.map((alt) => assignable(from, alt, path, depth + 1));
    return tried.find((r) => r.ok) ?? no(path, "it fits none of the " + to.oneOf.length + " accepted shapes");
  }
  // Literals on the source side: every value it can be must fit.
  if (from.const !== undefined) return fits(to, from.const) ? OK : no(path, "the constant " + JSON.stringify(from.const) + " is not accepted");
  if (from.enum) { const bad = from.enum.find((v) => !fits(to, v)); return bad === undefined ? OK : no(path, "the value " + JSON.stringify(bad) + " is not accepted"); }
  if (to.const !== undefined) return no(path, "the target accepts only " + JSON.stringify(to.const));
  if (to.enum) return no(path, "the target accepts only " + to.enum.length + " listed value(s) and the source is not limited to them");
  const t = from.type;
  if (t !== to.type && !(t === "integer" && to.type === "number")) return no(path, "the source is " + t + " but the target wants " + to.type);
  if (NUMERIC.has(t)) {
    for (const [lo, hi] of [["minimum", "maximum"]]) {
      if (to[lo] !== undefined && !(from[lo] !== undefined && from[lo] >= to[lo])) return no(path, "the source may be below " + to[lo]);
      if (to[hi] !== undefined && !(from[hi] !== undefined && from[hi] <= to[hi])) return no(path, "the source may be above " + to[hi]);
    }
    for (const k of ["exclusiveMinimum", "exclusiveMaximum"]) if (to[k] !== undefined && !(from[k] !== undefined && (k === "exclusiveMinimum" ? from[k] >= to[k] : from[k] <= to[k]))) return no(path, "the source is not proven within " + k + " " + to[k]);
    return OK;
  }
  if (t === "string") {
    if (to.maxLength !== undefined && !(from.maxLength !== undefined && from.maxLength <= to.maxLength)) return no(path, "the source may be longer than " + to.maxLength);
    if (to.minLength !== undefined && !((from.minLength ?? 0) >= to.minLength)) return no(path, "the source may be shorter than " + to.minLength);
    if (to.pattern !== undefined && from.pattern !== to.pattern) return no(path, "the target requires the pattern " + to.pattern);
    return OK;
  }
  if (t === "array") {
    if (to.maxItems !== undefined && !(from.maxItems !== undefined && from.maxItems <= to.maxItems)) return no(path, "the source may hold more than " + to.maxItems + " items");
    if (to.minItems !== undefined && !((from.minItems ?? 0) >= to.minItems)) return no(path, "the source may hold fewer than " + to.minItems + " items");
    return assignable(from.items, to.items, path + "[]", depth + 1);
  }
  if (t === "object") {
    const fp = from.properties ?? {}, tp = to.properties ?? {};
    for (const k of Object.keys(fp)) if (!Object.hasOwn(tp, k)) return no(path + "." + k, "the target does not accept this field");
    for (const k of to.required ?? []) if (!(from.required ?? []).includes(k)) return no(path + "." + k, "the target needs this field and the source may leave it out");
    for (const [k, s] of Object.entries(fp)) { const r = assignable(s, tp[k], path + "." + k, depth + 1); if (!r.ok) return r; }
    return OK;
  }
  return OK; // boolean, null: equal types are enough
}

// The fields a capability offers downstream (its outputSchema's properties) and wants upstream (its inputSchema's properties).
export const outputPorts = (outputSchema) => Object.entries(outputSchema?.properties ?? {}).map(([name, schema]) => ({ name, schema, required: (outputSchema.required ?? []).includes(name) }));
export const inputPorts = (inputSchema) => Object.entries(inputSchema?.properties ?? {}).map(([name, schema]) => ({ name, schema, required: (inputSchema.required ?? []).includes(name) }));
