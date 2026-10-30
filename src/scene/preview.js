// A picture of a canvas with its scene objects, for the model to check a
// module's result (and its own scratch objects, which the user does not
// see). Drawn from the same primitives as the widget and the SVG export.
import { entrySharp } from "../image-store.js";
import { renderedObjects } from "./scene-ops.js";
import { primitivesSvg } from "./objects.js";

const LONG_SIDE = 1000;

export async function renderPreview(entry, { scratch = true, longSide = LONG_SIDE } = {}) {
  const scale = Math.min(1, longSide / Math.max(entry.width, entry.height));
  const W = Math.max(1, Math.round(entry.width * scale)), H = Math.max(1, Math.round(entry.height * scale));
  const prims = renderedObjects(entry).filter((r) => scratch || r.object.visibility === "public")
    .map((r) => (r.object.visibility === "scratch" ? `<g opacity="0.7">` : "<g>") + primitivesSvg(r.primitives, W, H) + "</g>").join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${prims}</svg>`;
  const data = await entrySharp(entry).resize(W, H).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
  return { data, mimeType: "image/png", width: W, height: H };
}

