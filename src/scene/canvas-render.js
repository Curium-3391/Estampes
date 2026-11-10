// Public canvas pixels. No module execution, and no scratch objects.
import sharp from "sharp";
import { createHash } from "node:crypto";
import { entrySharp } from "../image-store.js";
import { regionToPixels, pixelsToRegion } from "../image-ops.js";
import { canvasMarks, canvasLayers } from "../canvas-state.js";
import { markSvg } from "../mark-render.js";
import { renderedObjects } from "./scene-ops.js";
import { primitivesSvg } from "./objects.js";

const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]);
const hiddenIds = (ids) => [...new Set(ids)].sort();

export function canvasRevision(entry, hiddenLayers = []) {
  return "cv:" + createHash("sha256").update(JSON.stringify(canonical({
    imageId: entry.imageId, setId: entry.setId, width: entry.width, height: entry.height,
    objects: [...(entry.objects?.values() ?? [])], marks: canvasMarks(entry),
    layers: canvasLayers(entry), baseAsObject: !!entry.baseAsObject, hiddenLayers: hiddenIds(hiddenLayers),
  }))).digest("hex").slice(0, 24);
}

export function canvasReadRequest(entry, hiddenLayers = []) {
  const hidden = hiddenIds(hiddenLayers);
  return { imageId: entry.imageId, ...(entry.setId ? { setId: entry.setId } : {}),
    hiddenLayers: hidden, expectedRevision: canvasRevision(entry, hidden) };
}

export async function renderCanvas(entry, { region, maxSide = 1600, format = "png", hiddenLayers = [], labels = "none", expectedRevision, scratch = false } = {}) {
  if (!Number.isInteger(maxSide) || maxSide < 64 || maxSide > 4096) throw new Error("maxSide must be 64..4096");
  if (!["png", "webp"].includes(format) || !["none", "all"].includes(labels)) throw new Error("Invalid format or labels");
  if (region && ![region.x, region.y, region.x2, region.y2].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error("Invalid region");
  const revision = canvasRevision(entry, hiddenLayers);
  if (expectedRevision !== undefined && revision !== expectedRevision) {
    const error = new Error("Canvas changed since submission; the requested revision is unavailable. Read the current state and clarify the changed context.");
    error.code = "STALE_CANVAS"; error.revision = revision; throw error;
  }
  // Snapshot all drawing inputs before the first await: concurrent edits cannot
  // mix a new annotation state into an older revision's pixels.
  const layers = canvasLayers(entry), hidden = new Set([...hiddenLayers, ...layers.filter(l => l.visible === false).map(l => l.id)]);
  const objects = renderedObjects(entry).filter((r) => (scratch || r.object.visibility === "public") && !hidden.has(r.object.layer));
  const marks = canvasMarks(entry).filter((m) => !hidden.has(m.layer));
  const px = regionToPixels(region, entry.width, entry.height);
  const scale = maxSide / Math.max(px.width, px.height);
  const width = Math.max(1, Math.round(px.width * scale)), height = Math.max(1, Math.round(px.height * scale));
  const actualRegion = pixelsToRegion(px, entry.width, entry.height);
  const layerOpacity = (id) => layers.find((l) => l.id === id)?.opacity ?? 1;
  // Match the widget's stacking: objects under marks; marks in layer order.
  const known = new Set(layers.map((l) => l.id));
  const markBody = (m) => markSvg(m, (x, y) => [x * entry.width, y * entry.height], entry.width / 1000) +
    (labels === "all" && m.label ? `<text x="${m.x * entry.width + 6}" y="${m.y * entry.height - 8}" font-size="${15 * entry.width / 640}" fill="#17212A">${xml(m.label)}</text>` : "");
  const marksSvg = [null, ...layers.map((l) => l.id)].map((id) => {
    const own = marks.filter((m) => id === null ? !known.has(m.layer) : m.layer === id);
    const objectSvg = objects.filter(r=>id===null?!known.has(r.object.layer):r.object.layer===id).map(r=>primitivesSvg(r.primitives,entry.width,entry.height)).join("");
    return `<g opacity="${layerOpacity(id)}">${objectSvg}` + own.filter((m) => m.author !== "user").map(markBody).join("") +
      `<g opacity="0.55">${own.filter((m) => m.author === "user").map(markBody).join("")}</g></g>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${px.left} ${px.top} ${px.width} ${px.height}" preserveAspectRatio="none">${marksSvg}</svg>`;
  const included = { base: !entry.baseAsObject, objects: objects.map((r) => r.object.id), marks: marks.map((m) => m.id) };
  const warnings = scale > 1 ? ["Base image enlarged by interpolation; vector overlays rendered at output resolution."] : [];
  const sourceKind = entry.source === "blank" ? "blank" : entry.page ? "pdf-page" : "image";
  const base = entry.baseAsObject ? sharp({create:{width:entry.width,height:entry.height,channels:4,background:{r:0,g:0,b:0,alpha:0}}}) : entrySharp(entry);
  const pipeline = base.extract(px).resize(width, height).composite([{ input: Buffer.from(svg) }]);
  const data = await (format === "webp" ? pipeline.webp({ lossless: true }) : pipeline.png()).toBuffer();
  return { data, mimeType: "image/" + format, width, height,
    metadata: { kind: "estampes.canvas_render", imageId: entry.imageId, ...(entry.setId ? { setId: entry.setId } : {}),
      revision, sourceKind, contentMode: "visible-composite", region: actualRegion, included,
      excluded: { scratch: !scratch, hiddenLayers: hiddenIds(hiddenLayers) }, labels,
      output: { width, height, format }, mapping: { pixelToCanvasNormalized: [px.width / width / entry.width, 0, px.left / entry.width,
        0, px.height / height / entry.height, px.top / entry.height, 0, 0, 1] }, warnings } };
}
