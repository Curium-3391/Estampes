// Segmentation primitives (issue #117): pure functions on binary masks and
// label images. No image decoding, no canvas, no domain knowledge: what a
// region *is* (a grain, a nucleus, a pad) is for a plugin or a person to say.
//
// A mask is a Uint8Array of 0 / non-zero, row-major, width x height.
// Pixel coordinates use the corner convention (pixel (i, j) covers
// [i, i+1) x [j, j+1)), so contours run along pixel edges and a contour's
// shoelace area equals the pixel count of a region without holes.
//
// Everything here is deterministic: ties are broken by pixel index, never by
// iteration order of a hash or by a clock.

export const SEGMENT_VERSION = "1";

const INF = 1e20;

// Exact squared Euclidean distance from each foreground pixel to the nearest
// background pixel centre (Felzenszwalb & Huttenlocher, two 1-D lower
// envelopes). Background pixels get 0. With `borderIsBackground` the outside
// of the image counts as background, so a region cut by the frame is not
// measured as if it went on forever. Returns Float64Array of squared
// distances (integers); a mask with no background at all gives Infinity.
export function squaredDistanceTransform(mask, width, height, { borderIsBackground = false } = {}) {
  const n = width * height;
  if (mask.length !== n) throw new Error("mask size does not match " + width + "x" + height);
  const out = new Float64Array(n);
  const size = Math.max(width, height);
  const f = new Float64Array(size), d = new Float64Array(size), z = new Float64Array(size + 3);
  const v = new Int32Array(size + 2);
  // 1-D transform of f[0..len) into d[0..len). With `edge`, virtual zero
  // sites sit at -1 and len (the pixels just outside the image).
  const pass = (len, edge) => {
    let k = -1;
    const push = (q, fq) => {
      if (fq >= INF) return;
      let s = 0;
      while (k >= 0) {
        const p = v[k];
        s = (fq + q * q - (fv(p) + p * p)) / (2 * q - 2 * p);
        if (s <= z[k]) k--; else break;
      }
      if (k < 0) { k = 0; v[0] = q; z[0] = -INF; z[1] = INF; }
      else { k++; v[k] = q; z[k] = s; z[k + 1] = INF; }
    };
    const fv = (p) => (p < 0 || p >= len ? 0 : f[p]);
    if (edge) push(-1, 0);
    for (let q = 0; q < len; q++) push(q, f[q]);
    if (edge) push(len, 0);
    if (k < 0) { d.fill(INF, 0, len); return; }
    let j = 0;
    for (let q = 0; q < len; q++) {
      while (z[j + 1] < q) j++;
      const p = v[j];
      d[q] = (q - p) * (q - p) + fv(p);
    }
  };
  // Columns first, then rows.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = mask[y * width + x] ? INF : 0;
    pass(height, borderIsBackground);
    for (let y = 0; y < height; y++) out[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) f[x] = out[row + x];
    pass(width, borderIsBackground);
    for (let x = 0; x < width; x++) out[row + x] = d[x] >= INF ? Infinity : d[x];
  }
  return out;
}

// Background not reachable from the image border (4-connected) becomes
// foreground. Returns a new mask and the number of pixels filled.
export function fillHoles(mask, width, height) {
  const n = width * height, outside = new Uint8Array(n), stack = [];
  const seed = (i) => { if (!mask[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  while (stack.length) {
    const p = stack.pop(), x = p % width;
    if (x > 0) seed(p - 1);
    if (x < width - 1) seed(p + 1);
    if (p >= width) seed(p - width);
    if (p < n - width) seed(p + width);
  }
  const out = new Uint8Array(n);
  let filled = 0;
  for (let i = 0; i < n; i++) { if (mask[i]) out[i] = 1; else if (!outside[i]) { out[i] = 1; filled++; } }
  return { mask: out, filled };
}

// 8-connected component labels, 1..count in scan order (top-left pixel
// first), 0 for background.
export function labelMask(mask, width, height) {
  const n = width * height, labels = new Int32Array(n), stack = [];
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i] || labels[i]) continue;
    labels[i] = ++count; stack.push(i);
    while (stack.length) {
      const p = stack.pop(), x = p % width, y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= width) continue;
          const q = yy * width + xx;
          if (mask[q] && !labels[q]) { labels[q] = count; stack.push(q); }
        }
      }
    }
  }
  return { labels, count };
}

// Split touching objects in a mask by the shape of each blob: a watershed
// of the distance transform, written as one descending sweep with
// union-find. Every local maximum of the distance starts a basin. When two
// basins first meet (at their saddle), the one with the lower peak is
// absorbed unless its peak stands out above the saddle by at least
// `minDepth` pixels AND by `minRelativeDepth` of its own height; basins
// that pass stay separate for good. Each pixel joins the basin of its
// highest already-labelled neighbour.
//
// A split is inferred from shape alone: no dark line was seen between the
// two parts. `weakestSplit` (per region, 0..1) is the smallest relative
// depth among the saddles that keep it apart from its neighbours; values
// near `minRelativeDepth` are the doubtful ones.
//
// Returns { labels (Int32Array, 1..count, 0 background), count,
//           regions: [{ label, peak (px), component, weakestSplit|null }],
//           components }.
export function splitByDistance(mask, width, height, { minDepth = 1.5, minRelativeDepth = 0.12, distance2 = null } = {}) {
  const n = width * height;
  const d2 = distance2 ?? squaredDistanceTransform(mask, width, height, { borderIsBackground: true });
  // Foreground pixels by descending distance, then ascending index: a
  // counting sort on the (integer) squared distance.
  let maxD2 = 0, fg = 0;
  for (let i = 0; i < n; i++) if (mask[i]) { fg++; if (d2[i] > maxD2) maxD2 = d2[i]; }
  if (!Number.isFinite(maxD2)) throw new Error("mask has no background; nothing to split against");
  const counts = new Uint32Array(maxD2 + 2);
  for (let i = 0; i < n; i++) if (mask[i]) counts[maxD2 - d2[i] + 1]++;
  for (let k = 1; k < counts.length; k++) counts[k] += counts[k - 1];
  const order = new Uint32Array(fg);
  for (let i = 0; i < n; i++) if (mask[i]) order[counts[maxD2 - d2[i]]++] = i;

  const basin = new Int32Array(n);          // 0 = not yet, else basin id (1-based)
  const parent = [0], peak = [0], weakest = [Infinity];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const roots = [];
  for (let k = 0; k < order.length; k++) {
    const p = order[k], x = p % width, y = (p - x) / width, here = Math.sqrt(d2[p]);
    roots.length = 0;
    let best = 0, bestD = -1, bestIdx = -1;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx; if (xx < 0 || xx >= width) continue;
        const q = yy * width + xx;
        if (!basin[q]) continue;
        const r = find(basin[q]);
        if (!roots.includes(r)) roots.push(r);
        if (d2[q] > bestD || (d2[q] === bestD && q < bestIdx)) { bestD = d2[q]; bestIdx = q; best = r; }
      }
    }
    if (!roots.length) {
      const id = parent.length;
      parent.push(id); peak.push(here); weakest.push(Infinity);
      basin[p] = id;
      continue;
    }
    // Basins meeting here meet at their saddle (later contacts are lower,
    // so they can only confirm a split, never undo one).
    if (roots.length > 1) {
      roots.sort((a, b) => peak[b] - peak[a] || a - b);
      const elder = roots[0];
      for (let i = 1; i < roots.length; i++) {
        const r = roots[i], depth = peak[r] - here, rel = peak[r] > 0 ? depth / peak[r] : 0;
        if (depth < minDepth || rel < minRelativeDepth) {
          parent[r] = elder;
          if (weakest[r] < weakest[elder]) weakest[elder] = weakest[r];
          if (best === r) best = elder;
        } else {
          for (let j = 0; j < i; j++) { const o = find(roots[j]); if (rel < weakest[o]) weakest[o] = rel; }
          if (rel < weakest[r]) weakest[r] = rel;
        }
      }
    }
    basin[p] = find(best);
  }

  // Compact basin roots to labels in scan order; note each one's component.
  const { labels: compLabels, count: components } = labelMask(mask, width, height);
  const labels = new Int32Array(n), map = new Map(), regions = [];
  for (let i = 0; i < n; i++) {
    if (!basin[i]) continue;
    const r = find(basin[i]);
    let label = map.get(r);
    if (!label) {
      label = regions.length + 1; map.set(r, label);
      regions.push({ label, peak: peak[r], component: compLabels[i], weakestSplit: Number.isFinite(weakest[r]) ? weakest[r] : null });
    }
    labels[i] = label;
  }
  return { labels, count: regions.length, regions, components };
}

// Shape statistics of every label in one pass over the label image.
//   area            pixel count
//   perimeter       Crofton estimate from boundary crossings in four
//                   directions: within about 1% for smooth outlines, up to
//                   6% low for long straight axis-aligned edges (a count of
//                   boundary pixels is off by far more and depends on
//                   rotation); the image frame counts as boundary
//   centroid        in corner-convention pixel coordinates
//   bbox            { x0, y0, x1, y1 }, x1/y1 exclusive
//   major, minor    axes of the ellipse with the same second moments
//   eccentricity    of that ellipse, 0 (circle) .. 1
//   orientation     of the major axis, degrees clockwise from +x on screen, [0, 180)
//   equivalentDiameter  of the circle with the same area
//   circularity     4 pi area / perimeter^2 (1 = disc; can exceed 1 slightly for tiny regions)
//   touchesBorder   a pixel lies on the image frame
export function regionStats(labels, width, height, count) {
  const area = new Float64Array(count + 1), sx = new Float64Array(count + 1), sy = new Float64Array(count + 1);
  const sxx = new Float64Array(count + 1), syy = new Float64Array(count + 1), sxy = new Float64Array(count + 1);
  const x0 = new Int32Array(count + 1).fill(width), y0 = new Int32Array(count + 1).fill(height);
  const x1 = new Int32Array(count + 1), y1 = new Int32Array(count + 1);
  const nh = new Float64Array(count + 1), nv = new Float64Array(count + 1), nd = new Float64Array(count + 1);
  const border = new Uint8Array(count + 1);
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : labels[y * width + x]);
  // Crossings between each pixel and its right, lower, lower-right and
  // lower-left neighbours, scanning one pixel beyond the frame.
  for (let y = -1; y < height; y++) for (let x = -1; x <= width; x++) {
    const a = at(x, y);
    const cross = (b, acc) => { if (a !== b) { if (a) acc[a]++; if (b) acc[b]++; } };
    cross(at(x + 1, y), nh); cross(at(x, y + 1), nv); cross(at(x + 1, y + 1), nd); cross(at(x - 1, y + 1), nd);
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = labels[y * width + x];
    if (!a) continue;
    const cx = x + 0.5, cy = y + 0.5;
    area[a]++; sx[a] += cx; sy[a] += cy; sxx[a] += cx * cx; syy[a] += cy * cy; sxy[a] += cx * cy;
    if (x < x0[a]) x0[a] = x; if (x + 1 > x1[a]) x1[a] = x + 1; if (y < y0[a]) y0[a] = y; if (y + 1 > y1[a]) y1[a] = y + 1;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border[a] = 1;
  }
  const out = [];
  for (let a = 1; a <= count; a++) {
    const A = area[a];
    if (!A) { out.push(null); continue; }
    const cx = sx[a] / A, cy = sy[a] / A;
    // Central second moments, plus 1/12 for the extent of a pixel.
    const mxx = sxx[a] / A - cx * cx + 1 / 12, myy = syy[a] / A - cy * cy + 1 / 12, mxy = sxy[a] / A - cx * cy;
    const common = Math.sqrt(((mxx - myy) / 2) ** 2 + mxy * mxy);
    const l1 = (mxx + myy) / 2 + common, l2 = Math.max(0, (mxx + myy) / 2 - common);
    const perimeter = (Math.PI / 8) * (nh[a] + nv[a] + nd[a] / Math.SQRT2);
    out.push({
      label: a, area: A, perimeter,
      centroid: { x: cx, y: cy },
      bbox: { x0: x0[a], y0: y0[a], x1: x1[a], y1: y1[a] },
      major: 4 * Math.sqrt(l1), minor: 4 * Math.sqrt(l2),
      eccentricity: l1 > 0 ? Math.sqrt(Math.max(0, 1 - l2 / l1)) : 0,
      orientation: ((Math.atan2(2 * mxy, mxx - myy) / 2) * 180 / Math.PI + 180) % 180,
      equivalentDiameter: 2 * Math.sqrt(A / Math.PI),
      circularity: perimeter > 0 ? (4 * Math.PI * A) / (perimeter * perimeter) : 0,
      touchesBorder: Boolean(border[a]),
    });
  }
  return out;
}

// Outer contour of one label as a closed polygon along pixel edges
// (corner coordinates), clockwise on screen, starting at the top-left
// corner of the label's first pixel in scan order. 8-connected: two pixels
// touching at a corner stay one outline. Holes are not traced.
export function traceContour(labels, width, height, label, start = -1) {
  if (start < 0) { start = labels.indexOf(label); if (start < 0) return []; }
  const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height && labels[y * width + x] === label;
  const sx = start % width, sy = (start - sx) / width;
  // Walk along edges with the region on the right. Directions: 0 east,
  // 1 south, 2 west, 3 north. At a vertex (x, y) heading in direction d,
  // `left` and `right` are the two pixels ahead.
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const ahead = (x, y, d) => d === 0 ? [[x, y - 1], [x, y]] : d === 1 ? [[x, y], [x - 1, y]] : d === 2 ? [[x - 1, y], [x - 1, y - 1]] : [[x - 1, y - 1], [x, y - 1]];
  // The start vertex has only the start pixel around it (the three other
  // pixels come earlier in scan order), so the walk passes it exactly once.
  const pts = [];
  let x = sx, y = sy, d = 0;
  const limit = 4 * (width + 1) * (height + 1) + 8;
  for (let i = 0; i < limit; i++) {
    const [[lx, ly], [rx, ry]] = ahead(x, y, d);
    const nd = inside(lx, ly) ? (d + 3) % 4 : inside(rx, ry) ? d : (d + 1) % 4;
    if (nd !== d || !pts.length) pts.push({ x, y });
    d = nd; x += DX[d]; y += DY[d];
    if (x === sx && y === sy) break;
  }
  return pts;
}

// Shoelace area of a closed polygon (positive for clockwise on screen).
export function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.y - b.x * a.y; }
  return s / 2;
}

// Fewer vertices for a closed polygon: Douglas-Peucker with `tolerance`
// (pixels), then, if still above `maxVertices`, the tolerance doubles until
// it fits. Returns { points, tolerance } with the tolerance actually used.
export function simplifyClosed(pts, { tolerance = 1, maxVertices = 64 } = {}) {
  if (pts.length <= 3) return { points: pts.slice(), tolerance: 0 };
  // Split the ring at its two mutually farthest-ish vertices: the first
  // vertex and the vertex farthest from it.
  let far = 0, farD = -1;
  for (let i = 1; i < pts.length; i++) { const dd = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2; if (dd > farD) { farD = dd; far = i; } }
  const ring = [...pts, pts[0]];
  const run = (tol) => {
    const keep = new Uint8Array(ring.length);
    keep[0] = keep[far] = keep[ring.length - 1] = 1;
    const stack = [[0, far], [far, ring.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const ax = ring[a].x, ay = ring[a].y, bx = ring[b].x - ax, by = ring[b].y - ay, len = Math.hypot(bx, by);
      let worst = -1, worstD = -1;
      for (let i = a + 1; i < b; i++) {
        const px = ring[i].x - ax, py = ring[i].y - ay;
        const dist = len ? Math.abs(px * by - py * bx) / len : Math.hypot(px, py);
        if (dist > worstD) { worstD = dist; worst = i; }
      }
      if (worstD > tol) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
    }
    const out = [];
    for (let i = 0; i < ring.length - 1; i++) if (keep[i]) out.push(ring[i]);
    return out;
  };
  let tol = tolerance, out = run(tol);
  for (let i = 0; out.length > maxVertices && i < 24; i++) { tol *= 2; out = run(tol); }
  return { points: out, tolerance: tol };
}
