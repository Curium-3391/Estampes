// Package sources and URL import: an easier path to the inbox that keeps every
// install check. Key pinning on first use (fingerprint accepted explicitly),
// a signed index, https-only fetches with checked redirects, and packages
// verified exactly as an install verifies them.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigningKey, signBundle } from "../src/modules/packages.js";
import { buildIndex, verifyIndex, fingerprintOf, fetchBytes, createSources } from "../src/modules/sources.js";

const manifest = (id, version = "1.0.0") => ({
  schema: "estampes.module/1", id, name: "Lab", description: "Labels.", version, publisher: { name: "Ex" }, license: "MPL-2.0", category: "other",
  coreCompatibility: ">=0.10.0 <1.0.0", runtime: { kind: "declarative", entry: "operations" }, permissions: ["canvas.write"],
  capabilities: [{ id: "add", description: "Add a label.", inputSchema: { type: "object", additionalProperties: false, properties: {} }, examples: [{ description: "x", params: {} }],
    operations: [{ op: "object.create", type: "shape", props: { kind: "text", x: 0.1, y: 0.1, text: "hi" } }] }],
});
const pkg = (key, keyId, id, version) => Buffer.from(JSON.stringify(signBundle({ schema: "estampes.package/1", manifest: manifest(id, version), files: {} }, key.privateKey, keyId)));

function site(files) {
  const seen = [];
  const transport = async (url) => {
    seen.push(url);
    const f = files[url];
    if (!f) return { status: 404, body: Buffer.alloc(0) };
    if (f.redirect) return { status: 302, location: f.redirect };
    return { status: 200, body: f };
  };
  return { transport, seen };
}

async function setup() {
  const key = generateSigningKey();
  const dir = await mkdtemp(join(tmpdir(), "estampes-src-"));
  const a1 = pkg(key, "pub", "org.example.lab", "1.0.0"), a2 = pkg(key, "pub", "org.example.lab", "1.1.0"), b = pkg(key, "pub", "org.example.other", "0.2.0");
  const index = buildIndex({ publisher: { name: "Example" }, keyId: "pub", privateKeyPem: key.privateKey, scopes: ["org.example"],
    packages: [{ bytes: a1, file: "lab-1.0.0.estpkg.json" }, { bytes: a2, file: "lab-1.1.0.estpkg.json" }, { bytes: b, file: "other.estpkg.json" }] });
  const base = "https://github.com/ex/mods/releases/latest/download/";
  // GitHub-like: release URLs redirect to a storage host.
  const files = {
    [base + "estampes-index.json"]: { redirect: "https://objects.example-cdn.net/release-assets/123/idx-uuid?sig=1" },
    "https://objects.example-cdn.net/release-assets/123/idx-uuid?sig=1": Buffer.from(JSON.stringify(index)),
    // Like GitHub: the index is served from an opaque storage path, while each
    // package is reached through its own name next to the *original* index URL.
    [base + "lab-1.0.0.estpkg.json"]: { redirect: "https://objects.example-cdn.net/lab-1.0.0.estpkg.json" },
    [base + "lab-1.1.0.estpkg.json"]: { redirect: "https://objects.example-cdn.net/lab-1.1.0.estpkg.json" },
    [base + "other.estpkg.json"]: { redirect: "https://objects.example-cdn.net/other.estpkg.json" },
    "https://objects.example-cdn.net/lab-1.0.0.estpkg.json": a1,
    "https://objects.example-cdn.net/lab-1.1.0.estpkg.json": a2,
    "https://objects.example-cdn.net/other.estpkg.json": b,
  };
  return { key, dir, index, base, files, a2 };
}

test("index: signed, scoped, and refuses tampering or a different key", async () => {
  const { key, index, dir } = await setup();
  const fp = fingerprintOf(index.publicKey);
  assert.equal(verifyIndex(Buffer.from(JSON.stringify(index))).fingerprint, fp);
  assert.equal(fp, fingerprintOf(key.publicKey));
  const tampered = structuredClone(index); tampered.packages[0].digest = "0".repeat(64);
  assert.throws(() => verifyIndex(Buffer.from(JSON.stringify(tampered))), /signature does not match/);
  const other = generateSigningKey();
  const forged = buildIndex({ publisher: { name: "Example" }, keyId: "pub", privateKeyPem: other.privateKey, scopes: ["org.example"], packages: [] });
  assert.throws(() => verifyIndex(Buffer.from(JSON.stringify(forged)), { fingerprint: fp }), /different key/);
  // A package outside the index's scopes, or signed by another key, cannot be listed.
  assert.throws(() => buildIndex({ publisher: { name: "E" }, keyId: "pub", privateKeyPem: key.privateKey, scopes: ["org.other"], packages: [{ bytes: pkg(key, "pub", "org.example.lab", "1.0.0"), file: "a.estpkg.json" }] }), /not allowed to publish/);
  assert.throws(() => buildIndex({ publisher: { name: "E" }, keyId: "pub", privateKeyPem: key.privateKey, scopes: ["org.example"], packages: [{ bytes: pkg(other, "x", "org.example.lab", "1.0.0"), file: "a.estpkg.json" }] }), /does not trust/);
  // File names cannot climb out of the index's folder.
  const bad = structuredClone(index); bad.packages[0].file = "../secret.json";
  assert.throws(() => verifyIndex(Buffer.from(JSON.stringify(bad))), /file name next to the index/);
  await rm(dir, { recursive: true, force: true });
});

test("fetch: https only, redirects checked, size limited", async () => {
  const s = site({ "https://a.example/x": { redirect: "http://b.example/x" }, "https://a.example/loop": { redirect: "https://a.example/loop" }, "https://a.example/big": Buffer.alloc(10) });
  await assert.rejects(fetchBytes("http://a.example/x", { maxBytes: 100, transport: s.transport }), /only https URLs/);
  await assert.rejects(fetchBytes("file:///etc/passwd", { maxBytes: 100, transport: s.transport }), /only https URLs/);
  await assert.rejects(fetchBytes("https://a.example/x", { maxBytes: 100, transport: s.transport }), /non-https address; refused/);
  await assert.rejects(fetchBytes("https://a.example/loop", { maxBytes: 100, transport: s.transport }), /more than 5 times/);
  await assert.rejects(fetchBytes("https://a.example/missing", { maxBytes: 100, transport: s.transport }), /answered 404/);
  // The real transport enforces the byte limit while reading; the local path does too.
  const dir = await mkdtemp(join(tmpdir(), "estampes-big-"));
  await writeFile(join(dir, "f"), Buffer.alloc(200));
  await assert.rejects(fetchBytes(join(dir, "f"), { maxBytes: 100 }), /larger than/);
  await rm(dir, { recursive: true, force: true });
});

test("source add pins the key only after the fingerprint is accepted; sync fills the inbox with verified packages", async () => {
  const { dir, index, base, files } = await setup();
  const s = site(files);
  const sources = createSources({ dir, coreVersion: "0.20.0", transport: s.transport });
  const url = base + "estampes-index.json";
  const fp = fingerprintOf(index.publicKey);
  await assert.rejects(sources.add({ name: "ex", url }), (e) => e.code === "confirm" && e.details.fingerprint === fp && e.details.packages.length === 3);
  assert.deepEqual(await sources.list(), []);
  await assert.rejects(readFile(join(dir, "trusted-keys.json")), /ENOENT/);
  await assert.rejects(sources.add({ name: "ex", url, accept: "sha256:" + "0".repeat(64) }), (e) => e.code === "mismatch");
  await assert.rejects(sources.add({ name: "ex", url, accept: fp, scopes: ["org"] }), /not an id prefix|wider/);
  await sources.add({ name: "ex", url, accept: fp, scopes: ["org.example.lab"] });
  const keys = JSON.parse(await readFile(join(dir, "trusted-keys.json"), "utf8"));
  assert.deepEqual(keys.map((k) => [k.keyId, k.scopes, k.source]), [["pub", ["org.example.lab"], "ex"]]);

  const results = await sources.sync();
  // Newest version only; the package outside the accepted scope is refused.
  assert.deepEqual(results.filter((r) => r.file).map((r) => r.id + "@" + r.version), ["org.example.lab@1.1.0"]);
  assert.match(results.find((r) => r.id === "org.example.other").error, /outside the scopes/);
  assert.deepEqual(await readdir(join(dir, "inbox")), ["org.example.lab-1.1.0.estpkg.json"]);
  await rm(dir, { recursive: true, force: true });
});

test("sync refuses a changed key, a swapped package and a size mismatch", async () => {
  const { dir, index, base, files, key } = await setup();
  const url = base + "estampes-index.json";
  const s = site(files);
  const sources = createSources({ dir, coreVersion: "0.20.0", transport: s.transport });
  await sources.add({ name: "ex", url, accept: fingerprintOf(index.publicKey) });
  // The publisher's account is taken over and a new key signs a new index.
  const other = generateSigningKey();
  const evil = pkg(other, "pub", "org.example.lab", "9.0.0");
  files["https://objects.example-cdn.net/release-assets/123/idx-uuid?sig=1"] = Buffer.from(JSON.stringify(buildIndex({ publisher: { name: "Example" }, keyId: "pub", privateKeyPem: other.privateKey, scopes: ["org.example"], packages: [] })));
  let r = await sources.sync("ex");
  assert.match(r[0].error, /different key/);
  // Same key, but the hosted package file was replaced by another one of the right size... or not.
  files["https://objects.example-cdn.net/release-assets/123/idx-uuid?sig=1"] = Buffer.from(JSON.stringify(index));
  files["https://objects.example-cdn.net/lab-1.1.0.estpkg.json"] = evil;
  r = await sources.sync("ex");
  assert.ok(r.find((x) => x.id === "org.example.lab").error);
  // The legitimately signed older package swapped in under the newer name.
  files["https://objects.example-cdn.net/lab-1.1.0.estpkg.json"] = pkg(key, "pub", "org.example.lab", "1.0.0");
  r = await sources.sync("ex");
  assert.match(r.find((x) => x.id === "org.example.lab").error, /size|does not match its index entry/);
  assert.deepEqual((await readdir(join(dir, "inbox"))).filter((n) => n.includes("lab")), []);
  await rm(dir, { recursive: true, force: true });
});

test("fetch imports one release asset only when its key is trusted; remove drops the key the source added", async () => {
  const { dir, index, base, files, a2 } = await setup();
  const s = site({ ...files, [base + "lab.estpkg.json"]: { redirect: "https://objects.example-cdn.net/lab-1.1.0.estpkg.json" } });
  const sources = createSources({ dir, coreVersion: "0.20.0", transport: s.transport });
  await assert.rejects(sources.fetchPackage(base + "lab.estpkg.json"), /does not trust.*source add/);
  await sources.add({ name: "ex", url: base + "estampes-index.json", accept: fingerprintOf(index.publicKey) });
  await assert.rejects(sources.fetchPackage(base + "lab.estpkg.json", { sha256: "ab".repeat(32) }), /sha256 is/);
  const { createHash } = await import("node:crypto");
  const got = await sources.fetchPackage(base + "lab.estpkg.json", { sha256: createHash("sha256").update(a2).digest("hex") });
  assert.equal(got.version, "1.1.0");
  await sources.remove("ex");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "trusted-keys.json"), "utf8")), []);
  await rm(dir, { recursive: true, force: true });
});

test("CLI: author publishes an index, administrator adds, syncs and sees the package in the inbox", async () => {
  const storage = await mkdtemp(join(tmpdir(), "estampes-src-store-"));
  const work = await mkdtemp(join(tmpdir(), "estampes-src-work-"));
  const cli = (...args) => spawnSync(process.execPath, [join(process.cwd(), "scripts/estampes-module.js"), ...args], { cwd: work, env: { ...process.env, ESTAMPES_STORAGE_DIR: storage }, encoding: "utf8" });
  try {
    assert.equal(cli("init", "m", "org.example.lab").status, 0);
    assert.equal(cli("keygen", "k").status, 0);
    assert.equal(cli("pack", "m/module.json", "--out", "lab.estpkg.json", "--key", "k.private.pem", "--key-id", "k").status, 0);
    let r = cli("index", "--out", "estampes-index.json", "--key", "k.private.pem", "--key-id", "k", "--publisher", "Ex Author", "--scope", "org.example", "lab.estpkg.json");
    assert.equal(r.status, 0, r.stderr);
    const fp = /Key fingerprint, for your README: (sha256:[0-9a-f]{64})/.exec(r.stdout)[1];
    r = cli("source", "add", "ex", join(work, "estampes-index.json"));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, new RegExp("Fingerprint: " + fp));
    assert.match(r.stderr, /--accept/);
    r = cli("source", "add", "ex", join(work, "estampes-index.json"), "--accept", fp);
    assert.equal(r.status, 0, r.stderr);
    r = cli("source", "sync");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /ok {3}ex org\.example\.lab 0\.1\.0 {2}-> inbox\/org\.example\.lab-0\.1\.0\.estpkg\.json/);
    assert.match(cli("inbox").stdout, /ok {3}org\.example\.lab 0\.1\.0 signed by Ex Author/);
    assert.match(cli("source", "add", "x", "http://example.org/i.json").stderr, /only https URLs/);
  } finally { await rm(storage, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); }
});
