// Window-manager maths for a Surface. Pure functions with no imports: no
// DOM, no storage, no validation library. The server validates and stores
// layouts with them (layout.js), and the very same source is inlined into the
// widget, so both sides apply identical rules and the rules are tested
// without a browser. Geometry is in surface units (0..1 of the work area),
// never in image coordinates, so moving or resizing a panel can never touch a
// mark or a plot.
export const SURFACE_SCHEMA = "estampes.surface/1";
export const PROFILES = ["desktop", "tablet", "mobile"];
export const MAX_PANELS = 12;
export const MIN_SIZE = { w: 0.2, h: 0.18 };
export const SNAP = 0.015;
export const PANEL_ID = /^p:[a-z0-9][a-z0-9-]{0,30}$/;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round3 = (v) => Math.round(v * 1000) / 1000;

// Keep a rectangle inside the work area and at least minimum size, so a
// panel can never be dragged where it cannot be reached again.
export function clampRect(r, min = MIN_SIZE) {
  const w = clamp(r.w, min.w, 1), h = clamp(r.h, min.h, 1);
  return { x: round3(clamp(r.x, 0, 1 - w)), y: round3(clamp(r.y, 0, 1 - h)), w: round3(w), h: round3(h) };
}

// Snap the moving edges to the work area and to neighbours within SNAP.
export function snapRect(r, others = [], snap = SNAP) {
  const xs = [0, 1, ...others.flatMap((o) => [o.x, o.x + o.w])], ys = [0, 1, ...others.flatMap((o) => [o.y, o.y + o.h])];
  const pull = (edges, targets) => {
    let best = null;
    for (const e of edges) for (const t of targets) { const d = t - e; if (Math.abs(d) <= snap && (best === null || Math.abs(d) < Math.abs(best))) best = d; }
    return best ?? 0;
  };
  const dx = pull([r.x, r.x + r.w], xs), dy = pull([r.y, r.y + r.h], ys);
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy });
}

const isRect = (r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite);
export const overlaps = (a, b) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;

// The default arrangement for a profile. The first panel is the viewport
// (photo / Graph); the others share the second column on desktop and
// tablet, or become tabs on a phone.
export function defaultLayout(profile, panelIds) {
  const ids = panelIds.slice(0, MAX_PANELS);
  const placements = {};
  if (profile === "mobile") {
    ids.forEach((id, i) => { placements[id] = { rect: { x: 0, y: 0, w: 1, h: 1 }, z: i + 1, mode: "docked", dock: "free" }; });
    return { placements, order: ids, active: ids[0] ?? null, sheet: ids.length > 1 ? "half" : "collapsed" };
  }
  const [main, ...rest] = ids;
  const split = profile === "tablet" ? 0.55 : 0.62;
  if (main) placements[main] = { rect: { x: 0, y: 0, w: rest.length ? split : 1, h: 1 }, z: 1, mode: "docked", dock: rest.length ? "left" : "free" };
  rest.forEach((id, i) => {
    placements[id] = { rect: clampRect({ x: split, y: round3(i / rest.length), w: 1 - split, h: round3(1 / rest.length) }), z: i + 2, mode: "docked", dock: "right" };
  });
  return { placements, order: ids, active: main ?? null, sheet: "half" };
}

export function defaultLayouts(panelIds) {
  return Object.fromEntries(PROFILES.map((p) => [p, defaultLayout(p, panelIds)]));
}

export class LayoutError extends Error {
  constructor(message) { super(message); this.code = "invalid"; }
}

const topZ = (layout) => Math.max(0, ...Object.values(layout.placements).map((p) => p.z));

// One layout operation applied to a copy of one profile's layout. Ops:
//   {op:"add", panelId}            place a new panel (docked beside the viewport)
//   {op:"remove", panelId}         forget a panel's place (its data is untouched)
//   {op:"focus", panelId}          raise it / make it the active tab
//   {op:"arrange", panelId, rect, mode?, dock?}   drag, resize, float, dock
//   {op:"minimize"|"restore"|"maximize", panelId}
//   {op:"reorder", order}          mobile tab order
//   {op:"sheet", sheet}            mobile sheet height
//   {op:"reset", panelIds}         back to the default arrangement
export function applyOp(layout, op, panelIds) {
  const next = structuredClone(layout);
  const has = (id) => Object.hasOwn(next.placements, id);
  const need = (id) => { if (!has(id)) throw new LayoutError("no panel " + id + " in this layout"); };
  switch (op.op) {
    case "add": {
      if (has(op.panelId)) { next.placements[op.panelId].mode = next.placements[op.panelId].mode === "minimized" ? "docked" : next.placements[op.panelId].mode; break; }
      if (Object.keys(next.placements).length >= MAX_PANELS) throw new LayoutError("at most " + MAX_PANELS + " panels");
      next.placements[op.panelId] = { rect: { x: 0.55, y: 0.05, w: 0.43, h: 0.9 }, z: topZ(next) + 1, mode: "floating", dock: "free" };
      if (!next.order.includes(op.panelId)) next.order.push(op.panelId);
      next.active = op.panelId;
      break;
    }
    case "remove":
      need(op.panelId);
      delete next.placements[op.panelId];
      next.order = next.order.filter((id) => id !== op.panelId);
      if (next.active === op.panelId) next.active = next.order[0] ?? null;
      break;
    case "focus":
      need(op.panelId);
      next.placements[op.panelId].z = topZ(next) + 1;
      if (next.placements[op.panelId].mode === "minimized") next.placements[op.panelId].mode = "docked";
      next.active = op.panelId;
      break;
    case "arrange": {
      need(op.panelId);
      if (!isRect(op.rect)) throw new LayoutError("arrange needs a rect {x,y,w,h}");
      const others = Object.entries(next.placements).filter(([id, p]) => id !== op.panelId && p.mode !== "minimized").map(([, p]) => p.rect);
      const p = next.placements[op.panelId];
      p.rect = op.snap === false ? clampRect(op.rect) : snapRect(clampRect(op.rect), others);
      p.mode = op.mode ?? (op.dock && op.dock !== "free" ? "docked" : "floating");
      p.dock = op.dock ?? "free";
      p.z = topZ(next) + 1;
      break;
    }
    case "minimize": need(op.panelId); next.placements[op.panelId].mode = "minimized"; break;
    case "restore": need(op.panelId); next.placements[op.panelId].mode = "docked"; next.placements[op.panelId].z = topZ(next) + 1; break;
    case "maximize": need(op.panelId); next.placements[op.panelId].mode = "maximized"; next.placements[op.panelId].z = topZ(next) + 1; next.active = op.panelId; break;
    case "reorder": {
      const ids = new Set(Object.keys(next.placements));
      if (!Array.isArray(op.order) || op.order.length !== ids.size || op.order.some((id) => !ids.has(id)) || new Set(op.order).size !== ids.size) {
        throw new LayoutError("reorder must list every panel exactly once");
      }
      next.order = [...op.order];
      break;
    }
    case "sheet":
      if (!["collapsed", "half", "full"].includes(op.sheet)) throw new LayoutError("sheet: collapsed, half or full");
      next.sheet = op.sheet;
      break;
    case "reset": return defaultLayout(op.profile ?? "desktop", op.panelIds ?? panelIds);
    default: throw new LayoutError("unknown layout operation " + JSON.stringify(op.op));
  }
  return next;
}

// Drop placements of panels that no longer exist and give new ones a place,
// so a stored layout always matches the surface's panel list.
export function reconcile(layouts, panelIds) {
  const out = {};
  for (const profile of PROFILES) {
    const cur = layouts?.[profile];
    if (!cur) { out[profile] = defaultLayout(profile, panelIds); continue; }
    const placements = Object.fromEntries(Object.entries(cur.placements).filter(([id]) => panelIds.includes(id)));
    const missing = panelIds.filter((id) => !placements[id]);
    // A lone viewport gets the standard two-column arrangement when its first
    // companion opens; after that, new panels float until the user places them.
    if (missing.length && Object.keys(placements).length <= 1) { out[profile] = defaultLayout(profile, panelIds); continue; }
    let next = { ...cur, placements, order: cur.order.filter((id) => panelIds.includes(id)) };
    for (const id of missing) next = applyOp(next, { op: "add", panelId: id }, panelIds);
    if (next.active && !panelIds.includes(next.active)) next.active = next.order[0] ?? null;
    out[profile] = next;
  }
  return out;
}

// Which profile fits a work area: from the host's real container size,
// with the user agent never consulted.
export function profileFor(width, height) {
  if (!(width > 0)) return "desktop";
  if (width >= 900) return "desktop";
  if (width >= 600 && height >= 420) return "tablet";
  return "mobile";
}
