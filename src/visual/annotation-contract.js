// The annotation contract: what a mark is, independent of which canvas
// (photo, graph, workspace item) holds it. One place names every field a
// mark can carry, who owns it, and which ones belong together, so adapters
// can prove they keep all of them (UVA Phase 2, PR-2A).
//
// Vocabulary (types, styles, statuses) is owned by scene-catalog.js, which is
// hash-sealed; it is re-exported here so new code has one entry point.
export {
  MARK_TYPES, MAX_POLYLINE_POINTS, MARK_STATUSES, MARK_COLORS, MARK_SIZES, MARK_PENS,
  polylineWithBounds, markStyle, markFindings,
} from "../scene-catalog.js";

// Field groups. A field belongs to exactly one group.
export const ANNOTATION_FIELDS = Object.freeze({
  identity: Object.freeze(["id", "type", "label", "targetId"]),
  geometry: Object.freeze(["x", "y", "x2", "y2", "points", "smooth", "closed"]),
  style: Object.freeze(["color", "size", "pen"]),
  // A shared note, its evidence and the user's verdict on it.
  claim: Object.freeze(["note", "status", "confidence", "evidence", "ambiguities", "review", "reviewReason", "previouslyRejected", "stale", "findingUpdatedAt"]),
  // Who made it and how it was placed.
  provenance: Object.freeze(["author", "grounding", "edited"]),
  placement: Object.freeze(["layer"]),
});

export const ANNOTATION_FIELD_NAMES = Object.freeze(new Set(Object.values(ANNOTATION_FIELDS).flat()));

// Fields that only change when the claim (the note) changes: a changed note is
// a new claim and does not inherit the old evidence or review.
// stale: the thing a claim was about changed under it (a curve a mark is
// pinned to was re-defined, UVA Phase 4B-4); the user checks it again.
export const CLAIM_FIELDS = Object.freeze(["confidence", "evidence", "ambiguities", "review", "reviewReason", "previouslyRejected", "stale"]);
export const claimOf = (m) => Object.fromEntries(CLAIM_FIELDS.filter((k) => m?.[k] !== undefined).map((k) => [k, m[k]]));
export const withoutClaim = (m) => { const c = { ...m }; for (const k of CLAIM_FIELDS) delete c[k]; return c; };

export const AUTHORS = Object.freeze(["user", "assistant"]);
export const isUserMark = (mark) => mark?.author === "user";

// Field names on a mark that the contract does not know. Adapters (UVA
// projection, bundle export) use this to refuse silently dropping data.
export const unknownFields = (mark) => Object.keys(mark ?? {}).filter((k) => !ANNOTATION_FIELD_NAMES.has(k));

// Did the mark move or change shape? Bounds and vertices only: style, label
// and the smooth/closed flags do not count (this is what "edited" means).
export function geometryChanged(before, after) {
  return ["x", "y", "x2", "y2"].some((k) => before?.[k] !== after?.[k]) || JSON.stringify(before?.points) !== JSON.stringify(after?.points);
}

// The mark with only the named group(s) of fields.
export function pickFields(mark, ...groups) {
  const keep = new Set(groups.flatMap((g) => ANNOTATION_FIELDS[g] ?? []));
  return Object.fromEntries(Object.entries(mark ?? {}).filter(([k]) => keep.has(k)));
}

// The geometry fields of a mark, for before/after reports (#69).
export function geometryOf(mark) {
  const g = { type: mark?.type };
  if (Array.isArray(mark?.points)) g.points = mark.points.map((p) => ({ x: p.x, y: p.y }));
  else for (const k of ["x", "y", "x2", "y2"]) if (mark?.[k] !== undefined) g[k] = mark[k];
  return g;
}

// How the geometry changed (#69): "move" when every vertex shifted by the same
// amount, "resize" when a box (rect) changed size, "reshape" otherwise (an
// arrow end, a polyline or quadrilateral vertex). null when it did not change.
export function geometryChange(before, after, eps = 1e-9) {
  if (!geometryChanged(before, after)) return null;
  const pts = (m) => Array.isArray(m.points) ? m.points : [{ x: m.x, y: m.y }, ...(m.x2 !== undefined ? [{ x: m.x2, y: m.y2 }] : [])];
  const a = pts(before), b = pts(after);
  if (a.length === b.length && a.length) {
    const dx = b[0].x - a[0].x, dy = b[0].y - a[0].y;
    if (a.every((p, i) => Math.abs(b[i].x - p.x - dx) <= eps && Math.abs(b[i].y - p.y - dy) <= eps)) return "move";
  }
  return before.type === "rect" && after.type === "rect" ? "resize" : "reshape";
}
