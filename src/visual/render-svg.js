// SVG adapter for RenderPlan/1 (UVA Phase 2, PR-2C). Writes only elements
// from a fixed set; every attribute value is a number or an entry of a fixed
// table, and the optional label text is XML-escaped. The legacy-profile
// output of mark-render.js's markSvg is the reference this must equal.
import { RENDER_PLAN_VERSION, USER_OPACITY } from "./render-plan.js";
import { K } from "./ink.js";

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v) => { if (!Number.isFinite(v)) throw new Error("Non-finite number in render plan"); return v; };
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]);

function pathData(pts, smooth, closed) {
  const n = pts.length, r = (v) => Math.round(v * 10) / 10;
  if (!smooth || n < 3) return "M" + pts.map((p) => p.map(r).join(" ")).join("L") + (closed ? "Z" : "");
  const at = (i) => closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)];
  let d = "M" + pts[0].map(r).join(" ");
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += "C" + [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]].map(r).join(" ");
  }
  return d + (closed ? "Z" : "");
}

// One item. `map(nx, ny)` → [px, py]; `toPx` converts canvas units to pixels.
export function itemSvg(item, map, toPx) {
  const { ink, highlighter: hl } = item;
  const w = Math.max(1.2, num(item.stroke) * toPx), op = hl ? 0.38 : 0.9;
  const stroke = `stroke="${ink}" stroke-width="${w}" stroke-opacity="${op}" stroke-linejoin="round" stroke-linecap="round"`;
  if (item.type === "polyline") {
    const d = pathData(item.points.map((p) => map(p.x, p.y)), item.smooth === true, item.closed === true);
    const outline = hl ? "" : `<path d="${d}" fill="none" stroke="#17212A" stroke-opacity="0.55" stroke-width="${w * 1.7}" stroke-linejoin="round" stroke-linecap="round"/>`;
    return outline + `<path d="${d}" ${hl && item.closed ? `fill="${ink}" fill-opacity="0.18"` : `fill="none"`} ${stroke}/>`;
  }
  const [x, y] = map(item.x, item.y), [x2, y2] = map(item.x2 ?? item.x, item.y2 ?? item.y);
  if (item.type === "point") {
    const r = Math.max(2, num(item.dot) / 2 * toPx);
    return hl ? `<circle cx="${x}" cy="${y}" r="${r}" fill="${ink}" fill-opacity="${op}"/>`
      : `<circle cx="${x}" cy="${y}" r="${r}" fill="${ink}" stroke="#fff" stroke-width="${Math.max(1, 2 * K * toPx)}"/>`;
  }
  if (item.type === "rect") {
    const box = `x="${Math.min(x, x2)}" y="${Math.min(y, y2)}" width="${Math.abs(x2 - x)}" height="${Math.abs(y2 - y)}"`;
    return hl ? `<rect ${box} fill="${ink}" fill-opacity="0.28"/>` : `<rect ${box} fill="${ink}" fill-opacity="0.12" ${stroke}/>`;
  }
  const ang = Math.atan2(y2 - y, x2 - x), h = Math.max(10 * K * toPx, w * 2.6);
  const pt = (t) => `${x2 - h * Math.cos(ang + t)},${y2 - h * Math.sin(ang + t)}`;
  return `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" ${stroke}/><polygon points="${x2},${y2} ${pt(0.45)} ${pt(-0.45)}" fill="${ink}" fill-opacity="${op}"/>`;
}

// The marks of a plan in the canvas's stacking: one <g opacity> per layer
// (objects first, via `objectsSvg(layerId)`), the assistant's marks, then the
// user's in a 0.55 group. `labels` writes each mark's label beside it.
export function planSvg(plan, { width, height, toPx = width / 1000, objectsSvg = () => "", labels = {} } = {}) {
  if (plan.version !== RENDER_PLAN_VERSION) throw new Error("Unsupported render plan version " + plan.version);
  const map = (x, y) => [x * width, y * height];
  const body = (item) => itemSvg(item, map, toPx) + (labels[item.id] ? `<text x="${num(item.at.x) * width + 6}" y="${num(item.at.y) * height - 8}" font-size="${15 * width / 640}" fill="#17212A">${xml(labels[item.id])}</text>` : "");
  return plan.layers.map((l) => `<g opacity="${l.opacity}">${objectsSvg(l.layer)}` + l.assistant.map(body).join("") +
    `<g opacity="${plan.userOpacity ?? USER_OPACITY}">${l.user.map(body).join("")}</g></g>`).join("");
}
