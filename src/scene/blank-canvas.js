// A blank canvas is an ordinary image: a plain PNG generated here and
// registered like any attached photo, so it gets an img: id, storage,
// export, zoom tiles and the canvas widget with no special case. Every
// blank canvas carries a random id in a PNG text chunk, so two blank
// canvases of the same size are different images with separate marks.
import { randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { intakeImage } from "../storage.js";

export const BACKGROUNDS = Object.freeze({ light: "#FFFFFF", paper: "#FBF8F1", grid: "#F4F7FA" });
export const BLANK_SIZE = Object.freeze({ width: 1600, height: 1000, min: 200, max: 4096 });

function textChunk(keyword, text) {
  const data = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]);
  const type = Buffer.from("tEXt", "latin1");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0);
  return Buffer.concat([len, type, data, crc]);
}

// Insert a tEXt chunk right before IEND (the last 12 bytes of a PNG).
export function withTextChunk(png, keyword, text) {
  const iend = png.length - 12;
  if (png.subarray(iend + 4, iend + 8).toString("latin1") !== "IEND") throw new Error("not a PNG");
  return Buffer.concat([png.subarray(0, iend), textChunk(keyword, text), png.subarray(iend)]);
}

export async function blankCanvasBytes({ width = BLANK_SIZE.width, height = BLANK_SIZE.height, background = "light" } = {}) {
  const w = Math.round(width), h = Math.round(height);
  if (![w, h].every((v) => v >= BLANK_SIZE.min && v <= BLANK_SIZE.max)) {
    throw new Error("A blank canvas is " + BLANK_SIZE.min + " to " + BLANK_SIZE.max + " pixels on each side");
  }
  const color = BACKGROUNDS[background];
  if (!color) throw new Error("background must be one of " + Object.keys(BACKGROUNDS).join(", "));
  const png = await sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
  return withTextChunk(png, "estampes-canvas", "blank:" + randomBytes(9).toString("base64url"));
}

export async function createBlankCanvas(options = {}) {
  return intakeImage(await blankCanvasBytes(options), { source: "blank", fileName: options.title ? String(options.title).slice(0, 80) : null });
}
