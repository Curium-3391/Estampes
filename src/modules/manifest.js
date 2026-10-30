// estampes.module/1: what a module is, what it can do and what it needs.
// This is Estampes's own format, not an MCP standard. A manifest is
// untrusted input (it can come from a package): it is validated strictly,
// unknown fields are refused, and its texts are only ever shown as data.
import { z } from "zod";
import { checkSchema } from "./json-schema.js";
import { PERMISSION_NAMES } from "./permissions.js";
import { isVersion, parseRange, satisfies } from "./semver.js";

export const MODULE_SCHEMA = "estampes.module/1";
export const RUNTIME_KINDS = ["builtin", "declarative", "wasm", "http"];
export const CATEGORIES = ["math", "diagram", "analysis", "text", "astronomy", "electronics", "utility", "other"];
export const TARGETS = ["none", "canvas", "canvas-or-new"];

// Reverse-DNS style ids. They are names, not proof that the publisher owns
// that domain; trust comes from the package signature (see packages.js).
export const MODULE_ID = /^[a-z][a-z0-9-]{0,30}(\.[a-z0-9][a-z0-9-]{0,30}){2,5}$/;
export const CAPABILITY_ID = /^[a-z][a-z0-9_]{0,47}$/;

const Text = (max) => z.string().max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), "control characters are not allowed");
const I18n = (max) => z.record(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/), Text(max)).refine((o) => Object.keys(o).length <= 8, "at most 8 languages");
const Https = z.string().max(300).url().refine((u) => u.startsWith("https://"), "must be an https URL");
const Host = z.string().max(253).regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "a lower-case public host name such as api.example.org");

const Example = z.object({ description: Text(200), params: z.record(z.string(), z.unknown()) }).strict();
// http runtime only: a request description, never a URL or code. `path` is
// fixed; values from the input go in `query` and `body` as {"$param": name}.
const HttpRequest = z.object({
  method: z.enum(["GET", "POST"]).default("GET"),
  host: z.string().max(253).optional(),
  path: z.string().max(200).regex(/^\/[A-Za-z0-9._~\/-]*$/, "a fixed path of letters, digits and . _ ~ / -").refine((p) => !p.split("/").some((x) => x === "." || x === ".."), "a fixed path of letters, digits and . _ ~ / - without . or .. segments"),
  query: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string().max(200)).optional(),
  secretHeaders: z.record(z.string(), z.object({ secret: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/), prefix: z.string().max(40).optional() }).strict()).optional(),
  body: z.unknown().optional(),
}).strict();
const HttpResponse = z.object({
  // Scene operations; {"$response": "a.b.0.c"} reads the JSON reply, {"$param": name} the input.
  operations: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
  // Dotted path of the part of the reply to hand back as data (default: all of it).
  data: z.string().max(120).optional(),
}).strict();

const Capability = z.object({
  id: z.string().regex(CAPABILITY_ID),
  title: Text(60).optional(), titleI18n: I18n(60).optional(),
  description: Text(400),
  inputSchema: z.record(z.string(), z.unknown()),
  permissions: z.array(z.enum(PERMISSION_NAMES)).max(12).optional(),
  target: z.enum(TARGETS).default("canvas"),
  examples: z.array(Example).max(6).optional(),
  // Declarative runtime only: scene operations with {"$param": name}
  // placeholders, filled in from the validated input.
  operations: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
  request: HttpRequest.optional(),
  response: HttpResponse.optional(),
  // Returns a job at once; the work runs in the background (see jobs.js).
  async: z.boolean().optional(),
}).strict();

export const ManifestSchema = z.object({
  schema: z.literal(MODULE_SCHEMA),
  id: z.string().regex(MODULE_ID, "reverse-DNS id such as org.example.graph"),
  name: Text(60).refine((s) => s.trim().length > 0, "name is empty"), nameI18n: I18n(60).optional(),
  description: Text(400), descriptionI18n: I18n(400).optional(),
  version: z.string().refine(isVersion, "MAJOR.MINOR.PATCH"),
  publisher: z.object({ name: Text(80), url: Https.optional() }).strict(),
  license: Text(64),
  source: Https.optional(), homepage: Https.optional(),
  category: z.enum(CATEGORIES).default("other"),
  coreCompatibility: z.string().max(120),
  runtime: z.object({
    kind: z.enum(RUNTIME_KINDS),
    entry: z.string().max(120).regex(/^[A-Za-z0-9._/-]+$/),
    abi: z.string().max(40).optional(),
  }).strict(),
  permissions: z.array(z.enum(PERMISSION_NAMES)).max(12),
  limits: z.object({
    timeMs: z.number().int().min(50).max(30000).optional(),
    memoryMb: z.number().int().min(1).max(256).optional(),
    outputKb: z.number().int().min(1).max(1024).optional(),
    // Longest an async capability may run, in milliseconds (default 10 minutes).
    jobMs: z.number().int().min(1000).max(1800000).optional(),
  }).strict().optional(),
  network: z.object({
    allow: z.array(Host).min(1).max(8),
    dataFlow: Text(400),
  }).strict().optional(),
  secrets: z.array(z.object({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/), label: Text(60), description: Text(200).optional() }).strict()).max(4).optional(),
  dependencies: z.array(z.object({ id: z.string().regex(MODULE_ID), version: z.string().max(120) }).strict()).max(8).optional(),
  capabilities: z.array(Capability).min(1).max(32),
}).strict();

export class ManifestError extends Error {}

// Returns the parsed manifest or throws a ManifestError naming the field.
export function validateManifest(raw, { coreVersion } = {}) {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ManifestError("manifest" + (issue.path.length ? "." + issue.path.join(".") : "") + ": " + issue.message);
  }
  const m = parsed.data;
  try { parseRange(m.coreCompatibility); } catch (error) { throw new ManifestError("manifest.coreCompatibility: " + error.message); }
  for (const d of m.dependencies ?? []) { try { parseRange(d.version); } catch (error) { throw new ManifestError("manifest.dependencies." + d.id + ": " + error.message); } }
  if (coreVersion && !satisfies(coreVersion, m.coreCompatibility)) {
    throw new ManifestError("needs Estampes " + m.coreCompatibility + ", this server is " + coreVersion);
  }
  const ids = new Set();
  m.capabilities.forEach((c, i) => {
    const where = "manifest.capabilities[" + i + "] (" + c.id + ")";
    if (ids.has(c.id)) throw new ManifestError(where + ": duplicate id");
    ids.add(c.id);
    try { checkSchema(c.inputSchema, where + ".inputSchema"); } catch (error) { throw new ManifestError(error.message); }
    if (c.inputSchema.type !== "object") throw new ManifestError(where + ".inputSchema: must be an object schema");
    const extra = (c.permissions ?? []).filter((p) => !m.permissions.includes(p));
    if (extra.length) throw new ManifestError(where + ".permissions: " + extra.join(", ") + " not in the module's permissions");
    if (c.target !== "none" && !(c.permissions ?? m.permissions).includes("canvas.write")) {
      throw new ManifestError(where + ": a capability that targets a canvas needs canvas.write");
    }
    if (c.target === "canvas-or-new" && !(c.permissions ?? m.permissions).includes("workspace.write")) {
      throw new ManifestError(where + ": target canvas-or-new needs workspace.write");
    }
    if ((m.runtime.kind === "http") !== !!c.request) {
      throw new ManifestError(where + (c.request ? ": request is only for the http runtime" : ": the http runtime needs a request"));
    }
    if (c.response && !c.request) throw new ManifestError(where + ": response is only for the http runtime");
    if (c.request) {
      const hosts = m.network?.allow ?? [];
      if (!(c.permissions ?? m.permissions).includes("network.request.approved")) throw new ManifestError(where + ": a request needs network.request.approved");
      if (c.request.host ? !hosts.includes(c.request.host) : hosts.length !== 1) throw new ManifestError(where + ".request.host: name one of network.allow" + (hosts.length === 1 ? "" : " (there is more than one)"));
      for (const ref of Object.values(c.request.secretHeaders ?? {})) {
        if (!m.secrets?.some((x) => x.name === ref.secret)) throw new ManifestError(where + ".request.secretHeaders: secret " + ref.secret + " is not declared in manifest.secrets");
      }
      if (JSON.stringify(c.request).length > 16 * 1024) throw new ManifestError(where + ".request: larger than 16 KB");
    }
    if (c.response?.operations && JSON.stringify(c.response.operations).length > 64 * 1024) throw new ManifestError(where + ".response.operations: larger than 64 KB");
    if ((m.runtime.kind === "declarative") !== !!c.operations) {
      throw new ManifestError(where + (c.operations ? ": operations are only for the declarative runtime" : ": the declarative runtime needs operations"));
    }
    if (c.operations && JSON.stringify(c.operations).length > 64 * 1024) throw new ManifestError(where + ".operations: larger than 64 KB");
  });
  if (m.network && !m.permissions.includes("network.request.approved")) throw new ManifestError("manifest.network: needs the network.request.approved permission");
  if (m.permissions.includes("network.request.approved") && !m.network) throw new ManifestError("manifest.permissions: network.request.approved needs manifest.network (hosts and data flow)");
  if (m.secrets?.length && !m.permissions.includes("module.secrets")) throw new ManifestError("manifest.secrets: needs the module.secrets permission");
  return m;
}

// Display text in the user's language when the manifest has it.
export const localized = (m, field, lang = "zh-TW") => m[field + "I18n"]?.[lang] ?? m[field + "I18n"]?.[lang.split("-")[0]] ?? m[field];
