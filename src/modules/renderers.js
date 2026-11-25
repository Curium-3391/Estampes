// #85 V1: which renderers a module view may name. A view's contract (what it reads, which actions it may
// request) does not depend on how it is drawn; `renderer: { type, schema, payload }` only picks the drawing.
// The core checks the envelope and the size; the payload is checked by the validator registered for its type.
// Only `declarative` is built in (its payload is checked by declarative-view.js; {} is still allowed, so a manifest written
// before the tree existed stays valid). A type nobody registered is refused (fail closed); adding one later is an additive
// change gated by `coreCompatibility`.
import { validateDeclarative } from "./declarative-view.js";
export const MAX_PAYLOAD_BYTES = 64 * 1024;

const renderers = new Map();
renderers.set("declarative", {
  schema: "estampes.renderer.declarative/1",
  validate: validateDeclarative,
});

// For tests and, later, hosts that add a renderer. Returns a function that removes it again.
export function registerRenderer(type, { schema, validate }) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(type) || renderers.has(type)) throw new Error("renderer type " + type + " is invalid or already registered");
  renderers.set(type, { schema, validate });
  return () => { renderers.delete(type); };
}
export const rendererTypes = () => [...renderers.keys()];

// Throws an Error whose message names what is wrong; the manifest check prefixes the path.
// ctx: what the payload may refer to ({ view, models, actions }); see declarative-view.js.
export function checkRenderer(renderer, ctx) {
  const r = renderers.get(renderer.type);
  if (!r) throw new Error("renderer type " + JSON.stringify(renderer.type) + " is not supported by this server (supported: " + rendererTypes().join(", ") + ")");
  if (renderer.schema !== r.schema) throw new Error("renderer.schema must be " + r.schema + " for type " + renderer.type);
  if (Buffer.byteLength(JSON.stringify(renderer.payload)) > MAX_PAYLOAD_BYTES) throw new Error("renderer.payload is larger than " + MAX_PAYLOAD_BYTES / 1024 + " KB");
  r.validate(renderer.payload, ctx);
}
