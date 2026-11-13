// RenderPlan/1: what to draw for a set of marks, as plain data (UVA Phase 2,
// PR-2C). The plan holds no pixels, no SVG and no free text: only resolved
// style (a colour from a fixed table, widths in canvas units), geometry in
// normalized image space, and the stacking order. Server, browser and SVG
// adapters turn the same plan into output, so they cannot drift apart.
import { inkUnits, INK_COLORS } from "./ink.js";
import { MARK_TYPES } from "./annotation-contract.js";

export const RENDER_PLAN_VERSION = 1;
export { INK_COLORS };
export const USER_OPACITY = 0.55;

const finite = (v) => Number.isFinite(v);

export function renderItem(mark, order = 0) {
  if (!MARK_TYPES.includes(mark.type)) throw new Error("Cannot draw mark of type " + JSON.stringify(mark.type));
  const ink = inkUnits(mark), highlighter = mark.pen === "highlighter";
  const geometry = mark.type === "polyline"
    ? { points: mark.points.map((p) => ({ x: p.x, y: p.y })) }
    : { x: mark.x, y: mark.y, ...(mark.type === "point" ? {} : { x2: mark.x2, y2: mark.y2 }) };
  const numbers = mark.type === "polyline" ? geometry.points.flatMap((p) => [p.x, p.y]) : Object.values(geometry);
  if (!numbers.every(finite)) throw new Error("Mark " + JSON.stringify(mark.id) + " has coordinates that cannot be drawn");
  return {
    id: mark.id, type: mark.type, order, highlighter,
    ink: INK_COLORS[mark.color] ?? (mark.author === "user" ? INK_COLORS.blue : INK_COLORS.gold),
    at: mark.type === "polyline" && !finite(mark.x) ? { ...geometry.points[0] } : { x: mark.x, y: mark.y }, stroke: ink.stroke, total: ink.total, dot: ink.dot,
    ...(mark.type === "polyline" ? { smooth: mark.smooth === true, closed: mark.closed === true } : {}),
    ...geometry,
  };
}

// Layers in drawing order. Marks without a (known) layer come first, as in
// the canvas. Within a layer the assistant's marks are drawn first, then the
// user's at USER_OPACITY. `hidden` layers are left out.
export function buildRenderPlan({ marks, layers, hidden = [] }) {
  const hide = new Set(hidden), known = new Set(layers.map((l) => l.id));
  const shown = marks.filter((m) => !hide.has(m.layer));
  const order = new Map(marks.map((m, i) => [m.id, i]));
  const group = (id, opacity) => {
    const own = shown.filter((m) => (id === null ? !known.has(m.layer) : m.layer === id));
    const make = (m) => renderItem(m, order.get(m.id));
    return { layer: id, opacity, assistant: own.filter((m) => m.author !== "user").map(make), user: own.filter((m) => m.author === "user").map(make) };
  };
  return { version: RENDER_PLAN_VERSION, userOpacity: USER_OPACITY,
    layers: [group(null, 1), ...layers.map((l) => group(l.id, l.opacity ?? 1))] };
}

export const planItems = (plan) => plan.layers.flatMap((l) => [...l.assistant, ...l.user]);
