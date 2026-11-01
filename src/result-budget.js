// Host-size budgeting for model-facing images. Widget previews use widgetImage.
// Never silently change a coordinate-bearing image's pixel frame.
import sharp from "sharp";

const MIN_SIDE = 320;

async function shrinkBlock(block, maxChars) {
  const source = Buffer.from(block.data, "base64");
  const meta = await sharp(source).metadata();
  const original = { width: meta.width, height: meta.height };
  let side = Math.max(meta.width, meta.height);
  for (let quality = 85; ; ) {
    const { data: bytes, info } = await sharp(source).flatten({ background: "#ffffff" })
      .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality }).toBuffer({ resolveWithObject: true });
    const data = bytes.toString("base64");
    if (data.length <= maxChars || side <= MIN_SIDE) {
      return { block: { ...block, data, mimeType: "image/jpeg" },
        original, delivered: { width: info.width, height: info.height } };
    }
    if (quality > 70) quality = 70;
    else side = Math.max(MIN_SIDE, Math.round(side * Math.sqrt(maxChars / data.length) * 0.95));
  }
}

// Multiply a pixel-to-normalized homogeneous matrix by the scale from
// delivered preview pixels to the original image pixels (right multiplication).
const mapDeliveredPixels = (m, sx, sy) => Array.isArray(m) && m.length === 9
  ? m.map((v, i) => v * (i % 3 === 0 ? sx : i % 3 === 1 ? sy : 1)) : m;

function describeDelivery(result, images) {
  if (!images.length) return result;
  let structuredContent = result.structuredContent;
  const first = images[0], { original, delivered } = first;
  const resized = original.width !== delivered.width || original.height !== delivered.height;
  const delivery = { original, delivered, mimeType: "image/jpeg",
    coordinates: resized ? "preview pixels differ from stored source/view pixels" : "same dimensions" };
  if (structuredContent && typeof structuredContent === "object") {
    structuredContent = { ...structuredContent, delivery };
    if (structuredContent.kind === "estampes.canvas_render") {
      const mapping = structuredContent.mapping?.pixelToCanvasNormalized;
      structuredContent.output = { ...structuredContent.output,
        width: delivered.width, height: delivered.height, format: "jpeg" };
      structuredContent.mapping = { ...structuredContent.mapping,
        pixelToCanvasNormalized: mapDeliveredPixels(mapping,
          original.width / delivered.width, original.height / delivered.height) };
    } else if (["estampes.processed_image", "estampes.derived_view"].includes(structuredContent.kind)) {
      // The persisted derivedView record and its original mapping stay intact;
      // the tool's output field describes the pixels ACTUALLY delivered.
      if (structuredContent.output) structuredContent.output = { ...structuredContent.output,
        width: delivered.width, height: delivered.height, mimeType: "image/jpeg",
        scale: typeof structuredContent.output.scale === "number"
          ? structuredContent.output.scale * delivered.width / original.width
          : structuredContent.output.scale };
      const originalMap = structuredContent.derivedView?.coordinateMapping?.derivedToNormalized;
      if (originalMap) structuredContent.delivery = { ...delivery,
        pixelToCanvasNormalized: mapDeliveredPixels(originalMap,
          original.width / delivered.width, original.height / delivered.height) };
    }
  }
  const note = resized
    ? " HOST IMAGE BUDGET: the next image is a " + delivered.width + "x" + delivered.height +
      " preview of " + original.width + "x" + original.height + " pixels. " +
      (structuredContent?.derivedViewId || structuredContent?.derivedView?.derivedViewId
        ? "When marking this preview, include coordinateFrame {derivedViewId: " +
          JSON.stringify(structuredContent.derivedViewId || structuredContent.derivedView.derivedViewId) +
          ", width: " + delivered.width + ", height: " + delivered.height +
          ", units: 'pixels'} with the PREVIEW pixel coordinates. For measure_image use normalized coordinates (x/" +
          delivered.width + ", y/" + delivered.height + ") with units:'normalized'."
        : "Use the delivered pixel dimensions and the returned mapping, NOT the original image dimensions.")
    : "";
  const content = result.content.map((part, index) =>
    index === 0 && part.type === "text" ? { ...part, text: part.text + note } : part);
  if (note && !content.some(p => p.type === "text")) content.unshift({ type: "text", text: note });
  return { ...result, content, ...(structuredContent ? { structuredContent } : {}) };
}

function budgetError(maxChars) {
  return { isError: true, content: [{ type: "text", text:
    "Estampes cannot safely deliver these pixels inside the " + maxChars +
    "-character host result limit. Request a smaller region/output size with process_image or render_canvas; no misleading coordinate mapping was returned." }] };
}

/** Reduce the model-facing image payload, keeping displayed coordinate metadata truthful. */
export async function fitResult(result, maxChars) {
  if (!(maxChars > 0) || !result || !Array.isArray(result.content)) return result;
  const total = JSON.stringify(result).length;
  if (total <= maxChars) return result;
  const images = result.content.map((block, index) => ({ block, index }))
    .filter(({ block }) => block?.type === "image" && typeof block.data === "string");
  if (!images.length) return total <= maxChars ? result : budgetError(maxChars);
  const imageChars = images.reduce((n, { block }) => n + block.data.length, 0);
  const room = maxChars - (total - imageChars) - 4000;
  if (room < images.length * 8000) return budgetError(maxChars);
  const content = [...result.content], deliveries = [];
  for (const { block, index } of images) {
    const share = Math.floor(room * block.data.length / imageChars);
    if (block.data.length > share) {
      try {
        const converted = await shrinkBlock(block, share);
        content[index] = converted.block;
        deliveries.push({ index, ...converted });
      } catch {
        return budgetError(maxChars);
      }
    }
  }
  const fitted = describeDelivery({ ...result, content }, deliveries);
  return JSON.stringify(fitted).length <= maxChars ? fitted : budgetError(maxChars);
}
