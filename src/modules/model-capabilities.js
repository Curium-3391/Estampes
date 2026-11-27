// #85 V1-3b: the two read capabilities the host provides for every module that declares `models[]`: `models.list` and `models.get`.
//
// They are the host's, not the module's: a module author writes no code for them, and they cannot be shadowed, because a capability id
// of a module never contains a dot (the manifest's id pattern) while these always do. They are found like any capability
// (search_capabilities, get_module_capabilities) and run through execute_module with every check an ordinary capability gets: the module
// must be enabled and hold `module.storage.write`. They read only the module's own instances and their output is bounded (a listing
// never carries values; one value is at most the type's maxBytes). Reading data of a disabled, removed or incompatible module is a
// separate path that does not depend on running the module (V1-4); these never loosen what a module may do.
import { createHash } from "node:crypto";
import { config } from "../config.js";
export const HOST_PERMISSIONS = ["module.storage.write"];
const LIST_MAX = 100;

// U3: the host also serves the files of a sandboxed-web view (`ui.get`), one bounded chunk per call. This is one transport for them: the widget asks
// through a small loader (public/sandboxed-view.js), so a faster path for large UIs can replace it without touching the renderer or the manifest.
export const UI_PERMISSIONS = ["ui.sandboxed-frame"];
// A chunk is sent twice (the text of the result and its structured content, base64 each), and the server replaces a result over `maxResultChars` with an error, so the
// raw size of a chunk follows that budget (default 145000 characters gives about 49 KB); with no budget (0) it is 192 KB.
export function uiChunkBytes(maxChars = config.maxResultChars) {
  if (!(maxChars > 0)) return 192 * 1024;
  return Math.max(1024, Math.floor(((maxChars - 6000) / 2) * 0.75 * 0.95));
}
const uiCapability = { id: "ui.get", host: "ui", title: "Read one file of a sandboxed view", description: "Read one chunk of a package file that a sandboxed-web view of this module shows (base64). Answered by the host from the verified package; used by the widget, not for the assistant to call.",
  target: "none", permissions: UI_PERMISSIONS, needs: UI_PERMISSIONS, inputSchema: { type: "object", properties: { path: { type: "string", maxLength: 120 }, offset: { type: "integer", minimum: 0 } }, required: ["path"], additionalProperties: false } };
const hasSandboxedView = (manifest) => (manifest.views ?? []).some((v) => v.renderer?.type === "sandboxed-web");

export function hostCapabilities(manifest) {
  const types = manifest.v2?.models;
  const ui = hasSandboxedView(manifest) ? [uiCapability] : [];
  if (!types || !Object.keys(types).length) return ui;
  const names = Object.keys(types);
  const model = { type: "string", enum: names, description: "A model type of this module: " + names.join(", ") };
  return [
    { id: "models.list", host: "models", title: "List stored instances", description: "List this module's stored model instances (id, type, revision, size, update time; no values). Read-only; answered by the host, not by the module.",
      target: "none", permissions: HOST_PERMISSIONS, needs: HOST_PERMISSIONS, inputSchema: { type: "object", properties: { model }, additionalProperties: false } },
    { id: "models.get", host: "models", title: "Read one stored instance", description: "Read one stored model instance of this module, with its value and revision. Quote the revision when changing it. Read-only; answered by the host, not by the module.",
      target: "none", permissions: HOST_PERMISSIONS, needs: HOST_PERMISSIONS, inputSchema: { type: "object", properties: { model, id: { type: "string", pattern: "^md:[0-9a-f]{12}$" } }, required: ["model", "id"], additionalProperties: false } },
    ...ui,
  ];
}

// The manifest's own capabilities and the host's, for discovery and for running.
export const allCapabilities = (manifest) => [...manifest.capabilities, ...hostCapabilities(manifest)];

export async function runHostCapability({ store, manifest, capability, input }) {
  const types = manifest.v2.models;
  if (capability === "models.list") {
    const rows = await store.list({ module: manifest.id, ...(input.model ? { model: input.model } : {}) });
    return { summary: rows.length + " instance" + (rows.length === 1 ? "" : "s"), data: { instances: rows.slice(0, LIST_MAX), total: rows.length, ...(rows.length > LIST_MAX ? { omitted: rows.length - LIST_MAX } : {}) } };
  }
  const one = await store.read({ module: manifest.id, type: types[input.model], id: input.id });
  return { summary: one.model + " " + one.id + " revision " + one.revision, data: { instance: one } };
}

// One chunk of one UI file of a sandboxed-web view, with the digest and size of the whole file so the widget can check what it assembled.
export function runUiCapability({ files, input }) {
  const f = files?.[input.path];
  if (!f) throw Object.assign(new Error("no UI file " + JSON.stringify(input.path) + " in this module's package"), { code: "not-found" });
  const bytes = Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8");
  const offset = input.offset ?? 0;
  if (offset > bytes.length) throw Object.assign(new Error("offset is past the end of the file"), { code: "input" });
  const chunk = bytes.subarray(offset, offset + uiChunkBytes());
  return { summary: input.path + " " + offset + "+" + chunk.length + " of " + bytes.length, data: { path: input.path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), offset, chunk: chunk.toString("base64"), done: offset + chunk.length >= bytes.length } };
}
