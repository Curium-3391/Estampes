// The only way a module's request leaves the server. A module never gets a
// socket, a URL fetcher or its secrets; it describes a request and this file
// decides whether it may be sent:
//
//   - the module must hold network.request.approved, and the host must be
//     one of the hosts in its manifest `network.allow` (exact name, https
//     only, port 443, a fixed path of safe characters);
//   - the name is resolved here and every address must be public: loopback,
//     private, link-local (cloud metadata), carrier-grade NAT, multicast and
//     reserved ranges are refused, and the connection is pinned to the
//     address that was checked, so DNS cannot change it afterwards;
//   - no redirects, no cookies, a fixed set of request headers, a time
//     limit and a response size limit;
//   - secrets (API keys) are added here from the administrator's store when
//     the module holds module.secrets and declared the secret name;
//   - every request is audited (host, status, sizes), never its content.
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { chmod, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export class EgressError extends Error {
  constructor(message, code = "network") { super(message); this.code = code; }
}

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2002::", 16], ["2001::", 32]]) blocked.addSubnet(net, bits, "ipv6");

export function isPublicAddress(address) {
  const family = isIP(address);
  if (!family) return false;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:/i.test(address)) return false;
  }
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

// dns lookup used for the connection itself: resolves, checks every address
// and hands back the first one, so the checked address is the one used.
export function safeLookup(hostname, options, callback) {
  dnsLookup(hostname, { all: true, family: options?.family ?? 0 }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses?.length) return callback(new EgressError("the host did not resolve"));
    const bad = addresses.find((a) => !isPublicAddress(a.address));
    if (bad) return callback(new EgressError("the host resolves to a non-public address (" + bad.address + "); refused"));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

const PATH = /^\/[A-Za-z0-9._~\/-]{0,200}$/;
const METHODS = new Set(["GET", "POST"]);
const SAFE_HEADERS = new Map([["accept", "Accept"], ["content-type", "Content-Type"]]);
const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_TIME_MS = 10000, DEFAULT_RESPONSE_KB = 256;

// The default transport. Tests replace it; it is the only code that opens a socket.
export function httpsTransport({ host, path, method, headers, body, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const req = httpsRequest({ host, port: 443, path, method, headers, lookup: safeLookup, servername: host, agent: false, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); done(reject, new EgressError("the response is larger than " + Math.round(maxBytes / 1024) + " KB; refused", "limit")); return; }
        chunks.push(c);
      });
      res.on("end", () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", (e) => done(reject, e));
    });
    const timer = setTimeout(() => { req.destroy(); done(reject, new EgressError("the request took longer than " + timeoutMs + " ms", "timeout")); }, timeoutMs);
    req.on("error", (e) => done(reject, e instanceof EgressError ? e : new EgressError("the request failed: " + (e?.message ?? e))));
    if (body) req.write(body);
    req.end();
  });
}

// ---- Secrets ---------------------------------------------------------------
// <storage>/modules/secrets.json: { "<moduleId>": { "<name>": "value" } }, mode 600,
// or an environment variable named by envName() below. Modules never read these; only this file does.
// Collision-free: ids only contain a-z 0-9 . -, so "_" never appears in them and
// can start an escape ("." -> _D, "-" -> _M); "_S" separates the id from the name.
// org.estampes.astrometry + api_key -> ESTAMPES_MODULE_SECRET_ORG_DESTAMPES_DASTROMETRY_SAPI_KEY
export const envName = (moduleId, name) =>
  "ESTAMPES_MODULE_SECRET_" + moduleId.replace(/\./g, "_D").replace(/-/g, "_M").toUpperCase() + "_S" + name.toUpperCase();

export function createSecrets({ dir = "", env = process.env } = {}) {
  const file = dir ? join(dir, "secrets.json") : "";
  const read = async () => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return {}; } };
  return {
    async get(moduleId, name) {
      const fromEnv = env[envName(moduleId, name)];
      if (fromEnv) return fromEnv;
      return file ? (await read())[moduleId]?.[name] ?? null : null;
    },
    async has(moduleId, name) { return !!(await this.get(moduleId, name)); },
    async set(moduleId, name, value) {
      if (!file) throw new Error("no storage folder for secrets");
      const all = await read();
      all[moduleId] = { ...all[moduleId], [name]: value };
      await mkdir(dir, { recursive: true });
      const tmp = file + "." + process.pid + ".tmp";
      await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, file);
    },
    envName,
  };
}

export function createEgress({ audit = null, secrets = createSecrets(), transport = httpsTransport } = {}) {
  // Checks and builds the request without sending it (used by install self-tests).
  async function prepare({ manifest, granted, request, resolveSecrets = true }) {
    const id = manifest.id;
    if (!granted.includes("network.request.approved")) throw new EgressError(id + " has not been given permission to use the network");
    const allow = manifest.network?.allow ?? [];
    const host = request.host ?? (allow.length === 1 ? allow[0] : null);
    if (!host || !allow.includes(host)) throw new EgressError("host " + JSON.stringify(host) + " is not in the module's allowed hosts (" + allow.join(", ") + ")");
    const method = String(request.method ?? "GET").toUpperCase();
    if (!METHODS.has(method)) throw new EgressError("method " + method + " is not allowed (GET, POST)");
    if (typeof request.path !== "string" || !PATH.test(request.path) || request.path.split("/").includes("..")) throw new EgressError("the request path is not allowed");
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(request.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(k) || typeof v === "object") throw new EgressError("query parameter " + JSON.stringify(k) + " is not allowed");
      query.set(k, String(v));
    }
    const headers = { "user-agent": "Estampes-module/1", accept: "application/json" };
    for (const [k, v] of Object.entries(request.headers ?? {})) {
      const name = SAFE_HEADERS.get(String(k).toLowerCase());
      if (!name || typeof v !== "string" || /[\r\n]/.test(v) || v.length > 200) throw new EgressError("header " + JSON.stringify(k) + " is not allowed");
      headers[name.toLowerCase()] = v;
    }
    const secretNames = [];
    for (const [headerName, ref] of Object.entries(request.secretHeaders ?? {})) {
      if (!/^[A-Za-z][A-Za-z0-9-]{0,40}$/.test(headerName) || SAFE_HEADERS.has(headerName.toLowerCase()) || /^(host|content-length|connection|transfer-encoding|cookie|user-agent)$/i.test(headerName)) throw new EgressError("secret header " + JSON.stringify(headerName) + " is not allowed");
      if (!granted.includes("module.secrets")) throw new EgressError(id + " has not been given permission to use secrets");
      if (!(manifest.secrets ?? []).some((s) => s.name === ref.secret)) throw new EgressError("secret " + JSON.stringify(ref.secret) + " is not declared in the manifest");
      secretNames.push(ref.secret);
      if (resolveSecrets) {
        const value = await secrets.get(id, ref.secret);
        if (!value) throw new EgressError("The administrator has not set the secret " + ref.secret + " for " + id + " (node scripts/estampes-module.js secret set " + id + " " + ref.secret + ")", "secret");
        headers[headerName.toLowerCase()] = String(ref.prefix ?? "") + value;
      }
    }
    let body = null;
    if (request.body !== undefined && request.body !== null) {
      if (method !== "POST") throw new EgressError("only POST may carry a body");
      body = Buffer.from(JSON.stringify(request.body));
      if (body.length > MAX_REQUEST_BYTES) throw new EgressError("the request body is larger than 1 MB");
      headers["content-type"] = "application/json";
      headers["content-length"] = String(body.length);
    }
    const path = request.path + (query.size ? "?" + query.toString() : "");
    return { host, method, path, headers, body, secretNames };
  }

  return {
    prepare,
    async call({ manifest, granted, request, limits = {}, capability }) {
      const started = Date.now();
      const prepared = await prepare({ manifest, granted, request });
      const maxBytes = (limits.outputKb ?? DEFAULT_RESPONSE_KB) * 1024;
      let res;
      try {
        res = await transport({ host: prepared.host, path: prepared.path, method: prepared.method, headers: prepared.headers, body: prepared.body,
          timeoutMs: limits.timeMs ?? DEFAULT_TIME_MS, maxBytes });
      } catch (error) {
        audit?.record({ kind: "network.failed", module: manifest.id, capability, host: prepared.host, method: prepared.method, error: scrub(String(error?.message || error), prepared), ms: Date.now() - started });
        throw error instanceof EgressError ? error : new EgressError(String(error?.message || error));
      }
      audit?.record({ kind: "network", module: manifest.id, capability, host: prepared.host, method: prepared.method, status: res.status,
        sent: prepared.body?.length ?? 0, received: res.body.length, ms: Date.now() - started, secrets: prepared.secretNames.length || undefined });
      if (res.status >= 300 && res.status < 400) throw new EgressError("the host answered with a redirect (" + res.status + "), which is not followed");
      if (res.status >= 400) throw new EgressError("the host answered " + res.status, "http");
      return res;
    },
  };
}

// Error text can echo a header; never let a secret value into logs or replies.
const scrub = (text, prepared) => {
  let out = text;
  for (const v of Object.values(prepared.headers)) if (typeof v === "string" && v.length >= 8) out = out.split(v).join("[hidden]");
  return out.slice(0, 300);
};
