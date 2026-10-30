import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../src/modules/index.js";
import { resolveAdminKey, writeApproval } from "../src/modules/admin.js";
import { createSecrets } from "../src/modules/egress.js";
import { createBlankCanvas } from "../src/scene/blank-canvas.js";
import { ensureImage } from "../src/storage.js";
import { canvasObjects } from "../src/scene/scene-ops.js";
import { settings } from "../src/builtin-modules/astrometry/index.js";

settings.pollMs = 5;
const ID = "org.estampes.astrometry";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const ok = (obj) => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(obj)) });

// A fake nova.astrometry.net. `script` can change what the job reports.
function fakeSite({ jobStatus = ["solving", "success"], annotations } = {}) {
  const seen = [];
  let polls = 0;
  const transport = async (req) => {
    seen.push(req);
    if (req.path === "/api/login") return ok({ status: "success", session: "sess-abc" });
    if (req.path === "/api/upload") return ok({ status: "success", subid: 4242 });
    if (req.path === "/api/submissions/4242") return ok({ jobs: polls++ < 1 ? [null] : [777] });
    if (req.path === "/api/jobs/777") return ok({ status: jobStatus.shift() ?? jobStatus.at(-1) ?? "success" });
    if (req.path === "/api/jobs/777/calibration/") return ok({ ra: 83.822, dec: -5.391, pixscale: 12.5, orientation: 33.2, radius: 2.1, parity: 1 });
    if (req.path === "/api/jobs/777/info/") return ok({ tags: ["The constellation Aquila (Aql)", "The constellation Scutum (Sct)"], objects_in_field: ["M11", "Altair"] });
    if (req.path === "/api/jobs/777/annotations/") return ok({ annotations: annotations ?? [
      { type: "ngc", names: ["M42", "NGC 1976"], pixelx: 800, pixely: 500, radius: 30 },
      { type: "star", names: ["Alnitak"], pixelx: 200, pixely: 100, radius: 0 },
      { type: "star", names: ["Offscreen"], pixelx: 5000, pixely: 100, radius: 0 },
      { type: "star", names: [], pixelx: 10, pixely: 10, radius: 0 },
    ] });
    return { status: 404, headers: {}, body: Buffer.from("{}") };
  };
  return { transport, seen };
}

async function boot(transport, { source = JPEG, key = "KEY-0123456789" } = {}) {
  const storage = await mkdtemp(join(tmpdir(), "estampes-astro-"));
  const { key: admin } = await resolveAdminKey({ storageDir: storage });
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.16.0", adminKey: admin, transport,
    canvases: { ensure: ensureImage, create: createBlankCanvas, save: async () => {} }, readSource: async () => source });
  if (key) await createSecrets({ dir: join(storage, "modules") }).set(ID, "api_key", key);
  const plan = await h.lifecycle.prepare("enable", ID);
  await writeApproval(storage, admin, plan.planId);
  await h.lifecycle.commit(plan.planId, { consent: plan.consent });
  const entry = await createBlankCanvas({});
  return { h, entry, storage };
}
const start = (h, entry, params = {}) => h.router.execute({ module: ID, capability: "solve_field", canvas: entry.imageId, params });
const finished = (h, id) => h.jobs.wait(id, 8000);

test("plate solving runs as a background job and marks the named objects", async () => {
  const site = fakeSite();
  const { h, entry } = await boot(site.transport);
  const started = await start(h, entry, { scaleLowArcsecPerPixel: 5, scaleHighArcsecPerPixel: 20 });
  assert.match(started.job.id, /^job_[a-f0-9]{12}$/);
  assert.equal(started.job.status, "running");
  assert.equal(canvasObjects(entry).length, 0, "nothing lands before the job finishes");
  const job = await finished(h, started.job.id);
  assert.equal(job.status, "done", job.error);
  assert.equal(job.data.solved, true);
  assert.equal(job.data.raDeg, 83.822);
  assert.equal(job.data.arcsecPerPixel, 12.5);
  assert.deepEqual(job.data.objects.map((o) => o.name), ["M42", "Alnitak"]);
  // two objects on the picture, each a circle plus a label, and one fact sheet
  assert.equal(canvasObjects(entry).length, 5);
  assert.equal(job.created.length, 5);
  const card = canvasObjects(entry).find((o) => o.type === "info-card");
  const row = (label) => card.props.rows.find((r) => r.label.startsWith(label));
  assert.match(row("中心 RA").value, /^05h 35m 17\.\d+s$/);
  assert.match(row("星座").value, /Aquila.*Scutum/);
  assert.match(row("Legacy").href, /^https:\/\/www\.legacysurvey\.org\/viewer\?ra=83\.822&dec=-5\.391&zoom=\d+$/);
  assert.equal(row("WCS").href, "https://nova.astrometry.net/wcs_file/777");
  assert.deepEqual(job.data.tags, ["The constellation Aquila (Aql)", "The constellation Scutum (Sct)"]);
  assert.match(job.data.links.result, /status\/4242$/);

  // The key never leaves through the module: it reached only the login request body.
  const login = site.seen.find((r) => r.path === "/api/login");
  assert.match(login.body.toString(), /KEY-0123456789/);
  const upload = site.seen.find((r) => r.path === "/api/upload");
  assert.ok(!upload.body.toString("latin1").includes("KEY-0123456789"));
  assert.match(upload.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.match(upload.body.toString("latin1"), /"scale_lower":5/);
  assert.match(upload.body.toString("latin1"), /"session":"sess-abc"/);
  assert.match(upload.body.toString("latin1"), /"publicly_visible":"n"/);
  assert.ok(site.seen.every((r) => r.host === "nova.astrometry.net"));
  assert.ok(!JSON.stringify(await h.audit.read()).includes("KEY-0123456789"));
  assert.ok(!JSON.stringify(h.jobs.list()).includes("KEY-0123456789"));
});

test("a failed solve is reported as a result, not an error, and changes nothing", async () => {
  const { h, entry } = await boot(fakeSite({ jobStatus: ["failure"] }).transport);
  const job = await finished(h, (await start(h, entry)).job.id);
  assert.equal(job.status, "done");
  assert.equal(job.data.solved, false);
  assert.equal(canvasObjects(entry).length, 0);
});

test("errors become a failed job with a plain reason", async () => {
  let c = await boot(fakeSite().transport, { key: "" });
  let job = await finished(c.h, (await start(c.h, c.entry)).job.id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /has not set the secret api_key/);

  c = await boot(async () => ok({ status: "error", errormessage: "bad apikey" }));
  job = await finished(c.h, (await start(c.h, c.entry)).job.id);
  assert.match(job.error, /refused the API key/);

  c = await boot(fakeSite().transport, { source: null });
  job = await finished(c.h, (await start(c.h, c.entry)).job.id);
  assert.match(job.error, /no stored copy/);

  c = await boot(fakeSite().transport, { source: Buffer.from("GIF89a....") });
  job = await finished(c.h, (await start(c.h, c.entry)).job.id);
  assert.match(job.error, /JPEG or PNG/);

  c = await boot(fakeSite().transport);
  job = await finished(c.h, (await start(c.h, c.entry, { scaleLowArcsecPerPixel: 5 })).job.id);
  assert.match(job.error, /both scaleLowArcsecPerPixel and scaleHighArcsecPerPixel/);
});

test("a job that runs too long is stopped and never applies its result later", async () => {
  const site = fakeSite({ jobStatus: Array(100000).fill("solving") });
  const { h, entry } = await boot(site.transport);
  h.registry.get(ID).manifest.limits.jobMs = 1000;
  const job = await finished(h, (await start(h, entry)).job.id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /took longer/);
  const polled = site.seen.length;
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(site.seen.length - polled <= 2, "polling stops after the limit");
  assert.equal(canvasObjects(entry).length, 0);
});

test("jobs survive a restart as interrupted, and the id format is checked", async () => {
  const { h, storage } = await boot(fakeSite({ jobStatus: Array(100000).fill("solving") }).transport);
  const entry = await createBlankCanvas({});
  h.registry.get(ID).manifest.limits.jobMs = 1000;
  const running = (await start(h, entry)).job;
  await h.jobs.flush();
  const again = await createModuleHost({ storageDir: storage, coreVersion: "0.16.0", canvases: { ensure: ensureImage, create: createBlankCanvas, save: async () => {} } });
  assert.equal(again.jobs.get(running.id).status, "interrupted");
  assert.equal(again.jobs.get("job_nope"), null);
  await finished(h, running.id); // let it stop so the test process can end
});

test("the module cannot run unless the user granted its permissions", async () => {
  const storage = await mkdtemp(join(tmpdir(), "estampes-astro-"));
  const h = await createModuleHost({ storageDir: storage, coreVersion: "0.16.0", canvases: { ensure: ensureImage, create: createBlankCanvas, save: async () => {} } });
  const entry = await createBlankCanvas({});
  await assert.rejects(start(h, entry), /Only the user can enable/);
});

test("job tools return the canvas payload, so the widget shows the photo and not its sample", async () => {
  const { registerModuleTools } = await import("../src/modules/mcp-tools.js");
  const { h, entry } = await boot(fakeSite().transport);
  const tools = new Map();
  const server = { registerTool: (name, spec, handler) => tools.set(name, { spec, handler }), registerResource() {} };
  registerModuleTools(server, { host: h, storeUri: "ui://s", storeHtml: "", visualUri: "ui://v", logSizes: (_n, r) => r,
    canvasPayload: async (e) => ({ structuredContent: { kind: "estampes.visual_surface", imageId: e.imageId }, _meta: { "estampes/image": "px" } }),
    ensureImage: async () => entry, saveCanvas: async () => {}, canvasLayers: () => [] });
  const started = await tools.get("execute_module").handler({ module: ID, capability: "solve_field", params: {}, canvas: entry.imageId, visibility: "public", preview: true });
  assert.equal(started.structuredContent.kind, "estampes.module_job");
  assert.equal(started.structuredContent.imageId, entry.imageId);
  assert.equal(started._meta["estampes/image"], "px");
  const id = started.structuredContent.job.id;
  const checked = await tools.get("get_module_job").handler({ job: id, waitSeconds: 5 });
  assert.equal(checked.structuredContent.job.status, "done");
  assert.equal(checked.structuredContent.imageId, entry.imageId);
  assert.ok(checked._meta["estampes/image"]);
  assert.equal(tools.get("get_module_job").spec._meta.ui.resourceUri, "ui://v");
});

test("marks: bright named stars come first and overlapping labels are skipped", async () => {
  const { pickMarks } = await import("../src/builtin-modules/astrometry/index.js");
  const ann = [
    { type: "hd", names: ["18 Cyg"], pixelx: 300, pixely: 300, radius: 0 },
    { type: "hd", names: ["19 Cyg"], pixelx: 305, pixely: 304, radius: 0 },
    { type: "ngc", names: ["M27"], pixelx: 900, pixely: 600, radius: 40 },
    { type: "bright_star", names: ["Altair"], pixelx: 1000, pixely: 400, radius: 0 },
    { type: "bright_star", names: ["Deneb"], pixelx: 1004, pixely: 402, radius: 0 },
    { type: "bright_star", names: ["Vega"], pixelx: 100, pixely: 100, radius: 0 },
  ];
  const marks = pickMarks(ann, { width: 2000, height: 1000, limit: 3 });
  assert.deepEqual(marks.map((m) => m.name), ["Altair", "Vega", "M27"]);
  assert.deepEqual(pickMarks(ann, { width: 2000, height: 1000, limit: 10 }).map((m) => m.name), ["Altair", "Vega", "M27", "18 Cyg"]);
});

test("the sky map draws the solved field with no network", async () => {
  const site = fakeSite();
  const { h } = await boot(site.transport);
  const out = await h.router.execute({ module: ID, capability: "sky_position", newCanvas: { background: "paper" },
    params: { raDeg: 286.76, decDeg: 12.42, fieldWidthDeg: 98.4, fieldHeightDeg: 67.9, rotationDeg: 71.3 } });
  assert.equal(site.seen.length, 0);
  assert.ok(out.createdCanvas && out.scene.created.length >= 20);
  const objs = canvasObjects(out.entry);
  assert.ok(objs.some((o) => o.props.kind === "polygon"), "the field outline");
  for (const o of objs.filter((o) => o.props.points)) assert.ok(o.props.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1));
  await assert.rejects(h.router.execute({ module: ID, capability: "sky_position", params: { raDeg: 400, decDeg: 0 } }), /raDeg/);
});

test("sky geometry: Hammer centre, RA grows to the left, field outline stays near its centre", async () => {
  const { hammer, fieldOutline } = await import("../src/builtin-modules/astrometry/skymap.js");
  assert.ok(Math.abs(hammer(0, 0).X) < 1e-9 && Math.abs(hammer(0, 0).Y) < 1e-9);
  assert.ok(hammer(60, 0).X < 0 && hammer(300, 0).X > 0);
  for (const p of fieldOutline({ raDeg: 100, decDeg: 20, widthDeg: 6, heightDeg: 4, rotationDeg: 30 })) {
    assert.ok(Math.abs(p.ra - 100) < 5 && Math.abs(p.dec - 20) < 5);
  }
});
