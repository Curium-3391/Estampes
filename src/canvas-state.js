// Per-photo canvas state. Marks live on the image cache entry, keyed by a
// stable id, so a later present_visual call adds to, edits or removes marks
// instead of the model re-sending everything. State lasts as long as the
// cached image (about an hour, in memory only).
import { markFindings, MARK_STATUSES } from "./scene-catalog.js";

const marksOf = (entry) => (entry.marks ??= new Map());

export function canvasMarks(entry) {
  return [...marksOf(entry).values()];
}

// Coordinates read off a process_image/overlay_grid output → full image.
// With width/height they are pixels of that output; without, 0..1 of region.
export function fromFrame(mark, frame) {
  if (!frame) return mark;
  const { region, width, height } = frame;
  const sx = width ? 1 / width : 1, sy = height ? 1 / height : 1;
  const mapX = (v) => v === undefined ? v : region.x + v * sx * (region.x2 - region.x);
  const mapY = (v) => v === undefined ? v : region.y + v * sy * (region.y2 - region.y);
  return {
    ...mark,
    x: mapX(mark.x), y: mapY(mark.y), x2: mapX(mark.x2), y2: mapY(mark.y2),
    ...(mark.points ? { points: mark.points.map((p) => ({ x: mapX(p.x), y: mapY(p.y) })) } : {}),
  };
}

export function storeUserMarks(entry, marks) {
  const state = marksOf(entry);
  for (const { role, ...mark } of marks) {
    state.set(mark.id, { ...(state.get(mark.id) ?? {}), ...mark, author: "user", grounding: "user-pointer" });
  }
}

// Apply one present_visual call. `resolve` turns a model mark into a
// validated assistant mark. Returns the ids this call added or changed.
export function applyCanvasChanges(entry, { annotations = [], findings = [], remove = [], reset = false, priorUser = [], frame, resolve }) {
  const state = marksOf(entry);
  if (reset) state.clear();
  for (const id of remove) {
    if (!state.delete(id)) throw new Error("No mark " + id + " to remove");
  }
  const changed = [];
  for (const mark of priorUser) if (!state.has(mark.id)) state.set(mark.id, mark);
  for (const raw of annotations) {
    if (state.get(raw.id)?.author === "user") {
      throw new Error("Mark " + raw.id + " was drawn by the user; comment on it with findings instead of replacing it");
    }
    const mark = resolve(fromFrame(raw, frame));
    // Re-using an id edits that mark; its old note survives unless replaced.
    const old = state.get(mark.id);
    state.set(mark.id, { ...(old ? markFindings(old) : {}), ...mark });
    changed.push(mark.id);
  }
  for (const finding of findings) {
    const mark = state.get(finding.id);
    if (!mark) throw new Error("No mark " + finding.id + " to attach a finding to");
    const update = markFindings(finding);
    if (finding.note === "") delete mark.note;
    if (finding.status !== undefined && !MARK_STATUSES.includes(finding.status)) delete mark.status;
    state.set(finding.id, { ...mark, ...update });
    changed.push(finding.id);
  }
  return [...new Set(changed)];
}
