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
// A call that fails part-way must leave the canvas as it was. Marks are
// replaced, never mutated, so a shallow copy is a full snapshot.
export function snapshotCanvas(entry) {
  const marks = new Map(marksOf(entry)), layers = [...layersOf(entry)];
  return () => { entry.marks = marks; entry.layers = layers; };
}

const stageError = (stage, i, id, error) =>
  new Error("present_visual " + stage + "[" + i + "] (mark " + JSON.stringify(id) + "): " + (error?.message || error));

export function applyCanvasChanges(entry, changes) {
  const restore = snapshotCanvas(entry);
  try { return applyChanges(entry, changes); } catch (error) { restore(); throw error; }
}

function applyChanges(entry, { annotations = [], findings = [], remove = [], reset = false, priorUser = [], layer: layerName, frame, resolve }) {
  const state = marksOf(entry);
  if (reset) { state.clear(); entry.layers = []; }
  remove.forEach((id, i) => {
    if (!state.delete(id)) throw stageError("remove", i, id, "no such mark on this canvas");
  });
  const changed = [];
  let replay = null, layer = null;
  for (const mark of priorUser) {
    if (!state.has(mark.id)) state.set(mark.id, { ...mark, layer: (replay ??= newLayer(entry, "user", "你 · 重播")).id });
  }
  annotations.forEach((raw, i) => {
    if (state.get(raw.id)?.author === "user") {
      throw stageError("annotations", i, raw.id, "field id is a mark the user drew; comment on it with findings instead of replacing it");
    }
    let mark;
    try { mark = resolve(fromFrame(raw, frame)); } catch (error) { throw stageError("annotations", i, raw.id, error); }
    // Re-using an id edits that mark; its old note survives unless replaced.
    const old = state.get(mark.id);
    const into = old?.layer && !layerName ? old.layer : (layer ??= layerFor(entry, "assistant", layerName)).id;
    state.set(mark.id, { ...(old ? markFindings(old) : {}), ...mark, layer: into });
    changed.push(mark.id);
  });
  findings.forEach((finding, i) => {
    const stored = state.get(finding.id);
    if (!stored) throw stageError("findings", i, finding.id, "no such mark to attach a finding to");
    // Copy: the stored object may belong to a snapshot. Only note/status
    // change; author, geometry and layer stay as they were.
    const mark = { ...stored };
    const update = markFindings(finding);
    if (finding.note === "") delete mark.note;
    if (finding.status !== undefined && !MARK_STATUSES.includes(finding.status)) delete mark.status;
    state.set(finding.id, { ...mark, ...update });
    changed.push(finding.id);
  });
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

// ---- Paired images ----------------------------------------------------------
// Two different images side by side (a schematic and a board photo, a map and
// an aerial photo, a drawing and the object). Each keeps its own marks and
// coordinates; links say "this left mark and this right mark are the same
// thing". Links live on the left entry, keyed by the right image, so showing
// the same pair again brings them back. GPT gives each link a confidence;
// the user confirms or rejects links, which GPT then reads back.
export const LINK_CONFIDENCE = ["high", "medium", "low"];
export const LINK_REVIEW = ["confirmed", "rejected"];

const linksOf = (left, rightId) => {
  left.pairLinks ??= new Map();
  if (!left.pairLinks.has(rightId)) left.pairLinks.set(rightId, new Map());
  return left.pairLinks.get(rightId);
};

export function pairLinks(left, right) {
  const links = linksOf(left, right.imageId), l = marksOf(left), r = marksOf(right);
  // A link whose mark was removed goes with it.
  for (const [id, link] of links) if (!l.has(link.left) || !r.has(link.right)) links.delete(id);
  return [...links.values()];
}

const sideError = (stage, i, id, message) =>
  new Error("present_visual " + stage + "[" + i + "] (mark " + JSON.stringify(id) + "): " + message);

// Apply one paired present_visual call. Annotations carry side left|right;
// findings and remove find their mark on either image. All or nothing.
export function applyPairChanges(left, right, { annotations = [], findings = [], remove = [], reset = false,
  priorUser = [], layer, frame, links = [], removeLinks = [], resolve }) {
  const restoreLeft = snapshotCanvas(left), restoreRight = snapshotCanvas(right);
  const store = linksOf(left, right.imageId), savedLinks = new Map(store);
  try {
    const entries = { left, right }, other = { left: right, right: left };
    const split = { left: { annotations: [], findings: [], remove: [], priorUser: [] }, right: { annotations: [], findings: [], remove: [], priorUser: [] } };
    if (reset) store.clear();
    const sideOf = (id) => marksOf(left).has(id) ? "left" : marksOf(right).has(id) ? "right" : null;
    // Ids must be unique across the pair: against what each image already
    // holds and against what this call adds or replays on the other side.
    const incoming = { left: new Set(), right: new Set() };
    for (const a of annotations) incoming[a.side ?? "left"].add(a.id);
    for (const m of priorUser) incoming[m.side ?? "left"].add(m.id);
    annotations.forEach((a, i) => {
      const side = a.side ?? "left", otherSide = side === "left" ? "right" : "left";
      if (incoming[otherSide].has(a.id)) {
        throw sideError("annotations", i, a.id, "field id is also used on the " + otherSide + " image in this call; ids must be unique across the pair");
      }
      if (!reset && marksOf(other[side]).has(a.id)) {
        throw sideError("annotations", i, a.id, "field id is already a mark on the " + (side === "left" ? "right" : "left") + " image; ids must be unique across the pair");
      }
      const { side: _s, ...mark } = a;
      split[side].annotations.push(mark);
    });
    priorUser.forEach((m) => { const { side = "left", ...mark } = m; split[side].priorUser.push(mark); });
    findings.forEach((f, i) => {
      // A mark added in this same call counts, on whichever side it was added.
      const added = ["left", "right"].find((s) => split[s].annotations.some((a) => a.id === f.id));
      const side = added ?? (reset ? null : sideOf(f.id));
      if (!side) throw sideError("findings", i, f.id, "no such mark on either image");
      split[side].findings.push(f);
    });
    remove.forEach((id, i) => {
      const side = sideOf(id);
      if (!side) throw sideError("remove", i, id, "no such mark on either image");
      split[side].remove.push(id);
    });
    const changed = [];
    for (const side of ["left", "right"]) {
      changed.push(...applyChanges(entries[side], {
        ...split[side], reset, layer, resolve,
        frame: frame && (frame.side ?? "left") === side ? frame : undefined,
      }));
    }
    removeLinks.forEach((id, i) => {
      if (!store.delete(id)) throw new Error("present_visual removeLinks[" + i + "] (link " + JSON.stringify(id) + "): no such link");
    });
    links.forEach((link, i) => {
      const where = "present_visual links[" + i + "] (link " + JSON.stringify(link.id) + "): ";
      if (!marksOf(left).has(link.left)) throw new Error(where + "field left " + JSON.stringify(link.left) + " is not a mark on the left image");
      if (!marksOf(right).has(link.right)) throw new Error(where + "field right " + JSON.stringify(link.right) + " is not a mark on the right image");
      const old = store.get(link.id);
      const moved = old && (old.left !== link.left || old.right !== link.right);
      // A user's review stays with the link unless GPT re-points it.
      store.set(link.id, {
        ...(old && !moved ? old : {}), ...link, author: "assistant",
        confidence: LINK_CONFIDENCE.includes(link.confidence) ? link.confidence : old?.confidence ?? "medium",
      });
      if (moved) { delete store.get(link.id).review; }
    });
    return changed;
  } catch (error) {
    restoreLeft(); restoreRight();
    left.pairLinks.set(right.imageId, savedLinks);
    throw error;
  }
}

// The user's verdict on one link, from the canvas.
export function reviewLink(left, right, id, review) {
  if (!LINK_REVIEW.includes(review)) throw new Error("review must be confirmed or rejected");
  const store = linksOf(left, right.imageId), link = store.get(id);
  if (!link) throw new Error("No link " + id + " between these images");
  const next = { ...link, review };
  store.set(id, next);
  return next;
}
