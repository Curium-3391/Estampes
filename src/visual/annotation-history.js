// Inverse history for edits to marks (UVA Phase 2, PR-2B). Each entry keeps
// the exact mark before and after, so undo and redo restore exact state, and
// refuse (instead of overwriting) when the mark is not as the entry expects:
// someone, the assistant included, changed it since.
//
// Kinds: move, resize, restyle, relabel, note, relayer, anchor, delete, create. One edit
// can be several kinds (e.g. move + restyle); `kinds` is for reporting.
import { markPoints } from "./coordinates.js";
import { ANNOTATION_FIELDS } from "./annotation-contract.js";

export const HISTORY_KEEP = 50;
const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
};

const span = (m) => {
  const pts = markPoints(m), xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
};

// What kind of change turns `before` into `after` (both stored marks).
export function classifyChange(before, after) {
  if (!before && after) return ["create"];
  if (before && !after) return ["delete"];
  const kinds = [];
  const geometry = ANNOTATION_FIELDS.geometry;
  if (geometry.some((k) => !deepEqual(before[k], after[k]))) {
    const [bw, bh] = span(before), [aw, ah] = span(after), eps = 1e-9;
    const resized = before.type !== after.type || Math.abs(bw - aw) > eps || Math.abs(bh - ah) > eps ||
      markPoints(before).length !== markPoints(after).length;
    kinds.push(resized ? "resize" : "move");
  }
  if (ANNOTATION_FIELDS.style.some((k) => before[k] !== after[k])) kinds.push("restyle");
  if (before.label !== after.label) kinds.push("relabel");
  if (before.note !== after.note) kinds.push("note");
  if (before.layer !== after.layer) kinds.push("relayer");
  // Fixed to the axes or to the page (UVA Phase 4B-3).
  const anchorOf = (m) => m.anchor?.space === "world" ? "world:" + m.anchor.frame : "document";
  if (anchorOf(before) !== anchorOf(after)) kinds.push("anchor");
  return kinds;
}

export class HistoryConflict extends Error {
  constructor(message, id) { super(message); this.name = "HistoryConflict"; this.id = id; }
}

export const historyOf = (entry) => (entry.markHistory ??= { past: [], future: [] });

// Record one successful change. A new change ends any redo chain.
export function recordChange(entry, { before, after }) {
  const id = (after ?? before).id, kinds = classifyChange(before, after);
  if (!kinds.length) return null;
  const h = historyOf(entry), item = { id, kinds, before: before ?? null, after: after ?? null };
  h.past.push(item);
  if (h.past.length > HISTORY_KEEP) h.past.splice(0, h.past.length - HISTORY_KEEP);
  h.future = [];
  return item;
}

// Put `to` in place of `from` for item.id, or throw HistoryConflict.
// `marks` is the canvas Map; `locked(mark)` says whether a mark's layer is locked.
function swap(marks, item, from, to, locked, verb) {
  const current = marks.get(item.id) ?? null;
  if (!deepEqual(current, from)) {
    throw new HistoryConflict("Cannot " + verb + " " + item.kinds.join("+") + " of mark " + JSON.stringify(item.id) + ": it has changed since (" +
      (current ? "it is not as that step left it" : "it no longer exists") + ")", item.id);
  }
  if (current && locked(current)) throw new HistoryConflict("Cannot " + verb + ": mark " + JSON.stringify(item.id) + " is in a layer the user locked", item.id);
  if (to && locked(to)) throw new HistoryConflict("Cannot " + verb + ": mark " + JSON.stringify(item.id) + " would return to a layer the user locked", item.id);
  if (to) marks.set(item.id, to); else marks.delete(item.id);
}

export function undoChange(entry, marks, locked = () => false) {
  const h = historyOf(entry), item = h.past[h.past.length - 1];
  if (!item) throw new HistoryConflict("Nothing to undo");
  swap(marks, item, item.after, item.before, locked, "undo");
  h.past.pop(); h.future.push(item);
  return item;
}

export function redoChange(entry, marks, locked = () => false) {
  const h = historyOf(entry), item = h.future[h.future.length - 1];
  if (!item) throw new HistoryConflict("Nothing to redo");
  swap(marks, item, item.before, item.after, locked, "redo");
  h.future.pop(); h.past.push(item);
  return item;
}

export const historyState = (entry) => ({ canUndo: historyOf(entry).past.length > 0, canRedo: historyOf(entry).future.length > 0,
  undoNext: historyOf(entry).past.at(-1)?.kinds ?? null });
