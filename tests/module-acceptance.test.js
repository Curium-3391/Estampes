// External-developer acceptance, automated: the three cases of
// docs/modules/ACCEPTANCE.md, each from a clean folder, using only the CLI and
// the public module contract (no change to core, no import of src/ by the
// module). For each: test -> keygen -> pack -> signed index -> source add
// (fingerprint accepted) -> source sync -> install (user consent +
// administrator approve <planId>) -> enable -> run -> result on the canvas.
// The http case runs against a fake https service (no real network).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { resolveAdminKey } from "../src/modules/admin.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { canvasObjects } from "../src/scene/scene-ops.js";

const version = JSON.parse(spawnSync(process.execPath, ["-p", "JSON.stringify(require('./package.json').version)"], { encoding: "utf8" }).stdout);
const canvases = { ensure: ensureImage, create: createBlankCanvas, save: async () => {} };

async function publishAndInstall(example, id, { extraFiles = [], secret, transport } = {}) {
  const storage = await mkdtemp(join(tmpdir(), "estampes-acc-store-"));
  const work = await mkdtemp(join(tmpdir(), "estampes-acc-work-"));
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [join(process.cwd(), "scripts/estampes-module.js"), ...args], { cwd: work, env: { ...process.env, ESTAMPES_STORAGE_DIR: storage }, encoding: "utf8", input: args[0] === "secret" ? secret : undefined });
    return r;
  };
  const ok = (r) => { assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout; };
  await cp(join("examples/modules", example), join(work, "mod"), { recursive: true });
  assert.match(ok(cli("test", "mod/module.json")), new RegExp("^OK " + id.replace(/\./g, "\\.") + " "));
  ok(cli("keygen", "acme"));
  const pkgFile = id + "-1.0.0.estpkg.json";
  ok(cli("pack", "mod/module.json", "--out", pkgFile, "--key", "acme.private.pem", "--key-id", "acme", ...extraFiles.flatMap((f) => ["--file", f + "=mod/" + f])));
  const fp = /(sha256:[0-9a-f]{64})/.exec(ok(cli("index", "--out", "estampes-index.json", "--key", "acme.private.pem", "--key-id", "acme", "--publisher", "Acme Labs", "--scope", "org.acme", pkgFile)))[1];
  // The administrator: add the source, accept the fingerprint, sync.
  assert.match(cli("source", "add", "acme", join(work, "estampes-index.json")).stdout, new RegExp("Fingerprint: " + fp));
  ok(cli("source", "add", "acme", join(work, "estampes-index.json"), "--accept", fp));
  assert.match(ok(cli("source", "sync")), new RegExp("ok   acme " + id.replace(/\./g, "\\.") + " 1\\.0\\.0"));
  if (secret) ok(cli("secret", "set", id, "api_key"));

  const { key: adminKey } = await resolveAdminKey({ storageDir: storage });
  const h = await createModuleHost({ storageDir: storage, coreVersion: version, canvases, adminKey, ...(transport ? { transport } : {}) });
  for (const action of ["install", "enable"]) {
    const plan = await h.lifecycle.prepare(action, id);
    if (plan.requiresAdmin) ok(cli("approve", plan.planId));
    await h.lifecycle.commit(plan.planId, { consent: plan.consent });
  }
  assert.equal(h.registry.record(id).state, "enabled");
  return { h, cleanup: async () => { await rm(storage, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); } };
}

test("acceptance 1, declarative: numbered markers", { timeout: 60000 }, async () => {
  const { h, cleanup } = await publishAndInstall("markers", "org.acme.markers");
  try {
    const entry = await createBlankCanvas({});
    await h.router.execute({ module: "org.acme.markers", capability: "place_markers", canvas: entry.imageId,
      params: { markers: [{ x: 0.2, y: 0.3, label: "crack" }, { x: 0.6, y: 0.5, label: "stain" }, { x: 0.8, y: 0.8, label: "chip" }], color: "gold" } });
    const objs = canvasObjects(entry);
    assert.equal(objs.length, 9);
    assert.deepEqual(objs.filter((o) => o.props.kind === "circle").map((o) => [o.props.x, o.props.style.color]), [[0.2, "gold"], [0.6, "gold"], [0.8, "gold"]]);
    assert.deepEqual(objs.filter((o) => o.props.kind === "text").map((o) => o.props.text), ["1", "2", "3", "crack", "stain", "chip"]);
  } finally { await cleanup(); }
});

test("acceptance 2, WebAssembly: least-squares line fit", { timeout: 60000 }, async () => {
  const { h, cleanup } = await publishAndInstall("linefit", "org.acme.linefit", { extraFiles: ["linefit.wasm"] });
  try {
    const run = await h.router.execute({ module: "org.acme.linefit", capability: "fit_line", newCanvas: {},
      params: { points: [[0, 0.9], [1, 3.1], [2, 4.9], [3, 7.2], [4, 8.9]] } });
    // numbers checked against an independent computation
    const xs = [0, 1, 2, 3, 4], ys = [0.9, 3.1, 4.9, 7.2, 8.9], n = 5, mx = 2, my = ys.reduce((a, b) => a + b) / n;
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    assert.ok(Math.abs(run.data.slope - sxy / sxx) < 1e-8, JSON.stringify(run.data));
    assert.ok(Math.abs(run.data.intercept - (my - (sxy / sxx) * mx)) < 1e-8);
    const objs = canvasObjects(run.entry);
    assert.deepEqual(objs.map((o) => o.type + (o.props.kind ? ":" + o.props.kind : "")), ["axes-2d", "shape:dots", "shape:polyline", "info-card"]);
    assert.equal(objs[1].props.frame, objs[0].id);
    await assert.rejects(h.router.execute({ module: "org.acme.linefit", capability: "fit_line", newCanvas: {}, params: { points: [[1, 1], [1, 2]] } }), /all x values are equal/);
  } finally { await cleanup(); }
});

test("acceptance 3, http: external analysis service, result on the canvas", { timeout: 60000 }, async () => {
  const seen = [];
  const transport = async (req) => {
    seen.push(req);
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ result: { summary: "Rust on the left hinge", keywords: [{ term: "rust", weight: 0.9 }, { term: "hinge", weight: 0.7 }] } })) };
  };
  const { h, cleanup } = await publishAndInstall("keywords", "org.acme.keywords", { secret: "KEY-acceptance-123", transport });
  try {
    const entry = await createBlankCanvas({});
    const run = await h.router.execute({ module: "org.acme.keywords", capability: "analyze", canvas: entry.imageId, params: { text: "There is rust on the left hinge.", top: 2, x: 0.1, y: 0.9 } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, "api.analysis.example.org");
    assert.equal(seen[0].headers.authorization, "Bearer KEY-acceptance-123");
    assert.deepEqual(JSON.parse(seen[0].body.toString()), { text: "There is rust on the left hinge.", top: 2 });
    const objs = canvasObjects(entry);
    assert.equal(objs.find((o) => o.props.kind === "text").props.text, "Rust on the left hinge");
    assert.deepEqual(objs.find((o) => o.type === "info-card").props.rows, [{ label: "rust", value: "0.9" }, { label: "hinge", value: "0.7" }]);
    assert.equal(run.data.summary, "Rust on the left hinge");
    assert.ok(!JSON.stringify(await h.audit.read()).includes("KEY-acceptance-123"));
  } finally { await cleanup(); }
});
