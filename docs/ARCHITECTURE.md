# Architecture

Estampes is one Node 22 process. ChatGPT (or any MCP client) talks to it at `/mcp`; ChatGPT renders the canvas as an MCP Apps widget inside the conversation. This page describes what exists today. For the reasons behind the design, see [Vision](VISION.md); for older experiments, see [history](history/README.md).

## Who does what

| Part | Responsibility | Not its job |
| --- | --- | --- |
| **GPT** | Understand the request, look at pixels, decide what is where, choose marks, pens and layer names | Storing anything between turns |
| **Estampes server** | Load and normalize images, process pixels, keep marks, layers and links per image, validate geometry, render the verification crop, store and export | Recognizing what is in an image |
| **Canvas widget** | Show the original image with marks, let the user draw, select, zoom, hide layers and review links, send marks back | Deciding what a mark means |
| **User** | Point, confirm or reject GPT's links, lock layers | |

Estampes never claims to know what an object is. A mark records geometry, who made it, an optional note and a status (for example `inspected` only after GPT looked at those pixels).

## Data flow

```
user ──attaches image──▶ ChatGPT ──load_image / present_visual (file param or URL)──▶ server
                                                                                    │ fetch, normalize, hash
GPT ◀── structured result + verification image ◀───────────────────────────────────┘
 │
 └─ present_visual (marks, layer, links) ─▶ server ─▶ widget (inline in chat)
                                                        │ user draws, edits, zooms
GPT ◀── chat message with the user's marks ◀── widget ◀─┘
          (validate_visual_annotations, edit_visual_canvas, load_visual_region… app-only tools)
```

The widget calls the server's app-only tools directly (they are hidden from the model) and sends a chat message so GPT sees the user's marks in the next turn. See [Tools](TOOLS.md).

## Server

`server.js` registers the MCP tools, the widget resources and the HTTP routes. Logic lives in `src/`:

| Module | Role |
| --- | --- |
| `image-store.js` | Image intake (ChatGPT file param or public https URL), EXIF orientation, size limits, content-hash identity, in-memory cache |
| `image-ops.js` | Pixel operations for `process_image` and `overlay_grid` (CLAHE, sharpen, denoise, threshold, edges, crop and zoom, grid), zoom tiles |
| `image/view.js`, `image/transform.js` | Derived views: analysis vs delivery resolution, native-resolution crops, recipes and ids, 3×3 coordinate transforms ([Image pipeline](IMAGE-PIPELINE.md)) |
| `canvas-state.js` | Per-image marks, layers (order, lock, opacity), paired-view links, user edits |
| `mark-render.js`, `pixel-font.js` | Verification crops drawn with the marks at real ink width |
| `marks-file.js`, `protocol.js` | Layered SVG export and restore; the `estampes.visual/2` document ([Visual protocol 2](PROTOCOL-V2.md)) |
| `workspace.js` | Workspaces: several annotation sets in one place, copies of sets, merge/split/move/copy/link with preview, revision checks, idempotency and undo; the `estampes.workspace/1` document ([Workspaces](WORKSPACES.md)) |
| `storage.js` | Optional disk storage ([Deployment](DEPLOYMENT.md#what-is-stored)) |
| `security.js`, `config.js` | Access key, signed export links, environment settings |
| `tunnel.js` | Reads the temporary Cloudflare tunnel address for the docker compose `tunnel` profile |
| `visual-input.js`, `scene-catalog.js`, `interaction-protocol.js` | Bundled SVG demo scenes and the older v0.2 event format; kept for legacy tools and tests |

### Image identity and coordinates

An image's id is derived from its content hash, so the same file attached in another chat maps to the same canvas. Every coordinate is **normalized to its own image with the origin at the top left**, independent of screen size, zoom or the working-copy resolution. Operations that return a crop report the region they cover and a `derivedViewId` whose matrix converts back exactly (`coordinateFrame`). The source file is kept unchanged next to the working copy, so crops and zoom tiles can use its full resolution. See [Image pipeline](IMAGE-PIPELINE.md).

### State and persistence

Memory is the working copy: decoded images and canvases are cached (`ESTAMPES_CACHE_*`, about an hour by default). With `ESTAMPES_STORAGE_DIR` set, every change is also written to `images/<hash>/` (source, `canvas.json`, `marks.svg`, `history.jsonl`), and an evicted or restarted image is reloaded from there on demand. Two processes must not share one storage folder.

### Security model

Self-hosted, one owner per instance. A shared access key (`?key=` or Bearer) gates `/mcp` and `/api/v1/*`; export links are signed; `X-Forwarded-*` headers are trusted only with `ESTAMPES_TRUST_PROXY`; remote image fetches are limited to public addresses with size, time and pixel caps; the Docker image runs unprivileged with a read-only filesystem. The key is a bearer secret in a URL, not per-user authentication. See [Deployment](DEPLOYMENT.md#caveats).

## Widget

`public/visual-surface.html` is a single self-contained page (no build step) served as an MCP Apps resource whose `ui://` URI contains the package version, so a release invalidates ChatGPT's cached copy. It draws the image and marks as SVG, supports zoom and pan with native-resolution tiles, drawing and selecting, undo/redo, layers, processed-image tabs and the paired view, and talks to the host through the MCP Apps bridge. `number-line.html` and `visual-evidence.html` are the demo and legacy widgets.

## Constraints that shaped the design

- Plugins cannot draw over images ChatGPT itself displays, so images are shown in Estampes's own canvas.
- Images enter only through ChatGPT's native paths (attached or photographed file, or a public URL), so there is no custom upload UI.
- The host may deliver tool input after the tool result, resize the widget at any time, and drop large payloads; the widget and server keep payloads small and can reload an image by id.
- Every feature stays generic: nothing in the tools or widget is specific to one kind of image.
