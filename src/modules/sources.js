// Package sources: an easier way to get signed packages onto a server without
// weakening what installing one requires.
//
// A publisher hosts an index (estampes.index/1) next to their packages, for
// example as an asset of a GitHub Release. The index names the publisher, the
// public key that signs their packages, the id prefixes they publish under,
// and each package's file and digest; it is signed by that same key.
//
// The administrator adds the source once. The first `source add` fetches the
// index and shows the key fingerprint; nothing is trusted until the
// administrator repeats the command with `--accept <fingerprint>` (compared
// out of band, for example on the publisher's README). From then on the key
// is pinned: `source sync` refuses an index signed by any other key, verifies
// every package exactly as an install does, and only places packages in the
// inbox. Installing still needs the user's confirmation in the Store and the
// administrator's approval, as before.
//
// Everything here runs in the administrator's CLI (scripts/estampes-module.js),
// never in the server: the server still cannot fetch packages, and module
// network access (egress.js) is unchanged.
//
//   <storage>/modules/sources.json        [{name, url, keyId, fingerprint, publisher, scopes, addedAt}]
//   <storage>/modules/trusted-keys.json   gains {keyId, publicKey, publisher, scopes, source}
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { canonical, verifyBundle, MAX_PACKAGE_BYTES } from "./packages.js";
import { MODULE_ID } from "./manifest.js";
import { isVersion, compareVersions } from "./semver.js";
import { safeLookup } from "./egress.js";

export const INDEX_SCHEMA = "estampes.index/1";
const MAX_INDEX_BYTES = 256 * 1024, MAX_REDIRECTS = 5, FETCH_MS = 30000;
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SCOPE = /^[a-z][a-z0-9-]{0,30}(\.[a-z0-9][a-z0-9-]{0,30}){1,5}$/;
// A package location in an index: an https URL, or a plain file name that is
// resolved next to the index (the usual case for a GitHub Release).
const LOCATION = z.string().max(500).refine((s) => s.startsWith("https://") || /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s), "an https URL or a file name next to the index");

export class SourceError extends Error {
  constructor(message, code = "source", details = undefined) { super(message); this.code = code; this.details = details; }
}

const IndexSchema = z.object({
  schema: z.literal(INDEX_SCHEMA),
  publisher: z.object({ name: z.string().min(1).max(80), url: z.string().max(300).startsWith("https://").optional() }).strict(),
  keyId: z.string().regex(KEY_ID),
  publicKey: z.string().max(400),
  scopes: z.array(z.string().regex(SCOPE)).min(1).max(8),
  packages: z.array(z.object({
    id: z.string().regex(MODULE_ID), version: z.string().max(64).refine(isVersion, "a version such as 1.2.3"),
    file: LOCATION, digest: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().positive().max(MAX_PACKAGE_BYTES),
  }).strict()).max(200),
  generatedAt: z.string().max(40).optional(),
  signature: z.object({ sig: z.string().max(200) }).strict(),
}).strict();

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const inScope = (id, scopes) => scopes.some((s) => id === s || id.startsWith(s.endsWith(".") ? s : s + "."));

// What the administrator compares out of band: sha256 of the key's DER bytes.
export function fingerprintOf(publicKeyPem) {
  return "sha256:" + sha256(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }));
}

// ---- Publisher side ----------------------------------------------------------
// Builds and signs an index for packages that the same key signed.
export function buildIndex({ publisher, keyId, privateKeyPem, scopes, packages, generatedAt = new Date().toISOString() }) {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "pem" });
  const trusted = new Map([[keyId, { keyId, publicKey, publisher: publisher.name, scopes }]]);
  const entries = packages.map(({ bytes, file }) => {
    let v;
    try { v = verifyBundle(bytes, { trusted }); } catch (error) { throw new SourceError(file + ": " + error.message); }
    if (!v.signer) throw new SourceError(file + ": not signed");
    return { id: v.manifest.id, version: v.manifest.version, file, digest: v.digest, bytes: bytes.length };
  });
  const body = { schema: INDEX_SCHEMA, publisher, keyId, publicKey, scopes, packages: entries, generatedAt };
  const parsed = IndexSchema.omit({ signature: true }).safeParse(body);
  if (!parsed.success) throw new SourceError("index." + parsed.error.issues[0].path.join(".") + ": " + parsed.error.issues[0].message);
  const sig = edSign(null, Buffer.from(canonical(body)), createPrivateKey(privateKeyPem)).toString("base64");
  return { ...body, signature: { sig } };
}

// ---- Verifying an index --------------------------------------------------------
// Checks the index is well formed, signed by the key it names, that every
// package id is inside its scopes, and (once a source is added) that the key
// is the pinned one.
export function verifyIndex(bytes, { fingerprint } = {}) {
  if (bytes.length > MAX_INDEX_BYTES) throw new SourceError("the index is larger than " + MAX_INDEX_BYTES / 1024 + " KB");
  let raw;
  try { raw = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new SourceError("the index is not valid JSON"); }
  const parsed = IndexSchema.safeParse(raw);
  if (!parsed.success) throw new SourceError("index." + parsed.error.issues[0].path.join(".") + ": " + parsed.error.issues[0].message);
  const index = parsed.data;
  let fp;
  try { fp = fingerprintOf(index.publicKey); } catch { throw new SourceError("index.publicKey is not a public key"); }
  if (createPublicKey(index.publicKey).asymmetricKeyType !== "ed25519") throw new SourceError("index.publicKey must be an ed25519 key");
  if (fingerprint && fp !== fingerprint) {
    throw new SourceError("the index is signed by a different key (" + fp + ") than the one this server pinned (" + fingerprint + "). If the publisher really changed keys, remove the source and add it again after checking the new fingerprint with them.", "key-changed");
  }
  const { signature, ...body } = index;
  let ok = false;
  try { ok = edVerify(null, Buffer.from(canonical(body)), createPublicKey(index.publicKey), Buffer.from(signature.sig, "base64")); } catch {}
  if (!ok) throw new SourceError("the index signature does not match its contents");
  for (const p of index.packages) if (!inScope(p.id, index.scopes)) throw new SourceError("index lists " + p.id + ", outside its own scopes (" + index.scopes.join(", ") + ")");
  return { index, fingerprint: fp };
}

// ---- Fetching ----------------------------------------------------------------
// GET over https only, to public addresses only (the same DNS check modules
// get), following at most 5 redirects, each of which must stay on https.
// GitHub Release downloads redirect to a storage host, so redirects are needed.
export function httpsGet(url, { maxBytes, timeoutMs = FETCH_MS }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const req = httpsRequest({ host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "GET", lookup: safeLookup, servername: u.hostname, agent: false,
      headers: { "user-agent": "Estampes-module-cli/1", accept: "application/json, application/octet-stream" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return done(resolve, { status: res.statusCode, location: res.headers.location }); }
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > maxBytes) { req.destroy(); done(reject, new SourceError(url + " is larger than " + Math.round(maxBytes / 1024) + " KB")); } else chunks.push(c); });
      res.on("end", () => done(resolve, { status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on("error", (e) => done(reject, e));
    });
    const timer = setTimeout(() => { req.destroy(); done(reject, new SourceError(url + " took longer than " + timeoutMs + " ms")); }, timeoutMs);
    req.on("error", (e) => done(reject, new SourceError("could not fetch " + url + ": " + (e?.message ?? e))));
    req.end();
  });
}

// `location` is an https URL or a local path (an administrator who
// downloaded the files by hand, or tests). `base` resolves relative names.
export async function fetchBytes(location, { base, maxBytes, transport = httpsGet } = {}) {
  let target = location;
  if (base && !/^[a-z][a-z0-9+.-]*:/i.test(location) && !isAbsolute(location)) {
    target = /^https:\/\//.test(base) ? new URL(location, base).href : join(dirname(base), location);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) {
    if (!target.startsWith("https://")) throw new SourceError("only https URLs (or local files) are accepted: " + target);
    let url = target;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await transport(url, { maxBytes });
      if (res.status >= 300 && res.status < 400) {
        if (!res.location) throw new SourceError(url + " redirected without a location");
        const next = new URL(res.location, url).href;
        if (!next.startsWith("https://")) throw new SourceError(url + " redirected to a non-https address; refused");
        url = next;
        continue;
      }
      if (res.status !== 200) throw new SourceError(url + " answered " + res.status);
      return { bytes: res.body, location: url };
    }
    throw new SourceError(target + " redirected more than " + MAX_REDIRECTS + " times");
  }
  const path = resolvePath(target);
  const bytes = await readFile(path).catch(() => { throw new SourceError("cannot read " + path); });
  if (bytes.length > maxBytes) throw new SourceError(path + " is larger than " + Math.round(maxBytes / 1024) + " KB");
  return { bytes, location: path };
}

// ---- Administrator side ---------------------------------------------------------
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } };
async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export function createSources({ dir, coreVersion, transport, allowUnsigned = false }) {
  const sourcesFile = join(dir, "sources.json"), keysFile = join(dir, "trusted-keys.json"), inbox = join(dir, "inbox");
  const list = async () => { const s = await readJson(sourcesFile, []); return Array.isArray(s) ? s : []; };
  const keys = async () => { const k = await readJson(keysFile, []); return Array.isArray(k) ? k : []; };
  const trustedMap = async () => new Map((await keys()).filter((k) => k && typeof k.keyId === "string").map((k) => [k.keyId, { ...k, scopes: Array.isArray(k.scopes) ? k.scopes : [] }]));
  const fetchIndex = (url) => fetchBytes(url, { maxBytes: MAX_INDEX_BYTES, transport });

  // Writes a verified package into the inbox. Returns the file name.
  async function place(bytes, manifest) {
    const name = (manifest.id + "-" + manifest.version).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) + ".estpkg.json";
    await atomicWrite(join(inbox, name), bytes);
    return name;
  }

  return {
    list,
    // First call without `accept`: throws code "confirm" with the details to
    // check. Second call with accept === fingerprint: pins the key.
    async add({ name, url, accept, scopes: narrowed }) {
      if (!NAME.test(name ?? "")) throw new SourceError("a source name is lower-case letters, digits, . _ - (such as example-tools)");
      const existing = await list();
      if (existing.some((s) => s.name === name)) throw new SourceError("there is already a source named " + name + " (source remove " + name + " first)");
      const { bytes, location } = await fetchIndex(url);
      const { index, fingerprint } = verifyIndex(bytes);
      const scopes = narrowed?.length ? narrowed : index.scopes;
      for (const s of scopes) {
        if (!SCOPE.test(s)) throw new SourceError("scope " + JSON.stringify(s) + " is not an id prefix such as org.example");
        if (!inScope(s, index.scopes)) throw new SourceError("scope " + s + " is wider than what the publisher publishes (" + index.scopes.join(", ") + ")");
      }
      const details = { publisher: index.publisher, keyId: index.keyId, fingerprint, scopes, packages: index.packages.map((p) => p.id + " " + p.version), location };
      if (!accept) throw new SourceError("not added yet: check this fingerprint with the publisher, then run the same command with --accept " + fingerprint, "confirm", details);
      if (accept !== fingerprint) throw new SourceError("the fingerprint you accepted (" + accept + ") is not the index's key (" + fingerprint + "); nothing was changed", "mismatch", details);
      const all = await keys();
      const clash = all.find((k) => k.keyId === index.keyId);
      if (clash && clash.publicKey && fingerprintOf(clash.publicKey) !== fingerprint) throw new SourceError("this server already trusts a different key named " + index.keyId + "; nothing was changed", "key-clash", details);
      if (existing.some((s) => s.keyId === index.keyId)) throw new SourceError("key " + index.keyId + " already belongs to source " + existing.find((s) => s.keyId === index.keyId).name, "key-clash", details);
      const entry = { name, url, keyId: index.keyId, fingerprint, publisher: index.publisher.name, scopes, addedAt: new Date().toISOString() };
      await atomicWrite(keysFile, JSON.stringify([...all.filter((k) => k.keyId !== index.keyId), { keyId: index.keyId, publisher: index.publisher.name, publicKey: index.publicKey, scopes, source: name }], null, 2));
      await atomicWrite(sourcesFile, JSON.stringify([...existing, entry], null, 2));
      return { ...entry, packages: details.packages };
    },
    // Removes the source and the key it added (a key trusted by hand stays).
    async remove(name) {
      const existing = await list();
      const entry = existing.find((s) => s.name === name);
      if (!entry) throw new SourceError("no source named " + name);
      await atomicWrite(sourcesFile, JSON.stringify(existing.filter((s) => s.name !== name), null, 2));
      const all = await keys();
      await atomicWrite(keysFile, JSON.stringify(all.filter((k) => !(k.keyId === entry.keyId && k.source === name)), null, 2));
      return entry;
    },
    // Fetches the newest version of each package of each (or one) source and
    // places those that verify into the inbox. A package that fails is
    // reported and skipped; the others still arrive.
    async sync(only) {
      const sources = (await list()).filter((s) => !only || s.name === only);
      if (only && !sources.length) throw new SourceError("no source named " + only);
      const trusted = await trustedMap();
      const results = [];
      for (const src of sources) {
        let index, location;
        try {
          const fetched = await fetchIndex(src.url);
          location = fetched.location;
          ({ index } = verifyIndex(fetched.bytes, { fingerprint: src.fingerprint }));
        } catch (error) { results.push({ source: src.name, error: String(error?.message || error) }); continue; }
        const newest = new Map();
        for (const p of index.packages) {
          if (!inScope(p.id, src.scopes)) { results.push({ source: src.name, id: p.id, version: p.version, error: "outside the scopes this server accepted from " + src.name + " (" + src.scopes.join(", ") + ")" }); continue; }
          if (!newest.has(p.id) || compareVersions(p.version, newest.get(p.id).version) > 0) newest.set(p.id, p);
        }
        for (const p of newest.values()) {
          try {
            const { bytes } = await fetchBytes(p.file, { base: location, maxBytes: MAX_PACKAGE_BYTES, transport });
            if (bytes.length !== p.bytes) throw new SourceError("size " + bytes.length + " does not match the index (" + p.bytes + ")");
            const v = verifyBundle(bytes, { trusted, allowUnsigned: false, coreVersion });
            if (v.signer?.keyId !== src.keyId) throw new SourceError("not signed by the source's key " + src.keyId);
            if (v.digest !== p.digest || v.manifest.id !== p.id || v.manifest.version !== p.version) throw new SourceError("does not match its index entry (id, version or digest)");
            results.push({ source: src.name, id: p.id, version: p.version, file: await place(bytes, v.manifest) });
          } catch (error) { results.push({ source: src.name, id: p.id, version: p.version, error: String(error?.message || error) }); }
        }
      }
      return results;
    },
    // One package from a URL (for example a GitHub Release asset) or a path.
    // Its key must already be trusted (by `trust` or a source); `sha256`
    // optionally pins the exact file bytes the publisher announced.
    async fetchPackage(url, { sha256: pinned } = {}) {
      const { bytes } = await fetchBytes(url, { maxBytes: MAX_PACKAGE_BYTES, transport });
      if (pinned && sha256(bytes) !== pinned.toLowerCase()) throw new SourceError("the file's sha256 is " + sha256(bytes) + ", not " + pinned);
      let v;
      try { v = verifyBundle(bytes, { trusted: await trustedMap(), allowUnsigned, coreVersion }); }
      catch (error) {
        const keyId = (() => { try { return JSON.parse(bytes.toString("utf8")).signature?.keyId; } catch { return undefined; } })();
        throw new SourceError(String(error?.message || error) + (keyId && /does not trust/.test(String(error?.message)) ? ". Add the publisher's source (source add) or trust the key (trust " + keyId + " <public.pem> <publisher> <scope>) first." : ""));
      }
      return { id: v.manifest.id, version: v.manifest.version, digest: v.digest, signer: v.signer, warnings: v.warnings, file: await place(bytes, v.manifest) };
    },
  };
}
