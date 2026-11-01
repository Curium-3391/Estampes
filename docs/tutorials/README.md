# Tutorials

Three worked examples. Each has a success path and a failure or degraded path, says what to expect at every step, and separates three kinds of statement you will meet:

| Label | Meaning | Example |
| --- | --- | --- |
| **Model inference** | GPT looked at pixels and decided. Estampes does not know what is in a picture. | "That component is R12." |
| **Tool result** | A server computed it from pixels, a file or a service. | Page count, a registration error, a solved sky position. |
| **User confirmation** | You pressed 確認/否決, locked a layer or approved a change. Only you or a tool can set a verification state. | A link you confirmed between two images. |

Estampes is not specific to one kind of picture. The tutorials use a circuit-board photo, a PDF page and a sky photo only because they exercise different features.

## Test material

`scripts/make-sample-material.mjs` writes two files from the repository, with no download:

```sh
npm ci
node scripts/make-sample-material.mjs        # writes ./sample-material/
```

| File | Used by | Notes |
| --- | --- | --- |
| `sample-board.png` | [Annotate a photo](PCB-ANNOTATION.md) | Synthetic 1200×800 board-like picture with labelled parts (U1, R12, R13, C4, U2, D7 "cracked", TP1). Not a photograph; real photos behave less cleanly. |
| `sample-two-page.pdf` | [Analyse a PDF page](PDF-ANALYSIS.md) | Two Letter-size pages with a text layer. Needs the optional PDF support. |

The PDF bytes are fixed by the script. The PNG is drawn by `sharp` from an SVG inside the script, so it is stable for one `sharp` version but not guaranteed byte-for-byte across versions; the tutorials do not depend on exact pixels. There is no sample sky photo: a plate-solving test needs a real star field, so [that tutorial](ASTROMETRY.md) uses your own photo, and its failure path uses the board image.

## Status of these tutorials

The steps follow the implemented behaviour described in [Tools](../TOOLS.md), [Image pipeline](../IMAGE-PIPELINE.md) and [Modules](../MODULES.md), and the sample PDF was rendered through Estampes's own PDF code with the pinned `pdfjs-dist@4.10.38` while writing them. **They have not been run end to end in a live ChatGPT conversation.** GPT's wording and choices vary between runs, so the "expected" lines describe what Estampes does, not an exact chat transcript. See [Compatibility](../COMPATIBILITY.md).

1. [Annotate a photo (circuit-board example)](PCB-ANNOTATION.md)
2. [Analyse a PDF page](PDF-ANALYSIS.md)
3. [Plate-solve a night-sky photo](ASTROMETRY.md)
