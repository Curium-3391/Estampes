// Graph: function plots and data on cartesian axes. It only describes what
// to draw (axes-2d, function-plot and shape objects); the Core validates,
// stores and renders them, and evaluates expressions with its own parser.
import { readFileSync } from "node:fs";
import { compileExpression } from "../../scene/expression.js";

export const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

const TWO_PI = 2 * Math.PI;
const axesOn = (canvas) => (canvas?.objects ?? []).filter((o) => o.type === "axes-2d");

function pickAxes(canvas, frame) {
  const all = axesOn(canvas);
  if (frame) {
    const found = all.find((o) => o.id === frame);
    if (!found) throw new Error("frame " + frame + " is not an axes object on this canvas" + (all.length ? " (axes: " + all.map((o) => o.id).join(", ") + ")" : ""));
    return found;
  }
  return all.at(-1) ?? null;
}

// A y range that shows the curve: the 2nd to 98th percentile of sampled
// values with a margin, so one asymptote does not flatten everything.
export function fitRange(fn, [x0, x1]) {
  const ys = [];
  for (let i = 0; i <= 400; i++) { const y = fn(x0 + ((x1 - x0) * i) / 400); if (Number.isFinite(y)) ys.push(y); }
  if (ys.length < 10) return [-10, 10];
  ys.sort((a, b) => a - b);
  let lo = ys[Math.floor(ys.length * 0.02)], hi = ys[Math.ceil(ys.length * 0.98) - 1];
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  return [round(lo - pad), round(hi + pad)];
}
const round = (v) => { const p = 10 ** (Math.floor(Math.log10(Math.abs(v) || 1)) - 2); return Math.round(v / p) * p; };
const isPiMultiple = ([a, b]) => [a, b].every((v) => Math.abs(v / Math.PI - Math.round(v / Math.PI)) < 1e-6) && b - a <= 16 * Math.PI;

function newAxes(params, fn) {
  const xRange = params.xRange ?? params.domain ?? (fn?.usesTrig ? [-TWO_PI, TWO_PI] : [-10, 10]);
  const yRange = params.yRange ?? (fn ? fitRange(fn, xRange) : [-10, 10]);
  return {
    op: "object.create", ref: "axes", type: "axes-2d",
    props: { xRange, yRange, ...(fn?.usesTrig && isPiMultiple(xRange) ? { xTicks: "pi" } : {}), ...(params.title ? { title: params.title } : {}) },
  };
}

const style = (color) => (color ? { style: { color } } : {});

export function run(capability, params, { canvas }) {
  if (capability === "plot_function") {
    const fn = compileExpression(params.expression);
    const axes = pickAxes(canvas, params.frame);
    const ops = axes ? [] : [newAxes(params, fn)];
    ops.push({
      op: "object.create", type: "function-plot",
      props: { expression: fn.source, frame: axes ? axes.id : "$axes", ...(params.domain ? { domain: params.domain } : {}),
        ...(params.label ? { label: params.label } : {}), ...style(params.color) },
    });
    return { operations: ops, method: "adaptive sampling of the parsed expression", summary: "y = " + fn.source + (axes ? " on axes " + axes.id : " on new axes") };
  }
  if (capability === "update_plot") {
    const target = (canvas?.objects ?? []).find((o) => o.id === params.object);
    if (!target || target.type !== "function-plot") throw new Error(params.object + " is not a function plot on this canvas");
    if (params.expression) compileExpression(params.expression);
    const props = {
      ...(params.expression ? { expression: params.expression } : {}), ...(params.domain ? { domain: params.domain } : {}),
      ...(params.label !== undefined ? { label: params.label } : {}),
      ...(params.color ? { style: { ...(target.props.style ?? {}), color: params.color } } : {}),
    };
    if (!Object.keys(props).length) throw new Error("nothing to change: give expression, domain, color or label");
    return { operations: [{ op: "object.update", id: target.id, props }], summary: "updated " + target.id };
  }
  if (capability === "set_axes") {
    const axes = pickAxes(canvas, params.object);
    const props = {
      ...(params.xRange ? { xRange: params.xRange } : {}), ...(params.yRange ? { yRange: params.yRange } : {}),
      ...(params.grid !== undefined ? { grid: params.grid } : {}), ...(params.piTicks !== undefined ? { xTicks: params.piTicks ? "pi" : "auto" } : {}),
      ...(params.title !== undefined ? { title: params.title } : {}), ...(params.xLabel !== undefined ? { xLabel: params.xLabel } : {}),
      ...(params.yLabel !== undefined ? { yLabel: params.yLabel } : {}),
    };
    if (!axes) return { operations: [{ ...newAxes(params, null), props: { xRange: [-10, 10], yRange: [-10, 10], ...props } }], summary: "new axes" };
    if (!Object.keys(props).length) throw new Error("nothing to change");
    return { operations: [{ op: "object.update", id: axes.id, props }], summary: "updated axes " + axes.id };
  }
  if (capability === "plot_points") {
    const pts = params.points;
    let axes = pickAxes(canvas, params.frame);
    const ops = [];
    if (!axes) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const span = (lo, hi) => { const pad = (hi - lo || 1) * 0.1; return [round(lo - pad), round(hi + pad)]; };
      ops.push({ ...newAxes({ xRange: span(Math.min(...xs), Math.max(...xs)), yRange: span(Math.min(...ys), Math.max(...ys)) }, null) });
    }
    const kind = params.style === "dots" || pts.length < 2 ? "dots" : "polyline";
    ops.push({ op: "object.create", type: "shape", ...(params.label ? { label: params.label } : {}),
      props: { kind, space: "frame", frame: axes ? axes.id : "$axes", points: pts, ...style(params.color ?? "blue") } });
    return { operations: ops, summary: pts.length + " points" };
  }
  throw new Error("unknown capability " + capability);
}
