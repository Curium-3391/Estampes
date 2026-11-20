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

// estampes.module/2 (UVA Phase 5A, ADR-005): the same module concepts with a
// strict manifest of its own. A capability names the document it works on
// (`none`, `document` or `document-or-new`, never an image id) and the
// permissions it really `needs`; the module declares an integer ABI. v1
// manifests, their signatures and their image behaviour are not changed.
// 5A-1 only defines and checks the format; nothing runs a v2 module yet, so
// a v2 manifest is refused unless the caller asks for it (`v2: true`).
export const MODULE_SCHEMA_V2 = "estampes.module/2";
export const TARGETS_V2 = ["none", "document", "document-or-new"];
export const SUPPORTED_ABI = 1;
const V1_TARGET = { none: "none", document: "canvas", "document-or-new": "canvas-or-new" };

// Reverse-DNS style ids. They are names, not proof that the publisher owns
// that domain; trust comes from the package signature (see packages.js).
export const MODULE_ID = /^[a-z][a-z0-9-]{0,30}(\.[a-z0-9][a-z0-9-]{0,30}){2,5}$/;
export const CAPABILITY_ID = /^[a-z][a-z0-9_]{0,47}$/;

const Text = (max) => z.string().max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), "control characters are not allowed");
const I18n = (max) => z.record(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/), Text(max)).refine((o) => Object.keys(o).length <= 8, "at most 8 languages");
const Https = z.string().max(300).url().refine((u) => u.startsWith("https://"), "must be an https URL");
const Host = z.string().max(253).regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "a lower-case public host name such as api.example.org");

// An example call. Examples are the module's own regression suite: `module
// test` and every install run them. `mockResponse` (http runtime only) is the
// reply the service would give, so the response mapping is tested offline;
// `expect` states what the call must produce (or the error it must fail with).
const MockResponse = z.object({
  status: z.number().int().min(100).max(599).default(200),
  json: z.unknown().optional(),
  text: z.string().max(64 * 1024).optional(),
}).strict().refine((r) => !(r.json !== undefined && r.text !== undefined), "give json or text, not both");
const Expect = z.object({
  operations: z.number().int().min(0).max(64).optional(),
  data: z.unknown().optional(),
  summary: Text(200).optional(),
  error: Text(200).optional(),
}).strict().refine((e) => !(e.error !== undefined && (e.operations !== undefined || e.data !== undefined || e.summary !== undefined)), "an example that expects an error cannot also expect a result");
const Example = z.object({ description: Text(200), params: z.record(z.string(), z.unknown()), mockResponse: MockResponse.optional(), expect: Expect.optional() }).strict();
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
  // A multipart/form-data body: text fields (templates) and, optionally, the
  // target canvas's original image as a file part (needs asset.read.selected).
  multipart: z.object({
    fields: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/), z.unknown()).optional(),
    file: z.object({
      field: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/),
      source: z.literal("canvas-image"),
      filename: z.string().regex(/^[A-Za-z0-9_. -]{1,80}$/).optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict().refine((r) => !(r.body !== undefined && r.multipart), "a request has one body: body or multipart").refine((r) => !((r.body !== undefined || r.multipart) && r.method === "GET"), "only POST may carry a body");
const HttpResponse = z.object({
  // Scene operations; {"$response": "a.b.0.c"} reads the JSON reply, {"$param": name} the input.
  operations: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
  // Dotted path of the part of the reply to hand back as data (default: all of it).
  data: z.string().max(120).optional(),
}).strict();

// What a model (and the person approving the module) needs to decide whether
// to use a capability, beyond its input schema. Every field is plain text a
// reader can act on; `cost.latency` and `dataFlow.leavesServer` are checked
// against what the capability really does.
export const LATENCIES = ["instant", "seconds", "minutes", "hours"];
const Profile = z.object({
  whenToUse: Text(300),
  whenNotToUse: Text(300).optional(),
  inputLimits: Text(300).optional(),
  cost: z.object({ latency: z.enum(LATENCIES), resource: Text(200).optional(), billable: z.boolean().optional() }).strict().optional(),
  dataFlow: z.object({ leavesServer: z.boolean(), sends: Text(300) }).strict().optional(),
  reliability: z.object({ kind: z.enum(["exact", "estimate", "heuristic", "external"]), note: Text(300), verify: Text(300).optional() }).strict().optional(),
  fallbacks: z.array(z.object({ when: Text(160), then: Text(300) }).strict()).max(6).optional(),
}).strict();

const Capability = z.object({
  id: z.string().regex(CAPABILITY_ID),
  title: Text(60).optional(), titleI18n: I18n(60).optional(),
  description: Text(400),
  // Search words for search_capabilities (issue #244): plain words, not instructions; they only affect ranking.
  keywords: z.array(Text(30).refine((k) => k.trim().length > 0, "a keyword cannot be empty")).max(12).optional(),
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
  profile: Profile.optional(), profileI18n: z.record(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/), Profile).refine((o) => Object.keys(o).length <= 8, "at most 8 languages").optional(),
}).strict();

// estampes.panel/1: a panel a module offers inside the Visual Surface. It is
// data only; `kind` names a renderer that ships with Estampes (the host
// draws every panel itself), so a manifest can never bring HTML, scripts or
// CSS. An unknown kind is accepted and shown as an inert placeholder.
export const PANEL_SCHEMA = "estampes.panel/1";
export const PANEL_KINDS = ["canvas", "graph", "calculator", "property-inspector", "data-table", "log", "form"];
const Size = z.object({ width: z.number().int().min(120).max(2000), height: z.number().int().min(120).max(2000) }).strict();
const Panel = z.object({
  schema: z.literal(PANEL_SCHEMA),
  id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  title: Text(60), titleI18n: I18n(60).optional(),
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  uiSchemaVersion: z.literal(1),
  defaultBinding: z.enum(["surface.canvas", "surface.casNotebook", "none"]).default("none"),
  preferredSize: Size.optional(), minSize: Size.optional(),
  maxInstances: z.number().int().min(1).max(8).default(1),
  resizable: z.boolean().default(true), dockable: z.boolean().default(true),
  // Capabilities this panel may trigger; each call is still checked against
  // the module's grants, so opening a panel never grants anything.
  capabilityBindings: z.array(z.string().regex(CAPABILITY_ID)).max(32).default([]),
  permissions: z.array(z.enum(PERMISSION_NAMES)).max(12).default([]),
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
  panels: z.array(Panel).max(8).optional(),
}).strict();

// v2 differs from v1 in four fields: the schema string, `runtime.abi` (a
// required integer), and per capability a document `target` and an explicit
// `needs` (v1's optional `permissions` subset).
const CapabilityV2 = Capability.omit({ permissions: true, target: true }).extend({
  target: z.enum(TARGETS_V2),
  needs: z.array(z.enum(PERMISSION_NAMES)).max(12),
});
export const ManifestSchemaV2 = ManifestSchema.omit({ schema: true, runtime: true, capabilities: true }).extend({
  schema: z.literal(MODULE_SCHEMA_V2),
  runtime: z.object({
    kind: z.enum(RUNTIME_KINDS),
    entry: z.string().max(120).regex(/^[A-Za-z0-9._/-]+$/),
    abi: z.number().int().min(1).max(1000),
  }).strict(),
  capabilities: z.array(CapabilityV2).min(1).max(32),
});

// The v1-shaped view the shared checks run on: the same permissions, the
// same capabilities, with the document target mapped to its canvas meaning.
const v1View = (m) => ({
  ...m, schema: MODULE_SCHEMA, runtime: { kind: m.runtime.kind, entry: m.runtime.entry },
  capabilities: m.capabilities.map(({ needs, target, ...c }) => ({ ...c, permissions: needs, target: V1_TARGET[target] })),
});

// The manifest the rest of the server works with. A v1 manifest is used as it
// is. A v2 manifest becomes the v1-shaped view (a capability's `permissions`
// are what it `needs`, its target is the canvas meaning of the document
// target) plus `v2: { abi, targets }`, which keeps what the view cannot say.
// The package bytes, digest and signature stay those of the original.
export function runtimeManifest(m) {
  if (m.schema !== MODULE_SCHEMA_V2) return m;
  return { ...v1View(m), schema: MODULE_SCHEMA_V2, v2: { abi: m.runtime.abi, targets: Object.fromEntries(m.capabilities.map((c) => [c.id, c.target])) } };
}

// What changed between two ABI versions of a module, for the Store.
export function abiChange(was, now) {
  if (was === undefined || was === null) return { from: null, to: now ?? null, kind: now === undefined ? "none" : "new" };
  if (now === undefined || now === null) return { from: was, to: null, kind: "removed" };
  if (was === now) return { from: was, to: now, kind: "same" };
  return { from: was, to: now, kind: now > was ? "upgrade" : "downgrade" };
}

export class ManifestError extends Error {}

// Returns the parsed manifest or throws a ManifestError naming the field.
export function validateManifest(raw, { coreVersion, v2 = false } = {}) {
  const isV2 = raw?.schema === MODULE_SCHEMA_V2;
  if (isV2 && !v2) throw new ManifestError("manifest.schema: " + MODULE_SCHEMA_V2 + " is not enabled on this server yet; use " + MODULE_SCHEMA);
  const parsed = (isV2 ? ManifestSchemaV2 : ManifestSchema).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ManifestError("manifest" + (issue.path.length ? "." + issue.path.join(".") : "") + ": " + issue.message);
  }
  const original = parsed.data;
  if (isV2) {
    if (original.runtime.abi > SUPPORTED_ABI) throw new ManifestError("manifest.runtime.abi: ABI " + original.runtime.abi + " is newer than this server supports (" + SUPPORTED_ABI + ")");
    if (original.runtime.kind === "wasm") throw new ManifestError("manifest.runtime.kind: the wasm runtime is not available for " + MODULE_SCHEMA_V2 + " yet");
    if (original.runtime.kind === "builtin") throw new ManifestError("manifest.runtime.kind: built-in modules use " + MODULE_SCHEMA);
  }
  const m = isV2 ? v1View(original) : original;
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
    const caps = c.permissions ?? m.permissions;
    const usesNetwork = caps.includes("network.request.approved");
    if (c.profile?.dataFlow?.leavesServer && !usesNetwork) throw new ManifestError(where + ".profile.dataFlow: says data leaves the server, but the capability has no network.request.approved permission");
    if (usesNetwork && !c.profile?.dataFlow?.leavesServer) throw new ManifestError(where + ".profile.dataFlow: a capability that uses the network must say what it sends (leavesServer true and sends)");
    if (c.async && c.profile && (!c.profile.cost || c.profile.cost.latency === "instant")) throw new ManifestError(where + ".profile.cost: a background job cannot be instant");
    if (c.profileI18n) for (const [lang, p] of Object.entries(c.profileI18n)) {
      if (!!p.dataFlow?.leavesServer !== !!c.profile?.dataFlow?.leavesServer || p.cost?.latency !== c.profile?.cost?.latency) throw new ManifestError(where + ".profileI18n." + lang + ": cost and data flow must match profile (only the text may differ)");
    }
    if ((m.runtime.kind === "http") !== !!c.request) {
      throw new ManifestError(where + (c.request ? ": request is only for the http runtime" : ": the http runtime needs a request"));
    }
    if (c.response && !c.request) throw new ManifestError(where + ": response is only for the http runtime");
    (c.examples ?? []).forEach((ex, j) => {
      if (ex.mockResponse && !c.request) throw new ManifestError(where + ".examples[" + j + "].mockResponse: only for the http runtime");
      if (c.request && !ex.mockResponse && ex.expect && ex.expect.error === undefined) throw new ManifestError(where + ".examples[" + j + "].expect: an http example can only check a result against a mockResponse");
      if (JSON.stringify(ex).length > 64 * 1024) throw new ManifestError(where + ".examples[" + j + "]: larger than 64 KB");
    });
    if (c.request) {
      const hosts = m.network?.allow ?? [];
      if (!(c.permissions ?? m.permissions).includes("network.request.approved")) throw new ManifestError(where + ": a request needs network.request.approved");
      if (c.request.host ? !hosts.includes(c.request.host) : hosts.length !== 1) throw new ManifestError(where + ".request.host: name one of network.allow" + (hosts.length === 1 ? "" : " (there is more than one)"));
      for (const ref of Object.values(c.request.secretHeaders ?? {})) {
        if (!m.secrets?.some((x) => x.name === ref.secret)) throw new ManifestError(where + ".request.secretHeaders: secret " + ref.secret + " is not declared in manifest.secrets");
      }
      if (c.request.multipart?.file) {
        if (!(c.permissions ?? m.permissions).includes("asset.read.selected")) throw new ManifestError(where + ".request.multipart.file: sending the canvas image needs asset.read.selected");
        if (c.target === "none") throw new ManifestError(where + ".request.multipart.file: sending the canvas image needs a target canvas");
      }
      if (JSON.stringify(c.request).length > 16 * 1024) throw new ManifestError(where + ".request: larger than 16 KB");
    }
    if (c.response?.operations && JSON.stringify(c.response.operations).length > 64 * 1024) throw new ManifestError(where + ".response.operations: larger than 64 KB");
    if ((m.runtime.kind === "declarative") !== !!c.operations) {
      throw new ManifestError(where + (c.operations ? ": operations are only for the declarative runtime" : ": the declarative runtime needs operations"));
    }
    if (c.operations && JSON.stringify(c.operations).length > 64 * 1024) throw new ManifestError(where + ".operations: larger than 64 KB");
  });
  const panelIds = new Set();
  (m.panels ?? []).forEach((pn, i) => {
    const where = "manifest.panels[" + i + "] (" + pn.id + ")";
    if (panelIds.has(pn.id)) throw new ManifestError(where + ": duplicate id");
    panelIds.add(pn.id);
    for (const b of pn.capabilityBindings) if (!ids.has(b)) throw new ManifestError(where + ".capabilityBindings: no capability " + b);
    const extra = pn.permissions.filter((x) => !m.permissions.includes(x));
    if (extra.length) throw new ManifestError(where + ".permissions: " + extra.join(", ") + " not in the module's permissions");
  });
  if (m.network && !m.permissions.includes("network.request.approved")) throw new ManifestError("manifest.network: needs the network.request.approved permission");
  if (m.permissions.includes("network.request.approved") && !m.network) throw new ManifestError("manifest.permissions: network.request.approved needs manifest.network (hosts and data flow)");
  if (m.secrets?.length && !m.permissions.includes("module.secrets")) throw new ManifestError("manifest.secrets: needs the module.secrets permission");
  return original;
}

// Display text in the user's language when the manifest has it.
export const localized = (m, field, lang = "zh-TW") => m[field + "I18n"]?.[lang] ?? m[field + "I18n"]?.[lang.split("-")[0]] ?? m[field];
