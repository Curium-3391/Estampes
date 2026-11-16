// Runtime for modules that talk to an external service (OCR, plate solving,
// a data API). The module is data: each capability describes one request
// (`request`) and how to turn the JSON reply into scene operations and data
// (`response`). It contains no code and gets no socket; the request goes out
// through egress.js, which holds all the network rules and the secrets.
import { fillTemplate, readPath } from "./declarative.js";

const MAX_DATA_BYTES = 128 * 1024;

// Turns the service's reply into what execute_module hands back. Shared by
// real calls and by self-tests with a mock reply, so both take one path.
// `missing` (self-tests only) collects $response paths the reply lacks.
export function mapResponse(manifest, cap, params, bodyBytes, missing) {
  let json;
  try { json = JSON.parse(Buffer.from(bodyBytes).toString("utf8")); } catch { throw new Error("the service did not answer with JSON"); }
  const data = cap.response?.data ? readPath(json, cap.response.data) : json;
  if (missing && cap.response?.data && data === undefined) missing.push(cap.response.data);
  if (data !== undefined && JSON.stringify(data).length > MAX_DATA_BYTES) throw new Error("the service's answer is too large to hand back");
  return {
    operations: cap.response?.operations ? fillTemplate(cap.response.operations, params, 0, json, missing) : [],
    data, summary: cap.title ?? cap.id, method: "external service " + (cap.request.host ?? manifest.network.allow[0]),
  };
}

// The canvas image is sent as stored (never re-encoded): JPEG, PNG or WebP.
function imageType(bytes) {
  const b = Buffer.from(bytes);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  throw new Error("the canvas image is not JPEG, PNG or WebP, so it cannot be sent");
}

export function createHttpRuntime({ egress }) {
  // A 1x1 PNG stands in for the canvas image in self-tests, so the request
  // (permissions, size, form fields) is checked without any real picture.
  const PLACEHOLDER_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const requestFor = async (cap, params, readImage) => {
    const r = cap.request;
    const out = {
      method: r.method, host: r.host, path: r.path,
      query: r.query ? fillTemplate(r.query, params) : undefined,
      headers: r.headers, secretHeaders: r.secretHeaders,
      body: r.body !== undefined ? fillTemplate(r.body, params) : undefined,
    };
    if (r.multipart) {
      const multipart = { fields: r.multipart.fields ? fillTemplate(r.multipart.fields, params) : {} };
      if (r.multipart.file) {
        const bytes = await readImage();
        const contentType = imageType(bytes);
        multipart.file = { field: r.multipart.file.field, filename: r.multipart.file.filename ?? "image." + contentType.split("/")[1], contentType, bytes };
      }
      out.multipart = multipart;
    }
    return out;
  };
  return {
    kind: "http",
    // Install self-test: check the request the example produces without
    // sending it. With the example's mockResponse, the reply is also run
    // through the response mapping, exactly as a real call would be.
    async selfTest(mod, capability, params, ctx = {}) {
      const cap = mod.manifest.capabilities.find((c) => c.id === capability);
      await egress.prepare({ manifest: mod.manifest, granted: ctx.permissions ?? mod.manifest.permissions, request: await requestFor(cap, params, async () => PLACEHOLDER_PNG), resolveSecrets: false });
      const mock = ctx.example?.mockResponse;
      if (!mock) return { untested: "response" };
      if (mock.status >= 300 && mock.status < 400) throw new Error("the host answered with a redirect (" + mock.status + "), which is not followed");
      if (mock.status >= 400) throw new Error("the host answered " + mock.status);
      const body = mock.json !== undefined ? JSON.stringify(mock.json) : mock.text ?? "";
      const missing = [];
      const out = mapResponse(mod.manifest, cap, params, Buffer.from(body, "utf8"), missing);
      if (missing.length) throw new Error("response mapping: " + [...new Set(missing)].map((p) => JSON.stringify(p)).join(", ") + " not found in the reply and no default given");
      return out;
    },
    async run(mod, capability, params, ctx = {}) {
      const { manifest } = mod;
      const cap = manifest.capabilities.find((c) => c.id === capability);
      const readImage = async () => {
        if (!ctx.readSource) throw new Error(manifest.id + " needs asset.read.selected and a canvas to send its image");
        const bytes = await ctx.readSource();
        if (!bytes?.length) throw new Error("this canvas has no image to send (a blank canvas)");
        return bytes;
      };
      const res = await egress.call({ manifest, granted: ctx.permissions ?? [], request: await requestFor(cap, params, readImage), limits: ctx.limits, capability });
      return mapResponse(manifest, cap, params, res.body);
    },
  };
}
