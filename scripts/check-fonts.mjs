#!/usr/bin/env node
// Checks that server-side rendering can draw text. sharp (librsvg) draws SVG
// <text> with the system's fonts; with none installed every character becomes
// the same missing-glyph box, so mark labels in render_canvas and PNG exports
// are unreadable. Two different strings of the same length must therefore
// render differently, and must draw something.
//
// Run: `node scripts/check-fonts.mjs` (the Docker build runs it too).
// Exit 1 when text cannot be drawn. See docs/rfc/i18n/README.md §7.
import sharp from "sharp";

const svg = (text) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="48"><rect width="320" height="48" fill="#fff"/>` +
  `<text x="6" y="34" font-size="28" fill="#000">${text}</text></svg>`);

async function pixels(text) {
  const { data } = await sharp(svg(text)).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data;
}

const ink = (data) => data.reduce((n, v) => n + (v < 128 ? 1 : 0), 0);

export async function checkFonts() {
  const a = await pixels("Estampes B7"), b = await pixels("HHHHHHHHHHH");
  if (!ink(a)) return { ok: false, reason: "no text was drawn at all" };
  if (Buffer.compare(a, b) === 0) return { ok: false, reason: "different letters render identically (missing-glyph boxes): no usable font is installed" };
  return { ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await checkFonts();
  console.log(r.ok ? "fonts ok: server-side text renders" : "fonts FAILED: " + r.reason + ". Install a font package (the Docker image uses fonts-dejavu-core).");
  process.exit(r.ok ? 0 : 1);
}
