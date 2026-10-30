import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearImages, registerImage } from "../src/image-store.js";
import { pdfAvailable, renderPdfPage, pdfInfo, isPdf } from "../src/image/pdf.js";
import { useStorageDir, intakeImage, saveDocument, loadDocument } from "../src/storage.js";

// Two-page PDF (second page rotated 90) built by hand with a correct xref.
function samplePdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /S /r >> 1 << /S /D /St 7 >>] >> >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    null,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Rotate 90 /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = (text) => `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  objs[3] = stream("BT /F1 24 Tf 20 40 Td (Hello PDF) Tj ET 0 0 1 rg 150 10 40 20 re f");
  objs[5] = stream("BT /F1 18 Tf 10 10 Td (Second) Tj ET");
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const available = (await pdfAvailable()).ok;

test("pdf recognition is cheap and does not need the engine", () => {
  assert.equal(isPdf(samplePdf()), true);
  assert.equal(isPdf(Buffer.from("not a pdf at all")), false);
});

test("PDF pages render at any dpi with the same normalized layout, labels and a text layer", { skip: !available && "pdfjs-dist / @napi-rs/canvas not installed" }, async () => {
  clearImages();
  const bytes = samplePdf();
  const info = await pdfInfo(bytes);
  assert.equal(info.pageCount, 2);
  assert.deepEqual(info.labels, ["i", "7"]);
  const low = await renderPdfPage(bytes, { pageIndex: 0, dpi: 72, text: true });
  const high = await renderPdfPage(bytes, { pageIndex: 0, dpi: 288, text: true });
  assert.deepEqual([low.info.pixelWidth, low.info.pixelHeight], [200, 100]);
  assert.deepEqual([high.info.pixelWidth, high.info.pixelHeight], [800, 400]);
  assert.equal(low.info.pageLabel, "i");
  assert.equal(low.info.documentSha256, high.info.documentSha256);
  const hello = (r) => r.boxes.find((b) => /Hello/.test(b.text));
  assert.ok(hello(low) && hello(high));
  for (const k of ["x", "y", "x2", "y2"]) assert.ok(Math.abs(hello(low)[k] - hello(high)[k]) < 0.02, k);
  assert.ok(hello(high).x > 0.05 && hello(high).x < 0.15); // starts at x = 20pt of 200
  // The rotated page swaps width and height.
  const turned = await renderPdfPage(bytes, { pageIndex: 1, dpi: 72 });
  assert.deepEqual([turned.info.pixelWidth, turned.info.pixelHeight], [100, 200]);
  assert.equal(turned.info.rotation, 90);
  await assert.rejects(renderPdfPage(bytes, { pageIndex: 2, dpi: 72 }), /outside this 2-page/);
  await assert.rejects(renderPdfPage(bytes, { pageIndex: 0, dpi: 5000 }), /dpi/);
  const entry = await registerImage(high.png, { source: "pdf-page", page: high.info });
  assert.equal(entry.page.pageIndex, 0);
  assert.equal(entry.width, 800);
});

test("stored PDFs can be rendered again from their hash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "estampes-pdf-"));
  useStorageDir(dir);
  const bytes = samplePdf();
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(bytes).digest("hex");
  await saveDocument(bytes, sha);
  assert.deepEqual(await loadDocument(sha), bytes);
  assert.equal(await loadDocument("0".repeat(64)), null);
  assert.equal(await loadDocument("../../etc/passwd"), null);
  useStorageDir("");
  void intakeImage;
});
