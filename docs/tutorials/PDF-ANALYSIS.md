# Tutorial: analyse a PDF page

Goal: turn one PDF page into an image on the canvas, mark a region, and see what Estampes reads from the PDF and what is GPT's reading. Capability: **Optional** (needs PDF support on the server).

## Prerequisites

- A running server connected to ChatGPT ([Quick start](../QUICKSTART.md)).
- PDF support on the server. There is no status page for it; the first request tells you (see the failure table). If you use Docker, rebuild with it enabled: `docker compose build --build-arg ESTAMPES_WITH_PDF=1 && docker compose up -d`. For a plain Node install: `npm i --no-save pdfjs-dist@4.10.38 @napi-rs/canvas`. Details: [PDF pages](../IMAGE-PIPELINE.md#pdf-pages).
- Material: `sample-material/sample-two-page.pdf` ([how to make it](README.md#test-material)). Page 1 has a title, the line "Supply voltage: 5.0 V" and a red bar; page 2 has "Measured current: 120 mA" and a blue bar. PDFs are untrusted input: no scripts run; size, page count and pixel limits apply.

## Success path

**1. Ask for a page.** Attach the PDF and write: *"Show page 2 of this PDF."*

- Expected: GPT renders physical page 2 (`pageIndex` 1, counted from 0) as an image and opens it on the canvas. **Tool result:** page count (2), page size, rendering resolution. The sample defines no page labels, so there is no printed page number.
- Check: the canvas shows "Page two", the current line and a blue bar.

**2. Read text.** Ask: *"What does it say about current?"*

- Expected: the answer is "120 mA". Two sources are possible: the **embedded text layer** (a **tool result**: text boxes with positions straight from the file) or GPT reading the rendered pixels (**model inference**). Ask which one it used; for scanned PDFs there is no text layer and only the pixel reading exists.

**3. Mark and verify.** Ask: *"Mark the line with the measured value."* Check the mark covers the line; the embedded text box gives an exact position, a pixel reading may be a little off.

**4. Zoom or raise the resolution.** Ask for the page again at a higher resolution (the tool accepts 36–600 dpi). Marks keep their position because coordinates are normalized to the page.

**5. Come back later.** With storage on, the PDF is kept; later requests can reuse the stored document instead of attaching it again.

## Failure and degraded paths

| What happens | Why | What to do |
| --- | --- | --- |
| GPT says PDF rendering is unavailable | Optional engine not installed | Enable it (see Prerequisites). Everything else keeps working; you can also attach a screenshot of the page. |
| "pageIndex … is outside this 2-page PDF" | `pageIndex` is physical and starts at 0; the PDF has 2 pages | Ask for page 1 or 2. |
| Text answer disagrees with the picture | Scanned PDF or text drawn as shapes | There is no text layer; treat the answer as GPT's reading and check it yourself. |
| File refused | Over the size, page or pixel limits, or not a PDF | Use a smaller file or one page extracted from it. |

Status: the sample PDF was parsed and a page rendered with its text boxes by Estampes's PDF code during documentation; the ChatGPT conversation above has not been run live ([Compatibility](../COMPATIBILITY.md)).
