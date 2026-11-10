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
  // What the assistant concluded, and the user's verdict on it.
  claim: Object.freeze(["note", "status", "confidence", "evidence", "ambiguities", "review", "reviewReason", "previouslyRejected", "findingUpdatedAt"]),
  // Who made it and how it was placed.
  provenance: Object.freeze(["author", "grounding", "edited"]),
  placement: Object.freeze(["layer"]),
});

export const ANNOTATION_FIELD_NAMES = Object.freeze(new Set(Object.values(ANNOTATION_FIELDS).flat()));

// Fields that only change when the claim (the note) changes: a changed note is
// a new claim and does not inherit the old evidence or review.
export const CLAIM_FIELDS = Object.freeze(["confidence", "evidence", "ambiguities", "review", "reviewReason", "previouslyRejected"]);
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
