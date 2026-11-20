// Export a photo's marks as a layered SVG the user can keep, open in any
// vector editor, and attach to a later chat to restore the canvas. The
// marks travel as JSON inside <metadata>; nothing else in the file is read
// back, so an edited drawing never turns into unvalidated marks.
import { cleanNameFields } from "./i18n/names.js";
import { markSvg } from "./mark-render.js";
import { READABLE_PROTOCOLS, marksFromDocument } from "./protocol.js";
import { renderedObjects } from "./scene/scene-ops.js";
import { primitivesSvg } from "./scene/objects.js";
import { t } from "./i18n/index.js";

export const MARKS_FORMAT = "estampes-marks";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const K = 1000 / 640;

const xml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

// One SVG layer per Estampes layer, in drawing order; marks without a
// layer (older canvases) fall back to a layer per author.
export function exportMarksSvg(entry, marks, layers = []) {
  const { width: W, height: H } = entry, toPx = W / 1000;
  const map = (nx, ny) => [Math.round(nx * W * 10) / 10, Math.round(ny * H * 10) / 10];
  // Public scene objects (function plots, axes, shapes) are drawn in their
  // layer under the marks, as plain vector paths and text.
  const objects = renderedObjects(entry).filter((r) => r.object.visibility === "public");
  const objectSvg = (layerId) => objects.filter((r) => (r.object.layer ?? null) === layerId)
    .map((r) => `<g id="object-${xml(r.object.id)}">${primitivesSvg(r.primitives, W, H)}</g>`).join("");
  const layer = (id, name, list, opacity, layerId = undefined, visible = true) => !list.length && !(layerId && objectSvg(layerId)) ? "" :
    `<g id="${id}" inkscape:groupmode="layer" inkscape:label="${xml(name)}"${opacity < 1 ? ` opacity="${opacity}"` : ""}${visible === false ? ' style="display:none"' : ""}>` + (layerId ? objectSvg(layerId) : "") + list.map((m) => {
      const a = m.type === "polyline" ? m.points[0] : { x: m.x, y: m.y };
      const [lx, ly] = map(a.x, a.y), fs = 15 * K * toPx;
      const label = m.label ? `<text x="${lx + fs * 0.6}" y="${ly - fs * 0.8}" font-size="${fs}" font-weight="700" fill="${m.author === "user" ? "#579DF6" : "#E4AE57"}" stroke="#17212A" stroke-width="${0.8 * K * toPx}" paint-order="stroke">${xml(m.label)}</text>` : "";
      return `<g id="mark-${xml(m.id)}">${markSvg(m, map, toPx)}${label}</g>`;
    }).join("") + "</g>";
  const known = new Set(layers.map((l) => l.id));
  const groups = [
    ...layers.map((l) => layer("estampes-" + l.id, l.name, marks.filter((m) => m.layer === l.id), l.opacity, l.id, l.visible)),
    layer("estampes-user", t("name.marksFile.user"), marks.filter((m) => m.author === "user" && !known.has(m.layer))),
    layer("estampes-gpt", "AI", marks.filter((m) => m.author !== "user" && !known.has(m.layer))),
  ].filter(Boolean).join("\n");
  const payload = JSON.stringify({ format: MARKS_FORMAT, version: 2, imageId: entry.imageId, width: W, height: H,
    layers: layers.map(({ id, author, name, nameKey, nameParams, locked, opacity, visible }) => ({ id, author, name, ...(nameKey ? { nameKey, nameParams } : {}),
      ...(locked ? { locked: true } : {}), ...(visible === false ? { visible: false } : {}), ...(opacity < 1 ? { opacity } : {}) })), marks })
    .replace(/]]>/g, "]]\\u003e");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<title>Estampes marks ${xml(entry.imageId)}</title>
<metadata id="${MARKS_FORMAT}"><![CDATA[${payload}]]></metadata>
${groups}
</svg>
`;
}

// Accepts the exported SVG, its bare JSON, or an estampes.visual/1 or /2 document
// (get_visual_state, /api/v1/canvas). Returns the untrusted payload; the
// caller validates every mark. `image` picks the matching image of a pair.
export function parseMarksFile(bytes, image = {}) {
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Marks file is larger than 2 MB");
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  const json = text.trimStart().startsWith("{") ? text :
    new RegExp(`<metadata id="${MARKS_FORMAT}"><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></metadata>`).exec(text)?.[1];
  if (!json) throw new Error("Not an Estampes marks file (no estampes-marks metadata)");
  let data;
  try { data = JSON.parse(json); } catch { throw new Error("Estampes marks metadata is not valid JSON"); }
  if (READABLE_PROTOCOLS.includes(data?.protocol)) data = { format: MARKS_FORMAT, ...marksFromDocument(data, image) };
  if (data?.format !== MARKS_FORMAT || !Array.isArray(data.marks)) throw new Error("Not an Estampes marks file");
  if (data.marks.length > 60) throw new Error("Marks file has more than 60 marks");
  return { imageId: data.imageId, width: Number(data.width), height: Number(data.height), marks: data.marks,
    layers: Array.isArray(data.layers) ? data.layers.slice(0, 60) : [] };
}


// The layers a parsed marks file may add: well-formed ids and authors, a short
// literal name, and the default-name key only when it matches the catalog.
export const fileLayers = (data) => (data.layers ?? []).filter((l) => /^L\d{1,6}$/.test(l?.id) && ["user", "assistant"].includes(l.author))
  .map((l) => ({ id: l.id, author: l.author, name: String(l.name ?? "").slice(0, 40), ...(String(l.name ?? "") ? cleanNameFields(l) : {}) }));
