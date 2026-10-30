# Changelog

The version in `package.json` is the single source of truth. Earlier milestone details are in [docs/history/](docs/history/README.md).

## Unreleased

## 0.10.0 — Geometry, registration, quality and measurement

- `process_image` / `views` `geometry`: rotate, flip, pad, deskew, four-point perspective rectification and polygon mask, each with an exact matrix and a validity fraction. Marks read off a rotated or rectified view map back through `derivedViewId`.
- New operators: `gamma`, `levels`, `white_balance`, `channel` (RGB, HSV, Lab), `flat_field`, `morphology`, `canny`.
- `register_images` (auto features + RANSAC, or landmarks; optional mirror) with honest quality reporting and failure reasons; `compare_images` (overlay, difference, checkerboard, matches, SSIM/PSNR).
- `assess_image` (sharpness, noise, contrast, clipping, colour cast, tilt) and `calibrate_scale` / `measure_image` (distance, path, area, angle with uncertainty).
- Fix: one-channel images stay one channel through normalize, contrast, brightness, sharpen, denoise and invert, and the adaptive threshold reads its local mean from the right buffer. Recipe ids of processed views that used these operators change.

## 0.9.0 — Image pipeline: source, derived views and coordinates

- `process_image` takes `sampling` (`preview` = unchanged default, `working`, `native` = pixels cut from the original file beyond the 4096 px working copy) and `output` (size; PNG, lossless WebP or JPEG). Ops run at the analysis resolution and the result is resized only for delivery; enlarging is opt-in and flagged as interpolation.
- Every processed view is a derived view with a `derivedViewId`, its recipe, operator versions, the 3×3 mapping back to the image and caveats (interpolated, lossy, thresholded, enhanced). `get_derived_view` renders it again from the recipe, also after a restart (`images/<hash>/derived.json`).
- `present_visual` `coordinateFrame: {derivedViewId}` converts coordinates read off a processed view exactly; `views` tabs accept `sampling`.
- `inspect_image`: source format, EXIF orientation, colour space, bit depth, alpha, ICC profile, SHA-256 `sourceAssetId`, working size and coordinate spaces.
- Zoom tiles come from the source file when it is larger than the working copy.
- New settings `ESTAMPES_MAX_ANALYSIS_MEGAPIXELS`, `ESTAMPES_DERIVED_VIEWS_PER_IMAGE`. See [Image pipeline](docs/IMAGE-PIPELINE.md).
- Arrows no longer mean "the head is the target" by default. The canvas's default purpose is now free annotation: each arrow is sent with `semanticHint: "unspecified"` and its direction (heading and angle in image pixels), and GPT reads the meaning from your note, so "I think the current flows this way" is discussed as a direction. Only the 「只是指出這裡」 purpose makes the head the referent, and a note that says otherwise still wins. See [What your marks mean](docs/TOOLS.md#what-your-marks-mean).
- Strokes that belong together are recognised without being merged. Each stroke you draw records its order, time since the first stroke of the send and input device; Estampes proposes candidate gesture groups (for example a freehand arrow drawn as a shaft plus a head, with its direction) and labels them as unconfirmed guesses for GPT. Below the canvas you can confirm or reject a candidate, or group and ungroup strokes yourself (`review_gesture_group`); verdicts are saved with the canvas, and `get_visual_state` includes `gestureGroups`.
- New docs: `docs/USAGE.md`, `docs/TOOLS.md`; `docs/ARCHITECTURE.md` rewritten to describe the current system.
- Licensed under the Mozilla Public License 2.0 (`LICENSE`, `package.json`).

## 0.8.0 — Claims, evidence and verification

- Every note GPT puts on a mark and every link is a claim with three separate parts: GPT's `confidence` (only orders review), `evidence` (what it saw, the kind of clue, and the region on which image, always recorded as the model's own observation) and a verification state that only you, or a tool's evidence, can change.
- Every unverified claim waits for you, not just low-confidence links. Each piece of evidence zooms to its region. GPT's notes on marks can be confirmed or rejected too (`review_visual_finding`), with an optional reason, and withdrawn.
- Rejected claims are remembered apart from their marks, so they survive deleting, redrawing and reset. GPT repeating one at the same place without a new kind of evidence is refused and told why.
- `estampes.visual/2` ([Visual protocol 2](docs/PROTOCOL-V2.md)); version 1 documents are still read.

## 0.7.2 — Temporary public address

- `docker compose --profile tunnel up -d` opens a Cloudflare quick tunnel and logs the ChatGPT connector URL. No account and no router changes; the address changes on every restart.

## 0.7.1 — Secure defaults for self-hosting

- Without `ESTAMPES_ACCESS_KEY`, Docker generates a key on first start and saves it as `/data/access-key`; `ESTAMPES_ALLOW_OPEN=1` opts out.
- compose binds `127.0.0.1` by default, with a read-only filesystem, no capabilities and `no-new-privileges`.
- `X-Forwarded-*` headers are trusted only with `ESTAMPES_TRUST_PROXY`.
- Signed `/export` links. Heroku generates a key.

## 0.7.0 — Disk storage, Docker and visual protocol 1

- `ESTAMPES_STORAGE_DIR`: each image gets `images/<hash>/` (source, `canvas.json`, `marks.svg`, history), so canvases survive restarts.
- Docker/compose (non-root, `/data` volume, `/healthz`), multi-arch GHCR image (amd64, arm64), Heroku `app.json`.
- Layers can be renamed, reordered, faded and locked.
- Select tool: move, restyle or delete one mark, including marks from earlier turns.
- `estampes.visual/1`: the `get_visual_state` tool and `/api/v1/canvas`.

## 0.6.0 — Paired view

- `pairImage`: two different images side by side; GPT records links between marks with a confidence, and the user reviews them (`review_visual_link`).

## 0.5.x — Real images and the canvas

- 0.5.0: `load_image` (chat file or public https URL), `process_image` (CLAHE, sharpen, denoise, threshold, edges, zoomed regions), `overlay_grid` (labelled coordinate grid).
- 0.5.1: `present_visual` shows the real photo, original by default, with optional processed tabs.
- 0.5.2: canvas tabs no longer snap back to the first view.
- 0.5.3: polylines and freehand drawing, faster processing, GPT notes and status on marks.
- 0.5.4: pens, colours, highlighter, verification image, crop coordinates, marks kept across turns.
- 0.5.5: undo/redo, GPT verification tab, smaller payloads, export `image.jpg` and layered `marks.svg`.
- 0.5.6: late tool input from ChatGPT no longer squashes the photo.
- 0.5.7: zoom and pan in the canvas (pinch, Ctrl+wheel, buttons) with native-resolution tiles.
- 0.5.8: touch drags no longer scroll the chat on phones.
- 0.5.9: layers: every send and every GPT drawing call is a layer you can show or hide.

## Up to 0.4.x — Proof of concept

- M0.3: number line, proving the GPT → widget → user → GPT round trip inside ChatGPT.
- M0.4–0.4.7: points, boxes and arrows on built-in SVG demo scenes, `inspect_visual` giving the model real pixels, merged into one canvas.
- 0.4.8: optional access key, rate limit, CORS allowlist, locked dependencies.
