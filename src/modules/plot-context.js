// The plot context a module reads (UVA Phase 4A-3). A module that plots
// (the graph module now, CAS in Phase 5, #174) asks for "which axes are on
// this canvas, which function plots, on which frame", not for the raw object
// list. The answer is the same whether the canvas is a Graph document (gph:)
// or an old blank-image canvas (img:), so a module never needs to know which.
//
// Plain data only: it is part of the module request, so it goes as JSON to
// wasm and http modules too.
export const PLOT_CONTEXT_VERSION = 1;

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const AXES_KEYS = ["xRange", "yRange", "xTicks", "grid", "title", "xLabel", "yLabel"];
const PLOT_KEYS = ["expression", "frame", "domain", "label", "labelMode", "style"];

// objects: the module's view of the canvas objects ({id, type, props, ...}).
// kind: "graph" for a Graph document, "image" otherwise.
export function plotContext({ kind = "image", objects = [] } = {}) {
  const list = Array.isArray(objects) ? objects : [];
  return {
    version: PLOT_CONTEXT_VERSION,
    kind,
    frames: list.filter((o) => o?.type === "axes-2d").map((o) => ({ id: o.id, ...pick(o.props ?? {}, AXES_KEYS) })),
    plots: list.filter((o) => o?.type === "function-plot").map((o) => ({ id: o.id, ...pick(o.props ?? {}, PLOT_KEYS) })),
  };
}

// The context a module was given, or one built from its objects when the
// caller is older than this adapter (a self-test passes {objects, marks}).
export const plotContextOf = (canvas) => canvas?.plot ?? plotContext({ kind: canvas?.kind, objects: canvas?.objects });
