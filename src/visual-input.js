// M0.4.3: image pixels and geometry only — no object recognition.
// Render the very same embedded SVG that the ChatGPT widget shows.
// Do not accept arbitrary remote URLs or untrusted SVG from callers.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export const SOURCE_WIDTH = 640;
export const SOURCE_HEIGHT = 360;
export const IMAGE_REVISION = "svg-v1";
export const SCENE_IDS = Object.freeze(["landscape", "shapes", "formula"]);

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../public/visual-surface.html"),
  "utf8"
);

// Parse only the three literal, trusted local SVG snippets. Deliberately no
// eval, remote image fetching, or user-provided SVG execution.
export function extractDemoScenes(source) {
  const declaration = source.match(/const SCENES=\{([\s\S]*?)\};\s*const SCENE_NAMES=/);
  if (!declaration) throw new Error("Embedded demo scenes not found");
  const found = [...declaration[1].matchAll(/\b(landscape|shapes|formula):\s*`([^`]*)`/g)];
  const scenes = Object.fromEntries(found.map((entry) => [entry[1], entry[2]]));
  if (found.length !== SCENE_IDS.length || SCENE_IDS.some((id) => !scenes[id])) {
    throw new Error("Demo scene source is incomplete");
  }
  // The literal snippets do not interpolate JS or load external media.
  for (const value of Object.values(scenes)) {
    if (value.includes("${") || /<script|<foreignObject|(?:href|src)=/i.test(value)) {
      throw new Error("Unexpected executable/external content in demo scene");
    }
  }
  return scenes;
}

const sceneMarkup = extractDemoScenes(html);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const bounded = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

export function validateFocus(focus) {
  if (!focus || !["point", "rect", "arrow"].includes(focus.type)) {
    throw new Error("focus.type must be point, rect or arrow");
  }
  if (!bounded(focus.x) || !bounded(focus.y)) throw new Error("Focus coordinates must be in 0..1");
  if (focus.type !== "point" && (!bounded(focus.x2) || !bounded(focus.y2))) {
    throw new Error("Rectangle or arrow needs normalized x2/y2");
  }
  return focus;
}

function sourceSvg(scene) {
  if (!SCENE_IDS.includes(scene)) throw new Error("Unknown scene");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SOURCE_WIDTH}" height="${SOURCE_HEIGHT}" viewBox="0 0 ${SOURCE_WIDTH} ${SOURCE_HEIGHT}">${sceneMarkup[scene]}</svg>`;
}

export function calculateCrop(focus, padding = 0.08) {
  validateFocus(focus);
  if (!Number.isFinite(padding) || padding < 0.02 || padding > 0.2) {
    throw new Error("Invalid crop padding");
  }
  // For arrows, the arrowhead is the referent; the tail is not the target.
  // For points, provide enough neighborhood to allow visual interpretation.
  const pointMode = focus.type !== "rect";
  const x = focus.type === "arrow" ? focus.x2 : focus.x;
  const y = focus.type === "arrow" ? focus.y2 : focus.y;
  const x0 = pointMode ? x - 0.16 : Math.min(focus.x, focus.x2) - padding;
  const x1 = pointMode ? x + 0.16 : Math.max(focus.x, focus.x2) + padding;
  const y0 = pointMode ? y - 0.18 : Math.min(focus.y, focus.y2) - padding;
  const y1 = pointMode ? y + 0.18 : Math.max(focus.y, focus.y2) + padding;
  const left = clamp(Math.floor(clamp(x0,0,1)*SOURCE_WIDTH), 0, SOURCE_WIDTH-1);
  const top = clamp(Math.floor(clamp(y0,0,1)*SOURCE_HEIGHT), 0, SOURCE_HEIGHT-1);
  const right = clamp(Math.ceil(clamp(x1,0,1)*SOURCE_WIDTH), left+1, SOURCE_WIDTH);
  const bottom = clamp(Math.ceil(clamp(y1,0,1)*SOURCE_HEIGHT), top+1, SOURCE_HEIGHT);
  return {left,top,width:right-left,height:bottom-top};
}

function overlaySvg(focus) {
  const x=focus.x*SOURCE_WIDTH, y=focus.y*SOURCE_HEIGHT;
  const x2=(focus.x2??focus.x)*SOURCE_WIDTH, y2=(focus.y2??focus.y)*SOURCE_HEIGHT;
  let shape;
  if (focus.type === "rect") {
    shape = `<rect x="${Math.min(x,x2)}" y="${Math.min(y,y2)}" width="${Math.abs(x2-x)}" height="${Math.abs(y2-y)}" fill="#4e9cec" fill-opacity=".08" stroke="#1761bd" stroke-width="4"/>`;
  } else if (focus.type === "arrow") {
    shape = `<path d="M ${x} ${y} L ${x2} ${y2}" stroke="#1761bd" stroke-width="4" fill="none" marker-end="url(#arrow)"/><circle cx="${x2}" cy="${y2}" r="7" fill="#1761bd" stroke="white" stroke-width="2"/>`;
  } else {
    shape = `<circle cx="${x}" cy="${y}" r="11" fill="none" stroke="white" stroke-width="6"/><circle cx="${x}" cy="${y}" r="11" fill="none" stroke="#1761bd" stroke-width="3"/>`;
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SOURCE_WIDTH}" height="${SOURCE_HEIGHT}" viewBox="0 0 ${SOURCE_WIDTH} ${SOURCE_HEIGHT}"><defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="9" refY="4.5" orient="auto"><path d="M0,0L9,4.5L0,9Z" fill="#1761bd"/></marker></defs>${shape}</svg>`);
}

export async function createVisualEvidence({scene, imageId, revision = IMAGE_REVISION, focus, padding=0.08}) {
  if (!SCENE_IDS.includes(scene)) throw new Error("Unknown scene");
  if (imageId !== `demo:${scene}` || revision !== IMAGE_REVISION) {
    throw new Error("Image identity or revision mismatch");
  }
  const validated=validateFocus(focus);
  const original=await sharp(Buffer.from(sourceSvg(scene)),{limitInputPixels:SOURCE_WIDTH*SOURCE_HEIGHT})
    .png().toBuffer();
  const marked=await sharp(original).composite([{input:overlaySvg(validated)}]).png().toBuffer();
  const crop=calculateCrop(validated,padding);
  const enlarged=await sharp(original).extract(crop)
    .resize({width:Math.min(crop.width*2,1280),kernel:"lanczos3"}).png().toBuffer();

  return {
    imageId, revision, scene,
    source:{kind:"svg",logicalSize:{width:SOURCE_WIDTH,height:SOURCE_HEIGHT,unit:"svg-user-unit"}},
    rendered:{width:SOURCE_WIDTH,height:SOURCE_HEIGHT,mimeType:"image/png"},
    coordinateSystem:"normalized-top-left",
    focus:{type:focus.type,x:focus.x,y:focus.y,
      ...(focus.type==="point"?{}:{x2:focus.x2,y2:focus.y2})},
    crop:{...crop,origin:"source-pixel-top-left",target:focus.type==="arrow"?"arrowhead":"point-or-region"},
    images:{original,marked,crop:enlarged}
  };
}
