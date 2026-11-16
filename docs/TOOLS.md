# MCP tools

Estampes exposes its tools at `/mcp`. Users never name them; the AI chooses. This page lists what each one does, which is useful when connecting another MCP client or debugging.

## Tools the AI calls

| Tool | Purpose |
| --- | --- |
| `present_visual` | Show the shared canvas. Takes the attached image (`image`), a public `imageUrl`, an earlier `imageId`, a second image for a side-by-side view (`pairImage`, `pairImageUrl`, `pairImageId`), or a whole workspace of three or more images (`workspaceId`; marks, findings and links then name their `item`). `upload: true` opens an empty canvas where the user picks or photographs an image themselves (for hosts such as Claude that do not pass attachments to tools). Adds, edits or removes marks (`annotations`, `remove`, `reset`), attaches notes and status to marks (`findings`), names the layer (`layer`), records links between paired marks (`links`), adds processed tabs (`views`, max 3) and restores a previous export (`marksFile`). Returns a verification image and download links. |
| `render_canvas` | Read full or cropped canvas pixels: base image, public scene objects and saved marks. Use submission `canvasReads` requests to retain hidden layers and check the revision. See [Canvas reads](CANVAS-READS.md). |
| `get_visual_layers` | Read stable layer IDs, authors, bottom-to-top order, opacity, shared visibility, locks, editability and the canvas revision. Workspace copies use `setId`. |
| `edit_visual_layers` | Set existing layer `opacity` (0–1, rounded to 0.05), `visible`, or bottom-to-top `order`. Requires `expectedRevision` from `get_visual_layers`; stale edits return `STALE_CANVAS`, locked edits return `LAYER_LOCKED`. `action: "undo"` / `"redo"` reverses the last unchanged appearance step. |
| `get_visual_state` | Read everything on a canvas as one `estampes.visual/2` JSON document (images, layers, marks, links, the confidence, evidence and verification of every claim, rejected claims, optional change history). Read-only. See [Visual protocol 2](PROTOCOL-V2.md). |
| `create_workspace` | Create a workspace with any number of images (up to 24): new files or URLs, existing canvases with their marks (`canvases`), or every image of other workspaces or canvases (`from`). See [Workspaces](WORKSPACES.md). |
| `edit_workspace` | Add images, detach items (`remove` never deletes images or marks), move, resize, rotate or label them (`arrange`), reorder, rename, re-flow. Checks `expectedRevision`; returns an `undoToken`. |
| `merge_workspaces` | Bring the images of one canvas or workspace, with their marks, into another. Previews by default; `commit: true` with the `previewId` applies. `mode` link (shared marks, default) or copy (independent copies); `removeFromSource` moves. |
| `split_workspace` | The same into a new workspace. |
| `undo_workspace_change` | Undo one workspace change by its `undoToken`. |
| `export_workspace_bundle` | Make a portable `.estampes` file of a workspace (signed download link). See [Workspaces](WORKSPACES.md#moving-a-workspace-estampes-bundles). |
| `import_workspace_bundle` | Open a `.estampes` file (attachment or public https URL) as a new workspace; checked, never overwrites. |
| `get_workspace_state` | Read a workspace (or a single or paired canvas in the same shape) as one `estampes.workspace/1` document, with a check of its totals. Read-only. |
| `load_image` | Load an image (`image` from the chat, or `imageUrl`) and get an `imageId` plus a preview. Use when GPT only needs to analyse; `present_visual` loads images too. |
| `process_image` | Return a processed view of an image or a region of it. Operations, applied in order (max 8): `grayscale`, `normalize`, `clahe`, `contrast`, `brightness`, `sharpen`, `denoise`, `threshold` (adaptive, Otsu, fixed), `invert`, `edges`. `sampling` picks the analysis resolution (`preview` = old behaviour, zoom up to 8x by interpolation; `working`; `native` = pixels from the original file), `output` the delivered size and codec (PNG / lossless WebP / JPEG). `geometry` (rotate, flip, pad, deskew, perspective, mask) runs first; extra operators `gamma`, `levels`, `white_balance`, `channel`, `flat_field`, `morphology`, `canny`. Returns a `derivedViewId`, the coordinate mapping back to the image and caveats. See [Image pipeline](IMAGE-PIPELINE.md). |
| `get_derived_view` | Render a processed view again from its `derivedViewId` (recipes survive restarts with storage), optionally at another size or codec. |
| `inspect_image` | Describe a loaded image without pixels: source format, size before and after EXIF orientation, colour space, bit depth, alpha, ICC profile, SHA-256 source asset id, working-copy size, coordinate spaces and their matrices, processed views so far. |
| `register_images` | Align image B onto image A: `auto` (corner features, RANSAC) or `landmarks` (point pairs), optional `mirror`. Reports status with reasons, inliers, error, coverage and residuals per area; optional `mapPoints`. See [Image pipeline](IMAGE-PIPELINE.md#registration-and-comparison). |
| `compare_images` | Overlay, difference, checkerboard or match lines of a registration, with overlap, SSIM and PSNR. |
| `assess_image` | Sharpness, noise, contrast, clipping, colour cast, histogram, line tilt, with advice; optional clipping map. |
| `calibrate_scale`, `measure_image` | Set a known length in the image or a processed view, then measure distance, path, area or angle with uncertainty. |
| `render_pdf_page` | Render one physical PDF page at 36–600 dpi as an image (optional server support), with page label, embedded text boxes and stored-document reuse. See [PDF pages](IMAGE-PIPELINE.md#pdf-pages). |
| `detect_features` | Run an analysis engine (`components`, `regions`, `blobs`, `lines`, `circles`, optional `ocr`) on an image, a region or a processed view (`derivedViewId`) and get candidate detections with geometry, attributes and a ready mark, or list the engines. Draws nothing. See [Analysis engines](IMAGE-PIPELINE.md#analysis-engines). |
| `overlay_grid` | Draw a labelled grid (rows A, B, C… × columns 1, 2, 3…, 2–12 each) over an image or region and return each cell's centre in source coordinates. |
| `open_module_store` | Open the Estampes Store in the chat: modules, what each can do, the permissions it asks for, enable or disable. See [Modules](MODULES.md). |
| `list_modules`, `get_module_capabilities` | List modules and their state; read one module's capabilities with exact input schemas and examples. |
| `execute_module` | Run a capability of an **enabled** module (for example Graph's `plot_function`) on a canvas, or on a new blank canvas. Returns object ids, the scene revision and a preview image. |
| `get_module_job` | Check a background job started by `execute_module` (for example plate solving): status, progress, result and created objects; can wait up to 25 s. See [Background jobs](MODULES.md#background-jobs). |
| `get_surface_state`, `manage_surface_panels` | Read which panels are open on a canvas and their layouts; open, close or arrange panels. `manage_surface_panels` also shows the Visual Surface, so it is how the calculator opens beside a canvas. See [Surfaces](SURFACES.md). |
| `add_image_layer` | Promote the base image into an editable layer, or copy another canvas (with its objects and marks) in as independent layers. PNG transparency is kept; the source is never modified. See [Canvas reads](CANVAS-READS.md). |
| `prepare_module_change` | Prepare enabling, disabling or (later) installing a module. Changes nothing: the user approves it in the Store. |

Mark types: `point`, `rect`, `arrow` (when GPT draws one, the head is the target) and `polyline` (up to 128 vertices, optionally `smooth` or `closed`). Coordinates are normalized to the full image with the origin at the top left; `coordinateFrame` lets GPT pass coordinates read off a processed view (`derivedViewId`, exact for any crop or zoom; or the older `region` form) and have Estampes convert them. Colour, size and pen (pen or translucent highlighter) are chosen by GPT.

## Tools only the canvas widget calls

These are hidden from the model (`visibility: ["app"]`).

| Tool | Purpose |
| --- | --- |
| `validate_visual_annotations` | Validates the marks you send, adds your intent and note, and produces the chat message GPT receives. See [What your marks mean](#what-your-marks-mean). |
| `load_visual_canvas` | Reloads a photo (or pair) into the widget, for example after the host dropped the pixels. |
| `load_visual_region` | Returns a higher-resolution tile while you zoom. |
| `documents_get_changes` | Poll for up to 12 canvas documents (`img:…`, `img:…#c…` or `ws:…`) with the revision the widget last saw. Each answer is `unchanged`, `snapshot` (the next revision), `gap` (more than one revision behind, or the server restarted) or `missing`. Revisions are `{epoch, counter, hash}`: the hash is the canvas content hash, the counter orders changes, the epoch changes when the server restarts. Snapshots carry marks, layers and objects, no pixels. |
| `load_visual_pixels` | Returns the canvas photo (or a processed view) as base64 in slices, when a result carried only a preview to stay under the host's size cap. |
| `upload_visual_image` | Receives an image picked or photographed in the canvas, as base64 slices; the last slice loads it and returns its canvas. |
| `edit_canvas_text` | Read/create/edit/delete standalone vector text, or undo/redo text changes. App-only; uses existing `shape` / `kind: "text"`, normalized coordinates, a required canvas revision for edits and `setId` for workspace copies. Refuses locked layers and stale revisions. |
| `edit_visual_canvas` | Applies your own layer and mark edits (rename, order, lock, opacity, visibility, move, restyle, label/note text, delete), or undoes / redoes your last mark edit with `history` (refused if the mark changed since or its layer is locked). |
| `review_visual_link` | Records your confirm or reject verdict (with an optional reason), or withdraws it, on a link in a paired view. A rejection is remembered for that place. |
| `review_visual_finding` | The same for GPT's note on one mark. |
| `review_gesture_group` | Records whether some of your strokes are one gesture: confirm or reject a candidate, group marks by hand, or withdraw the verdict. The strokes are not changed. |
| `store_get_catalog`, `store_get_detail`, `store_get_activity` | Read the module catalog, one module's details and the recent module activity for the Store widget. |
| `store_get_plan`, `store_commit_plan` | Prepare a change from a Store button, and apply it after the user confirms. Committing needs the plan's consent token, which only the widget receives. |
| `surface_get_state`, `surface_apply` | Read and change the open panels and this device's layout for the workbench. |
| `surface_cas`, `surface_cas_cancel` | The calculator panel: run, recompute, edit, plot a result in Graph, refresh links; cancel a running calculation. See [Scientific calculator](CAS.md). |
| `edit_scene_object` | Applies your own edit to a module's object from the canvas (for example a new formula for a plot), or deletes it. No module code runs. |
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
| `/mcp` | MCP endpoint. Needs the access key (or an OAuth token) when one is set. |
| `/api/v1/canvas/<hash>[?pair=<hash>][&history=N]` | The `estampes.visual/2` document over plain HTTP (key required when set). |
| `/api/v1/workspaces/<hex>[?history=N]` | The `estampes.workspace/1` document (key required when set). |
| `/export/<hash>/image.jpg`, `/export/<hash>/marks.svg` | Downloads; signed with `?sig=` when a key is set. |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token` | OAuth 2.1 sign-in (PKCE, dynamic registration, client ID metadata documents) for hosts such as Claude; only when a key is set. See [Connecting Claude](DEPLOYMENT.md#connecting-claude). |
| `/healthz`, `/version` | Public health check and build summary. |

## UVA store

`uva_store` is a read-only view of the UVA store, where canvases, workspaces,
panel layouts and calculator notebooks are committed by default
(`ESTAMPES_CANVAS_STORE=uva`): `status` (store health and, per canvas or record,
the legacy file, the durable pending seq and the committed seq), `list`, `open`,
`render`, `export` and `read_chunk`. It is registered whenever the store is on.
Edits go through the canvas, workspace, surface and calculator tools.


## Shared layer appearance

Read `get_visual_layers({imageId})`, then call `edit_visual_layers` with its
`revision` as `expectedRevision`, for example
`{imageId, expectedRevision, layers:[{id:"L2",opacity:0.4,visible:true}]}`.
Render with `render_canvas` to assess the composite, then present the result
with `present_visual`. Edits never change image pixels, annotation geometry or
authorship. The assistant cannot unlock layers or reorder across a locked layer.
Refresh and review after `STALE_CANVAS`; do not automatically overwrite user edits.

Visibility is now shared and persistent: the canvas checkbox, tool reads and
composite rendering use the same layer property. Previously saved viewer-local
`hiddenLayers` remain an additional viewing filter; “show all” clears those and
restores shared visibility. Appearance and order survive storage, workspace
movement/copy and bundle export/import. The last 50 assistant appearance steps
support undo/redo and survive a server restart; imported bundles start a fresh
appearance history. An intervening appearance edit causes `HISTORY_CONFLICT`.
A no-op does not create a history step. Workspace copies require the `setId`
from the item's `set` key or `canvasReads`; omit it for the image's own canvas.

Blend modes are unsupported. Brightness and contrast are separate image
processing operations, not layer properties.

## Typing on the canvas

Select your own annotation to edit its label (64 characters) and multiline note
(200 characters), then press **儲存標籤與備註**. Empty fields clear the text.
Enter saves a label after IME composition; Ctrl/Command+Enter saves a note.
Assistant annotations and locked annotations show read-only fields. A changed
note is a new claim and discards the previous evidence/review; it does not
automatically become confirmed. Undo restores the original note and claim data.
Saving text sends only the text fields, preserving current geometry and styling.
Draft notes are retained when sending a new annotation, in both the stored mark
and the submission event/chat message. Rejected text drags redraw the last
accepted coordinates.

Choose **文字**, tap a location, enter up to 80 characters (including newlines),
choose size (6–64) and color, then save. Use **選取** to click or drag existing
text. The same vector `shape/text` records are visible to assistant reads and
render/export without flattening. Use a `.estampes` bundle for an editable
standalone-text export/import round trip; SVG exports the vector drawing but
its marks-only importer does not reconstruct scene objects. Existing assistant text retains its creator
when the user edits it. Frame-space module text is not edited by this control.

The text editor has its own per-canvas undo/redo; toolbar undo/redo targets it
while it is open. The last 50 text operations persist across server restart.
A changed target refuses an inverse with `HISTORY_CONFLICT`; locked layers
refuse with `LAYER_LOCKED`. Edits use a read revision and refuse concurrent
changes with `STALE_CANVAS`; use **重新讀取** and review before retrying.
Images, pairs and workspace items use their own normalized source coordinates;
rotating/zooming a view does not change the stored text position. Workspace
copies have independent text history; bundle import starts a fresh history.
