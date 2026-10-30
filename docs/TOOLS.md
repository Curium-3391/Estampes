# MCP tools

Estampes exposes its tools at `/mcp`. Users never name them; GPT chooses. This page lists what each one does, which is useful when connecting another MCP client or debugging.

## Tools GPT calls

| Tool | Purpose |
| --- | --- |
| `present_visual` | Show the shared canvas. Takes the attached image (`image`), a public `imageUrl`, an earlier `imageId`, or a second image for a side-by-side view (`pairImage`, `pairImageUrl`, `pairImageId`). Adds, edits or removes marks (`annotations`, `remove`, `reset`), attaches notes and status to marks (`findings`), names the layer (`layer`), records links between paired marks (`links`), adds processed tabs (`views`, max 3) and restores a previous export (`marksFile`). Returns a verification image and download links. |
| `get_visual_state` | Read everything on a canvas as one `estampes.visual/2` JSON document (images, layers, marks, links, the confidence, evidence and verification of every claim, rejected claims, optional change history). Read-only. See [Visual protocol 2](PROTOCOL-V2.md). |
| `load_image` | Load an image (`image` from the chat, or `imageUrl`) and get an `imageId` plus a preview. Use when GPT only needs to analyse; `present_visual` loads images too. |
| `process_image` | Return a processed view of an image or a region of it. Operations, applied in order (max 8): `grayscale`, `normalize`, `clahe`, `contrast`, `brightness`, `sharpen`, `denoise`, `threshold` (adaptive, Otsu, fixed), `invert`, `edges`. `sampling` picks the analysis resolution (`preview` = old behaviour, zoom up to 8x by interpolation; `working`; `native` = pixels from the original file), `output` the delivered size and codec (PNG / lossless WebP / JPEG). `geometry` (rotate, flip, pad, deskew, perspective, mask) runs first; extra operators `gamma`, `levels`, `white_balance`, `channel`, `flat_field`, `morphology`, `canny`. Returns a `derivedViewId`, the coordinate mapping back to the image and caveats. See [Image pipeline](IMAGE-PIPELINE.md). |
| `get_derived_view` | Render a processed view again from its `derivedViewId` (recipes survive restarts with storage), optionally at another size or codec. |
| `inspect_image` | Describe a loaded image without pixels: source format, size before and after EXIF orientation, colour space, bit depth, alpha, ICC profile, SHA-256 source asset id, working-copy size, coordinate spaces and their matrices, processed views so far. |
| `register_images` | Align image B onto image A: `auto` (corner features, RANSAC) or `landmarks` (point pairs), optional `mirror`. Reports status with reasons, inliers, error, coverage and residuals per area; optional `mapPoints`. See [Image pipeline](IMAGE-PIPELINE.md#registration-and-comparison). |
| `compare_images` | Overlay, difference, checkerboard or match lines of a registration, with overlap, SSIM and PSNR. |
| `assess_image` | Sharpness, noise, contrast, clipping, colour cast, histogram, line tilt, with advice; optional clipping map. |
| `calibrate_scale`, `measure_image` | Set a known length in the image or a processed view, then measure distance, path, area or angle with uncertainty. |
| `render_pdf_page` | Render one physical PDF page at 36–600 dpi as an image (optional server support), with page label, embedded text boxes and stored-document reuse. See [PDF pages](IMAGE-PIPELINE.md#pdf-pages). |
| `overlay_grid` | Draw a labelled grid (rows A, B, C… × columns 1, 2, 3…, 2–12 each) over an image or region and return each cell's centre in source coordinates. |

Mark types: `point`, `rect`, `arrow` (when GPT draws one, the head is the target) and `polyline` (up to 128 vertices, optionally `smooth` or `closed`). Coordinates are normalized to the full image with the origin at the top left; `coordinateFrame` lets GPT pass coordinates read off a processed view (`derivedViewId`, exact for any crop or zoom; or the older `region` form) and have Estampes convert them. Colour, size and pen (pen or translucent highlighter) are chosen by GPT.

## Tools only the canvas widget calls

These are hidden from the model (`visibility: ["app"]`).

| Tool | Purpose |
| --- | --- |
| `validate_visual_annotations` | Validates the marks you send, adds your intent and note, and produces the chat message GPT receives. See [What your marks mean](#what-your-marks-mean). |
| `load_visual_canvas` | Reloads a photo (or pair) into the widget, for example after the host dropped the pixels. |
| `load_visual_region` | Returns a higher-resolution tile while you zoom. |
| `edit_visual_canvas` | Applies your own layer and mark edits (rename, order, lock, opacity, move, restyle, delete). |
| `review_visual_link` | Records your confirm or reject verdict (with an optional reason), or withdraws it, on a link in a paired view. A rejection is remembered for that place. |
| `review_visual_finding` | The same for GPT's note on one mark. |
| `review_gesture_group` | Records whether some of your strokes are one gesture: confirm or reject a candidate, group marks by hand, or withdraw the verdict. The strokes are not changed. |
| `record_number_line_selection` | Validates a selection in the number-line demo. |

## What your marks mean

A mark's `type` records what you drew, never what you meant. `validate_visual_annotations` keeps the geometry, your note and the chosen purpose apart, and tells GPT to read the meaning from your note, the image and the conversation.

- The default purpose is `free-annotate` (`requestedAssistantAction: "interpret-annotation"`). Every arrow you send carries `semanticHint: "unspecified"`: it may point at something, or show a direction, a flow, a movement or a relation. GPT is told to treat it as a direction when your note talks about direction or flow, as a pointer when you ask what it points at, and to give the possible readings (asking at most once) when there is no note.
- Only when you pick 「只是指出這裡」 (`point-out`) does an arrow get `semanticHint: "point-to-target"`, meaning the head is the referent. Even then, a note that says otherwise wins and GPT is told to point out the mismatch.
- Every arrow keeps its tail (`x`,`y`), head (`x2`,`y2`) and a `direction` computed in image pixels: `heading` (`right`, `up-right`, `up`, … ), `angleDeg` (0 = right, 90 = up, counter-clockwise), `lengthPx`, `provenance: "computed-from-geometry"`.
- Several strokes can form one gesture. The widget sends each stroke's order, time relative to the first stroke of the send and input device (`stroke`); Estampes proposes `gestureGroups` from where strokes meet in image pixels (end to end, or an end on another stroke; strokes that only cross are left alone) and recognises an arrowhead drawn as a separate stroke. Each group is labelled `system-inferred` and `unconfirmed` until you confirm or reject it, or `user-created` when you grouped the marks yourself, and GPT is told not to treat a guess as your intent. The fields are described in [Visual protocol 2](PROTOCOL-V2.md#gesture-groups).
- `interaction.arrowMeaning` is kept for older readers (`arrowhead-is-target` only for `point-out`, otherwise `unspecified`); `interaction.semanticsPolicy` is `geometry-is-not-intent`.

## Legacy and demo tools

Kept for older conversations and regression tests; new conversations do not need them.

| Tool | Purpose |
| --- | --- |
| `show_number_line` | Number-line demo for the GPT → widget → user → GPT round trip. |
| `inspect_visual` | Returns three PNGs for a marked spot on one of the three bundled SVG demo scenes. Does not accept your own images. |
| `present_visual_evidence` | Standalone three-PNG viewer for the same demo scenes. |

## HTTP endpoints

| Path | Purpose |
| --- | --- |
| `/mcp` | MCP endpoint. Needs the access key when one is set. |
| `/api/v1/canvas/<hash>[?pair=<hash>][&history=N]` | The `estampes.visual/2` document over plain HTTP (key required when set). |
| `/export/<hash>/image.jpg`, `/export/<hash>/marks.svg` | Downloads; signed with `?sig=` when a key is set. |
| `/healthz`, `/version` | Public health check and build summary. |
