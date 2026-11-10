// RenderPlan/1: what to draw for a set of marks, as plain data (UVA Phase 2,
// PR-2C). The plan holds no pixels, no SVG and no free text: only resolved
// style (a colour from a fixed table, widths in canvas units), geometry in
// normalized image space, and the stacking order. Server, browser and SVG
// adapters turn the same plan into output, so they cannot drift apart.
import { inkUnits } from "../mark-render.js";
import { MARK_TYPES } from "./annotation-contract.js";

export const RENDER_PLAN_VERSION = 1;
// Same table as the widget and mark-render.js; tests/visual-render.test.js
// fails if the server's drawing ever stops matching it.
export const INK_COLORS = Object.freeze({ gold: "#E4AE57", blue: "#579DF6", red: "#F2545B", green: "#3DDC84", yellow: "#FFD23F",
  magenta: "#E36BF0", cyan: "#3FD0E0", white: "#FFFFFF", black: "#111111" });
export const USER_OPACITY = 0.55;

const finite = (v) => Number.isFinite(v);

function itemOf(mark, order) {
  if (!MARK_TYPES.includes(mark.type)) throw new Error("Cannot draw mark of type " + JSON.stringify(mark.type));
  const ink = inkUnits(mark), highlighter = mark.pen === "highlighter";
  const geometry = mark.type === "polyline"
    ? { points: mark.points.map((p) => ({ x: p.x, y: p.y })) }
    : { x: mark.x, y: mark.y, ...(mark.type === "point" ? {} : { x2: mark.x2, y2: mark.y2 }) };
  const numbers = mark.type === "polyline" ? geometry.points.flatMap((p) => [p.x, p.y, mark.x, mark.y]) : Object.values(geometry);
  if (!numbers.every(finite)) throw new Error("Mark " + JSON.stringify(mark.id) + " has coordinates that cannot be drawn");
  return {
    id: mark.id, type: mark.type, order, highlighter,
    ink: INK_COLORS[mark.color] ?? (mark.author === "user" ? INK_COLORS.blue : INK_COLORS.gold),
    at: { x: mark.x, y: mark.y }, stroke: ink.stroke, total: ink.total, dot: ink.dot,
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
    const make = (m) => itemOf(m, order.get(m.id));
    return { layer: id, opacity, assistant: own.filter((m) => m.author !== "user").map(make), user: own.filter((m) => m.author === "user").map(make) };
  };
  return { version: RENDER_PLAN_VERSION, userOpacity: USER_OPACITY,
    layers: [group(null, 1), ...layers.map((l) => group(l.id, l.opacity ?? 1))] };
}

export const planItems = (plan) => plan.layers.flatMap((l) => [...l.assistant, ...l.user]);
