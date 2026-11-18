// What a canvas is drawn on (UVA Phase 4A). Every canvas so far draws on its
// image; a Graph document will draw on a plain colour instead, with no image
// bytes at all. The background is data: a stored canvas carries it, renderers
// read it here, and nothing guesses it from the image.
//
//   { kind: "image" }                  the canvas's own image (default; absent = image)
//   { kind: "solid", color: "#rrggbb" } a plain colour, drawn as a vector rect

export const SOLID_COLOR = /^#[0-9a-fA-F]{6}$/;
// Only a string is a colour: RegExp.test would coerce ["#123456"] to a match.
const isColor = (c) => typeof c === "string" && SOLID_COLOR.test(c);

// The background of a canvas entry. Anything that is not a valid solid
// background is the image background, so an old or damaged record still shows
// its image.
export function canvasBackground(entry) {
  const b = entry?.background;
  if (b?.kind === "solid" && isColor(b.color)) return { kind: "solid", color: b.color.toLowerCase() };
  return { kind: "image" };
}

export const isSolid = (entry) => canvasBackground(entry).kind === "solid";

// Checks a background given by a caller. Returns the normalized value or
// throws with a message that names the problem.
export function parseBackground(value) {
  if (value === undefined || value === null) return { kind: "image" };
  if (value?.kind === "image" && Object.keys(value).length === 1) return { kind: "image" };
  if (value?.kind === "solid") {
    if (!isColor(value.color)) throw new Error("A solid background needs color as #rrggbb");
    if (Object.keys(value).some((k) => k !== "kind" && k !== "color")) throw new Error("A solid background takes only kind and color");
    return { kind: "solid", color: value.color.toLowerCase() };
  }
  throw new Error('background.kind must be "image" or "solid"');
}

// What a solid canvas sends the widget in place of image pixels: no image
// data, only the colour and the canvas size.
export function backgroundPayload(entry) {
  const b = canvasBackground(entry);
  return b.kind === "solid" ? { background: b, width: entry.width, height: entry.height, full: true } : null;
}

// The canvas as the user sees it, for code that draws marks over the base
// pixels (render verification). A solid canvas gets plain pixels of its colour;
// the stored image and its bytes are untouched. Pixel analysis tools keep
// reading the stored image.
const solidPixels = new WeakMap();
export function visibleEntry(entry) {
  const b = canvasBackground(entry);
  if (b.kind !== "solid" || entry.baseAsObject) return entry;
  const key = entry.width + "x" + entry.height + b.color;
  let cached = solidPixels.get(entry);
  if (cached?.key !== key) {
    const rgb = [1, 3, 5].map((i) => parseInt(b.color.slice(i, i + 2), 16));
    const pixels = Buffer.alloc(entry.width * entry.height * 3);
    for (let i = 0; i < pixels.length; i += 3) { pixels[i] = rgb[0]; pixels[i + 1] = rgb[1]; pixels[i + 2] = rgb[2]; }
    cached = { key, pixels };
    solidPixels.set(entry, cached);
  }
  const view = Object.create(entry);
  view.pixels = cached.pixels; view.channels = 3;
  return view;
}
