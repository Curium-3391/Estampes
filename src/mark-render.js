// Draws marks onto the real photo so the model can check its own work: the
// same crop twice, original pixels next to the crop with marks numbered.
// Mirrors the widget's styles (colour, size, highlighter).
import sharp from "sharp";
import { entrySharp } from "./image-store.js";
import { regionToPixels } from "./image-ops.js";
import { labelSvg } from "./pixel-font.js";
import { inkUnits } from "./visual/ink.js";
import { renderItem } from "./visual/render-plan.js";
import { itemSvg } from "./visual/render-svg.js";

const PANEL_LONG_SIDE = 900;
const MAX_ZOOM = 6;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export { inkUnits };

// Plain-language check of each mark's ink against its own geometry, in
// pixels of the working image. The model has no other way to know how
// thick a size really is on this photo.
export function inkReport(marks, entry) {
  const toPx = entry.width / 1000;
  return marks.map((m) => {
    const ink = inkUnits(m), px = Math.round(ink.total * toPx * 10) / 10;
    const w = Math.abs((m.x2 ?? m.x) - m.x) * entry.width, h = Math.abs((m.y2 ?? m.y) - m.y) * entry.height;
    const hl = m.pen === "highlighter";
    let warn = null;
    if (ink.stroke < 2) warn = "very thin at full view; visible only when zoomed";
    else if (m.type === "rect" && !hl && px > 0.2 * Math.min(w, h)) warn = "outline covers much of a " + Math.round(w) + "x" + Math.round(h) + "px box; use a smaller size or the highlighter";
    else if (m.type === "polyline" && m.closed && px * 4 > Math.min(w, h)) warn = "loop is only " + Math.round(Math.min(w, h)) + "px across for a " + px + "px line; use a smaller size";
    else if (m.type === "point" && ink.dot * toPx > 0.05 * Math.max(entry.width, entry.height)) warn = "dot is large for a precise point; use a smaller size";
    return { id: m.id, type: m.type, pen: hl ? "highlighter" : "pen", size: m.size ?? "medium",
      px: m.type === "point" ? Math.round(ink.dot * toPx) : px, warn };
  });
}

// Union box of the marks, padded, at least `minSpan` wide/tall.
export function marksRegion(marks, { pad = 0.03, minSpan = 0.08 } = {}) {
  const xs = marks.flatMap((m) => [m.x, m.x2 ?? m.x]), ys = marks.flatMap((m) => [m.y, m.y2 ?? m.y]);
  let x = Math.min(...xs) - pad, x2 = Math.max(...xs) + pad, y = Math.min(...ys) - pad, y2 = Math.max(...ys) + pad;
  if (x2 - x < minSpan) { const c = (x + x2) / 2; x = c - minSpan / 2; x2 = c + minSpan / 2; }
  if (y2 - y < minSpan) { const c = (y + y2) / 2; y = c - minSpan / 2; y2 = c + minSpan / 2; }
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), x2: clamp(x2, 0, 1), y2: clamp(y2, 0, 1) };
}

// `toPx` turns canvas units into panel pixels, so strokes keep the width
// they really have on the photo: a line too fat for its target shows it.
// Drawn from the shared RenderPlan item (src/visual/render-svg.js).
export function markSvg(m, map, toPx) {
  return itemSvg(renderItem(m), map, toPx);
}

// Where to put a mark's number: its start (polyline), tail (arrow) or corner.
const anchor = (m) => m.type === "polyline" ? m.points[0] : { x: m.x, y: m.y };

export async function renderVerification(entry, marks, focusIds = []) {
  const focus = marks.filter((m) => focusIds.includes(m.id));
  const shown = focus.length ? focus : marks;
  const region = marksRegion(shown);
  const px = regionToPixels(region, entry.width, entry.height);
  const scale = Math.min(MAX_ZOOM, PANEL_LONG_SIDE / Math.max(px.width, px.height));
  const w = Math.max(1, Math.round(px.width * scale)), h = Math.max(1, Math.round(px.height * scale));
  const crop = await entrySharp(entry).extract(px).resize({ width: w, height: h, kernel: "lanczos3" }).png().toBuffer();
  const map = (nx, ny) => [Math.round((nx * entry.width - px.left) * scale * 10) / 10, Math.round((ny * entry.height - px.top) * scale * 10) / 10];
  const toPx = entry.width / 1000 * scale;
  const glyph = Math.max(2, Math.round(Math.max(w, h) / 220));
  const numbered = shown.map((m, i) => ({ m, n: i + 1 }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    numbered.map(({ m }) => markSvg(m, map, toPx)).join("") +
    numbered.map(({ m, n }) => {
      const [ax, ay] = map(anchor(m).x, anchor(m).y);
      return labelSvg(String(n), clamp(ax + glyph * 2, 0, w - glyph * 12), clamp(ay - glyph * 9, 0, h - glyph * 8), glyph);
    }).join("") + "</svg>";
  const marked = await sharp(crop).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  // Side by side for tall crops, stacked for wide ones; 8 px white gap.
  const across = w <= h, gap = 8;
  const W = across ? w * 2 + gap : w, H = across ? h : h * 2 + gap;
  const data = await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
    .composite([{ input: crop, left: 0, top: 0 }, { input: marked, left: across ? w + gap : 0, top: across ? 0 : h + gap }])
    // Full-resolution chroma keeps thin coloured lines from smearing.
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer();
  return {
    data, mimeType: "image/jpeg", layout: across ? "side-by-side" : "stacked",
    region: { x: px.left / entry.width, y: px.top / entry.height, x2: (px.left + px.width) / entry.width, y2: (px.top + px.height) / entry.height },
    numbers: numbered.map(({ m, n }) => ({ n, id: m.id, label: m.label })),
  };
}
