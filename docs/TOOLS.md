# MCP tools

Estampes exposes its tools at `/mcp`. Users never name them; GPT chooses. This page lists what each one does, which is useful when connecting another MCP client or debugging.

## Tools GPT calls

| Tool | Purpose |
| --- | --- |
| `present_visual` | Show the shared canvas. Takes the attached image (`image`), a public `imageUrl`, an earlier `imageId`, or a second image for a side-by-side view (`pairImage`, `pairImageUrl`, `pairImageId`). Adds, edits or removes marks (`annotations`, `remove`, `reset`), attaches notes and status to marks (`findings`), names the layer (`layer`), records links between paired marks (`links`), adds processed tabs (`views`, max 3) and restores a previous export (`marksFile`). Returns a verification image and download links. |
| `get_visual_state` | Read everything on a canvas as one `estampes.visual/2` JSON document (images, layers, marks, links, the confidence, evidence and verification of every claim, rejected claims, optional change history). Read-only. See [Visual protocol 2](PROTOCOL-V2.md). |
| `create_workspace` | Create a workspace with any number of images (up to 24): new files or URLs, existing canvases with their marks (`canvases`), or every image of other workspaces or canvases (`from`). See [Workspaces](WORKSPACES.md). |
| `edit_workspace` | Add images, detach items (`remove` never deletes images or marks), move, resize, rotate or label them (`arrange`), reorder, rename, re-flow. Checks `expectedRevision`; returns an `undoToken`. |
| `merge_workspaces` | Bring the images of one canvas or workspace, with their marks, into another. Previews by default; `commit: true` with the `previewId` applies. `mode` link (shared marks, default) or copy (independent copies); `removeFromSource` moves. |
| `split_workspace` | The same into a new workspace. |
| `undo_workspace_change` | Undo one workspace change by its `undoToken`. |
| `get_workspace_state` | Read a workspace (or a single or paired canvas in the same shape) as one `estampes.workspace/1` document, with a check of its totals. Read-only. |
| `load_image` | Load an image (`image` from the chat, or `imageUrl`) and get an `imageId` plus a preview. Use when GPT only needs to analyse; `present_visual` loads images too. |
| `process_image` | Return a processed view of an image or a region of it (zoom up to 8x). Operations, applied in order (max 8): `grayscale`, `normalize`, `clahe`, `contrast`, `brightness`, `sharpen`, `denoise`, `threshold` (adaptive, Otsu, fixed), `invert`, `edges`. |
| `overlay_grid` | Draw a labelled grid (rows A, B, C… × columns 1, 2, 3…, 2–12 each) over an image or region and return each cell's centre in source coordinates. |

Mark types: `point`, `rect`, `arrow` (head is the target) and `polyline` (up to 128 vertices, optionally `smooth` or `closed`). Coordinates are normalized to the full image with the origin at the top left; `coordinateFrame` lets GPT pass coordinates read off a processed crop and have Estampes convert them. Colour, size and pen (pen or translucent highlighter) are chosen by GPT.

## Tools only the canvas widget calls

These are hidden from the model (`visibility: ["app"]`).

| Tool | Purpose |
| --- | --- |
| `validate_visual_annotations` | Validates the marks you send, adds your intent and note, and produces the chat message GPT receives. |
| `load_visual_canvas` | Reloads a photo (or pair) into the widget, for example after the host dropped the pixels. |
| `load_visual_region` | Returns a higher-resolution tile while you zoom. |
| `edit_visual_canvas` | Applies your own layer and mark edits (rename, order, lock, opacity, move, restyle, delete). |
| `review_visual_link` | Records your confirm or reject verdict (with an optional reason), or withdraws it, on a link in a paired view. A rejection is remembered for that place. |
| `review_visual_finding` | The same for GPT's note on one mark. |
| `record_number_line_selection` | Validates a selection in the number-line demo. |

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
| `/api/v1/workspaces/<hex>[?history=N]` | The `estampes.workspace/1` document (key required when set). |
| `/export/<hash>/image.jpg`, `/export/<hash>/marks.svg` | Downloads; signed with `?sig=` when a key is set. |
| `/healthz`, `/version` | Public health check and build summary. |
