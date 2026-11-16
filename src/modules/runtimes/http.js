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

export function createHttpRuntime({ egress }) {
  const requestFor = (cap, params) => {
    const r = cap.request;
    return {
      method: r.method, host: r.host, path: r.path,
      query: r.query ? fillTemplate(r.query, params) : undefined,
      headers: r.headers, secretHeaders: r.secretHeaders,
      body: r.body !== undefined ? fillTemplate(r.body, params) : undefined,
    };
  };
  return {
    kind: "http",
    // Install self-test: check the request the example produces without
    // sending it. With the example's mockResponse, the reply is also run
    // through the response mapping, exactly as a real call would be.
    async selfTest(mod, capability, params, ctx = {}) {
      const cap = mod.manifest.capabilities.find((c) => c.id === capability);
      await egress.prepare({ manifest: mod.manifest, granted: ctx.permissions ?? mod.manifest.permissions, request: requestFor(cap, params), resolveSecrets: false });
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
      const res = await egress.call({ manifest, granted: ctx.permissions ?? [], request: requestFor(cap, params), limits: ctx.limits, capability });
      return mapResponse(manifest, cap, params, res.body);
    },
  };
}
