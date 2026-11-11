# Image capability map

How each item of the Image Preprocessing Audit & RFC's 84-item catalogue (2026-10-30) stands. The report called its list a candidate catalogue, not a commitment. **Done** items ship in Estampes today; **Plugin** items need a domain engine behind the module interface and are not in the core on purpose; **External** items need a service, an API key, a model download or data Estampes does not have; **Later** items are reasonable but not built yet. See [Image pipeline](IMAGE-PIPELINE.md) for how the finished ones work.

## A. Source and resolution

| Item | Status | Where |
| --- | --- | --- |
| A01 source-native ROI | Done | `process_image` `sampling: native`; zoom tiles cut from the source |
| A02 analysis vs delivery resolution | Done | `sampling`, `output` |
| A03 immutable source asset + checksum | Done | `sourceAssetId` (sha256), source kept unchanged |
| A04 colour and EXIF report | Done | `inspect_image` (orientation, colour space, bit depth, alpha, ICC, density) |
| A05 keep alpha | Done | `sampling.alpha` `keep` (native) |
| A06 lossless output | Done | `output.format` png / webp (lossless) |
| A07 zoom levels / pyramid | Partly | native tiles on demand with a small cache; no stored pyramid |
| A08 long scans, multi-page, huge images | Partly | PDF pages on demand; crops stay bounded by `ESTAMPES_MAX_ANALYSIS_MEGAPIXELS`; no tiled processing of images beyond the input pixel limit |
| A09 16-bit / float | Later | sources are quantized to 8 bit for processing and the result says so |
| A10 RAW / TIFF / multi-page adapters | Plugin | sharp reads TIFF; RAW and FITS need decoders (LibRaw, cfitsio) |
| A11 perceptual hash | Later | identity stays the cryptographic hash |

## B. Brightness, colour, noise, sharpening

| Item | Status | Where |
| --- | --- | --- |
| B01 gamma / exposure | Done | `gamma` |
| B02 levels / percentile stretch | Done | `levels` |
| B03 white balance | Done | `white_balance` (gray world, white patch) |
| B04 channel views (RGB, HSV, Lab) | Done | `channel` |
| B05 hue / saturation / vibrance | Later | `channel` shows them; no recolouring on purpose |
| B06 flat-field | Done | `flat_field` (estimated from a blurred copy; no reference frame) |
| B07 bilateral / guided filter | Later | |
| B08 non-local means | Later | heavy in JS; candidate for a worker |
| B09 unsharp mask with threshold | Later | `sharpen` exists |
| B10 deblur | External | needs a PSF or a model; would need an artefact warning |
| B11 highlight / shadow recovery | Partly | `gamma`, `levels`; clipped pixels cannot be recovered and `assess_image` says so |
| B12 noise-model denoising | Later | median only |
| B13 colour card / ΔE | External | needs a reference chart and lighting data |
| B14 histogram and clipping map | Done | `assess_image` |

## C. Binarization, morphology, edges, features

| Item | Status | Where |
| --- | --- | --- |
| C01 Sauvola / Niblack | Later | adaptive threshold exists |
| C02 morphology | Done | `morphology` |
| C03 connected components | Done | `detect_features` `components`; split and measured: `regions` |
| C04 Canny | Done | `canny` |
| C05 Hough lines and circles | Done | `lines`, `circles` |
| C06 contours + hierarchy | Partly | `regions` gives outer contours as closed polylines; holes are not traced |
| C07 skeletonization | Later | |
| C08 distance transform | Partly | exact Euclidean, inside `regions` (`src/image/segment.js`); not a `process_image` op |
| C09 mask / component overlay as a layer | Partly | detections carry ready marks; no mask layer type |
| C10 blob detector + centroid | Done | `blobs` |
| C11 ROI polygon mask | Done | geometry `mask` |
| C12 dominant line orientation | Done | `deskew`, `assess_image` |

## D. Geometry, registration, measurement

| Item | Status | Where |
| --- | --- | --- |
| D01 rotate / flip / crop / pad | Done | `geometry` |
| D02 auto deskew | Done | `deskew` |
| D03 perspective rectify | Done | `perspective` |
| D04 lens distortion | External | needs camera calibration (checkerboard shots or a lens profile) |
| D05 manual landmark alignment | Done | `register_images` `landmarks` |
| D06 feature matching | Done | `register_images` `auto` (Harris + oriented BRIEF; not ORB/AKAZE) |
| D07 RANSAC affine / homography | Done | with inliers and residuals |
| D08 overlay, swipe, difference | Done | `compare_images` (swipe is a widget feature, not built) |
| D09 difference map + SSIM | Done | `compare_images` |
| D10 stitching | Later | needs warping/blending of many images; parallax caveats |
| D11 scale calibration | Done | `calibrate_scale` |
| D12 length, area, angle | Done | `measure_image` |
| D13 transform graph + inverse | Done | `coordinateMapping`, `coordinateFrame {derivedViewId}` |
| D14 validity mask / distortion map | Partly | `validity.validFraction`; no per-pixel mask image |
| D15 registration uncertainty | Done | residuals per area of the image |
| D16 feature tracking across views | Later | |

## E. Documents and PDF

| Item | Status | Where |
| --- | --- | --- |
| E01 PDF page renderer | Done | `render_pdf_page` (optional install) |
| E02 page index vs printed label | Done | `pageIndex` physical, `pageLabel` |
| E03 render at DPI | Done | 36–600 dpi |
| E04 embedded text + boxes | Done | `text: true` |
| E05 OCR adapter + boxes | Done, optional | `detect_features` `ocr` (tesseract.js; language data download is a network access) |
| E06 layout regions | Later | |
| E07 table structure | Later | |
| E08 diagram line / junction candidates | Plugin | `lines`, `components`, `circles` give candidates; calling them wires or junctions is the model's or a plugin's job |
| E09 page dewarp | Later | |
| E10 vector paths from PDF / SVG | Later | |
| E11 page / version diff | Partly | `register_images` + `compare_images` on two rendered pages |

## F. Model-assisted analysis output

| Item | Status | Where |
| --- | --- | --- |
| F01 auto ROI suggestion | Partly | `components` and `assess_image` point at regions; no ranking |
| F02 structured detections | Done | `detect_features` envelope |
| F03 confidence + evidence | Done | derived view `evidence`, detections, claims (0.8.0) |
| F04 detection → annotation after confirmation | Done | ready `mark` on detections; marks only via `present_visual` |
| F05 crop comparison grid | Later | views tabs cover side-by-side use |
| F06 pipeline proposals | Later | |
| F07 quality metrics | Done | `assess_image` |
| F08 reproducible recipe | Done | `derivedViewId`, `get_derived_view` |
| F09 annotations independent of processed pixels | Done | marks stay in source-normalized space |
| F10 batch ROI requests | Later | |

## G. Domain plugins

These need domain engines, catalogues or services behind the module interface, so they are not in the core.

| Item | Status | What it needs |
| --- | --- | --- |
| G01 PCB trace explorer | Plugin | domain logic on top of `lines`, `components`, `register_images`; inner layers cannot be seen from a surface photo |
| G02 PCB top / bottom registration | Plugin | built from `register_images` with `mirror` and landmark holes |
| G03 component OCR + package candidates | Plugin | `ocr` plus a part / package database |
| G04 schematic ↔ photo correspondence | Plugin | cross-modal matching; links stay claims with evidence (0.8.0) |
| G05 star centroid / PSF / FWHM | Partly | `blobs` gives centroid, flux, FWHM |
| G06 plate solving | External | Astrometry.net API key or a local ASTAP / solve-field install plus index files |
| G07 astronomical calibration (dark, flat, bias, stacking) | External | raw frames and a FITS / RAW decoder |
| G08 instrument dial reader | Plugin | per-instrument calibration |
| G09 microscopy measurement | Plugin | scale bar + segmentation model; no diagnostic claims |
| G10 metrology | Plugin | calibrated optics |

## What was deliberately not done

- No OpenCV or ML runtime in the core, so the Docker image stays small and builds for amd64 and arm64. PDF and OCR are opt-in installs.
- No enhancement is presented as new evidence: results carry `interpolated`, `lossy`, `thresholded` and `enhanced` flags and caveats.
- No registration, detection or OCR result writes to the canvas by itself.
