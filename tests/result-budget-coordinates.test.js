import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { fitResult } from "../src/result-budget.js";
import { frameFromView } from "../src/image/view.js";
import { apply } from "../src/image/transform.js";

const W = 1200, H = 800, CAP = 145_000;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + " != " + b);

async function noise() {
  return sharp(randomBytes(W * H * 3), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

test("downsized process_image preview reports its actual pixels and preserves precise derived-view mapping", async () => {
  const data = (await noise()).toString("base64");
  const record = {
    derivedViewId: "dv:123456789abcdef0",
    pixelDimensions: { width: W, height: H },
    coordinateMapping: { derivedToNormalized: [1/W, 0, 0, 0, 1/H, 0, 0, 0, 1] },
  };
  const result = {
    content: [{ type: "text", text: "Use derivedViewId and pixel coordinates" },
      { type: "image", mimeType: "image/png", data }],
    structuredContent: {
      kind: "estampes.processed_image", imageId: "img:1111111111111111",
      derivedViewId: record.derivedViewId, derivedView: record,
      output: { width: W, height: H, scale: 1, mimeType: "image/png" },
    },
  };
  const fitted = await fitResult(result, CAP);
  assert.ok(!fitted.isError, fitted.content[0]?.text);
  assert.ok(JSON.stringify(fitted).length <= CAP);
  const preview = await sharp(Buffer.from(fitted.content[1].data, "base64")).metadata();
  assert.ok(preview.width < W);
  assert.equal(fitted.structuredContent.output.width, preview.width);
  assert.equal(fitted.structuredContent.output.height, preview.height);
  assert.equal(fitted.structuredContent.delivery.delivered.width, preview.width);
  assert.equal(fitted.structuredContent.derivedView.pixelDimensions.width, W, "saved record must not be rewritten");
  assert.match(fitted.content[0].text, /coordinateFrame/);
  const f = frameFromView(record, "pixels", { width: preview.width, height: preview.height });
  const center = apply(f.matrix, preview.width / 2, preview.height / 2);
  close(center.x, 0.5); close(center.y, 0.5);
  const normalized = frameFromView(record, "normalized");
  close(apply(normalized.matrix, 0.5, 0.5).x, 0.5);
});

test("render_canvas pixel-to-canvas matrix matches the resized image", async () => {
  const data = (await noise()).toString("base64");
  const result = {
    content: [{ type: "text", text: "Composite" }, { type: "image", data, mimeType: "image/png" }],
    structuredContent: {
      kind: "estampes.canvas_render", revision: "cv:test",
      output: { width: W, height: H, format: "png" },
      mapping: { pixelToCanvasNormalized: [1/W, 0, 0, 0, 1/H, 0, 0, 0, 1] },
    },
  };
  const fitted = await fitResult(result, CAP);
  assert.ok(!fitted.isError, fitted.content[0]?.text);
  const preview = await sharp(Buffer.from(fitted.content[1].data, "base64")).metadata();
  assert.equal(fitted.structuredContent.output.width, preview.width);
  assert.equal(fitted.structuredContent.output.height, preview.height);
  assert.equal(fitted.structuredContent.output.format, "jpeg");
  const center = apply(fitted.structuredContent.mapping.pixelToCanvasNormalized,
    preview.width / 2, preview.height / 2);
  close(center.x, 0.5); close(center.y, 0.5);
  assert.ok(JSON.stringify(fitted).length <= CAP);
});
