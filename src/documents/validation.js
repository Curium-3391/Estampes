// Pure validation support. No stores, clocks, filesystem or runtime grants.
import { createHash } from "node:crypto";
import { types } from "node:util";
import { z } from "zod";

export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const RevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const TimestampSchema = z.iso.datetime({ offset: false });
export const FiniteSchema = z.number().finite();

export class DocumentValidationError extends Error {
  constructor(code, message, path = []) {
    super(message);
    this.name = "DocumentValidationError";
    this.code = code;
    this.path = [...path];
  }
}

// Inspect descriptors before values: accessors, cycles and exotic prototypes
// must not execute user code or overflow a recursive Zod parser.
export function assertJson(value, { maxBytes = MAX_DOCUMENT_BYTES, maxDepth = 32, maxNodes = 4_000_000 } = {}) {
  const active = new WeakSet();
  let bytes = 0, nodes = 0;
  const add = (n, path) => {
    bytes += n;
    if (bytes > maxBytes) throw new DocumentValidationError("LIMIT", "JSON byte limit exceeded", path);
  };
  const addString = (value, path) => {
    add(2, path);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code === 34 || code === 92 || [8,9,10,12,13].includes(code)) add(2, path);
      else if (code < 32) add(6, path);
      else if (code < 128) add(1, path);
      else if (code < 2048) add(2, path);
      else if (code >= 0xD800 && code <= 0xDBFF && value.charCodeAt(i+1) >= 0xDC00 && value.charCodeAt(i+1) <= 0xDFFF) { add(4, path); i++; }
      else if (code >= 0xD800 && code <= 0xDFFF) add(6, path);
      else add(3, path);
    }
  };
  const visit = (v, depth, path) => {
    if (++nodes > maxNodes || depth > maxDepth) throw new DocumentValidationError("LIMIT", "JSON structure limit exceeded", path);
    if (v === null || typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) {
      if (typeof v === "string") addString(v, path); else add(Buffer.byteLength(JSON.stringify(v)), path);
      return;
    }
    if (typeof v !== "object") throw new DocumentValidationError("INVALID_INPUT", "Expected finite JSON data", path);
    if (types.isProxy(v)) throw new DocumentValidationError("INVALID_INPUT", "Proxy input is not JSON", path);
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if ((!array && proto !== Object.prototype && proto !== null) || (array && proto !== Array.prototype)) {
      throw new DocumentValidationError("INVALID_INPUT", "Expected a plain JSON object or array", path);
    }
    if (active.has(v)) throw new DocumentValidationError("INVALID_INPUT", "Cyclic JSON input", path);
    active.add(v);
    const keys = Reflect.ownKeys(v).filter(k => !(array && k === "length"));
    if (array && keys.length !== v.length) throw new DocumentValidationError("INVALID_INPUT", "Sparse or decorated array", path);
    add(2 + Math.max(0, keys.length - 1), path);
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (typeof key !== "string" || !d.enumerable || !Object.hasOwn(d, "value") || (array && !/^(0|[1-9][0-9]*)$/.test(key))) {
        throw new DocumentValidationError("INVALID_INPUT", "Non-JSON property or accessor", path);
      }
      if (!array) { addString(key, path); add(1, path); }
      visit(d.value, depth + 1, [...path, array ? Number(key) : key]);
    }
    active.delete(v);
  };
  visit(value, 0, []);
  return value;
}

function jsonGuardSchema(limits) {
  return z.unknown().superRefine((v, ctx) => {
    try { assertJson(v, limits); }
    catch (e) { if (!(e instanceof DocumentValidationError)) throw e; issue(ctx, e.code, e.message, e.path); }
  });
}
export const jsonSchema = limits => jsonGuardSchema(limits).transform(value => JSON.parse(canonicalJson(value, limits)));
export const bounded = (schema, limits) => jsonGuardSchema(limits).pipe(schema);
export function issue(ctx, code, message, path = []) {
  ctx.addIssue({ code: "custom", message, path, params: { documentCode: code } });
}
export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  throw new DocumentValidationError(first.params?.documentCode ?? (first.path.at(-1) === "schema" && first.code === "invalid_value" ? "UNSUPPORTED_SCHEMA" : first.code === "too_big" ? "LIMIT" : "INVALID_INPUT"), first.message, first.path);
}

export function canonicalJson(value, limits) {
  assertJson(value, limits);
  const encode = v => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(encode).join(",") + "]";
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + encode(v[k])).join(",") + "}";
  };
  return encode(value);
}
export const hashJson = value => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const cloneJson = value => JSON.parse(canonicalJson(value));
