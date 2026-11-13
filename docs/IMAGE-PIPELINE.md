# Image pipeline

How Estampes turns a source image into the pixels GPT and the user look at, and how coordinates stay honest on the way. The API version is `estampes.image/2`. The older `process_image` behaviour is unchanged unless a call asks for something new.

## Source, working copy and derived views

```
SourceAsset      the bytes exactly as received; id = sha256 of those bytes
  │ decode, apply EXIF orientation (recorded in inspect_image)
source space     oriented source pixels at full resolution
  │ reduce to long side <= ESTAMPES_WORKING_LONG_SIDE, sRGB, alpha flattened on white
working space    the cached working copy
  │ crop at an explicit analysis resolution (preview / working / native)
analysis pixels  ops run here
  │ resize for delivery only, encode (png / webp lossless / jpeg)
derived view     what process_image returns, with a derivedViewId and its recipe
```

- The source is never replaced or re-encoded. With storage on it is kept as `images/<hash>/source`; in memory it is kept next to the working copy (and counted in `ESTAMPES_CACHE_MB`).
- `imageId` (`img:` + 16 hex) stays the id every tool uses. `sourceAssetId` (`sha256:` + 64 hex) is the full hash of the same bytes. Two encodings of the same picture have different ids.
- `inspect_image` reports the source format, stored and oriented size, EXIF orientation, colour space, bit depth, alpha, ICC profile, density and page count, and whether native processing can show more than the working copy.

## Coordinate spaces

| Space | Units | Used for |
| --- | --- | --- |
| `normalized` | 0..1 of the oriented source, top-left origin | every mark, region and link (the canvas frame) |
| `source` | oriented source pixels | native crops; `normalizedToSource` = scale(width, height) |
| `working` | working-copy pixels | preview and working crops, the canvas display |
| `derived` | pixels of one derived view | what GPT reads positions off |

The widget's screen pixels never leave the widget. Pixel coordinates use the corner convention: pixel (i, j) covers [i, i+1) × [j, j+1).

Transforms are 3×3 homogeneous matrices (row-major, column vectors). Every derived view carries `coordinateMapping`:

```json
{
  "steps": [
    { "kind": "to-pixels", "from": "normalized", "to": "source", "matrix": [3000,0,0, 0,6000,0, 0,0,1] },
    { "kind": "crop", "from": "source", "to": "crop", "matrix": [1,0,-1480, 0,1,-2990, 0,0,1], "box": { "left": 1480, "top": 2990, "width": 40, "height": 40 } }
  ],
  "normalizedToDerived": [...],
  "derivedToNormalized": [...],
  "invertible": true,
  "kind": "affine"
}
```

An inverse is only given when the matrix is well conditioned; otherwise `derivedToNormalized` is `null` and marking through that view fails instead of guessing. Geometry being invertible does not mean pixel values are: thresholds, CLAHE and denoising cannot be undone (`evidence.pixelValuesInvertible`).

To mark something seen in a derived view, GPT passes `coordinateFrame: { derivedViewId }` to `present_visual` with pixel coordinates of that view (or `units: "normalized"` for 0..1 of it). Estampes applies `derivedToNormalized` exactly. Under rotation or perspective a rectangle becomes a closed four-point polyline, because it is no longer axis-aligned on the image. The older `coordinateFrame: { region, width, height }` still works for axis-aligned crops.

## Analysis resolution vs delivery resolution

`process_image` takes `sampling` and `output`:

| `sampling.mode` | Pixels the ops see | When |
| --- | --- | --- |
| `preview` (default) | the crop resized to the output size first (up to 8× by interpolation), as before 0.9.0 | quick looks; unchanged results for old calls |
| `working` | the working copy's own pixels, no resize | stable kernel sizes on images up to 4096 px |
| `native` | pixels cut from the source file, beyond the working copy | small text, fine traces, anything that must not be guessed |

- Crops larger than `ESTAMPES_MAX_ANALYSIS_MEGAPIXELS` (default 16) or `sampling.maxPixels` are reduced to fit, and the result says so.
- In `working` and `native` the delivered image is only reduced (`output.maxLongSide`, default 1600, max 2048). `allowUpscale: true` enlarges after the ops; the result is then marked `interpolated`.
- Thresholded or edge results that are enlarged use nearest-neighbour so they stay binary.
- `sampling.alpha`: `flatten` (white, default), `flatten-black`, or `keep` (native only).
- `output.format`: `auto` (PNG for one-channel results, else JPEG 88, as before), `png`, `webp` (lossless) or `jpeg` with `quality`.
- Sources with more than 8 bits per sample are quantized to 8 bits for processing; the result warns.

## Derived view record

Every result has a `derivedViewId` (`dv:` + 16 hex) computed from the source asset id, the recipe (region snapped to the pixel grid, sampling, ops with parameters, output) and operator versions, so the same recipe on the same source gives the same id and the same pixels.

```json
{
  "apiVersion": "estampes.image/2",
  "derivedViewId": "dv:…",
  "imageId": "img:…",
  "sourceAssetId": "sha256:…",
  "recipe": { "region": {…}, "sampling": { "mode": "native", "allowUpscale": false }, "ops": [{ "op": "clahe" }], "output": { "format": "png", "maxLongSide": 1600 } },
  "sourceDimensions": { "width": 3000, "height": 6000 },
  "workingDimensions": { "width": 2048, "height": 4096 },
  "analysis": { "space": "source", "sourceBox": {…}, "width": 40, "height": 40, "scale": 1 },
  "pixelDimensions": { "width": 40, "height": 40 },
  "delivery": { "mimeType": "image/png", "lossy": false, "bytes": 512, "scale": 1 },
  "coordinateMapping": {…},
  "evidence": {
    "interpolated": false, "sourcePixelsPerOutputPixel": 1, "lossyDelivery": false,
    "thresholded": false, "enhanced": true, "geometricallyInvertible": true, "pixelValuesInvertible": false,
    "warnings": ["enhanced pixels can show artefacts (halos, amplified noise); check against the original"]
  },
  "versions": { "ops": { "clahe": "js-1" }, "sharp": "…", "vips": "…" }
}
```

Records (not pixels) are kept per image, the last `ESTAMPES_DERIVED_VIEWS_PER_IMAGE` (default 200), and with storage in `images/<hash>/derived.json`. `get_derived_view` renders one again from its recipe, also after a restart, and says whether the id still matches (it would not if an operator changed). `present_visual` tabs (`views`) are derived views too and accept `sampling`.

## Zoom tiles

When the user zooms in the canvas, `load_visual_region` cuts the tile from the source file if the source is larger than the working copy and the working copy cannot fill the tile, so zooming past 4096 px shows real pixels. Recent tiles are cached.

## Geometry steps

`process_image` (and `present_visual` `views`) take `geometry`, applied to the analysis crop before `ops`, so filters see straightened pixels. Each step adds an exact matrix to the view's `coordinateMapping`, and the record reports `validity.validFraction`, the share of output pixels that really come from the image (the rest is fill).

| Step | What it does |
| --- | --- |
| `rotate` | Clockwise degrees. Multiples of 90 are lossless; other angles are resampled bilinearly and grow the canvas. |
| `flip` | Mirror horizontally or vertically (the back of a board). |
| `pad` | Add a border of `px`. |
| `deskew` | Estimate the dominant line direction (projection profiles) and rotate it level. Reports the estimated angle and a confidence, and leaves the image alone when there is no clear direction. |
| `perspective` | Four corners (0..1 of the whole image; top-left, top-right, bottom-right, bottom-left) become a top-down rectangle. Optional `width`, `height` or `aspect`. Degenerate corners fail. Correct only for flat surfaces. |
| `mask` | Keep the inside of a polygon; the rest is filled. |

A rectangle read off a rotated or warped view is not a rectangle on the image any more, so `coordinateFrame: {derivedViewId}` turns it into a closed four-point polyline (quarter turns and flips keep rectangles).

## More operators

`gamma`, `levels` (percentile or fixed points), `white_balance` (gray world or white patch), `channel` (red, green, blue, hue, saturation, value, Lab L/a/b as grey), `flat_field` (uneven illumination), `morphology` (erode, dilate, open, close; radius in analysis pixels) and `canny` (thin edges with hysteresis; thresholds are fractions of the strongest gradient in the crop). The older ten are unchanged except that one-channel inputs now stay one channel through sharp (before, the adaptive threshold's local mean was read from a three-channel copy); their operator versions changed, so new recipe ids differ from 0.9.0 for those ops.

## Registration and comparison

`register_images` estimates how image B maps onto image A, in normalized coordinates both ways.

- `method: auto`: Harris corners at four scales, oriented BRIEF descriptors, ratio and mutual-nearest tests, RANSAC (seeded, so the same pair always gives the same answer). Needs texture both photos share.
- `method: landmarks`: similarity (2+ pairs), affine (3+) or homography (4+) fitted to pairs the model or user identified; works across image types where pixels do not match. Residuals are reported per pair.
- `mirror: true` aligns a flipped copy of B.
- Result: `status` `ok` or `failed` with `reasons` (too few corners, too few matches, inliers below 12 or ratio below 0.25, ill-conditioned transform), inliers, inlier ratio, median and P95 error (working pixels of B), conditioning, coverage (hull of inliers over A) and median error per 4×4 cell of A. A schematic and a photo are not alignable this way; use landmarks.
- Nothing is written to the canvas. `registrationId` is a hash of the inputs; registrations are kept in memory.

`compare_images` shows B warped onto A: `overlay`, `difference`, `checkerboard` or `matches`, plus overlap, mean difference, PSNR and SSIM over the shared area. Lighting differences lower SSIM without misalignment; it points to where to look.

## Quality, scale and measurement

`assess_image` measures sharpness (Laplacian variance), noise (Immerkaer sigma), contrast and 1–99% range, clipped highlights and crushed shadows per channel, colour cast, a luminance histogram and the dominant line tilt, with plain advice. Values depend on the analysis resolution (stated in the result). Optional clipping map.

`calibrate_scale` fixes a known length between two points in one measurement space, the source image or one derived view, and stores it with the image. `measure_image` returns distance, path length, area or angle with an uncertainty from point precision and the scale; without a calibration the unit is `px`. Measure on a perspective-rectified view of a flat surface, where distances are uniform; on a tilted photo the tool warns.

## PDF pages

`render_pdf_page` turns one physical PDF page into an ordinary image (an `imageId`), so everything above, marks and exports included, works on it. PDF support is optional so the core stays small: it needs `pdfjs-dist` and `@napi-rs/canvas`. Install them with `npm i --no-save pdfjs-dist @napi-rs/canvas`, or build the Docker image with `--build-arg ESTAMPES_WITH_PDF=1` (adds about 60 MB, amd64 and arm64). Without them the tool says it is unavailable and nothing else changes.

- `pageIndex` is the 0-based physical position (the fifth page is 4). `pageLabel` carries the printed label when the PDF defines page labels. Omit `pageIndex` for page count and labels only.
- The image covers the page's visible box with its rotation applied, at `dpi` 36–600 (limited by `ESTAMPES_MAX_IMAGE_MEGAPIXELS`). Normalized coordinates are the same at every DPI, so a layout read at 150 dpi lines up with a 600 dpi render of the same page. Each render is a separate image (its own `imageId`); re-marking at a higher DPI is a copy of normalized coordinates.
- `text: true` returns the embedded text layer with boxes normalized to the page image, so text can be read without OCR. Scanned pages have no text layer. Box positions are approximate for rotated text.
- The page is described in `entry.page` and in `images/<hash>/meta.json`: `documentSha256`, `pageIndex`, `pageCount`, `pageLabel`, `dpi`, `rotation`, `cropBox`, `widthPt`, `heightPt`, `renderer`. With storage, the PDF is kept under `documents/<sha256>/source.pdf` and later calls can pass `documentSha256` instead of the file.
- PDFs are untrusted: no scripts run, and size, page count and pixel limits apply.

## Analysis engines

`detect_features` runs an analysis engine on an image, a region of it or a processed view of it, and returns structured detections. Engines are pure: they read pixels and return evidence, and never write to the canvas. GPT (or you) decides whether to turn a detection into a mark; every detection carries a ready `mark` for `present_visual`.

| Engine | Finds | Notes |
| --- | --- | --- |
| `components` | Connected dark or light regions as boxes | area, fill ratio, centroid; `polarity`, `method` (otsu, adaptive, fixed), `minArea` |
| `regions` | Closed regions (grains, cells, particles, pads), touching blobs split by shape | outline polygon, area, perimeter, equivalent diameter, axes, eccentricity, circularity, `touchesBorder`, `splitFrom`; see [Regions](#regions) |
| `blobs` | Point-like sources against the local background | intensity-weighted centroid, flux, peak, FWHM, SNR; for stars, solder joints, particles |
| `lines` | Straight segments (Hough on Canny edges) | endpoints, length, angle; a thick stroke gives two edge lines |
| `circles` | Rings, holes, dials | centre, radius, confidence from how much of the ring has edge pixels |
| `ocr` | Words with boxes and confidence | optional: `npm i tesseract.js`; language data is downloaded on first use unless `ESTAMPES_OCR_LANG_PATH` points at a folder of `.traineddata` files (a network access the owner should know about) |

Every result has the same envelope: `status` (`ok`, `failed` or `unavailable`) with `reasons`, `engine` and `engineVersion`, `imageId` and `sourceAssetId`, the `region` and analysis resolution it ran at, `detections` (normalized source coordinates), an optional `quality` summary and `warnings`. A missing optional engine is a result with status `unavailable`, never an error, and the core starts without it. Detections are candidates: two lines are not a verified wire, recognised text is not a verified part number. Use `sampling: {mode: "native"}` for small features.

### Detecting on a processed view

Without `derivedViewId` an engine always reads source pixels, whatever `process_image` did before. Pass `derivedViewId` (with the same `imageId`) and the engine reads that view's pixels instead: after its geometry and ops, before the delivery resize and codec, so a JPEG-delivered view is still analysed losslessly.

- The pixels are rebuilt from the stored recipe and the recipe must still give the same id. A view of another image, an unknown id, a view without an invertible mapping, or a stale view (an operator changed since it was made) is an error, not a silent fallback to other pixels. `region` and `sampling` cannot be combined with `derivedViewId`; the view has its own.
- Each detection has image coordinates as before (normalized, top-left origin) and `view` with the same geometry in pixels of the view, the frame `present_visual` accepts as `coordinateFrame: {derivedViewId}`. Both come from the view's `coordinateMapping`, so they agree exactly.
- Under a quarter turn, flip or crop a box stays a box. Under any other rotation or a perspective warp its four corners are given as `polygon`, `x/y/x2/y2` are their bounding box, and the ready `mark` is a closed polyline.
- Detections that fall in a view's fill (the corners of a rotated view, outside a mask) carry `outsideSource: true` and no `mark`.
- The result adds `derivedViewId`, `view` (`ops`, `geometry`, `sampling`, operator `versions`, `pixelDimensions`, `mapping`, `axisAligned`, `validFraction`) and `coordinates`. `analysis.space` is `view`; pixel attributes (`areaPx`, `lengthPx`, `radiusPx`) are in the view's analysis pixels, and `sourcePixelsPerAnalysisPixel` is `null` for a perspective view, where one view pixel is not one fixed length on the image.

### Regions

`regions` turns a dark-or-light mask into separate closed regions. It thresholds like `components` (`polarity`, `method`, `value`), optionally fills holes (`fillHoles`), and then splits blobs that touch: a watershed of the distance transform, in which two parts stay separate only if the neck between them is narrower than the smaller part's inner radius by at least `minDepth` pixels (default 1.5) and by `minRelativeDepth` of that radius (default 0.12). `split: false` gives plain connected components with the same statistics.

Per region: `areaPx`, `perimeterPx` (a Crofton estimate, within about 1% on smooth outlines and up to 6% low on long axis-aligned straight edges), `equivalentDiameterPx`, `majorPx`/`minorPx`/`eccentricity`/`orientationDeg` of the ellipse with the same second moments, `circularity`, `inscribedRadiusPx`, `touchesBorder`, and an outline as a closed polyline `mark` (`maxVertices`, default 16; `tolerance` in pixels; `contours: false` gives boxes). `quality` summarises every region found (count, median equivalent diameter, mean area, how many were split or touch the frame), also when `maxCount` (default 80) returns fewer.

What the result does not claim:

- A split is inferred from shape; no boundary was seen. Split regions carry `splitFrom` (the blob they came from), `splitParts` and `weakestSplit` (0–1, how much the neck narrows; values near `minRelativeDepth` are the doubtful ones). Every region is `verification: "unverified"`.
- A region count is not a count of grains, cells or parts. Where the picture shows the boundaries rather than the bodies (etched grain boundaries, cell membranes), segment a cleaned binary view (`process_image` threshold and morphology, then `derivedViewId`) with the polarity of the bodies.
- Regions touching the frame are probably cut off; their sizes are lower bounds (`excludeBorder: true` drops them).
- Real units (`area`, `equivalentDiameter`, `perimeter`, `unit`) appear only when `calibrate_scale` set a scale for the space the engine ran in: the source image, or that derived view. A view never borrows the image's scale.
- Outlines are outer contours; holes are not traced. Inputs above 6 million analysis pixels are refused.

The functions behind it (`squaredDistanceTransform`, `splitByDistance`, `regionStats`, `traceContour`, `simplifyClosed`, `fillHoles`, `labelMask` in `src/image/segment.js`) are pure and deterministic and can be used by other engines.

Engines register through `registerEngine({id, version, kind, description, available, run})` in `src/image/engines.js`; `run` receives the analysis pixels, a `toNormalized` function and, when one is set, the `scale` of its measurement space, and must return detections only. An engine written this way works on derived views without change: the runner maps its detections back to the image. The module system wraps engines as built-in capabilities.
