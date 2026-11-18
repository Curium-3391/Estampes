// Graph documents (UVA Phase 4A-2). A Graph is drawn on a plain colour, not on
// an image: it has no image bytes, no asset, no zoom tiles and no pixels. Its
// id is gph:<16 hex> (random), never img:, so nothing mistakes it for a photo.
//
// The canvas itself (marks, layers, objects such as axes and plots) is the
// same canvas record as an image's, saved through the UVA canvas store
// (src/storage.js). This module only holds the in-memory entries, in their own
// small registry: the image cache (src/image-store.js) is keyed by image bytes
// and stays as it is.
import { randomBytes } from "node:crypto";
import { SOLID_COLOR } from "./background.js";

export const GRAPH_ID = /^gph:[0-9a-f]{16}$/;
export const isGraphId = (id) => typeof id === "string" && GRAPH_ID.test(id);
export const newGraphId = () => "gph:" + randomBytes(8).toString("hex");
export const GRAPH_SIZE = Object.freeze({ width: 1600, height: 1000, min: 200, max: 4096 });
export const GRAPH_COLOR = "#ffffff";

// Checks the size and colour of a new Graph. Returns normalized values or throws.
export function graphSpec({ width = GRAPH_SIZE.width, height = GRAPH_SIZE.height, color = GRAPH_COLOR, title = null } = {}) {
  const w = Math.round(width), h = Math.round(height);
  if (![w, h].every((v) => Number.isFinite(v) && v >= GRAPH_SIZE.min && v <= GRAPH_SIZE.max)) {
    throw new Error("A Graph is " + GRAPH_SIZE.min + " to " + GRAPH_SIZE.max + " units on each side");
  }
  if (typeof color !== "string" || !SOLID_COLOR.test(color)) throw new Error("A Graph background colour is #rrggbb");
  return { width: w, height: h, color: color.toLowerCase(), title: title == null ? null : String(title).slice(0, 80) };
}

// A Graph entry has the fields canvas code reads from an image entry, and no
// pixels. `kind: "graph"` lets a caller tell it apart without parsing the id.
export function graphEntry(imageId, { width, height, color, title = null }) {
  if (!isGraphId(imageId)) throw new Error("Not a Graph id: " + imageId);
  return {
    imageId, kind: "graph", width, height,
    background: { kind: "solid", color },
    pixels: null, channels: 0, sourceBytes: null, sourceAssetId: null, sourceInfo: null,
    original: { format: "graph", width, height },
    source: "graph", fileName: title, touched: Date.now(),
  };
}

// Entries in memory, most recently used last. A Graph that falls out is read
// again from the store (storage.js ensureImage).
const LIMIT = 256;
const entries = new Map();
export function rememberGraph(entry) {
  entries.delete(entry.imageId); entries.set(entry.imageId, entry);
  while (entries.size > LIMIT) entries.delete(entries.keys().next().value);
  return entry;
}
export function cachedGraph(imageId) {
  const entry = entries.get(imageId);
  if (entry) { entries.delete(imageId); entries.set(imageId, entry); entry.touched = Date.now(); }
  return entry ?? null;
}
export const forgetGraph = (imageId) => entries.delete(imageId);
