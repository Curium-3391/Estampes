// What a canvas is drawn on (UVA Phase 4A). Every canvas so far draws on its
// image; a Graph document will draw on a plain colour instead, with no image
// bytes at all. The background is data: a stored canvas carries it, renderers
// read it here, and nothing guesses it from the image.
//
//   { kind: "image" }                  the canvas's own image (default; absent = image)
//   { kind: "solid", color: "#rrggbb" } a plain colour, drawn as a vector rect

export const SOLID_COLOR = /^#[0-9a-fA-F]{6}$/;

// The background of a canvas entry. Anything that is not a valid solid
// background is the image background, so an old or damaged record still shows
// its image.
export function canvasBackground(entry) {
  const b = entry?.background;
  if (b?.kind === "solid" && SOLID_COLOR.test(b.color)) return { kind: "solid", color: b.color.toLowerCase() };
  return { kind: "image" };
}

export const isSolid = (entry) => canvasBackground(entry).kind === "solid";

// Checks a background given by a caller. Returns the normalized value or
// throws with a message that names the problem.
export function parseBackground(value) {
  if (value === undefined || value === null) return { kind: "image" };
  if (value?.kind === "image" && Object.keys(value).length === 1) return { kind: "image" };
  if (value?.kind === "solid") {
    if (!SOLID_COLOR.test(value.color ?? "")) throw new Error("A solid background needs color as #rrggbb");
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
