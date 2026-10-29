// Export a photo's marks as a layered SVG the user can keep, open in any
// vector editor, and attach to a later chat to restore the canvas. The
// marks travel as JSON inside <metadata>; nothing else in the file is read
// back, so an edited drawing never turns into unvalidated marks.
import { markSvg } from "./mark-render.js";

export const MARKS_FORMAT = "estampes-marks";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const K = 1000 / 640;

const xml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

export function exportMarksSvg(entry, marks) {
  const { width: W, height: H } = entry, toPx = W / 1000;
  const map = (nx, ny) => [Math.round(nx * W * 10) / 10, Math.round(ny * H * 10) / 10];
  const layer = (id, name, list) =>
    `<g id="${id}" inkscape:groupmode="layer" inkscape:label="${name}">` + list.map((m) => {
      const a = m.type === "polyline" ? m.points[0] : { x: m.x, y: m.y };
      const [lx, ly] = map(a.x, a.y), fs = 15 * K * toPx;
      const label = m.label ? `<text x="${lx + fs * 0.6}" y="${ly - fs * 0.8}" font-size="${fs}" font-weight="700" fill="${m.author === "user" ? "#579DF6" : "#E4AE57"}" stroke="#17212A" stroke-width="${0.8 * K * toPx}" paint-order="stroke">${xml(m.label)}</text>` : "";
      return `<g id="mark-${xml(m.id)}">${markSvg(m, map, toPx)}${label}</g>`;
    }).join("") + "</g>";
  const payload = JSON.stringify({ format: MARKS_FORMAT, version: 1, imageId: entry.imageId, width: W, height: H, marks })
    .replace(/]]>/g, "]]\\u003e");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<title>Estampes marks ${xml(entry.imageId)}</title>
<metadata id="${MARKS_FORMAT}"><![CDATA[${payload}]]></metadata>
${layer("estampes-user", "使用者", marks.filter((m) => m.author === "user"))}
${layer("estampes-gpt", "GPT", marks.filter((m) => m.author !== "user"))}
</svg>
`;
}

// Accepts the exported SVG or its bare JSON. Returns the untrusted payload;
// the caller validates every mark.
export function parseMarksFile(bytes) {
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Marks file is larger than 2 MB");
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  const json = text.trimStart().startsWith("{") ? text :
    new RegExp(`<metadata id="${MARKS_FORMAT}"><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></metadata>`).exec(text)?.[1];
  if (!json) throw new Error("Not an Estampes marks file (no estampes-marks metadata)");
  let data;
  try { data = JSON.parse(json); } catch { throw new Error("Estampes marks metadata is not valid JSON"); }
  if (data?.format !== MARKS_FORMAT || !Array.isArray(data.marks)) throw new Error("Not an Estampes marks file");
  if (data.marks.length > 60) throw new Error("Marks file has more than 60 marks");
  return { imageId: data.imageId, width: Number(data.width), height: Number(data.height), marks: data.marks };
}

