// Scene objects: things on a canvas that keep their meaning instead of
// being flattened into pixels or loose marks. A function plot keeps its
// formula and domain, so changing sin(x) to sin(2*x) re-computes it; axes
// keep their ranges, so every plot on them is redrawn when they change.
//
// Modules never draw. They describe objects (type + props) through scene
// operations (scene-ops.js); the trusted renderer here turns each object
// into a small list of drawing primitives in canvas-normalized
// coordinates (0..1 of the canvas image, top-left origin). The widget,
// the SVG export and the preview image all draw those same primitives.
import { z } from "zod";
import { compileExpression, MAX_EXPRESSION_LENGTH } from "./expression.js";

export const COLOR_NAMES = Object.freeze({
  gold: "#E4AE57", blue: "#579DF6", red: "#F2545B", green: "#3DDC84", yellow: "#FFD23F",
  magenta: "#E36BF0", cyan: "#3FD0E0", white: "#FFFFFF", black: "#111111", gray: "#7A8691", ink: "#22303C",
});
const ColorSchema = z.union([z.enum(Object.keys(COLOR_NAMES)), z.string().regex(/^#[0-9a-fA-F]{6}$/)]);
const colorOf = (c, fallback) => COLOR_NAMES[c] ?? (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : fallback);
const Finite = z.number().finite();
const Range = z.tuple([Finite, Finite]).refine(([a, b]) => b > a && b - a < 1e12 && Math.abs(a) < 1e12 && Math.abs(b) < 1e12, "range must be [min, max] with max > min");
const Region = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), x2: z.number().min(0).max(1), y2: z.number().min(0).max(1) })
  .strict().refine((r) => r.x2 - r.x >= 0.05 && r.y2 - r.y >= 0.05, "region must be at least 0.05 wide and tall");
const Style = z.object({
  color: ColorSchema.optional(), width: z.number().min(0.2).max(12).optional(),
  dash: z.enum(["solid", "dashed", "dotted"]).optional(), opacity: z.number().min(0.1).max(1).optional(),
}).strict();
const Text = z.string().max(80);

// Where an object's coordinates live: the canvas itself (0..1, top-left) or
// the cartesian frame of an axes object on the same canvas (y up).
export const SPACES = ["canvas", "frame"];

export const OBJECT_TYPES = {
  "axes-2d": {
    description: "Cartesian axes with grid, ticks and labels. Function plots and frame-space shapes are drawn through it.",
    props: z.object({
      xRange: Range, yRange: Range,
      region: Region.optional().describe("Part of the canvas the axes occupy; default leaves a margin"),
      grid: z.boolean().optional(), xTicks: z.enum(["auto", "pi"]).optional(),
      xLabel: Text.optional(), yLabel: Text.optional(), title: Text.optional(), style: Style.optional(),
    }).strict(),
    defaults: { grid: true, xTicks: "auto" },
  },
  "function-plot": {
    description: "y = f(x) drawn through an axes object; keeps the expression so it can be edited and re-computed.",
    props: z.object({
      expression: z.string().min(1).max(MAX_EXPRESSION_LENGTH),
      frame: z.string().min(1).max(64).describe("id of the axes-2d object"),
      domain: Range.optional().describe("x interval; default the axes' xRange"),
      label: Text.optional(),
      labelMode: z.enum(["auto", "custom"]).optional().describe("auto follows the expression; custom preserves label (empty hides it)"),
      style: Style.optional(),
    }).strict(),
    defaults: {},
    dependsOn: (props) => [props.frame],
  },
  shape: {
    description: "A generic vector shape (polyline, polygon, dots, circle, rect, arrow, point or text) in canvas or frame space.",
    props: z.object({
      kind: z.enum(["polyline", "polygon", "dots", "circle", "rect", "arrow", "point", "text"]),
      space: z.enum(SPACES).optional(), frame: z.string().min(1).max(64).optional(),
      points: z.array(z.tuple([Finite, Finite])).max(2000).optional(),
      x: Finite.optional(), y: Finite.optional(), x2: Finite.optional(), y2: Finite.optional(),
      r: z.number().positive().max(1e12).optional().describe("circle radius in the x units of its space"),
      text: Text.optional(), size: z.number().min(6).max(64).optional(),
      fill: ColorSchema.optional(), smooth: z.boolean().optional(), style: Style.optional(),
    }).strict().superRefine((p, ctx) => {
      const need = (cond, msg) => { if (!cond) ctx.addIssue({ code: "custom", message: msg }); };
      if ((p.space ?? "canvas") === "frame") need(p.frame, "frame space needs frame (an axes-2d id)");
      if (["polyline", "polygon"].includes(p.kind)) need(p.points?.length >= 2, p.kind + " needs at least 2 points");
      if (p.kind === "dots") need(p.points?.length >= 1, "dots needs points");
      if (["circle", "point", "text"].includes(p.kind)) need(p.x !== undefined && p.y !== undefined, p.kind + " needs x and y");
      if (p.kind === "circle") need(p.r !== undefined, "circle needs r");
      if (p.kind === "text") need(p.text, "text needs text");
      if (["rect", "arrow"].includes(p.kind)) need([p.x, p.y, p.x2, p.y2].every((v) => v !== undefined), p.kind + " needs x, y, x2, y2");
    }),
    defaults: {},
    dependsOn: (props) => (props.space === "frame" && props.frame ? [props.frame] : []),
  },
};
export const OBJECT_TYPE_NAMES = Object.keys(OBJECT_TYPES);

export function validateProps(type, props, where = "props") {
  const spec = OBJECT_TYPES[type];
  if (!spec) throw new Error("Unknown object type " + JSON.stringify(type) + " (known: " + OBJECT_TYPE_NAMES.join(", ") + ")");
  const parsed = spec.props.safeParse(props);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(where + (issue.path.length ? "." + issue.path.join(".") : "") + ": " + issue.message);
  }
  if (type === "function-plot") {
    compileExpression(parsed.data.expression); // throws a readable parse error
    // Legacy labels are always custom, even when they look like formulas.
    parsed.data.labelMode ??= parsed.data.label === undefined ? "auto" : "custom";
    if (parsed.data.labelMode === "auto") delete parsed.data.label;
  }
  return parsed.data;
}

// ---- Frames -----------------------------------------------------------------
const DEFAULT_REGION = { x: 0.08, y: 0.07, x2: 0.96, y2: 0.9 };
export function frameOf(axes) {
  const p = axes.props, r = p.region ?? DEFAULT_REGION;
  const [x0, x1] = p.xRange, [y0, y1] = p.yRange;
  return {
    region: r, xRange: p.xRange, yRange: p.yRange,
    toCanvas: (x, y) => [r.x + ((x - x0) / (x1 - x0)) * (r.x2 - r.x), r.y2 - ((y - y0) / (y1 - y0)) * (r.y2 - r.y)],
    toFrame: (cx, cy) => [x0 + ((cx - r.x) / (r.x2 - r.x)) * (x1 - x0), y0 + ((r.y2 - cy) / (r.y2 - r.y)) * (y1 - y0)],
  };
}

// 1, 2, 5 x 10^k steps giving about `target` ticks.
export function niceTicks(min, max, target = 8) {
  const raw = (max - min) / target, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9 && ticks.length < 60; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { step, ticks };
}
function piTicks(min, max) {
  const span = (max - min) / Math.PI;
  const div = span <= 3 ? 4 : span <= 8 ? 2 : span <= 16 ? 1 : 0;
  if (!div) return null;
  const step = Math.PI / div, ticks = [];
  for (let k = Math.ceil(min / step); k * step <= max + 1e-9 && ticks.length < 60; k++) ticks.push({ v: k * step, text: piText(k, div) });
  return ticks;
}
function piText(k, div) {
  if (k === 0) return "0";
  const g = gcd(Math.abs(k), div), n = k / g, d = div / g;
  const num = n === 1 ? "π" : n === -1 ? "−π" : (n < 0 ? "−" : "") + Math.abs(n) + "π";
  return d === 1 ? num : num + "/" + d;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
export function tickText(v, step) {
  if (v === 0) return "0";
  const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  const abs = Math.abs(v);
  const s = abs >= 1e6 || abs < 1e-4 ? v.toExponential(2) : v.toFixed(digits);
  return s.replace("-", "−");
}

// ---- Function sampling ------------------------------------------------------
// Adaptive sampling in canvas space: start uniform, then split intervals
// whose midpoint is off the straight line by more than `tolerance`. Gaps
// (NaN, outside the y range, or a jump with no point in between, such as
// tan at π/2) end a segment, so asymptotes are never joined.
const TOLERANCE = 0.0008, MAX_EVALS = 6000, MAX_DEPTH = 7, BASE_SAMPLES = 240;
export function sampleFunction(fn, frame, domain) {
  const [d0, d1] = domain;
  const ySpan = frame.yRange[1] - frame.yRange[0], yMid = (frame.yRange[0] + frame.yRange[1]) / 2;
  const visible = (y) => Math.abs(y - yMid) <= ySpan * 0.6;
  let evaluations = 0;
  const f = (x) => { evaluations++; return fn(x); };
  const samples = [];
  const off = (xa, ya, xb, yb, xm, ym) => {
    const a = frame.toCanvas(xa, ya), b = frame.toCanvas(xb, yb), m = frame.toCanvas(xm, ym);
    return Math.hypot(m[0] - (a[0] + b[0]) / 2, m[1] - (a[1] + b[1]) / 2);
  };
  // Adds the samples strictly between a and b, in order.
  const refine = (xa, ya, xb, yb, depth) => {
    if (depth >= MAX_DEPTH || evaluations >= MAX_EVALS) return;
    const xm = (xa + xb) / 2, ym = f(xm);
    const fa = Number.isFinite(ya), fb = Number.isFinite(yb), fm = Number.isFinite(ym);
    // Finite everywhere: split where the curve bends. Around a gap: split
    // to find where the gap starts and ends.
    const split = fa && fb && fm ? off(xa, ya, xb, yb, xm, ym) > TOLERANCE : fa || fb || fm;
    if (!split) return;
    refine(xa, ya, xm, ym, depth + 1);
    samples.push([xm, ym]);
    refine(xm, ym, xb, yb, depth + 1);
  };
  let xa = d0, ya = f(d0);
  samples.push([xa, ya]);
  for (let i = 1; i <= BASE_SAMPLES; i++) {
    const xb = d0 + ((d1 - d0) * i) / BASE_SAMPLES, yb = f(xb);
    refine(xa, ya, xb, yb, 0);
    samples.push([xb, yb]);
    xa = xb; ya = yb;
  }
  // Split into drawable runs: NaN is a gap, and so is a jump between
  // neighbours that bisection cannot close (tan at pi/2, 1/x at 0).
  const segments = [];
  let run = [];
  const flush = () => { if (run.length >= 2) segments.push(run); run = []; };
  for (let i = 0; i < samples.length; i++) {
    const [x, y] = samples[i];
    if (!Number.isFinite(y)) { flush(); continue; }
    const prev = run.at(-1);
    if (prev && Math.abs(y - prev[1]) > ySpan * 0.04) {
      // Both off screen: only crossing the whole view matters. Otherwise
      // bisect, within a budget, to tell a jump from a steep stretch.
      if (!visible(y) && !visible(prev[1])) { if ((y > yMid) !== (prev[1] > yMid)) flush(); }
      else if (evaluations < MAX_EVALS * 2 && jumps(f, prev[0], prev[1], x, y, ySpan)) flush();
    }
    run.push([x, y]);
  }
  flush();
  const canvas = segments.map((s) => s.map(([x, y]) => frame.toCanvas(x, y)));
  return { segments: canvas.flatMap((s) => clipToFrame(s, frame)).map((s) => simplify(s)), evaluations };
}
function jumps(f, xa, ya, xb, yb, span) {
  for (let i = 0; i < 12; i++) {
    const xm = (xa + xb) / 2, ym = f(xm);
    if (!Number.isFinite(ym)) return true;
    if (Math.abs(ym - ya) > Math.abs(ym - yb)) { xb = xm; yb = ym; } else { xa = xm; ya = ym; }
    if (Math.abs(yb - ya) < span * 0.02) return false;
  }
  return true;
}
// Cut a canvas-space polyline at the frame's top and bottom edges.
function clipToFrame(points, frame) {
  const { y: top, y2: bottom } = frame.region, out = [];
  let cur = [];
  const inside = (p) => p[1] >= top - 1e-9 && p[1] <= bottom + 1e-9;
  const edge = (a, b) => {
    const yEdge = (a[1] < top || b[1] < top) ? top : bottom, t = (yEdge - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), yEdge];
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i], prev = points[i - 1];
    if (inside(p)) {
      if (prev && !inside(prev)) cur.push(edge(prev, p));
      cur.push(p);
    } else if (prev && inside(prev)) { cur.push(edge(prev, p)); out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out.filter((s) => s.length >= 2);
}
// Ramer-Douglas-Peucker with a tolerance well under a screen pixel.
function simplify(points, tol = 0.0003) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + bx * ay - by * ax) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// ---- Rendering --------------------------------------------------------------
// Primitives: {k:"path", pts:[[x,y]...], closed?, smooth?, stroke, width, dash?, fill?, opacity?}
//             {k:"text", x, y, text, size, anchor, baseline, fill, weight?}
//             {k:"circle", x, y, r, fill?, stroke?, width?}
// x/y are 0..1 of the canvas; width, size and r are canvas units (the
// canvas is 1000 units wide), the same scale marks use.
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const pt = ([x, y]) => [r5(x), r5(y)];
const DASH = { dashed: [8, 6], dotted: [2, 5] };
const styled = (style = {}, fallback, width = 2.5) => ({
  stroke: colorOf(style.color, fallback), width: style.width ?? width,
  ...(style.dash && style.dash !== "solid" ? { dash: DASH[style.dash] } : {}),
  ...(style.opacity && style.opacity < 1 ? { opacity: style.opacity } : {}),
});

function renderAxes(obj, aspect) {
  const p = obj.props, frame = frameOf(obj), r = frame.region, out = [];
  const ink = colorOf(p.style?.color, COLOR_NAMES.ink), grid = "#C9D1D8";
  const [x0, x1] = p.xRange, [y0, y1] = p.yRange;
  const xt = (p.xTicks === "pi" && piTicks(x0, x1)) || niceTicks(x0, x1, 9).ticks.map((v, _, a) => ({ v, text: tickText(v, a[1] - a[0] || 1) }));
  const ys = niceTicks(y0, y1, 7);
  const yt = ys.ticks.map((v) => ({ v, text: tickText(v, ys.step) }));
  const X = (v) => frame.toCanvas(v, y0)[0], Y = (v) => frame.toCanvas(x0, v)[1];
  if (p.grid !== false) {
    for (const t of xt) out.push({ k: "path", pts: [pt([X(t.v), r.y]), pt([X(t.v), r.y2])], stroke: grid, width: 1 });
    for (const t of yt) out.push({ k: "path", pts: [pt([r.x, Y(t.v)]), pt([r.x2, Y(t.v)])], stroke: grid, width: 1 });
  }
  out.push({ k: "path", pts: [pt([r.x, r.y]), pt([r.x2, r.y]), pt([r.x2, r.y2]), pt([r.x, r.y2])], closed: true, stroke: grid, width: 1.2 });
  // Axis lines through 0 when 0 is in range, else along the frame edge.
  const ax = y0 <= 0 && y1 >= 0 ? Y(0) : r.y2, ay = x0 <= 0 && x1 >= 0 ? X(0) : r.x;
  out.push({ k: "path", pts: [pt([r.x, ax]), pt([r.x2, ax])], stroke: ink, width: 2 });
  out.push({ k: "path", pts: [pt([ay, r.y]), pt([ay, r.y2])], stroke: ink, width: 2 });
  const tick = 0.008, size = 13;
  for (const t of xt) {
    const x = X(t.v);
    out.push({ k: "path", pts: [pt([x, ax - tick * aspect]), pt([x, ax + tick * aspect])], stroke: ink, width: 1.6 });
    if (t.v !== 0 || ay === r.x) out.push({ k: "text", x: r5(x), y: r5(Math.min(r.y2 + 0.012, ax + 0.012)), text: t.text, size, anchor: "middle", baseline: "hanging", fill: ink });
  }
  for (const t of yt) {
    const y = Y(t.v);
    out.push({ k: "path", pts: [pt([ay - tick, y]), pt([ay + tick, y])], stroke: ink, width: 1.6 });
    if (t.v !== 0 || ax === r.y2) out.push({ k: "text", x: r5(Math.max(r.x - 0.006, ay - 0.013)), y: r5(y), text: t.text, size, anchor: "end", baseline: "middle", fill: ink });
  }
  if (p.xLabel) out.push({ k: "text", x: r5(r.x2), y: r5(ax - 0.015), text: p.xLabel, size: 15, anchor: "end", baseline: "auto", fill: ink, weight: 700 });
  if (p.yLabel) out.push({ k: "text", x: r5(ay + 0.008), y: r5(r.y + 0.02), text: p.yLabel, size: 15, anchor: "start", baseline: "hanging", fill: ink, weight: 700 });
  if (p.title) out.push({ k: "text", x: r5((r.x + r.x2) / 2), y: r5(Math.max(0.02, r.y - 0.035)), text: p.title, size: 18, anchor: "middle", baseline: "middle", fill: ink, weight: 700 });
  return out;
}

function renderFunction(obj, axes) {
  const p = obj.props, frame = frameOf(axes), fn = compileExpression(p.expression);
  const [a, b] = p.domain ?? frame.xRange;
  const lo = Math.max(a, frame.xRange[0]), hi = Math.min(b, frame.xRange[1]);
  if (!(hi > lo)) return { primitives: [], info: { segments: 0, points: 0, note: "domain is outside the axes' x range" } };
  const { segments, evaluations } = sampleFunction(fn, frame, [lo, hi]);
  const stroke = styled(p.style, COLOR_NAMES.blue, 3);
  const prims = segments.map((s) => ({ k: "path", pts: s.map(pt), ...stroke }));
  const label = p.labelMode === "auto" ? "y = " + fn.source : p.label ?? (p.labelMode === "custom" ? "" : "y = " + fn.source);
  const last = segments.at(-1)?.at(-1);
  if (last && label) prims.push({ k: "text", x: r5(Math.min(last[0], frame.region.x2 - 0.01)), y: r5(Math.max(frame.region.y + 0.02, last[1] - 0.025)),
    text: label.slice(0, 80), size: 14, anchor: "end", baseline: "auto", fill: stroke.stroke, weight: 700 });
  return { primitives: prims, info: { segments: segments.length, points: segments.reduce((n, s) => n + s.length, 0), evaluations } };
}

function renderShape(obj, axes, aspect) {
  const p = obj.props, frame = (p.space ?? "canvas") === "frame" ? frameOf(axes) : null;
  const map = frame ? ([x, y]) => frame.toCanvas(x, y) : ([x, y]) => [x, y];
  const stroke = styled(p.style, COLOR_NAMES.gold, 2.5), fill = p.fill ? colorOf(p.fill) : undefined;
  const at = map([p.x ?? 0, p.y ?? 0]);
  switch (p.kind) {
    case "polyline": case "polygon":
      return [{ k: "path", pts: p.points.map((q) => pt(map(q))), ...(p.kind === "polygon" ? { closed: true } : {}), ...(p.smooth ? { smooth: true } : {}),
        ...stroke, ...(fill ? { fill } : {}) }];
    case "rect": {
      const [ax, ay] = map([p.x, p.y]), [bx, by] = map([p.x2, p.y2]);
      return [{ k: "path", pts: [[ax, ay], [bx, ay], [bx, by], [ax, by]].map(pt), closed: true, ...stroke, ...(fill ? { fill } : {}) }];
    }
    case "arrow": {
      const a = map([p.x, p.y]), b = map([p.x2, p.y2]), ang = Math.atan2((b[1] - a[1]) / aspect, b[0] - a[0]), h = 0.018;
      const wing = (t) => pt([b[0] - h * Math.cos(ang + t), b[1] - h * Math.sin(ang + t) * aspect]);
      return [{ k: "path", pts: [pt(a), pt(b)], ...stroke }, { k: "path", pts: [wing(0.45), pt(b), wing(-0.45)], closed: true, ...stroke, fill: stroke.stroke }];
    }
    case "circle": {
      // r is in x units of the space; turn it into canvas units (0..1000).
      const rx = frame ? Math.abs(frame.toCanvas(p.x + p.r, p.y)[0] - at[0]) : p.r;
      return [{ k: "circle", x: r5(at[0]), y: r5(at[1]), r: r5(rx * 1000), stroke: stroke.stroke, width: stroke.width, ...(fill ? { fill } : {}) }];
    }
    case "point": return [{ k: "circle", x: r5(at[0]), y: r5(at[1]), r: 5, fill: fill ?? stroke.stroke, stroke: "#FFFFFF", width: 1.5 }];
    case "dots": return p.points.map((q) => { const [x, y] = map(q); return { k: "circle", x: r5(x), y: r5(y), r: 4, fill: fill ?? stroke.stroke, stroke: "#FFFFFF", width: 1 }; });
    case "text": return [{ k: "text", x: r5(at[0]), y: r5(at[1]), text: p.text, size: p.size ?? 15, anchor: "start", baseline: "middle", fill: fill ?? stroke.stroke }];
  }
  return [];
}

// Render one object given the canvas aspect (height / width) and a lookup
// for frames. Returns { primitives, info } and never throws for a broken
// reference: a plot whose axes were deleted renders nothing and says why.
export function renderObject(obj, { lookup, aspect = 0.625 }) {
  const needsFrame = obj.type === "function-plot" || (obj.type === "shape" && obj.props.space === "frame");
  const axes = needsFrame ? lookup(obj.props.frame) : null;
  if (needsFrame && axes?.type !== "axes-2d") return { primitives: [], info: { note: "frame " + obj.props.frame + " is not an axes-2d object on this canvas" } };
  try {
    if (obj.type === "axes-2d") return { primitives: renderAxes(obj, aspect), info: {} };
    if (obj.type === "function-plot") return renderFunction(obj, axes);
    if (obj.type === "shape") return { primitives: renderShape(obj, axes, aspect), info: {} };
  } catch (error) {
    return { primitives: [], info: { note: String(error?.message || error) } };
  }
  return { primitives: [], info: { note: "no renderer for " + obj.type } };
}

// ---- SVG --------------------------------------------------------------------
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]);
const BASELINE = { hanging: "hanging", middle: "central", auto: "auto" };
// The same primitives as SVG elements, in pixels of a W x H canvas.
export function primitivesSvg(prims, W, H) {
  const u = W / 1000, X = (x) => Math.round(x * W * 10) / 10, Y = (y) => Math.round(y * H * 10) / 10;
  return prims.map((p) => {
    if (p.k === "path") {
      const d = "M" + p.pts.map(([x, y]) => X(x) + " " + Y(y)).join("L") + (p.closed ? "Z" : "");
      return `<path d="${d}" fill="${p.fill ? xml(p.fill) : "none"}"${p.fill ? ' fill-opacity="0.25"' : ""} stroke="${xml(p.stroke)}" stroke-width="${Math.round(p.width * u * 10) / 10}"` +
        ` stroke-linejoin="round" stroke-linecap="round"${p.dash ? ` stroke-dasharray="${p.dash.map((d) => Math.round(d * u * 10) / 10).join(" ")}"` : ""}${p.opacity ? ` opacity="${p.opacity}"` : ""}/>`;
    }
    if (p.k === "circle") {
      return `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${Math.round(p.r * u * 10) / 10}" fill="${p.fill ? xml(p.fill) : "none"}"${p.stroke ? ` stroke="${xml(p.stroke)}" stroke-width="${Math.round((p.width ?? 1.5) * u * 10) / 10}"` : ""}/>`;
    }
    if (p.k === "text") {
      return `<text x="${X(p.x)}" y="${Y(p.y)}" font-family="system-ui, -apple-system, Segoe UI, Arial, sans-serif" font-size="${Math.round(p.size * u * 10) / 10}"` +
        ` text-anchor="${p.anchor ?? "start"}" dominant-baseline="${BASELINE[p.baseline] ?? "auto"}" fill="${xml(p.fill)}"${p.weight ? ` font-weight="${p.weight}"` : ""}>${xml(p.text)}</text>`;
    }
    return "";
  }).join("");
}
