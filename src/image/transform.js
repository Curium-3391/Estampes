// Coordinate spaces and the transforms between them (RFC PRE-03). Every
// image has four kinds of space:
//   source      oriented source pixels at full resolution (EXIF applied)
//   normalized  0..1 of the oriented source, top-left origin: where marks live
//   working     the cached copy (long side <= ESTAMPES_WORKING_LONG_SIDE)
//   derived     pixels of one processed view (crop, scale, rotation, warp)
// The widget's screen pixels ("view") never leave the widget.
// Transforms are 3x3 homogeneous matrices, row-major, mapping column vectors
// [x, y, 1]. Pixel coordinates use the corner convention: pixel (i, j)
// covers [i, i+1) x [j, j+1), so a crop's left edge maps exactly.

export const SPACES = Object.freeze(["source", "normalized", "working", "derived"]);
export const identity = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const translate = (tx, ty) => [1, 0, tx, 0, 1, ty, 0, 0, 1];
export const scale = (sx, sy = sx) => [sx, 0, 0, 0, sy, 0, 0, 0, 1];

// Rotation by `deg` clockwise on screen (y points down).
export function rotate(deg) {
  const r = (deg * Math.PI) / 180;
  // Exact values for quarter turns so round trips stay exact.
  const q = ((Math.round(deg) % 360) + 360) % 360;
  const exact = Number.isInteger(deg) && q % 90 === 0;
  const c = exact ? [1, 0, -1, 0][q / 90] : Math.cos(r);
  const s = exact ? [0, 1, 0, -1][q / 90] : Math.sin(r);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

// a then b: multiply(b, a) maps p to b(a(p)).
export function multiply(b, a) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    out[r * 3 + c] = b[r * 3] * a[c] + b[r * 3 + 1] * a[3 + c] + b[r * 3 + 2] * a[6 + c];
  }
  return out;
}
export const chain = (...ms) => ms.reduce((acc, m) => multiply(m, acc), identity());

export function apply(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w, w };
}

const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
const norm = (m) => Math.sqrt(m.reduce((s, v) => s + v * v, 0));

// Inverse, or null when the matrix is singular or too ill-conditioned to
// trust (RFC T07: fail instead of inventing an inverse).
export function invert(m, { maxCondition = 1e12 } = {}) {
  const d = det3(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-15 * norm(m) ** 3) return null;
  const inv = [
    (m[4] * m[8] - m[5] * m[7]) / d, (m[2] * m[7] - m[1] * m[8]) / d, (m[1] * m[5] - m[2] * m[4]) / d,
    (m[5] * m[6] - m[3] * m[8]) / d, (m[0] * m[8] - m[2] * m[6]) / d, (m[2] * m[3] - m[0] * m[5]) / d,
    (m[3] * m[7] - m[4] * m[6]) / d, (m[1] * m[6] - m[0] * m[7]) / d, (m[0] * m[4] - m[1] * m[3]) / d,
  ];
  if (!inv.every(Number.isFinite) || condition(m, inv) > maxCondition) return null;
  return inv;
}

// Frobenius condition estimate ||M|| * ||M^-1|| on the normalized matrix.
export function condition(m, inv = null) {
  const s = m[8] || 1;
  const a = m.map((v) => v / s);
  const b = inv ?? invert(a, { maxCondition: Infinity });
  return b ? norm(a) * norm(b.map((v) => v * s)) : Infinity;
}

export const isAffine = (m, eps = 1e-12) => Math.abs(m[6]) < eps && Math.abs(m[7]) < eps;

// Solve a small dense linear system by Gaussian elimination with partial
// pivoting. Returns null when singular.
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Least squares via normal equations (fine for the small, normalized
// point sets used here).
function leastSquares(rows, rhs) {
  const n = rows[0].length;
  const AtA = Array.from({ length: n }, () => new Array(n).fill(0));
  const Atb = new Array(n).fill(0);
  rows.forEach((row, k) => {
    for (let i = 0; i < n; i++) {
      Atb[i] += row[i] * rhs[k];
      for (let j = 0; j < n; j++) AtA[i][j] += row[i] * row[j];
    }
  });
  return solve(AtA, Atb);
}

// Hartley normalization: centre the points and scale mean distance to √2.
function normalizer(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length || 1;
  const k = Math.SQRT2 / d;
  return [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1];
}

// Transform mapping `from[i]` onto `to[i]`. kind: similarity (≥2 points),
// affine (≥3) or homography (≥4). Returns null for degenerate input.
export function fitTransform(from, to, kind = "homography") {
  const need = { similarity: 2, affine: 3, homography: 4 }[kind];
  if (!need) throw new Error("Unknown transform kind " + kind);
  if (from.length !== to.length || from.length < need) return null;
  const Tf = normalizer(from), Tt = normalizer(to);
  const a = from.map((p) => apply(Tf, p.x, p.y)), b = to.map((p) => apply(Tt, p.x, p.y));
  let H;
  if (kind === "similarity") {
    // [x' y'] = [[s c, -s s],[s s, s c]] [x y] + t : unknowns p, q, tx, ty
    const rows = [], rhs = [];
    a.forEach((p, i) => {
      rows.push([p.x, -p.y, 1, 0]); rhs.push(b[i].x);
      rows.push([p.y, p.x, 0, 1]); rhs.push(b[i].y);
    });
    const s = leastSquares(rows, rhs);
    if (!s) return null;
    H = [s[0], -s[1], s[2], s[1], s[0], s[3], 0, 0, 1];
  } else if (kind === "affine") {
    const rows = [], rhs = [];
    a.forEach((p, i) => {
      rows.push([p.x, p.y, 1, 0, 0, 0]); rhs.push(b[i].x);
      rows.push([0, 0, 0, p.x, p.y, 1]); rhs.push(b[i].y);
    });
    const s = leastSquares(rows, rhs);
    if (!s) return null;
    H = [...s, 0, 0, 1];
  } else {
    // DLT with h33 = 1 (fine after normalization unless the true h33 is ~0).
    const rows = [], rhs = [];
    a.forEach((p, i) => {
      const q = b[i];
      rows.push([p.x, p.y, 1, 0, 0, 0, -p.x * q.x, -p.y * q.x]); rhs.push(q.x);
      rows.push([0, 0, 0, p.x, p.y, 1, -p.x * q.y, -p.y * q.y]); rhs.push(q.y);
    });
    const s = leastSquares(rows, rhs);
    if (!s) return null;
    H = [...s, 1];
  }
  const TtInv = invert(Tt, { maxCondition: Infinity });
  if (!TtInv) return null;
  const out = chain(Tf, H, TtInv);
  const s = out[8];
  if (!Number.isFinite(s) || Math.abs(s) < 1e-15) return null;
  const result = out.map((v) => v / s);
  return invert(result) ? result : null;
}

export function reprojectionErrors(H, from, to) {
  return from.map((p, i) => {
    const q = apply(H, p.x, p.y);
    return Math.hypot(q.x - to[i].x, q.y - to[i].y);
  });
}

export const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};

const round = (v) => (v === 0 ? 0 : Number(v.toPrecision(12)));
export const roundMatrix = (m) => m.map((v) => round(v));

// One step of a transform graph: a named edge between two spaces with the
// matrix (when the step is projective) and what is lost along it.
export function step(kind, from, to, matrix, extra = {}) {
  return { kind, from, to, matrix: roundMatrix(matrix), invertible: Boolean(invert(matrix)), ...extra };
}

// The graph for one derived view is a chain of steps from "normalized" to
// "derived". viewToNormalized maps a derived pixel back to the canvas frame.
export function composeSteps(steps) {
  return steps.reduce((acc, s) => multiply(s.matrix, acc), identity());
}

export function graphSummary(steps) {
  const forward = composeSteps(steps);
  const inverse = invert(forward);
  return {
    steps,
    normalizedToDerived: roundMatrix(forward),
    derivedToNormalized: inverse ? roundMatrix(inverse) : null,
    invertible: Boolean(inverse),
    kind: steps.every((s) => isAffine(s.matrix)) ? "affine" : "homography",
  };
}

// Map a mark from derived pixels (or 0..1 of the derived frame) back to
// normalized source coordinates using derivedToNormalized.
// A rect stays a rect only under axis-aligned scale + shift; under rotation
// or perspective its four corners become a closed polyline.
export const axisAligned = (m, eps = 1e-9) => isAffine(m, eps) && Math.abs(m[1]) < eps && Math.abs(m[3]) < eps;
export function mapMark(mark, m) {
  if (mark.type === "rect" && !axisAligned(m)) {
    const { x, y, x2, y2, ...rest } = mark;
    const corners = [[x, y], [x2, y], [x2, y2], [x, y2]].map(([u, v]) => { const q = apply(m, u, v); return { x: q.x, y: q.y }; });
    return { ...rest, type: "polyline", closed: true, points: corners };
  }
  const map = (x, y) => (x === undefined || y === undefined ? null : apply(m, x, y));
  const p1 = map(mark.x, mark.y), p2 = map(mark.x2, mark.y2);
  return {
    ...mark,
    ...(p1 ? { x: p1.x, y: p1.y } : {}),
    ...(p2 ? { x2: p2.x, y2: p2.y } : {}),
    ...(mark.points ? { points: mark.points.map((p) => { const q = apply(m, p.x, p.y); return { x: q.x, y: q.y }; }) } : {}),
  };
}
