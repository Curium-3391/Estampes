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
