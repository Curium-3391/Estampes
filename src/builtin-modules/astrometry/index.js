// Plate solving through Astrometry.net. All network access goes through the
// Core's egress service (host allow-list, no redirects, secrets substituted by
// the server), so the module only describes which requests to make.
import { readFileSync } from "node:fs";
import { skyMapOperations } from "./skymap.js";

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

// Which annotations to draw: bright named stars first, then deep-sky objects,
// then the rest; a label that would sit on one already drawn is skipped, so
// a crowded field shows fewer, readable marks instead of a pile of text.
const rank = (a) => (a.type === "bright_star" ? 0 : /^(ngc|ic|messier)/i.test(String(a.type ?? "")) ? 1 : 2);
export function pickMarks(annotations, { width, height, limit }) {
  const usable = annotations.filter((a) => Array.isArray(a.names) && a.names.length && Number.isFinite(a.pixelx) && Number.isFinite(a.pixely)
    && a.pixelx >= 0 && a.pixelx <= width && a.pixely >= 0 && a.pixely <= height);
  const order = usable.map((a, i) => ({ a, i })).sort((p, q) => rank(p.a) - rank(q.a) || p.i - q.i);
  const taken = [], picked = [];
  for (const { a } of order) {
    if (picked.length >= limit) break;
    const name = String(a.names[0]).slice(0, 60);
    const rpx = Math.max(8, Number(a.radius) || 0);
    const box = { x0: a.pixelx - rpx, x1: a.pixelx + rpx + 6 + name.length * 7, y0: a.pixely - Math.max(rpx, 8), y1: a.pixely + Math.max(rpx, 8) };
    if (taken.some((t) => box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0)) continue;
    taken.push(box);
    picked.push({ a, name, x: a.pixelx / width, y: a.pixely / height, r: Math.min(0.08, rpx / width) });
  }
  return picked;
}

const num = (v, digits) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(digits)) : undefined);

const pad = (n, w = 2) => String(n).padStart(w, "0");
export function hms(raDeg) {
  const total = ((raDeg % 360) + 360) % 360 / 15, h = Math.floor(total), m = Math.floor((total - h) * 60), sec = ((total - h) * 60 - m) * 60;
  return pad(h) + "h " + pad(m) + "m " + pad(sec.toFixed(2), 5) + "s";
}
export function dms(decDeg) {
  const a = Math.abs(decDeg), d = Math.floor(a), m = Math.floor((a - d) * 60), sec = ((a - d) * 60 - m) * 60;
  return (decDeg < 0 ? "-" : "+") + pad(d) + "° " + pad(m) + "' " + pad(sec.toFixed(1), 4) + '"';
}
const text = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);

// The sky map needs no network: it draws a field given by its centre and size.
function skyPosition(params, ctx) {
  const { width, height } = ctx.canvas;
  const { operations, wraps } = skyMapOperations({ raDeg: params.raDeg, decDeg: params.decDeg, widthDeg: params.fieldWidthDeg ?? 5, heightDeg: params.fieldHeightDeg ?? params.fieldWidthDeg ?? 5,
    rotationDeg: params.rotationDeg ?? 0, title: params.title }, { width, height });
  return { operations, method: "Hammer all-sky projection of the solved field",
    summary: "sky map of RA " + params.raDeg + "°, Dec " + params.decDeg + "°" + (wraps ? " (the field crosses the map edge at RA 180°, so only its centre is shown)" : ""),
    data: { footprint: wraps ? "centre only" : "outline" } };
}

export async function run(capability, params, ctx) {
  if (capability === "sky_position") return skyPosition(params, ctx);
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
  // Constellation tags and the objects Astrometry.net lists for the field; optional, never fails the solve.
  let info = {};
  try { info = await get(ctx, "/api/jobs/" + jobId + "/info/"); } catch { /* the calibration alone is enough */ }

  const { width, height } = ctx.canvas;
  const operations = [];
  const objects = [];
  for (const { a, name, x, y, r } of pickMarks(ann.annotations ?? [], { width, height, limit: params.maxMarks ?? 20 })) {
    operations.push({ op: "object.create", type: "shape", props: { kind: "circle", x, y, r, style: { color: "cyan", width: 1.5 } } });
    operations.push({ op: "object.create", type: "shape", props: { kind: "text", x: Math.min(0.97, x + r + 0.004), y, text: name, size: 12, style: { color: "cyan" } } });
    objects.push({ name, type: a.type ?? undefined, x: Math.round(a.pixelx), y: Math.round(a.pixely) });
  }
  const fieldWidthDeg = num((cal.pixscale * width) / 3600, 4), fieldHeightDeg = num((cal.pixscale * height) / 3600, 4);
  const tags = (Array.isArray(info.tags) ? info.tags : []).filter((t) => typeof t === "string").map((t) => t.slice(0, 80)).slice(0, 20);
  const inField = (Array.isArray(info.objects_in_field) ? info.objects_in_field : []).filter((t) => typeof t === "string").map((t) => t.slice(0, 60)).slice(0, 30);
  const links = {
    result: "https://nova.astrometry.net/status/" + up.subid,
    wcs: "https://nova.astrometry.net/wcs_file/" + jobId,
    newImage: "https://nova.astrometry.net/new_fits_file/" + jobId,
    correspondences: "https://nova.astrometry.net/corr_file/" + jobId,
    legacySurveys: "https://www.legacysurvey.org/viewer?ra=" + num(cal.ra, 5) + "&dec=" + num(cal.dec, 5) + "&zoom=" + Math.max(1, Math.min(16, Math.round(Math.log2(360 / Math.max(fieldWidthDeg ?? 1, 0.01))))),
  };
  const data = {
    solved: true, submission: up.subid, job: jobId,
    raDeg: num(cal.ra, 5), decDeg: num(cal.dec, 5), raHms: hms(cal.ra), decDms: dms(cal.dec), arcsecPerPixel: num(cal.pixscale, 4), rotationDeg: num(cal.orientation, 3),
    radiusDeg: num(cal.radius, 4), parity: cal.parity, fieldWidthDeg, fieldHeightDeg,
    ...(tags.length ? { tags } : {}), ...(inField.length ? { objectsInField: inField } : {}), objects, links, link: links.result,
  };
  // The fact sheet shown beside the canvas, like the Calibration block on the Astrometry.net result page.
  const rows = [
    { label: "中心 (RA, Dec)", value: "(" + data.raDeg + ", " + data.decDeg + ")" },
    { label: "中心 RA (時分秒)", value: data.raHms }, { label: "中心 Dec (度分秒)", value: data.decDms },
    { label: "視野大小", value: fieldWidthDeg + " × " + fieldHeightDeg + " °" }, { label: "半徑", value: data.radiusDeg + " °" },
    { label: "像素比例", value: data.arcsecPerPixel + " arcsec/pixel" },
    { label: "方向（可能不準）", value: "上方朝向東偏北 " + data.rotationDeg + "°" },
    ...(tags.length ? [{ label: "星座與標籤", value: tags.join("；").slice(0, 240) }] : []),
    ...(inField.length ? [{ label: "視野內天體", value: inField.slice(0, 12).join("、").slice(0, 240) }] : []),
    { label: "Astrometry.net 結果頁", value: "開啟", href: links.result }, { label: "WCS 檔", value: "wcs.fits", href: links.wcs },
    { label: "Legacy Surveys 星空瀏覽", value: "瀏覽天空", href: links.legacySurveys },
  ];
  operations.push({ op: "object.create", type: "info-card", props: { title: "星圖解算結果（Astrometry.net）", shown: params.showCard !== false, rows } });
  return { operations, data, method: "Astrometry.net plate solving",
    summary: "solved: RA " + data.raDeg + "°, Dec " + data.decDeg + "°, " + data.arcsecPerPixel + " arcsec/px, rotation " + data.rotationDeg + "°; marked " + objects.length + " named objects" };
}
