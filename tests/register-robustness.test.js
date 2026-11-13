// register_images on a board-like photo pair (issue #68): large rotations,
// oblique views and bad lighting are aligned; unrelated boards are not;
// and "ok" is told apart from how far the fit can be trusted.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { registerImage, clearImages } from "../src/image-store.js";
import { registerPair } from "../src/image/register.js";
import { warp } from "../src/image/geometry.js";
import { apply, invert, chain, translate, rotate, scale, fitTransform } from "../src/image/transform.js";

beforeEach(() => clearImages());
const W = 768, H = 1024;

// A repetitive board: traces, chips with rows of identical pins, passives,
// pads, labels. Deterministic from `seed`.
function board(seed) {
  let s = seed; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#1d5b33"/>`;
  for (let i = 0; i < 90; i++) { let x = r() * W, y = r() * H, d = `M${x} ${y}`; for (let k = 0; k < 4; k++) { if (r() < 0.5) x += (r() - 0.5) * 220; else y += (r() - 0.5) * 220; d += ` L${x} ${y}`; } svg += `<path d="${d}" stroke="#3f8f58" stroke-width="${2 + r() * 3}" fill="none"/>`; }
  for (let i = 0; i < 10; i++) {
    const x = 40 + r() * (W - 220), y = 40 + r() * (H - 200), w = 50 + r() * 120, h = 50 + r() * 90;
    svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#222"/>`;
    for (let px = x + 4; px < x + w - 4; px += 9) svg += `<rect x="${px}" y="${y - 8}" width="4" height="8" fill="#ccc"/><rect x="${px}" y="${y + h}" width="4" height="8" fill="#ccc"/>`;
    svg += `<text x="${x + 6}" y="${y + h / 2}" font-size="${11 + r() * 8}" fill="#bbb" font-family="monospace">${Math.floor(r() * 1e6).toString(36).toUpperCase()}${Math.floor(r() * 999)}</text>`;
  }
  for (let i = 0; i < 170; i++) {
    const x = r() * W, y = r() * H, k = r();
    if (k < 0.35) svg += `<rect x="${x}" y="${y}" width="${10 + r() * 14}" height="${6 + r() * 8}" fill="${r() < 0.5 ? "#c9a36a" : "#333"}"/>`;
    else if (k < 0.6) svg += `<circle cx="${x}" cy="${y}" r="${3 + r() * 5}" fill="#d8d8c0"/><circle cx="${x}" cy="${y}" r="1.5" fill="#111"/>`;
    else if (k < 0.85) svg += `<text x="${x}" y="${y}" font-size="${9 + r() * 6}" fill="#eee" font-family="monospace">${"RCULQD"[Math.floor(r() * 6)]}${Math.floor(r() * 400)}</text>`;
    else svg += `<circle cx="${x}" cy="${y}" r="${8 + r() * 14}" fill="#8a8f95"/>`;
  }
  return sharp(Buffer.from(svg + "</svg>")).png().toBuffer();
}
const rawOf = async (buf) => { const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, width: info.width, height: info.height, channels: 3 }; };

// The transform that carries A pixels to B pixels: rotation and scale about
// the centre, then an oblique tilt.
function truth(deg, k, tilt) {
  const base = chain(translate(-W / 2, -H / 2), rotate(deg), scale(k), translate(W / 2, H / 2));
  if (!tilt) return base;
  const c = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => ({ x, y }));
  const t = [{ x: tilt * W, y: tilt * H * 0.6 }, { x: W - tilt * W * 0.3, y: 0 }, { x: W, y: H }, { x: 0, y: H - tilt * H * 0.8 }];
  return chain(base, fitTransform(c, t, "homography"));
}
// B: A seen through `Ht`, then uneven light, a soft bright patch, defocus, noise and JPEG.
async function photo(Abuf, Ht, { gamma = 1, gradient = 0, blur = 0, noise = 0, jpeg = 0, glare = 0 } = {}) {
  const out = warp(await rawOf(Abuf), invert(Ht), W, H, { fill: 40 }).img, d = Buffer.from(out.data);
  let s = 3; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    const i = (y * W + x) * 3 + c;
    d[i] = Math.max(0, Math.min(255, Math.round(Math.pow(d[i] / 255, gamma) * (1 + gradient * (x / W - 0.5) * 2) * 255 + (noise ? (r() + r() + r() - 1.5) * 2 * noise : 0))));
  }
  for (let g = 0; g < glare; g++) {
    const cx = r() * W, cy = r() * H, rx = 30 + r() * 100, ry = 20 + r() * 70;
    for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(H, cy + ry); y++) for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(W, cx + rx); x++) {
      const q = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (q < 1) for (let c = 0; c < 3; c++) { const i = (y * W + x) * 3 + c; d[i] = Math.min(255, d[i] + (1 - q) * 200); }
    }
  }
  let p = sharp(d, { raw: { width: W, height: H, channels: 3 } });
  if (blur) p = p.blur(blur);
  return jpeg ? p.jpeg({ quality: jpeg }).toBuffer() : p.png().toBuffer();
}
// Largest distance, in B pixels, between where the result and the truth send five points of A.
const worstError = (reg, Ht) => Math.max(...[[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8], [0.5, 0.5]].map(([x, y]) => {
  const p = apply(reg.pixelAtoB, x * W, y * H), q = apply(Ht, x * W, y * H); return Math.hypot(p.x - q.x, p.y - q.y);
}));
const register = async (Abuf, Bbuf, opts) => registerPair(await registerImage(Abuf, { source: "url" }), await registerImage(Bbuf, { source: "url" }), opts);

test("an oblique, defocused, unevenly lit view turned by a large angle is aligned to a few pixels", { timeout: 180000 }, async () => {
  const A = await board(1);
  const cases = [
    [40, 1, 0.3, { gamma: 0.6, gradient: 0.5, blur: 2.2, noise: 8, jpeg: 55, glare: 6 }],
    [120, 0.7, 0.38, { gamma: 1.6, gradient: -0.5, blur: 1.8, noise: 12, jpeg: 50, glare: 4 }],
    [215, 1.25, 0.25, { gamma: 0.8, gradient: 0.3, blur: 3, noise: 6, jpeg: 60, glare: 8 }],
    [90, 1, 0, {}],
  ];
  for (const [deg, k, tilt, light] of cases) {
    const Ht = truth(deg, k, tilt), B = await photo(A, Ht, light);
    const reg = await register(A, B, { method: "auto" });
    const name = `rot ${deg}, scale ${k}, tilt ${tilt}`;
    assert.equal(reg.status, "ok", name + ": " + JSON.stringify(reg.reasons));
    const err = worstError(reg, Ht);
    assert.ok(err < 8, name + ": worst error " + err.toFixed(1) + " px");
    // Many supporters, far above what a shifted transform finds by chance.
    assert.ok(reg.quality.inliers > 100 && reg.quality.inliers > 5 * reg.quality.chanceInliers, name + ": " + reg.quality.inliers + " vs chance " + reg.quality.chanceInliers);
    assert.ok(reg.quality.coverage > 0.4, name + ": coverage " + reg.quality.coverage);
    assert.equal(reg.alignmentConfidence, "high", name + ": " + JSON.stringify(reg.confidenceReasons));
    assert.equal(reg.quality.heldOut.scheme, "split-half");
    assert.ok(reg.quality.heldOut.medianErrorPx < 3, name + ": held-out " + reg.quality.heldOut.medianErrorPx);
  }
});

test("the same result on every call; unrelated boards, even with different light, are refused", { timeout: 180000 }, async () => {
  const A = await board(1), Ht = truth(70, 1, 0.2), B = await photo(A, Ht, { gamma: 0.7, blur: 1.5, noise: 6, jpeg: 70 });
  const first = await register(A, B, { method: "auto" });
  clearImages();
  const again = await register(A, B, { method: "auto" });
  assert.equal(first.status, "ok");
  assert.deepEqual(again.normalizedAtoB, first.normalizedAtoB);
  assert.equal(again.registrationId, first.registrationId);
  for (const seed of [7, 8, 9]) {
    clearImages();
    const other = await photo(await board(seed), truth(seed * 40, 1, seed % 2 ? 0.2 : 0), seed % 2 ? { gamma: 0.7, blur: 1.5, noise: 6, jpeg: 70, glare: 3 } : {});
    const bad = await register(A, other, { method: "auto" });
    assert.equal(bad.status, "failed", "board " + seed + " accepted");
    assert.equal(bad.alignmentConfidence, "none");
    assert.match(bad.reasons.join("; "), /not clearly above the \d+ that a shifted transform reaches by chance|inlier ratio/);
    // How close the false matches came is reported, not hidden.
    assert.ok(bad.quality.inliers < 5 * bad.quality.chanceInliers + 10 || bad.quality.inlierRatio < 0.04);
  }
});

test("a flipped copy needs mirror, and the refusal says so", { timeout: 120000 }, async () => {
  const A = await board(1), B = await sharp(await photo(A, truth(30, 1, 0), {})).flop().png().toBuffer();
  const plain = await register(A, B, { method: "auto" });
  assert.equal(plain.status, "failed");
  assert.equal(plain.alignmentConfidence, "none");
  clearImages();
  const mirrored = await register(A, B, { method: "auto", mirror: true });
  assert.equal(mirrored.status, "ok", JSON.stringify(mirrored.reasons));
  assert.equal(mirrored.alignmentConfidence, "high");
});

test("landmarks: four points always fit, and that is not reported as verified alignment", async () => {
  const A = await board(1), Ht = truth(25, 1, 0.15), B = await photo(A, Ht, {});
  const mk = (pts) => pts.map(([x, y]) => { const q = apply(Ht, x * W, y * H); return { a: { x, y }, b: { x: q.x / W, y: q.y / H } }; });
  const four = await register(A, B, { method: "landmarks", model: "homography", landmarks: mk([[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]) });
  assert.equal(four.status, "ok");
  assert.ok(four.quality.medianErrorPx < 1e-3);
  assert.equal(four.alignmentConfidence, "unverified");
  assert.match(four.confidenceReasons.join(" "), /passes exactly through 4 points/);
  assert.equal(four.quality.heldOut, null);
  clearImages();
  // Ten well spread, consistent landmarks: the hold-out check passes and confidence is high.
  const spread = [[0.1, 0.1], [0.5, 0.08], [0.9, 0.1], [0.12, 0.5], [0.5, 0.5], [0.88, 0.5], [0.1, 0.9], [0.5, 0.92], [0.9, 0.9], [0.3, 0.3]];
  const ten = await register(A, B, { method: "landmarks", model: "homography", landmarks: mk(spread) });
  assert.equal(ten.alignmentConfidence, "high", JSON.stringify(ten.confidenceReasons));
  assert.equal(ten.quality.heldOut.scheme, "leave-one-out");
  assert.ok(ten.quality.heldOut.maxErrorPx < 1);
  clearImages();
  // Seven landmarks in one corner fit well but say nothing about the rest.
  const corner = await register(A, B, { method: "landmarks", model: "homography", landmarks: mk([[0.05, 0.05], [0.2, 0.05], [0.05, 0.2], [0.2, 0.2], [0.12, 0.12], [0.16, 0.08], [0.08, 0.16]]) });
  assert.equal(corner.status, "ok");
  assert.notEqual(corner.alignmentConfidence, "high");
  assert.match(corner.confidenceReasons.join(" "), /span only \d+% of image A/);
  clearImages();
  // One misplaced landmark among consistent ones is flagged, the transform still holds.
  const bent = mk(spread); bent[4].b = { x: bent[4].b.x + 0.2, y: bent[4].b.y - 0.15 };
  const off = await register(A, B, { method: "landmarks", model: "homography", landmarks: bent });
  assert.equal(off.status, "ok");
  assert.notEqual(off.alignmentConfidence, "high");
  assert.match(off.confidenceReasons.join(" "), /1 landmark does not fit/);
  assert.equal(off.landmarkResiduals.filter((l) => !l.inlier).length, 1);
});
