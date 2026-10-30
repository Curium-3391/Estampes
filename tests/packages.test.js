import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { resolveAdminKey, writeApproval } from "../src/modules/admin.js";
import { generateSigningKey, signBundle, verifyBundle, digestOf, parseBundle } from "../src/modules/packages.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { canvasObjects } from "../src/scene/scene-ops.js";

const callout = JSON.parse(await readFile(new URL("../examples/modules/callout/module.json", import.meta.url), "utf8"));
const canvases = { ensure: ensureImage, create: createBlankCanvas, save: async () => {} };
const keys = generateSigningKey();
const sign = (manifest, files = {}, keyId = "pub1") => signBundle({ schema: "estampes.package/1", manifest, files }, keys.privateKey, keyId);
const v = (version, extra = {}) => ({ ...structuredClone(callout), version, ...extra });

async function setup({ allowUnsigned = false, scopes = ["org.example"] } = {}) {
  const storage = await mkdtemp(join(tmpdir(), "estampes-pkg-"));
  const mods = join(storage, "modules");
  await mkdir(join(mods, "inbox"), { recursive: true });
  await writeFile(join(mods, "trusted-keys.json"), JSON.stringify([{ keyId: "pub1", publisher: "Example Publisher", publicKey: keys.publicKey, scopes }]));
  const { key } = await resolveAdminKey({ storageDir: storage });
  const boot = () => createModuleHost({ storageDir: storage, coreVersion: "0.10.0", canvases, adminKey: key, allowUnsigned });
  const put = (name, bundle) => writeFile(join(mods, "inbox", name + ".estpkg.json"), typeof bundle === "string" ? bundle : JSON.stringify(bundle));
  const commit = async (h, action, id, opts = {}, { approve = false } = {}) => {
    const plan = await h.lifecycle.prepare(action, id, opts);
    if (approve) await writeApproval(storage, key, plan.planId);
    return { plan, done: await h.lifecycle.commit(plan.planId, { consent: plan.consent }) };
  };
  return { storage, mods, key, boot, put, commit };
}

test("package verification: digest, signature, scope, tampering, reserved ids, bad files", () => {
  const trusted = new Map([["pub1", { keyId: "pub1", publicKey: keys.publicKey, publisher: "P", scopes: ["org.example"] }]]);
  const ok = verifyBundle(Buffer.from(JSON.stringify(sign(v("1.0.0")))), { trusted, coreVersion: "0.10.0" });
  assert.equal(ok.signer.keyId, "pub1");
  assert.equal(ok.digest, digestOf(sign(v("1.0.0"))));
  const tampered = sign(v("1.0.0")); tampered.manifest.permissions = ["canvas.write", "network.request.approved"];
  assert.throws(() => verifyBundle(Buffer.from(JSON.stringify(tampered)), { trusted, coreVersion: "0.10.0" }));
  const edited = sign(v("1.0.0")); edited.manifest.description = "changed after signing";
  assert.throws(() => verifyBundle(Buffer.from(JSON.stringify(edited)), { trusted, coreVersion: "0.10.0" }), /signature does not match/);
  assert.throws(() => verifyBundle(Buffer.from(JSON.stringify(sign(v("1.0.0", { id: "org.other.callout" })))), { trusted, coreVersion: "0.10.0" }), /not allowed to publish/);
  assert.throws(() => verifyBundle(Buffer.from(JSON.stringify(sign(v("1.0.0"), {}, "stranger"))), { trusted, coreVersion: "0.10.0" }), /does not trust/);
  assert.throws(() => verifyBundle(Buffer.from(JSON.stringify({ schema: "estampes.package/1", manifest: v("1.0.0") })), { trusted, coreVersion: "0.10.0" }), /not signed/);
  assert.throws(() => verifyBundle(Buffer.from(JSON.stringify(sign(v("1.0.0", { id: "org.estampes.graph" })))), { trusted, coreVersion: "0.10.0", reserved: new Set(["org.estampes.graph"]) }), /built-in/);
  assert.throws(() => verifyBundle(Buffer.from(JSON.stringify(sign(v("1.0.0", { runtime: { kind: "builtin", entry: "x" } })))), { trusted, coreVersion: "0.10.0" }), /builtin|declarative runtime/);
  for (const path of ["../evil", "/etc/passwd", "a/../b", "a\\b", ".hidden"]) {
    assert.throws(() => parseBundle(Buffer.from(JSON.stringify({ schema: "estampes.package/1", manifest: v("1.0.0"), files: { [path]: { encoding: "utf8", content: "x" } } }))), /unsafe file path|files/, path);
  }
  assert.throws(() => parseBundle(Buffer.alloc(3 * 1024 * 1024, 32)), /larger than/);
});

test("install needs consent AND the administrator's approval from the server; the chat cannot supply it", async () => {
  const s = await setup();
  await s.put("callout-1", sign(v("1.0.0")));
  const h = await s.boot();
  assert.equal((await h.packages.available())[0].signed, true);
  const plan = await h.lifecycle.prepare("install", "org.example.callout", {}, { by: "model" });
  assert.equal(plan.requiresAdmin, true);
  assert.equal(plan.toVersion, "1.0.0");
  // consent alone is not enough; neither is any admin-looking proof in the commit.
  await assert.rejects(h.lifecycle.commit(plan.planId, { consent: plan.consent, adminCode: s.key, adminToken: s.key }), /administrator approval/);
  assert.equal(h.registry.has("org.example.callout"), false);
  await writeApproval(s.storage, s.key, plan.planId);
  const done = await h.lifecycle.commit(plan.planId, { consent: plan.consent });
  assert.equal(done.result.state, "installed");
  // The approval file is single-use.
  const again = await h.lifecycle.prepare("uninstall", "org.example.callout");
  assert.equal(again.requiresAdmin, false);
  // A forged approval file (wrong MAC) is refused.
  const s2 = await setup(); await s2.put("c", sign(v("1.0.0"))); const h2 = await s2.boot();
  const p2 = await h2.lifecycle.prepare("install", "org.example.callout");
  await mkdir(join(s2.mods, "approvals"), { recursive: true });
  await writeFile(join(s2.mods, "approvals", p2.planId + ".json"), JSON.stringify({ planId: p2.planId, mac: "forged", at: new Date().toISOString() }));
  await assert.rejects(h2.lifecycle.commit(p2.planId, { consent: p2.consent }), /administrator approval/);
  assert.equal((await readdir(join(s2.mods, "approvals"))).length, 0, "a bad approval is consumed too");
});

test("installed package: enable, run, restart, lock file", async () => {
  const s = await setup();
  await s.put("callout-1", sign(v("1.0.0")));
  let h = await s.boot();
  await s.commit(h, "install", "org.example.callout", {}, { approve: true });
  await s.commit(h, "enable", "org.example.callout");
  const run = await h.router.execute({ module: "org.example.callout", capability: "add_callout", newCanvas: undefined, canvas: (await createBlankCanvas({})).imageId,
    params: { x: 0.1, y: 0.1, x2: 0.4, y2: 0.2, text: "Check here" } });
  assert.deepEqual(canvasObjects(run.entry).map((o) => o.type + ":" + o.props.kind), ["shape:rect", "shape:text"]);
  assert.equal(canvasObjects(run.entry)[0].provenance.module, "org.example.callout");
  const lock = JSON.parse(await readFile(join(s.mods, "lock.json"), "utf8"));
  assert.equal(lock.modules["org.example.callout"].active.version, "1.0.0");
  h = await s.boot();
  assert.equal(h.registry.record("org.example.callout").state, "enabled");
  assert.equal(h.registry.get("org.example.callout").package.keyId, "pub1");
});

test("update adds permissions, rollback restores the exact earlier bytes, tampered storage is refused at startup", async () => {
  const s = await setup();
  await s.put("callout-1", sign(v("1.0.0")));
  let h = await s.boot();
  await s.commit(h, "install", "org.example.callout", {}, { approve: true });
  await s.commit(h, "enable", "org.example.callout");
  const v2 = v("1.1.0", { permissions: ["canvas.write", "canvas.read"] });
  await s.put("callout-2", sign(v2));
  const upPlan = await h.lifecycle.prepare("update", "org.example.callout");
  assert.equal(upPlan.toVersion, "1.1.0");
  assert.deepEqual(upPlan.permissions.added.map((p) => p.id), ["canvas.read"]);
  await writeApproval(s.storage, s.key, upPlan.planId);
  await h.lifecycle.commit(upPlan.planId, { consent: upPlan.consent });
  let rec = h.registry.record("org.example.callout");
  assert.equal(rec.version, "1.1.0"); assert.equal(rec.state, "enabled"); assert.deepEqual(rec.granted, ["canvas.write", "canvas.read"]);
  const rb = await s.commit(h, "rollback", "org.example.callout");
  rec = h.registry.record("org.example.callout");
  assert.equal(rb.done.result.version, "1.0.0");
  assert.deepEqual(rec.granted, ["canvas.write"], "permissions go back too");
  assert.equal(h.registry.get("org.example.callout").package.sha256, digestOf(sign(v("1.0.0"))));
  await assert.rejects(h.lifecycle.prepare("rollback", "org.example.callout"), /no earlier version/);
  // Tamper with the stored active version: the next start refuses it.
  const file = join(s.mods, "packages", "org.example.callout", "1.0.0", "package.json");
  const bundle = JSON.parse(await readFile(file, "utf8")); bundle.manifest.description = "evil";
  const { chmod } = await import("node:fs/promises"); await chmod(file, 0o644); await writeFile(file, JSON.stringify(bundle));
  h = await s.boot();
  assert.equal(h.registry.record("org.example.callout").state, "failed");
  await assert.rejects(h.router.execute({ module: "org.example.callout", capability: "add_callout", params: {} }), /failed|no module/);
});

test("a package whose own example fails never becomes active; unsigned needs the explicit switch", async () => {
  const s = await setup();
  const broken = v("1.0.0"); broken.capabilities[0].examples = [{ description: "bad", params: { x: 0.1, y: 0.1, x2: 0.4, y2: 0.2, text: "x" } }];
  broken.capabilities[0].operations = [{ op: "object.create", type: "shape", props: { kind: "rect", x: { $param: "x" } } }];
  await s.put("broken", sign(broken));
  const h = await s.boot();
  const plan = await h.lifecycle.prepare("install", "org.example.callout"); await writeApproval(s.storage, s.key, plan.planId);
  await assert.rejects(h.lifecycle.commit(plan.planId, { consent: plan.consent }), /self-test/);
  assert.equal(h.registry.has("org.example.callout"), false);
  const u = await setup(); await u.put("unsigned", { schema: "estampes.package/1", manifest: v("1.0.0"), files: {} });
  const hu = await u.boot();
  assert.equal((await hu.packages.available())[0].error.includes("not signed"), true);
  const open = await setup({ allowUnsigned: true }); await open.put("unsigned", { schema: "estampes.package/1", manifest: v("1.0.0"), files: {} });
  const ho = await open.boot();
  const p = await ho.lifecycle.prepare("install", "org.example.callout");
  assert.equal(p.risk, "high"); assert.ok(p.notes.some((n) => /NOT signed/.test(n)));
});

test("uninstall keeps canvas objects; purge removes stored versions and needs admin", async () => {
  const s = await setup();
  await s.put("callout-1", sign(v("1.0.0")));
  const h = await s.boot();
  await s.commit(h, "install", "org.example.callout", {}, { approve: true });
  await s.commit(h, "enable", "org.example.callout");
  const entry = await createBlankCanvas({});
  await h.router.execute({ module: "org.example.callout", capability: "add_callout", canvas: entry.imageId, params: { x: 0.1, y: 0.1, x2: 0.3, y2: 0.2, text: "t" } });
  await s.commit(h, "uninstall", "org.example.callout");
  assert.equal(canvasObjects(entry).length, 2);
  assert.equal(h.registry.has("org.example.callout"), false);
  const purge = await h.lifecycle.prepare("purge", "org.example.callout");
  assert.equal(purge.requiresAdmin, true);
  await writeApproval(s.storage, s.key, purge.planId);
  await h.lifecycle.commit(purge.planId, { consent: purge.consent });
  await assert.rejects(readFile(join(s.mods, "packages", "org.example.callout", "1.0.0", "package.json")));
  const audit = (await h.audit.read()).map((e) => e.kind); await h.audit.flush();
  assert.ok(audit.includes("package.activated"));
});

test("purge and install refuse ids that are not module ids (no path traversal)", async () => {
  const s = await setup();
  const h = await s.boot();
  await assert.rejects(h.lifecycle.prepare("purge", "../../images"), /not a module id/);
  await assert.rejects(h.lifecycle.prepare("install", "../x"), /not a module id/);
});

test("a purge plan goes stale when the package is installed before it is confirmed", async () => {
  const s = await setup();
  await s.put("callout-1", sign(v("1.0.0")));
  const h = await s.boot();
  await s.commit(h, "install", "org.example.callout", {}, { approve: true });
  await s.commit(h, "uninstall", "org.example.callout");
  const purge = await h.lifecycle.prepare("purge", "org.example.callout");
  await s.commit(h, "install", "org.example.callout", {}, { approve: true });
  await writeApproval(s.storage, s.key, purge.planId);
  await assert.rejects(h.lifecycle.commit(purge.planId, { consent: purge.consent }), /installed after this plan/);
  await readFile(join(s.mods, "packages", "org.example.callout", "1.0.0", "package.json"));
});

test("a corrupted active version stays visible so it can be rolled back", async () => {
  const s = await setup();
  await s.put("callout-1", sign(v("1.0.0")));
  let h = await s.boot();
  await s.commit(h, "install", "org.example.callout", {}, { approve: true });
  await s.put("callout-2", sign(v("1.1.0")));
  await s.commit(h, "update", "org.example.callout", {}, { approve: true });
  const file = join(s.mods, "packages", "org.example.callout", "1.1.0", "package.json");
  const bundle = JSON.parse(await readFile(file, "utf8")); bundle.manifest.description = "evil";
  const { chmod } = await import("node:fs/promises"); await chmod(file, 0o644); await writeFile(file, JSON.stringify(bundle));
  h = await s.boot();
  assert.equal(h.registry.record("org.example.callout").state, "failed");
  assert.equal(h.registry.has("org.example.callout"), true);
  const rb = await s.commit(h, "rollback", "org.example.callout");
  assert.equal(rb.done.result.version, "1.0.0");
});

test("a rollback plan goes stale when another update lands first", async () => {
  const s = await setup();
  await s.put("callout-1", sign(v("1.0.0")));
  const h = await s.boot();
  await s.commit(h, "install", "org.example.callout", {}, { approve: true });
  await s.put("callout-2", sign(v("1.1.0")));
  await s.commit(h, "update", "org.example.callout", {}, { approve: true });
  const rb = await h.lifecycle.prepare("rollback", "org.example.callout");
  await s.put("callout-3", sign(v("1.2.0")));
  await s.commit(h, "update", "org.example.callout", {}, { approve: true });
  await assert.rejects(h.lifecycle.commit(rb.planId, { consent: rb.consent }), /changed after this rollback/);
});

test("an update plan goes stale when a newer version is installed first", async () => {
  const s = await setup();
  await s.put("callout-1", sign(v("1.0.0")));
  const h = await s.boot();
  await s.commit(h, "install", "org.example.callout", {}, { approve: true });
  await s.put("callout-2", sign(v("1.1.0")));
  const old = await h.lifecycle.prepare("update", "org.example.callout", { version: "1.1.0" });
  await s.put("callout-3", sign(v("1.2.0")));
  await s.commit(h, "update", "org.example.callout", { version: "1.2.0" }, { approve: true });
  await writeApproval(s.storage, s.key, old.planId);
  await assert.rejects(h.lifecycle.commit(old.planId, { consent: old.consent }), /out of date/);
  assert.equal(h.registry.record("org.example.callout").version, "1.2.0");
});

test("an install plan goes stale when the package is installed by another plan first", async () => {
  const s = await setup();
  await s.put("callout-1", sign(v("1.0.0")));
  const h = await s.boot();
  const a = await h.lifecycle.prepare("install", "org.example.callout");
  const b = await h.lifecycle.prepare("install", "org.example.callout");
  await writeApproval(s.storage, s.key, a.planId);
  await h.lifecycle.commit(a.planId, { consent: a.consent });
  await writeApproval(s.storage, s.key, b.planId);
  await assert.rejects(h.lifecycle.commit(b.planId, { consent: b.consent }), /installed after this plan/);
});
