// PDF page adapter (RFC PRE-07, E01-E04): render one physical page at a
// chosen DPI and read its text layer with boxes. Optional: needs
// `pdfjs-dist` and `@napi-rs/canvas`, which are not core dependencies (the
// Docker image installs them with --build-arg ESTAMPES_WITH_PDF=1, or run
// `npm i --no-save pdfjs-dist @napi-rs/canvas`). Without them the tool
// reports that it is unavailable and the rest of Estampes is unaffected.
// PDF content is untrusted: no scripts run, fonts and images are decoded by
// pdf.js only, and size, page count and pixel limits apply.
import { createHash } from "node:crypto";
import { config } from "../config.js";

export const PDF_VERSION = "1";
export const MAX_DPI = 600;
export const MAX_PAGES = 5000;

let loaded = null;
export async function pdfEngine() {
  loaded ??= (async () => {
    try {
      const canvas = await import("@napi-rs/canvas");
      // pdf.js draws with these browser classes; give it the canvas ones.
      for (const name of ["DOMMatrix", "Path2D", "ImageData"]) globalThis[name] ??= canvas[name];
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      return { ok: true, pdfjs, canvas, version: pdfjs.version ?? "unknown" };
    } catch (error) {
      return { ok: false, reason: "PDF support is not installed on this server (pdfjs-dist and @napi-rs/canvas): " + String(error?.code ?? error?.message ?? error) };
    }
  })();
  return loaded;
}
export const pdfAvailable = async () => { const e = await pdfEngine(); return e.ok ? { ok: true, version: e.version } : { ok: false, reason: e.reason }; };

export const isPdf = (bytes) => bytes.length > 5 && bytes.subarray(0, 1024).includes("%PDF-");

const hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

class CanvasFactory {
  constructor(canvas) { this.canvas = canvas; }
  create(width, height) {
    const canvas = this.canvas.createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(pair, width, height) { pair.canvas.width = width; pair.canvas.height = height; }
  destroy(pair) { pair.canvas.width = 0; pair.canvas.height = 0; }
}

async function openDocument(engine, bytes) {
  const task = engine.pdfjs.getDocument({
    data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
    enableXfa: false, verbosity: 0, canvasFactory: new CanvasFactory(engine.canvas),
    standardFontDataUrl: undefined,
  });
  try { return await task.promise; } catch (error) {
    if (/password/i.test(String(error?.message))) throw new Error("The PDF is password protected");
    throw new Error("Could not read the PDF: " + String(error?.message ?? error));
  }
}

// Info about the document without rendering: page count, per-page size,
// labels (printed page numbers when the PDF defines them).
export async function pdfInfo(bytes) {
  const engine = await pdfEngine();
  if (!engine.ok) throw new Error(engine.reason);
  const doc = await openDocument(engine, bytes);
  try {
    if (doc.numPages > MAX_PAGES) throw new Error("The PDF has " + doc.numPages + " pages; the limit is " + MAX_PAGES);
    const labels = await doc.getPageLabels().catch(() => null);
    return { documentSha256: hex(bytes), pageCount: doc.numPages, labels: labels ?? null };
  } finally { await doc.destroy().catch(() => {}); }
}

// Render physical page `pageIndex` (0-based). Returns PNG bytes and the page
// description. Page coordinates: the rendered image covers the page's crop
// box (as a viewer shows it) with rotation applied, so normalized image
// coordinates are the same at every DPI.
export async function renderPdfPage(bytes, { pageIndex, dpi = 150, text = false }) {
  const engine = await pdfEngine();
  if (!engine.ok) throw new Error(engine.reason);
  if (!(dpi >= 36 && dpi <= MAX_DPI)) throw new Error("dpi must be between 36 and " + MAX_DPI);
  const doc = await openDocument(engine, bytes);
  try {
    if (doc.numPages > MAX_PAGES) throw new Error("The PDF has " + doc.numPages + " pages; the limit is " + MAX_PAGES);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.numPages) {
      throw new Error("pageIndex " + pageIndex + " is outside this " + doc.numPages + "-page PDF (physical pages, 0-based; printed page numbers differ)");
    }
    const labels = await doc.getPageLabels().catch(() => null);
    const page = await doc.getPage(pageIndex + 1);
    const scale = dpi / 72;
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
    if (width * height > config.maxInputPixels) {
      throw new Error("Page at " + dpi + " dpi would be " + width + "x" + height + " px, above the " + config.maxInputPixels / 1e6 + " MP limit; lower dpi");
    }
    const factory = new CanvasFactory(engine.canvas);
    const { canvas, context } = factory.create(width, height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    await page.render({ canvasContext: context, viewport, canvasFactory: factory, intent: "display" }).promise;
    const png = await canvas.encode("png");
    const view = page.view; // [x0, y0, x1, y1] crop box in points
    const info = {
      documentSha256: hex(bytes), pageIndex, pageCount: doc.numPages,
      pageLabel: labels?.[pageIndex] ?? null, dpi, rotation: page.rotate ?? 0,
      cropBox: view, widthPt: Math.abs(view[2] - view[0]), heightPt: Math.abs(view[3] - view[1]),
      pixelWidth: width, pixelHeight: height, renderer: "pdfjs-" + engine.version,
    };
    let boxes = null;
    if (text) {
      const content = await page.getTextContent();
      boxes = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const t = engine.pdfjs.Util.transform(viewport.transform, item.transform);
        // t = [a b c d e f]: baseline origin (e,f) in pixels, font height ~ hypot(c,d).
        const h = Math.hypot(t[2], t[3]), w = (item.width ?? 0) * scale;
        const x0 = t[4], y1 = t[5];
        boxes.push({ text: item.str, x: x0 / width, y: (y1 - h) / height, x2: (x0 + w) / width, y2: y1 / height });
      }
    }
    return { png, info, boxes };
  } finally { await doc.destroy().catch(() => {}); }
}
