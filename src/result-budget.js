// Keeps every tool result under the strictest host's size cap. claude.ai
// drops (or moves out of the conversation) a result above about 150,000
// characters, and an MCP App then never gets its data. Images are the only
// large part, so image blocks the model sees are re-encoded as JPEG, then
// reduced, until the whole result fits. Text, structuredContent and _meta
// are never changed (the canvas budgets its own pixels; see widgetImage).
import sharp from "sharp";

const MIN_SIDE = 320;

async function shrinkBlock(block, maxChars) {
  let buf = Buffer.from(block.data, "base64");
  let { width = 0, height = 0 } = await sharp(buf).metadata();
  let side = Math.max(width, height);
  for (let quality = 85; ; ) {
    const out = await sharp(buf).flatten({ background: "#ffffff" })
      .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality }).toBuffer();
    const data = out.toString("base64");
    if (data.length <= maxChars || side <= MIN_SIDE) return { ...block, data, mimeType: "image/jpeg" };
    if (quality > 70) quality = 70;
    else side = Math.max(MIN_SIDE, Math.round(side * Math.sqrt(maxChars / data.length) * 0.95));
  }
}

/** Returns the result, with its image blocks reduced when it is over maxChars. */
export async function fitResult(result, maxChars) {
  if (!(maxChars > 0) || !result || !Array.isArray(result.content)) return result;
  const total = JSON.stringify(result).length;
  if (total <= maxChars) return result;
  const images = result.content.map((b, i) => ({ b, i })).filter(({ b }) => b?.type === "image" && typeof b.data === "string");
  const imageChars = images.reduce((n, { b }) => n + b.data.length, 0);
  if (!imageChars) return result;
  const room = maxChars - (total - imageChars) - 2000;
  if (room < images.length * 8000) return result;
  const content = [...result.content];
  for (const { b, i } of images) {
    const share = Math.floor(room * b.data.length / imageChars);
    if (b.data.length > share) {
      try { content[i] = await shrinkBlock(b, share); } catch { /* not an image sharp reads: leave it */ }
    }
  }
  return { ...result, content };
}
