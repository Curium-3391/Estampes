// Runtime for modules that talk to an external service (OCR, plate solving,
// a data API). The module is data: each capability describes one request
// (`request`) and how to turn the JSON reply into scene operations and data
// (`response`). It contains no code and gets no socket; the request goes out
// through egress.js, which holds all the network rules and the secrets.
import { fillTemplate, readPath } from "./declarative.js";

const MAX_DATA_BYTES = 128 * 1024;

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
    // Install self-test: check the request the examples produce without sending it.
    async selfTest(mod, capability, params, ctx = {}) {
      const cap = mod.manifest.capabilities.find((c) => c.id === capability);
      await egress.prepare({ manifest: mod.manifest, granted: ctx.permissions ?? mod.manifest.permissions, request: requestFor(cap, params), resolveSecrets: false });
      return {};
    },
    async run(mod, capability, params, ctx = {}) {
      const { manifest } = mod;
      const cap = manifest.capabilities.find((c) => c.id === capability);
      const res = await egress.call({ manifest, granted: ctx.permissions ?? [], request: requestFor(cap, params), limits: ctx.limits, capability });
      let json;
      try { json = JSON.parse(res.body.toString("utf8")); } catch { throw new Error("the service did not answer with JSON"); }
      const data = cap.response?.data ? readPath(json, cap.response.data) : json;
      if (data !== undefined && JSON.stringify(data).length > MAX_DATA_BYTES) throw new Error("the service's answer is too large to hand back");
      return {
        operations: cap.response?.operations ? fillTemplate(cap.response.operations, params, 0, json) : [],
        data, summary: cap.title ?? capability, method: "external service " + (cap.request.host ?? manifest.network.allow[0]),
      };
    },
  };
}
