import test from "node:test";
import assert from "node:assert/strict";
import {
  squaredDistanceTransform, fillHoles, labelMask, splitByDistance, regionStats, traceContour, polygonArea, simplifyClosed,
} from "../src/image/segment.js";

// Deterministic pseudo-random numbers (no Math.random: failures must repeat).
const lcg = (seed) => () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
const discs = (W, H, list) => {
  const m = new Uint8Array(W * H);
  for (const [cx, cy, r] of list) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) m[y * W + x] = 1;
  return m;
};

test("distance transform equals a brute-force search on random masks, with and without the frame as background", () => {
  const rnd = lcg(7);
  for (const border of [false, true]) for (let t = 0; t < 25; t++) {
    const w = 3 + Math.floor(rnd() * 28), h = 3 + Math.floor(rnd() * 28), p = rnd();
    const m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = rnd() < p ? 1 : 0;
    const d = squaredDistanceTransform(m, w, h, { borderIsBackground: border });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let best = Infinity;
      if (!m[y * w + x]) best = 0;
      else for (let yy = -1; yy <= h; yy++) for (let xx = -1; xx <= w; xx++) {
        const out = xx < 0 || yy < 0 || xx >= w || yy >= h;
        if (out ? border : !m[yy * w + xx]) best = Math.min(best, (xx - x) ** 2 + (yy - y) ** 2);
      }
      assert.equal(d[y * w + x], best, `border=${border} ${w}x${h} at ${x},${y}`);
    }
  }
  // No background anywhere: infinite, unless the frame counts.
  const full = new Uint8Array(12).fill(1);
  assert.equal(squaredDistanceTransform(full, 4, 3)[5], Infinity);
  assert.equal(squaredDistanceTransform(full, 4, 3, { borderIsBackground: true })[5], 4);
  assert.throws(() => squaredDistanceTransform(full, 5, 3), /mask size/);
});

test("fillHoles fills enclosed background only; labelMask is 8-connected in scan order", () => {
  const ring = new Uint8Array([
    1, 1, 1, 0, 0,
    1, 0, 1, 0, 0,
    1, 1, 1, 0, 1,
  ]);
  const { mask, filled } = fillHoles(ring, 5, 3);
  assert.equal(filled, 1);
  assert.deepEqual([...mask], [1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1]);
  // (0,0) and (1,1) touch at a corner: one component.
  const { labels, count } = labelMask(new Uint8Array([
    1, 0, 0, 0, 1,
    0, 1, 0, 0, 0,
    0, 0, 0, 1, 0,
  ]), 5, 3);
  assert.equal(count, 3);
  assert.deepEqual([...labels], [1, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 3, 0]);
});

test("two overlapping discs are split at the neck; a lone disc and a dumbbell that barely narrows are not", () => {
  const W = 200, H = 120;
  const res = splitByDistance(discs(W, H, [[70, 60, 30], [115, 60, 30], [170, 30, 12]]), W, H);
  assert.equal(res.components, 2);
  assert.equal(res.count, 3);
  const stats = regionStats(res.labels, W, H, res.count);
  const big = stats.filter((s) => s.area > 2000);
  assert.equal(big.length, 2);
  // The cut is the vertical line midway between the centres (x = 92.5).
  for (const s of big) assert.ok(Math.abs(s.area - 2620) < 60, "area " + s.area);
  assert.ok(Math.abs(big[0].centroid.x + big[1].centroid.x - 185) < 2);
  let leftMax = 0, rightMin = W;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const l = res.labels[y * W + x];
    if (l === big[0].label) leftMax = Math.max(leftMax, x); else if (l === big[1].label) rightMin = Math.min(rightMin, x);
  }
  assert.ok(Math.abs(leftMax - 92) <= 2 && Math.abs(rightMin - 92) <= 3, leftMax + " / " + rightMin);
  // Both halves report the same doubtfulness: neck 19.8 px against radius 29.4.
  const split = res.regions.filter((r) => r.component === 2);
  assert.ok(split.every((r) => Math.abs(r.weakestSplit - 0.32) < 0.02));
  assert.equal(res.regions.find((r) => r.component === 1).weakestSplit, null);
  // Heavily overlapping discs (centres 16 px apart, radius 30) dip by 0.4 px: one region.
  assert.equal(splitByDistance(discs(W, H, [[80, 60, 30], [96, 60, 30]]), W, H).count, 1);
  // The thresholds are the caller's: demand less and the same blob splits.
  assert.equal(splitByDistance(discs(W, H, [[80, 60, 30], [96, 60, 30]]), W, H, { minDepth: 0.3, minRelativeDepth: 0.01 }).count, 2);
  // Same input, same labels.
  const again = splitByDistance(discs(W, H, [[70, 60, 30], [115, 60, 30], [170, 30, 12]]), W, H);
  assert.deepEqual(again.labels, res.labels);
});

test("a row of touching discs gives one region per disc, and a rough-edged blob is not shattered", () => {
  const W = 260, H = 80, centres = [30, 70, 110, 150, 190, 230];
  const res = splitByDistance(discs(W, H, centres.map((x) => [x, 40, 22])), W, H);
  assert.equal(res.components, 1);
  assert.equal(res.count, 6);
  const xs = regionStats(res.labels, W, H, res.count).map((s) => Math.round(s.centroid.x)).sort((a, b) => a - b);
  xs.forEach((x, i) => assert.ok(Math.abs(x - centres[i]) <= 2, x + " vs " + centres[i]));
  // One large disc with a jagged rim (radius 40 +- 2 px noise): still one region.
  const rnd = lcg(3), m = new Uint8Array(120 * 120);
  const rim = Array.from({ length: 360 }, () => 38 + rnd() * 4);
  for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) {
    const dx = x + 0.5 - 60, dy = y + 0.5 - 60, a = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 360) % 360;
    if (Math.hypot(dx, dy) <= rim[a]) m[y * 120 + x] = 1;
  }
  // (Stray rim pixels may be components of their own; none comes from a split.)
  const rough = splitByDistance(m, 120, 120);
  assert.equal(rough.count, rough.components);
  assert.equal(regionStats(rough.labels, 120, 120, rough.count).filter((s) => s.area > 20).length, 1);
});

test("region statistics match the geometry of discs, ellipses and rectangles", () => {
  const W = 240, H = 200;
  // Disc of radius 40.
  let { labels } = labelMask(discs(W, H, [[100, 90, 40]]), W, H);
  let s = regionStats(labels, W, H, 1)[0];
  assert.ok(Math.abs(s.area - Math.PI * 1600) / (Math.PI * 1600) < 0.005);
  assert.ok(Math.abs(s.perimeter - 2 * Math.PI * 40) / (2 * Math.PI * 40) < 0.01, "perimeter " + s.perimeter);
  assert.ok(Math.abs(s.centroid.x - 100) < 0.01 && Math.abs(s.centroid.y - 90) < 0.01);
  assert.ok(Math.abs(s.equivalentDiameter - 80) < 0.1 && Math.abs(s.major - 80) < 0.2 && Math.abs(s.minor - 80) < 0.2);
  assert.ok(s.eccentricity < 0.05 && Math.abs(s.circularity - 1) < 0.02);
  assert.deepEqual(s.bbox, { x0: 60, y0: 50, x1: 140, y1: 130 });
  assert.equal(s.touchesBorder, false);
  // Ellipse with semi-axes 60 and 20, rotated 30 degrees clockwise on screen.
  const m = new Uint8Array(W * H), c = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x + 0.5 - 120, dy = y + 0.5 - 100, u = dx * c + dy * sn, v = -dx * sn + dy * c;
    if ((u / 60) ** 2 + (v / 20) ** 2 <= 1) m[y * W + x] = 1;
  }
  ({ labels } = labelMask(m, W, H));
  s = regionStats(labels, W, H, 1)[0];
  assert.ok(Math.abs(s.major - 120) < 0.5 && Math.abs(s.minor - 40) < 0.5, s.major + " x " + s.minor);
  assert.ok(Math.abs(s.orientation - 30) < 0.5, "orientation " + s.orientation);
  assert.ok(Math.abs(s.eccentricity - Math.sqrt(1 - (20 / 60) ** 2)) < 0.005);
  // Ramanujan's approximation of the ellipse perimeter.
  const P = Math.PI * (3 * 80 - Math.sqrt((3 * 60 + 20) * (60 + 3 * 20)));
  assert.ok(Math.abs(s.perimeter - P) / P < 0.02, s.perimeter + " vs " + P);
  // Rectangle 50 x 20 against the top-left corner of the frame.
  const r = new Uint8Array(W * H);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 50; x++) r[y * W + x] = 1;
  ({ labels } = labelMask(r, W, H));
  s = regionStats(labels, W, H, 1)[0];
  assert.equal(s.area, 1000);
  assert.equal(s.touchesBorder, true);
  // Four directions underestimate straight axis-aligned edges by about 6%
  // (the worst case); the true perimeter is 140.
  assert.ok(s.perimeter > 140 * 0.93 && s.perimeter < 140, "perimeter " + s.perimeter);
  assert.ok(Math.abs(s.orientation) < 0.01 || Math.abs(s.orientation - 180) < 0.01);
  // An absent label is null, not a fabricated zero-size region.
  assert.equal(regionStats(new Int32Array(4), 2, 2, 1)[0], null);
});

test("contours run along pixel edges, enclose exactly the region's pixels and simplify within tolerance", () => {
  const W = 200, H = 120;
  const res = splitByDistance(discs(W, H, [[70, 60, 30], [115, 60, 30], [170, 30, 12]]), W, H);
  for (const s of regionStats(res.labels, W, H, res.count)) {
    const ring = traceContour(res.labels, W, H, s.label);
    assert.equal(polygonArea(ring), s.area);
    assert.ok(ring.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y)));
    const { points, tolerance } = simplifyClosed(ring, { tolerance: 1, maxVertices: 16 });
    assert.ok(points.length >= 6 && points.length <= 16, "vertices " + points.length);
    assert.ok(Math.abs(polygonArea(points) - s.area) / s.area < 0.05);
    // Every dropped vertex is within the tolerance used of the simplified outline.
    const dist = (p, a, b) => { const bx = b.x - a.x, by = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * bx + (p.y - a.y) * by) / (bx * bx + by * by || 1))); return Math.hypot(p.x - a.x - t * bx, p.y - a.y - t * by); };
    for (const p of ring) assert.ok(Math.min(...points.map((a, i) => dist(p, a, points[(i + 1) % points.length]))) <= tolerance + 1e-9);
  }
  // Pixels touching only at corners are one outline (8-connected).
  const diag = labelMask(new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), 3, 3);
  const ring = traceContour(diag.labels, 3, 3, 1);
  assert.equal(ring.length, 12);
  assert.equal(polygonArea(ring), 3);
  // A ring's outline ignores its hole.
  const donut = labelMask(new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]), 3, 3);
  assert.deepEqual(traceContour(donut.labels, 3, 3, 1), [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }]);
  assert.deepEqual(traceContour(donut.labels, 3, 3, 7), []);
  // A vertex budget is met by loosening the tolerance, and says so.
  const big = labelMask(discs(W, H, [[100, 60, 50]]), W, H);
  const tight = simplifyClosed(traceContour(big.labels, W, H, 1), { tolerance: 0.25, maxVertices: 8 });
  assert.ok(tight.points.length <= 8 && tight.tolerance > 0.25);
});
