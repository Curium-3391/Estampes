#!/usr/bin/env node
// Checks that server-side rendering can draw text. sharp (librsvg) draws SVG
// <text> with the system's fonts; with none installed every character becomes
// the same missing-glyph box, so mark labels in render_canvas and PNG exports
// are unreadable. Two different strings of the same length must therefore
// render differently, and must draw something.
//
// Run: `node scripts/check-fonts.mjs` (Latin). `--require cjk` also checks
// that Chinese characters render; `--require cjk,cjk-tc` also that they
// default to the Traditional Chinese face. The Docker build runs the last
// form, since the image ships Traditional Chinese and English fonts.
// Exit 1 when text cannot be drawn. See docs/rfc/i18n/README.md §7.
import sharp from "sharp";

const svg = (text, family) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="48"><rect width="320" height="48" fill="#fff"/>` +
  `<text x="6" y="34" font-size="28" fill="#000"${family ? ` font-family="${family}"` : ""}>${text}</text></svg>`);

async function pixels(text, family) {
  const { data } = await sharp(svg(text, family)).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data;
}

// Han characters whose Traditional and Simplified Chinese glyphs differ in
// shape. Labels carry no font-family, so the default must be the TC face.
const TC_SAMPLE = "骨直次";
async function checkTraditionalChinese() {
  const def = await pixels(TC_SAMPLE), tc = await pixels(TC_SAMPLE, "Noto Sans CJK TC"), sc = await pixels(TC_SAMPLE, "Noto Sans CJK SC");
  if (Buffer.compare(tc, sc) === 0) return { ok: false, reason: "cjk-tc: Noto Sans CJK TC and SC render alike, so the TC face is not installed" };
  if (Buffer.compare(def, tc) !== 0) return { ok: false, reason: "cjk-tc: Han characters do not default to the Traditional Chinese face" };
  return { ok: true };
}

const ink = (data) => data.reduce((n, v) => n + (v < 128 ? 1 : 0), 0);

// Each pair: two strings of the same length in one script. With no font at
// all every character is the same box, so the two renders are identical.
// When a font exists but lacks the script, Pango draws a box holding the
// code point's hex digits, which does differ per character; so the pair is a
// one-stroke and a many-stroke character, whose real glyphs differ hugely in
// ink while their hex boxes do not.
const SAMPLES = {
  latin: ["Estampes B7", "HHHHHHHHHHH", 0],
  cjk: ["鬱鬱鬱鬱", "一一一一", 3],
};

export async function checkFonts(scripts = ["latin"]) {
  for (const s of scripts) {
    if (s === "cjk-tc") { const r = await checkTraditionalChinese(); if (!r.ok) return r; continue; }
    const [x, y, ratio] = SAMPLES[s] ?? [];
    if (!x) return { ok: false, reason: "unknown script " + s };
    const r = judgeSample(s, await pixels(x), await pixels(y), ratio);
    if (!r.ok) return r;
  }
  return { ok: true };
}

// The verdict on one sample pair. With no font at all, librsvg draws a string
// either as missing-glyph boxes or, at random, as nothing, and two boxed
// renders can differ in a few anti-aliased grey levels. So both renders must
// draw ink, and they are compared as black-and-white masks, not byte for byte.
const mask = (data) => Buffer.from(data.map((v) => (v < 128 ? 0 : 255)));
export function judgeSample(s, a, b, ratio = 0) {
  if (!ink(a) || !ink(b)) return { ok: false, reason: s + ": no text was drawn at all" };
  if (Buffer.compare(mask(a), mask(b)) === 0) return { ok: false, reason: s + ": different characters render identically (missing-glyph boxes), no font covers them" };
  if (ratio && ink(a) < ratio * ink(b)) return { ok: false, reason: s + ": characters render as missing-glyph boxes (ink " + ink(a) + " vs " + ink(b) + "), no font covers them" };
  return { ok: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--require");
  const scripts = ["latin", ...(i > 0 && process.argv[i + 1] ? process.argv[i + 1].split(",") : [])];
  const r = await checkFonts(scripts);
  console.log(r.ok ? "fonts ok: server-side text renders (" + scripts.join(", ") + ")" : "fonts FAILED: " + r.reason + ". Install a font package (the Docker image uses fonts-dejavu-core and fonts-noto-cjk).");
  process.exit(r.ok ? 0 : 1);
}
