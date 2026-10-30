// Plate solving through Astrometry.net. All network access goes through the
// Core's egress service (host allow-list, no redirects, secrets substituted by
// the server), so the module only describes which requests to make.
import { readFileSync } from "node:fs";

export const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

const HOST = "nova.astrometry.net";
// Tests make this short.
export const settings = { pollMs: 5000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function imageKind(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return { contentType: "image/jpeg", filename: "image.jpg" };
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { contentType: "image/png", filename: "image.png" };
  return null;
}

const json = (res) => { try { return JSON.parse(res.body.toString("utf8")); } catch { throw new Error("Astrometry.net did not answer with JSON"); } };
const get = (ctx, path) => ctx.http({ method: "GET", host: HOST, path }).then(json);

async function login(ctx) {
  const res = json(await ctx.http({ method: "POST", host: HOST, path: "/api/login", form: { "request-json": JSON.stringify({ apikey: "${secret:api_key}" }) } }));
  if (res.status !== "success" || !res.session) throw new Error("Astrometry.net refused the API key (" + (res.errormessage ?? res.status) + "). Check the key the administrator set");
  return res.session;
}

function uploadOptions(session, p) {
  const o = { session, publicly_visible: "n", allow_commercial_use: "n", allow_modifications: "n" };
  if (p.scaleLowArcsecPerPixel !== undefined && p.scaleHighArcsecPerPixel !== undefined) {
    Object.assign(o, { scale_units: "arcsecperpix", scale_type: "ul", scale_lower: p.scaleLowArcsecPerPixel, scale_upper: p.scaleHighArcsecPerPixel });
  } else if (p.scaleLowArcsecPerPixel !== undefined || p.scaleHighArcsecPerPixel !== undefined) {
    throw new Error("give both scaleLowArcsecPerPixel and scaleHighArcsecPerPixel, or neither");
  }
  if (p.centerRa !== undefined || p.centerDec !== undefined || p.radiusDeg !== undefined) {
    if (p.centerRa === undefined || p.centerDec === undefined || p.radiusDeg === undefined) throw new Error("give centerRa, centerDec and radiusDeg together, or none of them");
    Object.assign(o, { center_ra: p.centerRa, center_dec: p.centerDec, radius: p.radiusDeg });
  }
  return o;
}

async function waitFor(ctx, poll) {
  const deadline = Date.now() + (ctx.limits?.jobMs ?? 600000);
  for (;;) {
    if (ctx.cancelled?.()) throw new Error("cancelled");
    const out = await poll();
    if (out !== undefined) return out;
    if (Date.now() > deadline) throw new Error("Astrometry.net did not finish in time");
    await sleep(settings.pollMs);
  }
}

const num = (v, digits) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(digits)) : undefined);

export async function run(capability, params, ctx) {
  if (capability !== "solve_field") throw new Error("unknown capability " + capability);
  if (!ctx.http) throw new Error("this module needs network and secret permissions");
  if (!ctx.readSource) throw new Error("this module needs permission to read the image");
  uploadOptions("", params); // refuse bad hints before any network call
  const bytes = await ctx.readSource();
  if (!bytes) throw new Error("this server has no stored copy of the image (storage must be on), so it cannot upload it");
  const kind = imageKind(bytes);
  if (!kind) throw new Error("Astrometry.net takes JPEG or PNG images; this image is another format");

  ctx.progress?.("signing in");
  const session = await login(ctx);
  ctx.progress?.("uploading");
  const up = json(await ctx.http({ method: "POST", host: HOST, path: "/api/upload", multipart: {
    fields: { "request-json": JSON.stringify(uploadOptions(session, params)) },
    file: { field: "file", filename: kind.filename, contentType: kind.contentType, bytes },
  } }));
  if (up.status !== "success" || !Number.isInteger(up.subid)) throw new Error("Astrometry.net did not accept the upload (" + (up.errormessage ?? up.status) + ")");

  ctx.progress?.("waiting for a solver");
  const jobId = await waitFor(ctx, async () => {
    const sub = await get(ctx, "/api/submissions/" + up.subid);
    const id = (sub.jobs ?? []).find((j) => Number.isInteger(j));
    return id ?? undefined;
  });
  ctx.progress?.("solving");
  const status = await waitFor(ctx, async () => {
    const info = await get(ctx, "/api/jobs/" + jobId);
    return info.status === "success" || info.status === "failure" ? info.status : undefined;
  });
  if (status === "failure") {
    return { summary: "Astrometry.net could not solve this image", data: { solved: false, submission: up.subid, job: jobId,
      hint: "Try scale hints, a sharper or longer exposure, or remove strong light pollution and lens distortion" } };
  }
  ctx.progress?.("reading the solution");
  const cal = await get(ctx, "/api/jobs/" + jobId + "/calibration/");
  const ann = await get(ctx, "/api/jobs/" + jobId + "/annotations/");

  const { width, height } = ctx.canvas;
  const limit = params.maxMarks ?? 20;
  const named = (ann.annotations ?? []).filter((a) => Array.isArray(a.names) && a.names.length && Number.isFinite(a.pixelx) && Number.isFinite(a.pixely)
    && a.pixelx >= 0 && a.pixelx <= width && a.pixely >= 0 && a.pixely <= height).slice(0, limit);
  const operations = [];
  const objects = [];
  for (const a of named) {
    const name = String(a.names[0]).slice(0, 60);
    const x = a.pixelx / width, y = a.pixely / height, r = Math.min(0.08, Math.max(8, Number(a.radius) || 0) / width);
    operations.push({ op: "object.create", type: "shape", props: { kind: "circle", x, y, r, style: { color: "cyan", width: 1.5 } } });
    operations.push({ op: "object.create", type: "shape", props: { kind: "text", x: Math.min(0.97, x + r + 0.004), y, text: name, size: 12, style: { color: "cyan" } } });
    objects.push({ name, type: a.type ?? undefined, x: Math.round(a.pixelx), y: Math.round(a.pixely) });
  }
  const data = {
    solved: true, submission: up.subid, job: jobId,
    raDeg: num(cal.ra, 5), decDeg: num(cal.dec, 5), arcsecPerPixel: num(cal.pixscale, 4), rotationDeg: num(cal.orientation, 3),
    radiusDeg: num(cal.radius, 4), parity: cal.parity, fieldWidthDeg: num((cal.pixscale * width) / 3600, 4), fieldHeightDeg: num((cal.pixscale * height) / 3600, 4),
    objects, link: "https://nova.astrometry.net/status/" + up.subid,
  };
  return { operations, data, method: "Astrometry.net plate solving",
    summary: "solved: RA " + data.raDeg + "°, Dec " + data.decDeg + "°, " + data.arcsecPerPixel + " arcsec/px, rotation " + data.rotationDeg + "°; marked " + objects.length + " named objects" };
}
