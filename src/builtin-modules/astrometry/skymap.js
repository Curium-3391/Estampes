// An all-sky map (Hammer projection) with the solved field drawn on it, as
// scene operations. Pure geometry: no network, nothing specific to one target.
const RAD = Math.PI / 180, ARCSEC = Math.PI / 648000;
const norm360 = (deg) => ((deg % 360) + 360) % 360;
const wrapLon = (raDeg) => { const r = norm360(raDeg); return r > 180 ? r - 360 : r; };

// Hammer projection of (RA, Dec) in degrees to unit-free X in [-2.83, 2.83], Y in [-1.41, 1.41]
// with RA increasing to the left, the way sky charts are drawn.
export function hammer(raDeg, decDeg) {
  const lon = wrapLon(raDeg) * RAD, lat = decDeg * RAD;
  const z = Math.sqrt(1 + Math.cos(lat) * Math.cos(lon / 2));
  return { X: -(2 * Math.SQRT2 * Math.cos(lat) * Math.sin(lon / 2)) / z, Y: (Math.SQRT2 * Math.sin(lat)) / z };
}

// RA/Dec of a point offset from the field centre by (dx right, dy up) in degrees,
// for a field whose "up" direction points `orientationDeg` east of north (tangent plane).
export function offsetToSky(raDeg, decDeg, dxDeg, dyDeg, orientationDeg = 0) {
  const t = orientationDeg * RAD;
  const xi = (dyDeg * Math.sin(t) - dxDeg * Math.cos(t)) * RAD, eta = (dyDeg * Math.cos(t) + dxDeg * Math.sin(t)) * RAD;
  const ra0 = raDeg * RAD, dec0 = decDeg * RAD, rho = Math.hypot(xi, eta);
  if (rho === 0) return { ra: raDeg, dec: decDeg };
  const c = Math.atan(rho);
  const dec = Math.asin(Math.cos(c) * Math.sin(dec0) + (eta * Math.sin(c) * Math.cos(dec0)) / rho);
  const ra = ra0 + Math.atan2(xi * Math.sin(c), rho * Math.cos(dec0) * Math.cos(c) - eta * Math.sin(dec0) * Math.sin(c));
  return { ra: norm360(ra / RAD), dec: dec / RAD };
}

export const fieldOutline = ({ raDeg, decDeg, widthDeg, heightDeg, rotationDeg = 0 }, perEdge = 12) => {
  const w = widthDeg / 2, h = heightDeg / 2, pts = [];
  const edge = (x0, y0, x1, y1) => { for (let i = 0; i < perEdge; i++) pts.push([x0 + ((x1 - x0) * i) / perEdge, y0 + ((y1 - y0) * i) / perEdge]); };
  edge(-w, -h, w, -h); edge(w, -h, w, h); edge(w, h, -w, h); edge(-w, h, -w, -h);
  return pts.map(([dx, dy]) => offsetToSky(raDeg, decDeg, dx, dy, rotationDeg));
};

// Scene operations for the map, laid out for a canvas of width x height pixels.
export function skyMapOperations({ raDeg, decDeg, widthDeg, heightDeg, rotationDeg = 0, title }, { width, height }) {
  const k = Math.min((0.46 * width) / (2 * Math.SQRT2), (0.46 * height) / Math.SQRT2);
  const to = (ra, dec) => { const { X, Y } = hammer(ra, dec); return [(width / 2 + k * X) / width, (height / 2 - k * Y) / height]; };
  const line = (points, color, w = 1) => ({ op: "object.create", type: "shape", props: { kind: "polyline", points, style: { color, width: w } } });
  const text = (x, y, t, size = 12, color = "gray") => ({ op: "object.create", type: "shape", props: { kind: "text", x, y, text: t, size, style: { color } } });
  const ops = [];
  const meridian = (lon) => { const pts = []; for (let d = -90; d <= 90; d += 5) pts.push(to(lon < 0 ? lon + 360 : lon, d)); return pts; };
  // Outline: the two edge meridians at RA 180 (approached from either side).
  const edge = (sign) => { const pts = []; for (let d = -90; d <= 90; d += 5) pts.push(to(180 + sign * 1e-6, d)); return pts; };
  ops.push(line(edge(-1), "gray", 1.5), line(edge(1), "gray", 1.5));
  for (const lon of [-120, -60, 0, 60, 120]) ops.push(line(meridian(lon), "gray", 0.6));
  for (const dec of [-60, -30, 0, 30, 60]) {
    const pts = []; for (let lon = -179.99; lon <= 179.99; lon += 5) pts.push(to(norm360(lon), dec));
    ops.push(line(pts, "gray", 0.6));
  }
  for (const lon of [-120, -60, 0, 60, 120]) { const [x, y] = to(norm360(lon), 0); ops.push(text(x - 0.012, y + 0.02, String(norm360(lon)) + "°", 11)); }
  for (const dec of [-60, -30, 30, 60]) { const [x, y] = to(0, dec); ops.push(text(x + 0.006, y - 0.012, (dec > 0 ? "+" : "") + dec + "°", 11)); }

  const outline = fieldOutline({ raDeg, decDeg, widthDeg, heightDeg, rotationDeg }).map((p) => to(p.ra, p.dec));
  const wraps = outline.some((p, i) => Math.abs(p[0] - outline[(i + 1) % outline.length][0]) > 0.3);
  if (!wraps) ops.push({ op: "object.create", type: "shape", props: { kind: "polygon", points: outline, style: { color: "red", width: 2.5 } } });
  const [cx, cy] = to(raDeg, decDeg);
  ops.push({ op: "object.create", type: "shape", props: { kind: "point", x: cx, y: cy, style: { color: "red" } } });
  ops.push(text(0.02, 0.04, title ?? "RA " + norm360(raDeg).toFixed(2) + "°, Dec " + (decDeg > 0 ? "+" : "") + decDeg.toFixed(2) + "°  (field " + widthDeg.toFixed(1) + "° × " + heightDeg.toFixed(1) + "°)", 14, "red"));
  return { operations: ops, wraps };
}
