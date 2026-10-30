// Managed packages: how a module that is not built in gets installed.
//
// A package is one JSON file (estampes.package/1): the manifest, a map of
// data files and a signature. There is deliberately no archive format, no
// download from arbitrary URLs and no npm: packages are placed in
// <storage>/modules/inbox/ by the administrator, so there is nothing to
// unzip, no path to traverse and no address to fetch. Installing checks
//   - size and path limits,
//   - the manifest (manifest.js), the core version and the runtime,
//   - the digest (sha256 over the canonical manifest and files),
//   - an ed25519 signature by a key the administrator trusts, whose scope
//     covers the module id (unsigned packages need ESTAMPES_MODULE_ALLOW_UNSIGNED=1
//     and are then always high risk),
// stages the verified bytes in an immutable folder, runs the module's own
// examples as a self-test, and only then switches the active version. Every
// version is kept so rollback is an exact restore, checked against the lock.
//
//   <storage>/modules/inbox/<name>.estpkg.json   put here by the administrator
//   <storage>/modules/packages/<id>/<version>/package.json   verified, read-only
//   <storage>/modules/lock.json                  active digest and history per module
//   <storage>/modules/trusted-keys.json          [{keyId, publicKey (PEM), publisher, scopes}]
import { createHash, createPublicKey, createPrivateKey, sign as edSign, verify as edVerify, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { validateManifest, ManifestError, MODULE_ID } from "./manifest.js";
import { riskOf, permissionDiff } from "./permissions.js";
import { LifecycleError } from "./lifecycle.js";
import { applySceneOps } from "../scene/scene-ops.js";
import { validateValue } from "./json-schema.js";

export const PACKAGE_SCHEMA = "estampes.package/1";
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024, MAX_FILES = 16;
const PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}$/;
const hex = (buf) => createHash("sha256").update(buf).digest("hex");

const BundleSchema = z.object({
  schema: z.literal(PACKAGE_SCHEMA),
  manifest: z.record(z.string(), z.unknown()),
  files: z.record(z.string(), z.object({ encoding: z.enum(["utf8", "base64"]), content: z.string().max(MAX_PACKAGE_BYTES) }).strict()).default({}),
  signature: z.object({ keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), sig: z.string().max(200) }).strict().optional(),
}).strict();

// JSON with sorted keys, so the same package always has the same digest.
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
export const digestOf = ({ manifest, files }) => hex(canonical({ manifest, files: files ?? {} }));

export function parseBundle(bytes) {
  if (bytes.length > MAX_PACKAGE_BYTES) throw new ManifestError("package is larger than " + MAX_PACKAGE_BYTES / 1024 / 1024 + " MB");
  let raw;
  try { raw = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new ManifestError("package is not valid JSON"); }
  const parsed = BundleSchema.safeParse(raw);
  if (!parsed.success) throw new ManifestError("package." + parsed.error.issues[0].path.join(".") + ": " + parsed.error.issues[0].message);
  const bundle = parsed.data;
  const names = Object.keys(bundle.files);
  if (names.length > MAX_FILES) throw new ManifestError("package has more than " + MAX_FILES + " files");
  let total = 0;
  for (const name of names) {
    if (!PATH.test(name) || name.split("/").some((p) => p === "." || p === "..")) throw new ManifestError("unsafe file path " + JSON.stringify(name));
    const f = bundle.files[name];
    if (f.encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(f.content)) throw new ManifestError("file " + name + " is not valid base64");
    total += f.content.length;
  }
  if (total > MAX_PACKAGE_BYTES) throw new ManifestError("package contents are too large");
  return bundle;
}

// ---- Signing ---------------------------------------------------------------
export function generateSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "pem" }), privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) };
}
export function signBundle(bundle, privateKeyPem, keyId) {
  const digest = digestOf(bundle);
  const sig = edSign(null, Buffer.from(digest), createPrivateKey(privateKeyPem)).toString("base64");
  return { ...bundle, signature: { keyId, sig } };
}

// Checks everything about a package that can be checked without installing.
// Returns { bundle, manifest, digest, signer, warnings } or throws.
export function verifyBundle(bytes, { trusted = new Map(), allowUnsigned = false, coreVersion, reserved = new Set() } = {}) {
  const bundle = parseBundle(bytes);
  const manifest = validateManifest(bundle.manifest, { coreVersion });
  if (reserved.has(manifest.id)) throw new ManifestError(manifest.id + " is a built-in module and cannot be replaced by a package");
  if (manifest.runtime.kind === "builtin") throw new ManifestError("packages cannot use the builtin runtime");
  const digest = digestOf(bundle), warnings = [];
  let signer = null;
  if (bundle.signature) {
    const key = trusted.get(bundle.signature.keyId);
    if (!key) throw new ManifestError("signed by key " + bundle.signature.keyId + ", which this server does not trust (see trusted-keys.json)");
    if (!key.scopes.some((s) => manifest.id === s || manifest.id.startsWith(s.endsWith(".") ? s : s + "."))) {
      throw new ManifestError("key " + key.keyId + " is not allowed to publish " + manifest.id + " (allowed: " + key.scopes.join(", ") + ")");
    }
    let ok = false;
    try { ok = edVerify(null, Buffer.from(digest), createPublicKey(key.publicKey), Buffer.from(bundle.signature.sig, "base64")); } catch {}
    if (!ok) throw new ManifestError("the signature does not match the package contents");
    signer = { keyId: key.keyId, publisher: key.publisher };
  } else if (allowUnsigned) {
    warnings.push("This package is NOT signed. Only install it if you made it or checked it yourself.");
  } else {
    throw new ManifestError("the package is not signed, and this server only installs packages signed by a trusted key");
  }
  return { bundle, manifest, digest, signer, warnings };
}

async function atomicWrite(path, data, mode) {
  const tmp = path + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(tmp, data, mode ? { mode } : undefined);
  await rename(tmp, path);
}
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } };

// Runs a module's own examples through the same checks execute_module does,
// against a throwaway canvas, so a broken package never becomes active.
export function selfTest(manifest, runtime, { runtimes }) {
  const rt = runtimes[manifest.runtime.kind];
  if (!rt) throw new LifecycleError("runtime " + manifest.runtime.kind + " is not available on this server", "runtime");
  return (async () => {
    for (const cap of manifest.capabilities) {
      for (const ex of cap.examples ?? [{ description: "defaults", params: {} }]) {
        let input;
        try { input = validateValue(cap.inputSchema, ex.params ?? {}, cap.id + " example"); }
        catch (error) { if (!cap.examples) continue; throw new LifecycleError("self-test: " + error.message, "selftest"); }
        const out = await rt.run({ manifest, runtime }, cap.id, input, { canvas: { objects: [], marks: [] }, module: { id: manifest.id, version: manifest.version }, permissions: manifest.permissions, limits: manifest.limits ?? {} });
        if (out?.operations?.length) {
          const entry = { imageId: "img:0000000000000000", width: 1600, height: 1000, marks: new Map(), layers: [] };
          try { applySceneOps(entry, out.operations, { author: "module", module: manifest.id, moduleVersion: manifest.version, capability: cap.id }); }
          catch (error) { throw new LifecycleError("self-test of " + cap.id + ": " + error.message, "selftest"); }
        }
      }
    }
  })();
}

export function createPackages({ dir, registry, audit, runtimes, coreVersion, trustedKeys = [], allowUnsigned = false, reserved = new Set() }) {
  const inbox = join(dir, "inbox"), store = join(dir, "packages"), lockFile = join(dir, "lock.json"), keysFile = join(dir, "trusted-keys.json");
  const trusted = new Map();
  const loadKeys = async () => {
    trusted.clear();
    const fromFile = await readJson(keysFile, []);
    for (const k of [...(Array.isArray(fromFile) ? fromFile : []), ...trustedKeys]) {
      if (!k || typeof k.keyId !== "string" || typeof k.publicKey !== "string") continue;
      try { createPublicKey(k.publicKey); } catch { continue; }
      trusted.set(k.keyId, { keyId: k.keyId, publicKey: k.publicKey, publisher: String(k.publisher ?? k.keyId).slice(0, 80),
        scopes: (Array.isArray(k.scopes) && k.scopes.length ? k.scopes : []).map(String).slice(0, 8) });
    }
  };
  const verifyOptions = () => ({ trusted, allowUnsigned, coreVersion, reserved });
  const lock = { async read() { return readJson(lockFile, { schema: "estampes.module-lock/1", modules: {} }); },
    async write(data) { await mkdir(dir, { recursive: true }); await atomicWrite(lockFile, JSON.stringify(data, null, 2)); } };
  const versionDir = (id, version) => join(store, id, version);

  async function inboxFiles() {
    const names = await readdir(inbox).catch(() => []);
    return names.filter((n) => /^[A-Za-z0-9._-]{1,100}\.estpkg\.json$/.test(n));
  }
  // Packages waiting in the inbox that verify. Broken ones are reported by name.
  async function available() {
    await loadKeys();
    const out = [];
    for (const name of await inboxFiles()) {
      try {
        const bytes = await readFile(join(inbox, name));
        const v = verifyBundle(bytes, verifyOptions());
        const installed = registry.record(v.manifest.id);
        out.push({ id: v.manifest.id, name: v.manifest.name, version: v.manifest.version, file: name, origin: "inbox", signed: !!v.signer,
          signer: v.signer?.publisher, digest: v.digest, installed: registry.has(v.manifest.id) && registry.get(v.manifest.id).source === "package" ? installed.version : null });
      } catch (error) { out.push({ id: name, name, version: "", file: name, origin: "inbox", error: String(error?.message || error) }); }
    }
    return out;
  }
  async function findInInbox(id, version) {
    await loadKeys();
    const matches = [];
    for (const name of await inboxFiles()) {
      try {
        const bytes = await readFile(join(inbox, name));
        const v = verifyBundle(bytes, verifyOptions());
        if (v.manifest.id === id && (!version || v.manifest.version === version)) matches.push({ ...v, bytes, file: name });
      } catch { /* reported by available() */ }
    }
    if (!matches.length) throw new LifecycleError("no verified package for " + id + (version ? " " + version : "") + " in the inbox (" + inbox + ")", "not-found");
    const { compareVersions } = await import("./semver.js");
    return matches.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))[0];
  }

  // Immutable store of verified bytes.
  async function stage(v) {
    const target = versionDir(v.manifest.id, v.manifest.version), file = join(target, "package.json");
    const existing = await readFile(file).catch(() => null);
    if (existing) {
      if (hex(canonical({ manifest: JSON.parse(existing).manifest, files: JSON.parse(existing).files ?? {} })) !== v.digest) {
        throw new LifecycleError(v.manifest.id + " " + v.manifest.version + " is already installed with different contents; publish a new version", "conflict");
      }
      return target;
    }
    await mkdir(target, { recursive: true });
    await atomicWrite(file, JSON.stringify(v.bundle), 0o444);
    return target;
  }
  async function loadVersion(id, version, expectedDigest) {
    const bytes = await readFile(join(versionDir(id, version), "package.json"));
    const v = verifyBundle(bytes, verifyOptions());
    if (expectedDigest && v.digest !== expectedDigest) throw new LifecycleError("stored package " + id + " " + version + " no longer matches its lock entry", "integrity");
    return v;
  }
  const runtimeFor = (manifest) => ({ kind: manifest.runtime.kind });
  const infoOf = (v, extra = {}) => ({ sha256: v.digest, keyId: v.signer?.keyId ?? null, signer: v.signer?.publisher ?? null, ...extra });

  // At startup: bring installed packages back, re-verifying each.
  async function loadInstalled() {
    await loadKeys();
    const locked = await lock.read();
    for (const [id, rec] of registry.records()) {
      if (rec.source !== "package") continue;
      const entry = locked.modules[id]?.active;
      try {
        if (!entry) throw new Error("no lock entry");
        const v = await loadVersion(id, entry.version, entry.sha256);
        registry.addPackage(v.manifest, runtimeFor(v.manifest), infoOf(v, { installedAt: entry.at }));
      } catch (error) {
        audit.record({ kind: "package.rejected", module: id, reason: "startup: " + String(error?.message || error).slice(0, 200) });
        // Keep it visible so rollback or uninstall can still be prepared: show the
        // newest earlier version that still verifies, in the failed state.
        for (const old of [...(locked.modules[id]?.history ?? [])].reverse()) {
          try { const v = await loadVersion(id, old.version, old.sha256); registry.addPackage(v.manifest, runtimeFor(v.manifest), infoOf(v, { installedAt: old.at })); break; } catch { /* try the next */ }
        }
        await registry.setRecord(id, { ...rec, state: "failed", error: String(error?.message || error).slice(0, 200) });
      }
    }
  }

  async function activate(v, { previous, state, granted }) {
    const id = v.manifest.id, now = new Date().toISOString();
    registry.addPackage(v.manifest, runtimeFor(v.manifest), infoOf(v, { installedAt: now }));
    const locked = await lock.read();
    const prior = locked.modules[id];
    const priorLock = structuredClone(locked);
    locked.modules[id] = { active: { version: v.manifest.version, sha256: v.digest, keyId: v.signer?.keyId ?? null, at: now },
      history: [...(prior?.history ?? []), ...(prior?.active ? [prior.active] : [])].slice(-10) };
    try {
      await lock.write(locked);
      await registry.setRecord(id, { source: "package", state, version: v.manifest.version, granted, previous });
    } catch (error) {
      await lock.write(priorLock).catch(() => {});
      throw error;
    }
  }

  const checkedId = (id) => {
    if (typeof id !== "string" || !MODULE_ID.test(id)) throw new LifecycleError("not a module id: " + JSON.stringify(String(id).slice(0, 60)), "invalid");
    return id;
  };

  const handlers = {
    install: {
      withoutModule: true,
      async prepare(_mod, options) {
        const id = options.module ?? options.id;
        if (!id) throw new LifecycleError("install needs a module id", "invalid");
        checkedId(id);
        if (registry.has(id) && registry.get(id).source === "package") throw new LifecycleError(id + " is already installed (version " + registry.record(id).version + "); use update", "noop");
        if (registry.has(id)) throw new LifecycleError(id + " is built in", "noop");
        const v = await findInInbox(id, options.version);
        const requested = v.manifest.permissions;
        const risk = !v.signer ? "high" : riskOf(requested);
        return { name: v.manifest.name, toVersion: v.manifest.version, requested, diff: permissionDiff([], requested), risk, requiresAdmin: true,
          notes: ["Package digest " + v.digest.slice(0, 16) + "…", ...(v.signer ? ["Signed by " + v.signer.publisher + " (" + v.signer.keyId + ")"] : []), ...v.warnings],
          dataFlow: v.manifest.network ? "Requests go to " + v.manifest.network.allow.join(", ") + ". " + v.manifest.network.dataFlow : null,
          options: { id, version: v.manifest.version, digest: v.digest } };
      },
      async commit(_mod, plan) {
        const { id, version, digest } = plan.options;
        const v = await findInInbox(id, version);
        if (v.digest !== digest) throw new LifecycleError("the package in the inbox changed after the plan was made; prepare it again", "integrity");
        await stage(v);
        try { await selfTest(v.manifest, runtimeFor(v.manifest), { runtimes }); }
        catch (error) { audit.record({ kind: "package.rejected", module: id, reason: String(error?.message || error).slice(0, 200) }); throw error; }
        audit.record({ kind: "package.verified", module: id, toVersion: version, sha256: digest, keyId: v.signer?.keyId });
        await activate(v, { previous: [], state: "installed", granted: [] });
        audit.record({ kind: "package.activated", module: id, toVersion: version });
        return { state: "installed", version };
      },
    },
    update: {
      async prepare(mod, options) {
        if (mod.source !== "package") throw new LifecycleError(mod.manifest.id + " is built in and updates with Estampes", "noop");
        const v = await findInInbox(mod.manifest.id, options.version);
        const { compareVersions } = await import("./semver.js");
        if (compareVersions(v.manifest.version, mod.record.version) <= 0) throw new LifecycleError(v.manifest.id + " " + mod.record.version + " is already installed; the inbox has " + v.manifest.version, "noop");
        const was = mod.record.state === "enabled" ? mod.record.granted ?? [] : [];
        const requested = v.manifest.permissions, diff = permissionDiff(was, requested);
        const risk = !v.signer ? "high" : riskOf(diff.added.length ? diff.added : []);
        return { name: v.manifest.name, toVersion: v.manifest.version, requested, diff, risk, requiresAdmin: true,
          notes: [...(diff.added.length ? ["The new version asks for more permissions; approving this grants them."] : []), "Previous version " + mod.record.version + " stays available for rollback.",
            "Package digest " + v.digest.slice(0, 16) + "…", ...v.warnings],
          dataFlow: v.manifest.network ? "Requests go to " + v.manifest.network.allow.join(", ") + ". " + v.manifest.network.dataFlow : null,
          options: { id: v.manifest.id, version: v.manifest.version, digest: v.digest } };
      },
      async commit(mod, plan) {
        const { id, version, digest } = plan.options;
        const v = await findInInbox(id, version);
        if (v.digest !== digest) throw new LifecycleError("the package in the inbox changed after the plan was made; prepare it again", "integrity");
        await stage(v);
        const before = registry.get(id);
        try { await selfTest(v.manifest, runtimeFor(v.manifest), { runtimes }); }
        catch (error) { audit.record({ kind: "package.rejected", module: id, reason: String(error?.message || error).slice(0, 200) }); throw error; }
        const wasEnabled = mod.record.state === "enabled";
        try {
          await activate(v, { previous: [...(mod.record.previous ?? []), { version: mod.record.version, sha256: before.package?.sha256 }].slice(-10),
            state: wasEnabled ? "enabled" : mod.record.state === "failed" ? "installed" : mod.record.state, granted: wasEnabled ? v.manifest.permissions : [] });
        } catch (error) { await restoreActive(id, mod.record); throw error; }
        audit.record({ kind: "package.activated", module: id, toVersion: version, fromVersion: mod.record.version });
        return { state: registry.record(id).state, version };
      },
    },
    rollback: {
      async prepare(mod) {
        const prev = (mod.record.previous ?? []).at(-1);
        if (mod.source !== "package" || !prev) throw new LifecycleError(mod.manifest.id + " has no earlier version to go back to", "noop");
        const v = await loadVersion(mod.manifest.id, prev.version, prev.sha256);
        return { name: v.manifest.name, toVersion: prev.version, requested: v.manifest.permissions, diff: permissionDiff(mod.record.granted ?? [], v.manifest.permissions),
          risk: "low", requiresAdmin: false, notes: ["Restores the exact bytes of " + prev.version + " that were verified earlier."], options: { id: mod.manifest.id, version: prev.version, digest: prev.sha256, from: mod.record.version } };
      },
      async commit(mod, plan) {
        const { id, version, digest, from } = plan.options;
        const last = (mod.record.previous ?? []).at(-1);
        if (mod.record.version !== from || last?.version !== version || last?.sha256 !== digest) throw new LifecycleError(id + " changed after this rollback was planned; prepare it again", "conflict");
        const v = await loadVersion(id, version, digest);
        const previous = (mod.record.previous ?? []).slice(0, -1);
        const wasEnabled = mod.record.state === "enabled";
        await activate(v, { previous, state: wasEnabled ? "enabled" : "installed", granted: wasEnabled ? v.manifest.permissions : [] });
        audit.record({ kind: "package.rolledback", module: id, toVersion: version, fromVersion: mod.record.version });
        return { state: registry.record(id).state, version };
      },
    },
    uninstall: {
      async prepare(mod) {
        if (mod.source !== "package") throw new LifecycleError(mod.manifest.id + " is built in; disable it instead", "noop");
        return { name: mod.manifest.name, toVersion: null, requested: [], diff: permissionDiff(mod.record.granted ?? [], []), risk: "low", requiresAdmin: false,
          notes: ["Objects this module already put on canvases stay; they are not deleted.", "Downloaded versions stay on disk so it can be installed again."] };
      },
      async commit(mod) {
        const id = mod.manifest.id;
        registry.removeFromCatalog(id);
        await registry.dropRecord(id);
        const locked = await lock.read();
        if (locked.modules[id]) { locked.modules[id] = { active: null, history: [...(locked.modules[id].history ?? []), ...(locked.modules[id].active ? [locked.modules[id].active] : [])] }; await lock.write(locked); }
        return { state: "removed" };
      },
    },
    purge: {
      withoutModule: true,
      async prepare(_mod, options) {
        const id = checkedId(options.module ?? options.id);
        if (registry.has(id) && registry.get(id).source === "package") throw new LifecycleError(id + " is installed; uninstall it first", "invalid");
        const present = await stat(join(store, id)).then(() => true, () => false);
        if (!present) throw new LifecycleError("nothing stored for " + id, "not-found");
        return { name: id, toVersion: null, requested: [], diff: permissionDiff([], []), risk: "high", requiresAdmin: true,
          notes: ["Deletes every stored version of this package. Rolling back or reinstalling then needs the package in the inbox again."], options: { id } };
      },
      async commit(_mod, plan) {
        const id = checkedId(plan.options.id);
        if (registry.has(id) && registry.get(id).source === "package") throw new LifecycleError(id + " was installed after this plan was made; prepare it again", "conflict");
        await rm(join(store, id), { recursive: true, force: true });
        const locked = await lock.read(); delete locked.modules[id]; await lock.write(locked);
        return { state: "purged" };
      },
    },
  };
  async function restoreActive(id, record) {
    const entry = (await lock.read()).modules[id]?.active;
    if (!entry) return;
    try { const v = await loadVersion(id, entry.version, entry.sha256); registry.addPackage(v.manifest, runtimeFor(v.manifest), infoOf(v)); await registry.setRecord(id, record); } catch {}
  }

  return { dir, inbox, trusted, loadKeys, loadInstalled, available, verifyBundle: (b) => verifyBundle(b, verifyOptions()), actions: handlers };
}

export async function ensureDirs(dir) {
  for (const sub of ["inbox", "packages", "approvals"]) { await mkdir(join(dir, sub), { recursive: true }); }
  await chmod(join(dir, "approvals"), 0o700).catch(() => {});
}
