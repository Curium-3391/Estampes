// Per-photo canvas state. Marks live on the image cache entry, keyed by a
// stable id, so a later present_visual call adds to, edits or removes marks
// instead of the model re-sending everything. State lasts as long as the
// cached image (about an hour, in memory only).
import { mapMark } from "./image/transform.js";
import { markFindings, MARK_STATUSES } from "./scene-catalog.js";
import {
  assessmentInput, markRegion, findRejection, bringsNewEvidence, rejectionOf, addRejection, dropRejections,
} from "./assessment.js";

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

// Objects a module adds go into a layer of their own, named after the
// module (or what the caller asked for); the same name re-uses the layer.
export function moduleLayer(entry, name, module) {
  const found = layersOf(entry).find((l) => l.author === "assistant" && l.name === name && (l.module ?? null) === (module ?? null));
  if (found) return found;
  const layer = newLayer(entry, "assistant", name);
  if (module) layer.module = module;
  return layer;
}

// A layer can be renamed, reordered, locked and faded by the user. Locked
// means nobody (user or GPT) moves, restyles or deletes its marks; notes
// (findings) can still be attached. Opacity only changes how it is drawn.
const findLayer = (entry, id) => layersOf(entry).find((l) => l.id === id);
export const markLocked = (entry, mark) => !!mark?.layer && findLayer(entry, mark.layer)?.locked === true;
const lockedText = (entry, mark) => {
  const l = findLayer(entry, mark.layer);
  return "is in layer " + l.id + " " + JSON.stringify(l.name) + ", which the user locked; leave it as it is or ask the user to unlock it";
};

// Layers that still hold marks, in drawing order, with their mark counts.
export function canvasLayers(entry) {
  const counts = new Map();
  for (const m of marksOf(entry).values()) if (m.layer) counts.set(m.layer, (counts.get(m.layer) ?? 0) + 1);
  // Scene objects (scene/scene-ops.js) live in layers too.
  for (const o of entry.objects?.values() ?? []) if (o.layer) counts.set(o.layer, (counts.get(o.layer) ?? 0) + 1);
  return layersOf(entry).filter((l) => counts.has(l.id)).map((l) => ({ ...l, count: counts.get(l.id) }));
}

// Coordinates read off a process_image/overlay_grid output → full image.
// With width/height they are pixels of that output; without, 0..1 of region.
// With `matrix` (a derived view's derivedToNormalized, see src/image/view.js)
// any crop, scale, rotation or perspective warp is undone exactly.
export function fromFrame(mark, frame) {
  if (!frame) return mark;
  if (frame.matrix) return mapMark(mark, frame.matrix);
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
    if (markLocked(entry, old)) continue;
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

// ---- Claims on marks ---------------------------------------------------------
// A note on a mark is a claim. It carries the assistant's confidence, its
// evidence and ambiguities, and the user's review (see assessment.js). A
// changed note is a new claim: the old evidence and review do not carry
// over. A note the user already rejected at the same place is refused
// unless new evidence comes with it; refusals are reported, not thrown, so
// the rest of the call still lands.
const CLAIM_FIELDS = ["confidence", "evidence", "ambiguities", "review", "reviewReason", "previouslyRejected"];
export const claimOf = (m) => Object.fromEntries(CLAIM_FIELDS.filter((k) => m?.[k] !== undefined).map((k) => [k, m[k]]));
const withoutClaim = (m) => { const c = { ...m }; for (const k of CLAIM_FIELDS) delete c[k]; return c; };

function settleClaim(entry, old, mark, raw, { images, refused = [], where }) {
  const assess = assessmentInput(raw, { observer: "model", images: images ?? { left: entry.imageId }, where: where + ".evidence" });
  const base = withoutClaim(mark);
  if (!base.note) return base;
  if (old?.note === base.note) return { ...base, ...claimOf(old), ...assess };
  const at = { image: entry.imageId, region: markRegion(base) };
  const rejection = findRejection(entry.rejections, "note", { from: { ...at, text: base.note } }) ??
    (base.label ? findRejection(entry.rejections, "note", { from: { ...at, text: base.label } }) : undefined);
  if (rejection && !bringsNewEvidence(rejection, assess.evidence)) {
    refused.push({ id: base.id, kind: "note", text: base.note, rejection });
    // Keep whatever the mark said before; the refused wording never lands.
    if (old?.note) return { ...base, note: old.note, ...claimOf(old) };
    delete base.note;
    return base;
  }
  return { ...base, ...assess, ...(rejection ? { previouslyRejected: { at: rejection.at, ...(rejection.reason ? { reason: rejection.reason } : {}) } } : {}) };
}

const stageError = (stage, i, id, error) =>
  new Error("present_visual " + stage + "[" + i + "] (mark " + JSON.stringify(id) + "): " + (error?.message || error));

export function applyCanvasChanges(entry, changes) {
  const restore = snapshotCanvas(entry);
  try { return applyChanges(entry, changes); } catch (error) { restore(); throw error; }
}

function applyChanges(entry, { annotations = [], findings = [], remove = [], reset = false, priorUser = [], layer: layerName, frame, resolve, images, refused }) {
  const state = marksOf(entry);
  // Reset keeps what the user locked, and the layers of module objects
  // (marks are cleared; objects are changed through scene operations).
  if (reset) {
    for (const [id, m] of state) if (!markLocked(entry, m)) state.delete(id);
    const objectLayers = new Set([...(entry.objects?.values() ?? [])].map((o) => o.layer));
    entry.layers = layersOf(entry).filter((l) => l.locked || objectLayers.has(l.id));
  }
  remove.forEach((id, i) => {
    if (markLocked(entry, state.get(id))) throw stageError("remove", i, id, "mark " + lockedText(entry, state.get(id)));
    if (!state.delete(id)) throw stageError("remove", i, id, "no such mark on this canvas");
  });
  const named = layerName && layersOf(entry).find((l) => l.author === "assistant" && l.name === layerName);
  if (named?.locked && annotations.length) {
    throw stageError("layer", 0, layerName, "layer " + named.id + " is locked by the user; draw into another layer");
  }
  const changed = [];
  let replay = null, layer = null;
  for (const mark of priorUser) {
    if (!state.has(mark.id)) state.set(mark.id, { ...mark, layer: (replay ??= newLayer(entry, "user", "你 · 重播")).id });
  }
  annotations.forEach((raw, i) => {
    if (state.get(raw.id)?.author === "user") {
      throw stageError("annotations", i, raw.id, "field id is a mark the user drew; comment on it with findings instead of replacing it");
    }
    if (markLocked(entry, state.get(raw.id))) throw stageError("annotations", i, raw.id, "mark " + lockedText(entry, state.get(raw.id)));
    let mark;
    try { mark = resolve(fromFrame(raw, frame)); } catch (error) { throw stageError("annotations", i, raw.id, error); }
    // Re-using an id edits that mark; its old note survives unless replaced.
    const old = state.get(mark.id);
    const into = old?.layer && !layerName ? old.layer : (layer ??= layerFor(entry, "assistant", layerName)).id;
    let next;
    try {
      next = settleClaim(entry, old, { ...(old ? markFindings(old) : {}), ...mark, layer: into }, raw, { images, refused, where: "annotations[" + i + "]" });
    } catch (error) { throw stageError("annotations", i, raw.id, error); }
    state.set(mark.id, next);
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
    try {
      state.set(finding.id, settleClaim(entry, stored, { ...mark, ...update }, finding, { images, refused, where: "findings[" + i + "]" }));
    } catch (error) { throw stageError("findings", i, finding.id, error); }
    changed.push(finding.id);
  });
  return [...new Set(changed)];
}

// ---- The user's own edits from the canvas ----------------------------------
// Layer settings, moving or restyling marks the user drew in earlier turns,
// and deleting marks (the user owns the canvas, so GPT's marks too). GPT
// learns about them from `userEdits` on its next call. All or nothing.
export const LAYER_NAME_MAX = 40;
const opacityOf = (v) => Math.round(Math.min(1, Math.max(0.1, v)) * 20) / 20;

export function editCanvas(entry, { layers = [], order, marks = [], remove = [], resolveUser }) {
  const restore = snapshotCanvas(entry), state = marksOf(entry), edits = [];
  const fail = (stage, i, id, message) => new Error("edit_visual_canvas " + stage + "[" + i + "] (" + JSON.stringify(id) + "): " + message);
  try {
    entry.layers = layersOf(entry).map((l) => ({ ...l }));
    layers.forEach((edit, i) => {
      const layer = findLayer(entry, edit.id);
      if (!layer) throw fail("layers", i, edit.id, "no such layer");
      if (edit.name !== undefined) {
        const name = String(edit.name).trim().slice(0, LAYER_NAME_MAX);
        if (!name) throw fail("layers", i, edit.id, "name is empty");
        if (name !== layer.name) edits.push({ kind: "rename-layer", layer: layer.id, from: layer.name, to: name });
        layer.name = name;
      }
      if (edit.locked !== undefined && !!edit.locked !== !!layer.locked) {
        edits.push({ kind: edit.locked ? "lock-layer" : "unlock-layer", layer: layer.id });
        if (edit.locked) layer.locked = true; else delete layer.locked;
      }
      if (edit.opacity !== undefined) {
        const o = opacityOf(Number(edit.opacity));
        if (o >= 1) delete layer.opacity; else layer.opacity = o;
      }
    });
    if (order) {
      const all = layersOf(entry), byId = new Map(all.map((l) => [l.id, l]));
      if (new Set(order).size !== order.length || order.some((id) => !byId.has(id))) throw fail("order", 0, order.join(","), "unknown or repeated layer id");
      const rest = all.filter((l) => !order.includes(l.id));
      entry.layers = [...order.map((id) => byId.get(id)), ...rest];
      edits.push({ kind: "reorder-layers", order: entry.layers.map((l) => l.id) });
    }
    remove.forEach((id, i) => {
      const old = state.get(id);
      if (!old) throw fail("remove", i, id, "no such mark");
      if (markLocked(entry, old)) throw fail("remove", i, id, "its layer is locked");
      state.delete(id);
      edits.push({ kind: "remove-mark", id, author: old.author, ...(old.label ? { label: old.label } : {}) });
    });
    marks.forEach((edit, i) => {
      const old = state.get(edit.id);
      if (!old) throw fail("marks", i, edit.id, "no such mark");
      if (old.author !== "user") throw fail("marks", i, edit.id, "only your own marks can be moved or restyled; GPT's marks can be deleted");
      if (markLocked(entry, old)) throw fail("marks", i, edit.id, "its layer is locked");
      let next;
      try { next = resolveUser({ ...old, ...edit, author: "user" }); } catch (error) { throw fail("marks", i, edit.id, error?.message || error); }
      const moved = ["x", "y", "x2", "y2"].some((k) => next[k] !== old[k]) || JSON.stringify(next.points) !== JSON.stringify(old.points);
      state.set(edit.id, { ...old, ...next, author: "user", grounding: old.grounding, layer: old.layer, ...(moved ? { edited: true } : {}) });
      edits.push({ kind: moved ? "move-mark" : "restyle-mark", id: edit.id, ...(next.label ? { label: next.label } : {}) });
    });
    (entry.userEdits ??= []).push(...edits);
    if (entry.userEdits.length > 60) entry.userEdits.splice(0, entry.userEdits.length - 60);
    return edits;
  } catch (error) { restore(); throw error; }
}

// What the user changed by hand since GPT last looked; read once.
export function takeUserEdits(entry) {
  const edits = entry.userEdits ?? [];
  entry.userEdits = [];
  return edits;
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
// The key of an annotation set: an image's own canvas is keyed by its
// imageId; a copy made by a workspace Copy is "<imageId>#<setId>" (see
// workspace.js). Link stores are keyed by the other set's key, so links
// between two images' own canvases are the same in a paired view and in
// any workspace that shows both.
export const setKeyOf = (entry) => entry.setKey ?? entry.imageId;
export const LINK_REVIEW = ["confirmed", "rejected"];

export const linksOf = (left, rightId) => {
  left.pairLinks ??= new Map();
  if (!left.pairLinks.has(rightId)) left.pairLinks.set(rightId, new Map());
  return left.pairLinks.get(rightId);
};

export function pairLinks(left, right) {
  const links = linksOf(left, setKeyOf(right)), l = marksOf(left), r = marksOf(right);
  // A link whose mark was removed goes with it.
  for (const [id, link] of links) if (!l.has(link.left) || !r.has(link.right)) links.delete(id);
  return [...links.values()];
}

const sideError = (stage, i, id, message) =>
  new Error("present_visual " + stage + "[" + i + "] (mark " + JSON.stringify(id) + "): " + message);

// Apply one paired present_visual call. Annotations carry side left|right;
// findings and remove find their mark on either image. All or nothing.
export function applyPairChanges(left, right, { annotations = [], findings = [], remove = [], reset = false,
  priorUser = [], layer, frame, links = [], removeLinks = [], resolve, refused = [] }) {
  const images = { left: left.imageId, right: right.imageId };
  const restoreLeft = snapshotCanvas(left), restoreRight = snapshotCanvas(right);
  const store = linksOf(left, setKeyOf(right)), savedLinks = new Map(store);
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
        ...split[side], reset, layer, resolve, images, refused,
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
      const { evidence: _e, ambiguities: _a, confidence: _c, ...fields } = link;
      let assess;
      try { assess = assessmentInput(link, { observer: "model", images, where: "evidence" }); }
      catch (error) { throw new Error(where + error.message); }
      // A new or re-pointed link the user already rejected (same places on
      // both images, whatever the ids) needs new evidence; otherwise it is
      // left out and reported.
      let previouslyRejected;
      if (!old || moved) {
        const lm = marksOf(left).get(link.left), rm = marksOf(right).get(link.right);
        const rejection = findRejection(left.rejections, "link", {
          from: { image: left.imageId, region: markRegion(lm) }, to: { image: right.imageId, region: markRegion(rm) },
        });
        if (rejection && !bringsNewEvidence(rejection, assess.evidence)) { refused.push({ id: link.id, kind: "link", rejection }); return; }
        if (rejection) previouslyRejected = { at: rejection.at, ...(rejection.reason ? { reason: rejection.reason } : {}) };
      }
      // A user's review and the evidence stay with the link unless GPT re-points it.
      const next = {
        ...(old && !moved ? old : {}), ...fields, ...assess, author: "assistant",
        confidence: assess.confidence ?? (moved ? undefined : old?.confidence) ?? "medium",
        ...(previouslyRejected ? { previouslyRejected } : {}),
      };
      if (moved) { delete next.review; delete next.reviewReason; }
      store.set(link.id, next);
    });
    return changed;
  } catch (error) {
    restoreLeft(); restoreRight();
    left.pairLinks.set(setKeyOf(right), savedLinks);
    throw error;
  }
}

// The user's verdict on one link, from the canvas. A rejection is also
// remembered apart from the link (see assessment.js), so it outlives the
// link and its marks; confirming or withdrawing the verdict forgets it.
export const linkRef = (rightId, id) => "link:" + rightId + ":" + id;
const clearReview = (claim) => { const c = { ...claim }; delete c.review; delete c.reviewReason; return c; };

export function reviewLink(left, right, id, review, reason) {
  if (!LINK_REVIEW.includes(review) && review !== "unreviewed") throw new Error("review must be confirmed, rejected or unreviewed");
  const store = linksOf(left, setKeyOf(right)), link = store.get(id);
  if (!link) throw new Error("No link " + id + " between these images");
  const ref = linkRef(setKeyOf(right), id);
  dropRejections(left, ref);
  const next = { ...clearReview(link), ...(review === "unreviewed" ? {} : { review }) };
  if (review === "rejected") {
    if (reason?.trim()) next.reviewReason = reason.trim().slice(0, 200);
    const lm = marksOf(left).get(link.left), rm = marksOf(right).get(link.right);
    const end = (entry, m) => ({ image: entry.imageId, region: markRegion(m), text: m.label || link.label || m.id });
    addRejection(left, rejectionOf("link", link, { from: end(left, lm), to: end(right, rm), reason, ref }));
  }
  store.set(id, next);
  return next;
}

// The user's verdict on the note of one mark (the assistant's claim about
// what is there), on either kind of canvas.
export function reviewFinding(entry, id, review, reason) {
  if (!LINK_REVIEW.includes(review) && review !== "unreviewed") throw new Error("review must be confirmed, rejected or unreviewed");
  const state = marksOf(entry), mark = state.get(id);
  if (!mark) throw new Error("No mark " + id + " on this image");
  if (!mark.note) throw new Error("Mark " + id + " has no note to review");
  const ref = "note:" + id;
  dropRejections(entry, ref);
  const next = { ...clearReview(mark), ...(review === "unreviewed" ? {} : { review }) };
  if (review === "rejected") {
    if (reason?.trim()) next.reviewReason = reason.trim().slice(0, 200);
    addRejection(entry, rejectionOf("note", mark, { from: { image: entry.imageId, region: markRegion(mark), text: mark.note }, reason, ref }));
  }
  state.set(id, next);
  return next;
}

// ---- Workspaces: any number of images ---------------------------------------
// A workspace shows N annotation sets side by side (see workspace.js). Each
// item is { id: itemId, entry } where entry holds that item's marks. Marks
// are addressed by item and id: ids need only be unique within one item.
// Links join a mark of one item to a mark of another; they are stored on
// one of the two sets keyed by the other (the same store a paired view
// uses), so a link made in a paired view shows in every workspace that has
// both canvases and the other way round.

// Both directions of the link store between two sets, flattened to
// { id, fromItem, from, toItem, to, ...claim } in item order.
export function workspaceLinks(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) for (let j = 0; j < items.length; j++) {
    if (i === j || !items[i].entry.pairLinks?.has(setKeyOf(items[j].entry))) continue;
    for (const l of pairLinks(items[i].entry, items[j].entry)) {
      const { left, right, ...rest } = l;
      out.push({ ...rest, fromItem: items[i].id, from: left, toItem: items[j].id, to: right });
    }
  }
  return out;
}

// The store for a link between two items, in the direction it already has.
function linkStoreFor(a, b, id) {
  const ab = a.entry.pairLinks?.get(setKeyOf(b.entry)), ba = b.entry.pairLinks?.get(setKeyOf(a.entry));
  if (ba?.has(id) && !ab?.has(id)) return { owner: b, other: a, flipped: true, store: linksOf(b.entry, setKeyOf(a.entry)) };
  return { owner: a, other: b, flipped: false, store: linksOf(a.entry, setKeyOf(b.entry)) };
}

const wsError = (stage, i, id, message) =>
  new Error("present_visual " + stage + "[" + i + "] (" + JSON.stringify(id) + "): " + message);

// Apply one present_visual call on a workspace. annotations carry `item`
// (default: the first item); findings and remove take `item` or find a
// mark id that is unique across the workspace; links carry fromItem/from
// and toItem/to; removeLinks entries are link ids (unique across the
// workspace) or { id, fromItem, toItem }. All or nothing.
export function applyWorkspaceChanges(items, { annotations = [], findings = [], remove = [], reset = false, layer, frame, links = [],
  removeLinks = [], resolve, refused = [] }) {
  if (!items.length) throw new Error("This workspace has no images; add some first");
  const byId = new Map(items.map((it) => [it.id, it]));
  const images = Object.fromEntries(items.map((it) => [it.id, it.entry.imageId]));
  const restores = items.map((it) => snapshotCanvas(it.entry));
  const savedLinks = items.map((it) => new Map([...(it.entry.pairLinks ?? new Map())].map(([k, v]) => [k, new Map(v)])));
  const itemOf = (stage, i, id, item) => {
    if (item === undefined) return null;
    const found = byId.get(item);
    if (!found) throw wsError(stage, i, id, "field item " + JSON.stringify(item) + " is not an item of this workspace (items: " + [...byId.keys()].join(", ") + ")");
    return found;
  };
  const holding = (id) => items.filter((it) => marksOf(it.entry).has(id));
  const findMark = (stage, i, id, item) => {
    const it = itemOf(stage, i, id, item);
    if (it) { if (!marksOf(it.entry).has(id)) throw wsError(stage, i, id, "no such mark on item " + it.id); return it; }
    const all = holding(id);
    if (!all.length) throw wsError(stage, i, id, "no such mark on any item");
    if (all.length > 1) throw wsError(stage, i, id, "this mark id exists on items " + all.map((x) => x.id).join(", ") + "; give `item`");
    return all[0];
  };
  // Evidence names an item (default: the claim's own item).
  const evidenceIn = (raw, itemId) => raw.evidence === undefined ? raw
    : { ...raw, evidence: raw.evidence.map((e) => { const { item, ...rest } = e; return { ...rest, side: item ?? itemId }; }) };
  try {
    const split = new Map(items.map((it) => [it.id, { annotations: [], findings: [], remove: [] }]));
    if (reset) for (const it of items) it.entry.pairLinks = new Map([...(it.entry.pairLinks ?? [])].filter(([k]) => !items.some((o) => setKeyOf(o.entry) === k)));
    annotations.forEach((a, i) => {
      const it = itemOf("annotations", i, a.id, a.item) ?? items[0];
      const { item: _i, ...mark } = evidenceIn(a, it.id);
      split.get(it.id).annotations.push(mark);
    });
    findings.forEach((f, i) => {
      const added = items.filter((it) => split.get(it.id).annotations.some((a) => a.id === f.id));
      let it = itemOf("findings", i, f.id, f.item);
      if (!it && added.length === 1) it = added[0];
      if (!it) it = reset ? null : findMark("findings", i, f.id);
      if (!it) throw wsError("findings", i, f.id, "no such mark on any item");
      const { item: _i, ...finding } = evidenceIn(f, it.id);
      split.get(it.id).findings.push(finding);
    });
    remove.forEach((r, i) => {
      const { id, item } = typeof r === "string" ? { id: r } : r;
      split.get(findMark("remove", i, id, item).id).remove.push(id);
    });
    const changed = [];
    for (const it of items) {
      const own = split.get(it.id);
      changed.push(...applyChanges(it.entry, {
        ...own, reset, layer, resolve, images, refused,
        frame: frame && (frame.item ?? items[0].id) === it.id ? frame : undefined,
      }).map((id) => ({ item: it.id, id })));
    }
    removeLinks.forEach((r, i) => {
      const { id, fromItem, toItem } = typeof r === "string" ? { id: r } : r;
      const where = "present_visual removeLinks[" + i + "] (link " + JSON.stringify(id) + "): ";
      const found = workspaceLinks(items).filter((l) => l.id === id && (!fromItem || [l.fromItem, l.toItem].includes(fromItem)) && (!toItem || [l.fromItem, l.toItem].includes(toItem)));
      if (!found.length) throw new Error(where + "no such link");
      if (found.length > 1) throw new Error(where + "several links have this id; give fromItem and toItem");
      const l = found[0];
      linksOf(byId.get(l.fromItem).entry, setKeyOf(byId.get(l.toItem).entry)).delete(id);
    });
    links.forEach((link, i) => {
      const where = "present_visual links[" + i + "] (link " + JSON.stringify(link.id) + "): ";
      const a = byId.get(link.fromItem), b = byId.get(link.toItem);
      if (!a || !b) throw new Error(where + "fromItem and toItem must be items of this workspace (" + [...byId.keys()].join(", ") + ")");
      if (a === b) throw new Error(where + "a link joins marks on two different items");
      if (!marksOf(a.entry).has(link.from)) throw new Error(where + "field from " + JSON.stringify(link.from) + " is not a mark on item " + a.id);
      if (!marksOf(b.entry).has(link.to)) throw new Error(where + "field to " + JSON.stringify(link.to) + " is not a mark on item " + b.id);
      const { owner, other, flipped, store } = linkStoreFor(a, b, link.id);
      const leftMark = flipped ? link.to : link.from, rightMark = flipped ? link.from : link.to;
      const old = store.get(link.id);
      const moved = old && (old.left !== leftMark || old.right !== rightMark);
      const { evidence: _e, ambiguities: _a, confidence: _c, fromItem: _f, toItem: _t, from: _fm, to: _tm, ...fields } = link;
      let assess;
      try { assess = assessmentInput(evidenceIn(link, a.id), { observer: "model", images, where: "evidence" }); }
      catch (error) { throw new Error(where + error.message); }
      let previouslyRejected;
      if (!old || moved) {
        const lm = marksOf(owner.entry).get(leftMark), rm = marksOf(other.entry).get(rightMark);
        const rejection = findRejection(owner.entry.rejections, "link", {
          from: { image: owner.entry.imageId, region: markRegion(lm) }, to: { image: other.entry.imageId, region: markRegion(rm) },
        });
        if (rejection && !bringsNewEvidence(rejection, assess.evidence)) { refused.push({ id: link.id, kind: "link", rejection }); return; }
        if (rejection) previouslyRejected = { at: rejection.at, ...(rejection.reason ? { reason: rejection.reason } : {}) };
      }
      const next = {
        ...(old && !moved ? old : {}), ...fields, left: leftMark, right: rightMark, ...assess, author: "assistant",
        confidence: assess.confidence ?? (moved ? undefined : old?.confidence) ?? "medium",
        ...(previouslyRejected ? { previouslyRejected } : {}),
      };
      if (moved) { delete next.review; delete next.reviewReason; }
      store.set(link.id, next);
    });
    return changed;
  } catch (error) {
    restores.forEach((r) => r());
    items.forEach((it, i) => { it.entry.pairLinks = savedLinks[i]; });
    throw error;
  }
}

// The user's verdict on a workspace link: the same as a paired-view review,
// on whichever of the two sets holds the link.
export function reviewWorkspaceLink(items, { fromItem, toItem, id }, review, reason) {
  const a = items.find((it) => it.id === fromItem), b = items.find((it) => it.id === toItem);
  if (!a || !b) throw new Error("fromItem and toItem must be items of this workspace");
  const { owner, other } = linkStoreFor(a, b, id);
  return { owner, link: reviewLink(owner.entry, other.entry, id, review, reason) };
}
