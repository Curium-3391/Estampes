#!/usr/bin/env node
// Writes deterministic sample files for the tutorials in docs/tutorials/:
//   node scripts/make-sample-material.mjs [outputDir]     (default ./sample-material)
//   sample-board.png     a synthetic circuit-board-like picture with labelled parts
//   sample-two-page.pdf  a two-page PDF with an embedded text layer
// Same Estampes version, same bytes for the PDF; the PNG is drawn by sharp from
// the SVG below, so it is stable for one sharp version. Nothing is downloaded.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

const out = resolve(process.argv[2] ?? "sample-material");
mkdirSync(out, { recursive: true });

const part = (x, y, w, h, fill, label) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#111" stroke-width="2"/>` +
  `<text x="${x + w / 2}" y="${y + h + 22}" font-family="sans-serif" font-size="18" text-anchor="middle" fill="#fff">${label}</text>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<rect width="1200" height="800" fill="#1f5c3a"/>
<path d="M60 200H1140M60 400H1140M60 600H1140M300 60V740M700 60V740" stroke="#c9a84a" stroke-width="6" fill="none"/>
${part(120, 140, 120, 60, "#222", "U1")}
${part(420, 140, 60, 30, "#8a5a2b", "R12")}
${part(520, 140, 60, 30, "#8a5a2b", "R13")}
${part(820, 330, 90, 90, "#2a2a6a", "C4")}
${part(420, 520, 140, 70, "#111", "U2")}
${part(900, 540, 50, 50, "#b33", "D7 (cracked)")}
<circle cx="1050" cy="150" r="28" fill="#ccc" stroke="#111" stroke-width="3"/>
<text x="1050" y="200" font-family="sans-serif" font-size="18" text-anchor="middle" fill="#fff">TP1</text>
</svg>`;
await sharp(Buffer.from(svg)).png().toFile(join(out, "sample-board.png"));

// Two-page PDF built by hand with a correct xref (same approach as tests/pdf-page.test.js).
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
  null,
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
  null,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
const stream = (t) => `<< /Length ${t.length} >>\nstream\n${t}\nendstream`;
objs[3] = stream("BT /F1 28 Tf 72 700 Td (Sample report - page one) Tj ET BT /F1 14 Tf 72 660 Td (Supply voltage: 5.0 V) Tj ET 0.8 0.1 0.1 rg 72 560 200 40 re f");
objs[5] = stream("BT /F1 28 Tf 72 700 Td (Page two) Tj ET BT /F1 14 Tf 72 660 Td (Measured current: 120 mA) Tj ET 0.1 0.3 0.8 rg 72 560 300 40 re f");
let pdf = "%PDF-1.4\n";
const offsets = [];
objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(out, "sample-two-page.pdf"), Buffer.from(pdf, "latin1"));
console.log(`Wrote sample-board.png and sample-two-page.pdf to ${out}`);
