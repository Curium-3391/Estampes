// Client for the local CAS service (cas-service/): a Unix-domain socket,
// 4-byte length + JSON frames. The socket is a private channel shared with
// the CAS container through one narrow volume; it is never a web endpoint
// and never goes through the outbound egress guard.
import net from "node:net";
import { randomBytes } from "node:crypto";

export class CasClientError extends Error {
  constructor(message, code = "worker_unavailable") { super(message); this.code = code; }
}

const MAX_FRAME = 4 * 1024 * 1024;

export function createCasClient({ socketPath, timeoutMs = 10000 } = {}) {
  if (!socketPath) return null;
  function request(method, params = {}, { id = randomBytes(8).toString("hex"), timeout = timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const chunks = [];
      let got = 0, settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); fn(v); };
      const timer = setTimeout(() => done(reject, new CasClientError("the calculator did not answer in time", "timeout")), timeout);
      socket.on("error", (e) => done(reject, new CasClientError("the calculator service is not reachable (" + (e.code || e.message) + ")")));
      socket.on("close", () => done(reject, new CasClientError("the calculator service closed the connection")));
      socket.on("connect", () => {
        const body = Buffer.from(JSON.stringify({ v: 1, id, method, params }));
        const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
        socket.write(Buffer.concat([head, body]));
      });
      socket.on("data", (d) => {
        chunks.push(d); got += d.length;
        if (got > MAX_FRAME) return done(reject, new CasClientError("the calculator reply is too large", "resource_limit"));
        const buf = Buffer.concat(chunks);
        if (buf.length < 4) return;
        const n = buf.readUInt32BE(0);
        if (n > MAX_FRAME) return done(reject, new CasClientError("the calculator reply is too large", "resource_limit"));
        if (buf.length < 4 + n) return;
        let msg;
        try { msg = JSON.parse(buf.subarray(4, 4 + n).toString("utf8")); } catch { return done(reject, new CasClientError("bad reply from the calculator", "internal")); }
        if (msg.ok) done(resolve, msg.result);
        else done(reject, new CasClientError(msg.error?.message ?? "calculator error", msg.error?.code ?? "internal"));
      });
    });
  }
  return {
    socketPath,
    compute: (params, opts = {}) => request("compute", params, { ...opts, timeout: (params.timeoutMs ?? 8000) + 4000 }),
    parse: (params) => request("parse", params, { timeout: 4000 }),
    cancel: (target) => request("cancel", { target }, { timeout: 3000 }),
    health: () => request("health", {}, { timeout: 2000 }),
  };
}
