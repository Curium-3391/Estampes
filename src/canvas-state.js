// Per-photo canvas state. Marks live on the image cache entry, keyed by a
// stable id, so a later present_visual call adds to, edits or removes marks
// instead of the model re-sending everything. State lasts as long as the
// cached image (about an hour, in memory only).
import { markFindings, MARK_STATUSES } from "./scene-catalog.js";

const marksOf = (entry) => (entry.marks ??= new Map());

export function canvasMarks(entry) {
  return [...marksOf(entry).values()];
}

// Layers group marks by when they were drawn: each user submission and
// each GPT drawing call starts one, unless GPT names an existing layer.
// A mark carries its layer id; the widget shows or hides whole layers.
const layersOf = (entry) => (entry.layers ??= []);
const AUTHOR_NAME = { user: "你", assistant: "GPT" };

function newLayer(entry, author, name) {
  const layers = layersOf(entry);
  const n = layers.filter((l) => l.author === author).length + 1;
  const layer = { id: "L" + (layers.reduce((m, l) => Math.max(m, +l.id.slice(1) || 0), 0) + 1), author,
    name: name || AUTHOR_NAME[author] + " · 第" + n + "次" };
  layers.push(layer);
  return layer;
}

function layerFor(entry, author, name) {
  return (name && layersOf(entry).find((l) => l.author === author && l.name === name)) || newLayer(entry, author, name);
}

// Layers that still hold marks, in drawing order, with their mark counts.
export function canvasLayers(entry) {
  const counts = new Map();
  for (const m of marksOf(entry).values()) if (m.layer) counts.set(m.layer, (counts.get(m.layer) ?? 0) + 1);
  return layersOf(entry).filter((l) => counts.has(l.id)).map((l) => ({ ...l, count: counts.get(l.id) }));
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

// Marks the canvas already had keep their layer; new ones share a layer
// for this submission, which is returned (null when nothing was new).
export function storeUserMarks(entry, marks) {
  const state = marksOf(entry);
  let layer = null;
  for (const { role, layer: _ignored, ...mark } of marks) {
    const old = state.get(mark.id);
    const id = old?.layer ?? (layer ??= newLayer(entry, "user")).id;
    state.set(mark.id, { ...(old ?? {}), ...mark, author: "user", grounding: "user-pointer", layer: id });
  }
  return layer;
}

// Apply one present_visual call. `resolve` turns a model mark into a
// validated assistant mark. New marks go into one layer per call (`layer`
// names it, or picks an existing GPT layer of that name); edited marks stay
// in their layer unless `layer` is given. Returns the ids this call added
// or changed.
export function applyCanvasChanges(entry, { annotations = [], findings = [], remove = [], reset = false, priorUser = [], layer: layerName, frame, resolve }) {
  const state = marksOf(entry);
  if (reset) { state.clear(); entry.layers = []; }
  for (const id of remove) {
    if (!state.delete(id)) throw new Error("No mark " + id + " to remove");
  }
  const changed = [];
  let replay = null, layer = null;
  for (const mark of priorUser) {
    if (!state.has(mark.id)) state.set(mark.id, { ...mark, layer: (replay ??= newLayer(entry, "user", "你 · 重播")).id });
  }
  for (const raw of annotations) {
    if (state.get(raw.id)?.author === "user") {
      throw new Error("Mark " + raw.id + " was drawn by the user; comment on it with findings instead of replacing it");
    }
    const mark = resolve(fromFrame(raw, frame));
    // Re-using an id edits that mark; its old note survives unless replaced.
    const old = state.get(mark.id);
    const into = old?.layer && !layerName ? old.layer : (layer ??= layerFor(entry, "assistant", layerName)).id;
    state.set(mark.id, { ...(old ? markFindings(old) : {}), ...mark, layer: into });
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

// Marks restored from an exported file. User marks keep their author but
// are marked as replayed; GPT marks are re-validated. Existing marks win
// for user ids; GPT ids are overwritten by the file. The file's layers come
// back under fresh ids so they never merge with this canvas's layers.
// Returns the ids added.
export function importMarks(entry, marks, { layers = [], replayUser, resolve }) {
  const state = marksOf(entry), added = [], mapped = new Map();
  const into = (mark) => {
    const key = mark.author + "\u0000" + (mark.layer ?? "");
    if (!mapped.has(key)) {
      const from = layers.find((l) => l.id === mark.layer && l.author === mark.author);
      mapped.set(key, newLayer(entry, mark.author, from?.name || AUTHOR_NAME[mark.author] + " · 匯入").id);
    }
    return mapped.get(key);
  };
  for (const mark of marks) {
    if (mark.author === "user") {
      if (state.has(mark.id)) continue;
      state.set(mark.id, { ...replayUser(mark), layer: into(mark) });
    } else {
      if (state.get(mark.id)?.author === "user") continue;
      state.set(mark.id, { ...resolve(mark), layer: into(mark) });
    }
    added.push(mark.id);
  }
  return added;
}
