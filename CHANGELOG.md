# Changelog

The version in `package.json` is the single source of truth. Earlier milestone details are in [docs/history/](docs/history/README.md).


## Unreleased

- Docs: README, the Chinese guide, ARCHITECTURE, TOOLS, DEPLOYMENT and VISION brought up to date (all docs indexed, modules, calculator container, surface tools, `ESTAMPES_ADMIN_KEY`, `ESTAMPES_MODULE_ALLOW_UNSIGNED`).
- **Capability profile.** Besides its input schema, a capability can describe when to use it and when not to, input limits, cost (latency, resources, billing), data flow, how far to trust the result and how to check it, and what to do when it fails. The model reads it through `get_module_capabilities` and the Store shows it; network capabilities must declare what they send, and the text may be translated (`profileI18n`) but not the cost or data flow. Filled in for Graph, plate solving and the example OCR adapter.
- **Info cards.** A new scene object `info-card` (title, label/value rows, optional https links) shown beside the canvas, not on the picture. The widget groups cards by module; each folds open and closed, starts folded, can be hidden by the module (`shown: false`) or the user, and hidden cards are listed so they can be brought back.
- Plate solving adds hms/dms, field size, constellation tags, objects in the field, result and Legacy Surveys links to its result and an info card (`showCard`), and a new `sky_position` capability draws an all-sky map with the solved field outlined. It asks for `workspace.write` (it can make a new canvas), so an already enabled install must be approved again for that capability.
- Plate solving marks the brightest named stars first (for example Altair, Deneb, Vega), then deep-sky objects, and skips labels that would overlap one already drawn.
- Browser test `tests/layers-e2e.test.js` (shared helper `tests/helpers/widget-host.js`): a base image, an image laid over it, a Graph curve and marks are all layers; fading one to 50% and moving it down are saved on the server. No product change: layers, opacity, order and `add_image_layer` already shipped.
- Retention sweep also removes stored PDF documents past `ESTAMPES_STORAGE_RETENTION_DAYS`; the PDF renderer passes pdf.js its bundled standard fonts so text in PDFs that do not embed fonts is drawn.
- Docs: `get_module_job` in TOOLS.md; DEPLOYMENT.md and MODULES.md explain running `estampes-module.js` inside the container (or with `ESTAMPES_STORAGE_DIR`) and the plate-solving test steps.

## 0.20.0 — Works in Claude

- **Sign in with OAuth.** Hosts that connect remote MCP servers with OAuth (Claude's custom connectors, Claude Code) now get a sign-in page on your own server: type the access key once and the host receives a token. OAuth 2.1 with PKCE (S256), dynamic client registration, client ID metadata documents and refresh tokens; tokens are signed with a key derived from the access key, so changing the key signs every client out. The `?key=` URL and `Authorization: Bearer <key>` keep working. Endpoints exist only when the server has a key. See [Connecting Claude](docs/DEPLOYMENT.md#connecting-claude).
- **Upload from the canvas.** A 選擇圖片／拍照 button in the canvas picks a file or takes a photo and sends it to the server in slices (`upload_visual_image`, app-only), then shows its canvas and tells the model the new `imageId`. `present_visual` with `upload: true` opens an empty canvas for it. For hosts that do not pass chat attachments to tools, such as Claude; works in ChatGPT too. Photos over 6 MB or 4096 px are re-encoded in the browser at 4096 px.
- **Results fit host size caps.** Every tool result stays under `ESTAMPES_MAX_RESULT_CHARS` (default 145,000; claude.ai drops results above about 150,000): images the model sees are re-encoded as JPEG and reduced to fit. The canvas gets a budgeted preview inline and loads the full display image and deferred processed views in slices (`load_visual_pixels`, app-only); zoom tiles shrink to fit.
- **Host-neutral wording.** The canvas, layer names (`AI · 第1次`), exported SVG layers and tool descriptions say AI instead of GPT/ChatGPT. Existing layer names and saved marks are unchanged.
- The canvas and Store declare `availableDisplayModes` in `ui/initialize`, so hosts allow full screen.
- 401 responses carry `WWW-Authenticate: Bearer resource_metadata=…` for OAuth discovery.
- Tests: `tests/oauth.test.js`, `tests/result-budget.test.js`.

## 0.19.5 — Several calculator windows

- A surface can hold up to four calculator windows, each with its own notebook (`maxInstances` 4); extra windows are titled 科學計算機 2, 3, 4 and close independently without losing data.
- A second *independent Graph viewport inside one surface* is not part of this change: the canvas viewer is a single-instance component. For an independent Graph, plot into a new canvas (`newCanvas`), which opens its own surface.
- Tests: `tests/surface.test.js`, `tests/workbench-e2e.test.js` (browser).

## 0.19.4 — Notebooks and layouts travel in `.estampes`

- `export_workspace_bundle` adds `surface.json` (open panels, per-device layouts) and `notebooks/<n>.json` (definitions, cells, Graph links) when the workspace has a surface. The format stays `estampes.bundle/1`; the files are optional, so older readers ignore them.
- `import_workspace_bundle` rebuilds them from known fields under new ids and never overwrites. Calculator results come in **stale** (a file cannot prove SymPy computed them) with their Graph links marked stale; press 重算 or 更新所有連結. Links are remapped to the imported images. Limits: 20 notebooks, 200 cells each, bounded sizes.
- Tests: `tests/bundle-extras.test.js`.

## 0.19.3 — Links follow their cells

- Plots made from calculator cells can be refreshed: **更新所有連結** recomputes stale cells and redraws their Graph plots (`refresh_links`, widget only). Turn on **自動更新 Graph** (`set_options autoRefresh`) and a changed definition or assumption does it for you. A link remembers its plot domain; a plot you deleted is reported, not recreated; a cell that cannot be recomputed keeps its stale links.
- Tests: `tests/surface-refresh.test.js`, browser step in `tests/workbench-e2e.test.js`. The cancel tests use an integral that stays slow, so they no longer depend on machine speed.

## 0.19.2 — Open the calculator from the model

- `manage_surface_panels` now shows the Visual Surface. It had no widget, so a model that ran `org.estampes.cas` through `execute_module` left the user with the sample landscape and no calculator. Give it an `imageId` to open the calculator beside that canvas; with none, the calculator opens alone. `notebook` attaches the calculation the model already made. `execute_module` results that are not on a canvas now tell the model to call it.
- Fix: the widget's `define` call was refused (`by` was not in the schema); definitions typed in the panel now work.
- Tests: `tests/surface-open.test.js`.

## 0.19.1 — Stop a calculation

- Calculator panel: **停止** cancels a running calculation or recompute. `calculate` and `recompute` accept a `job` id; new widget-only tool `surface_cas_cancel`. A cancelled calculation leaves no cell and no error behind; the service remembers a cancel that arrives before the job starts.

## 0.19.0 — Workbench UI

- The Visual Surface widget is now a workbench: the canvas and the SymPy calculator are panels you can move, resize, dock, minimise and maximise inside the widget; phones get tabs; each device profile keeps its own layout (also by keyboard: Alt+Arrows). No pop-out, no second page.
- **Calculator panel**: operations, text or LaTeX input, exact results typeset as MathML, approximate values, warnings, status, definitions and assumptions, **畫在 Graph** with links that go stale when upstream definitions change, recompute, edit, copy LaTeX/text. Everything is built with DOM APIs (no `innerHTML`).
- Browser test `tests/workbench-e2e.test.js` (real server, real SymPy, real widget, fake host) runs in CI with screenshots. A live ChatGPT host test has not been executed. See [docs/WORKBENCH.md](docs/WORKBENCH.md).

## 0.18.0 — Surface and panels (server side)

- **`estampes.surface/1`**: a shared, persistent record of which panels are open on a canvas and one layout per device profile (desktop, tablet, mobile), stored in `<storage>/surfaces`. Panel geometry is in surface units, always reachable, snapped and size-limited; layouts are revision-checked and idempotent, and a change to one profile never rewrites another.
- **`estampes.panel/1`**: modules may declare panels (`panels` in the manifest) naming a built-in renderer kind and the capabilities it may trigger; no HTML, script or CSS can come from a manifest. Graph and the calculator declare theirs. Opening a panel never enables a module.
- New tools: `get_surface_state` and `manage_surface_panels` (model), `surface_get_state`, `surface_apply`, `surface_cas` (widget only). See [docs/SURFACES.md](docs/SURFACES.md).
- Fix: starting or checking a background job on a canvas now hands the widget that canvas, so it shows the real image instead of its sample picture; `get_module_job` shows the canvas with the finished result.

## 0.17.0 — Scientific CAS (SymPy)

- **`org.estampes.cas`, a built-in module backed by SymPy.** Exact arithmetic, simplify/expand/factor/collect/cancel/apart/trigsimp, derivatives, definite and indefinite integrals, limits, series, sums, equations and systems (`solve`, `solve_system`, `nsolve`), substitution, matrices, definitions (`f(x) = ...`), assumptions, degrees and radians, and a chosen numeric precision. Every result carries a status (exact, approximate, complex, conditional, partial, undefined), plain text, LaTeX, a typed AST (`estampes.math-ast/1`) and the SymPy version. Input may be text or LaTeX.
- **No `eval` on user input.** Text and LaTeX go through a closed parser that only knows numbers, names, operators and an allowlist of functions; the Python side validates the AST again and maps only allowlisted nodes to SymPy. Python-shaped input is a syntax error before anything runs.
- **Separate, locked-down service** (`cas-service/`, `cas` in `compose.yaml`): no network, read-only filesystem, no capabilities, reachable only through a Unix socket on one shared volume (mode 0600, peer uid checked). Each calculation runs in a forked child with CPU, memory and wall-clock limits; a timeout or cancel kills it. If the service is down, only calculations fail.
- **Notebooks** (`<storage>/cas/notebooks`): cells keep their input, result and Graph links; definitions and assumptions apply to the whole notebook and make older results stale; writes are atomic and revision-checked, with idempotency keys.
- **Plot in Graph.** `plot_result` turns an exact or approximate real single-variable result into an editable `function-plot` through a typed AST-to-expression translator. Conditional, partial, complex or multivariable results are refused and change nothing; a stale result must be recomputed first; a plot made from a result can be refreshed in place.
- New permission `cas.compute`. `/healthz` reports calculator availability.

## 0.16.0 — Plate solving and background jobs

- **Background jobs.** A capability can be marked `async`: it returns a job id at once and runs in the background (`limits.jobMs`, default 10 minutes). The new fixed tool `get_module_job` shows its status and result, optionally waiting up to 25 seconds. Jobs survive in `<storage>/modules/jobs.json`; one interrupted by a restart is shown as such. A stopped job never applies a late result.
- **Plate solving** (`org.estampes.astrometry`, built in): uploads the chosen image to Astrometry.net with the administrator's API key, waits for the solution, marks the named objects on the canvas and reports the field's centre, scale and rotation. Setup in [docs/MODULES.md](docs/MODULES.md#plate-solving-orgestampesastrometry).
- Egress requests can now carry a form, a multipart body with the image's bytes (needs `asset.read.selected`) and `${secret:name}` tokens; the request limit is 25 MB.

## 0.15.0 — Controlled network access for modules

- **`http` modules** describe a request to an approved external service and how to turn its JSON reply into scene operations; they contain no code. All requests go through one egress service: only hosts listed in the manifest, https on 443, public addresses only (loopback, private, link-local and metadata ranges refused, connection pinned to the checked address), no redirects, fixed headers, time and size limits, and an audit record of every request (never its content). Enabling such a module needs administrator approval.
- **Secrets.** API keys are set by the administrator (`estampes-module.js secret set <moduleId> <name>`, value from standard input) and added to requests by the server for declared secrets only; modules cannot read them and they never reach the audit log. Example: `examples/modules/ocr-http`.
- Installing an http module sends nothing; its self-test only checks the requests its examples would make.

## 0.14.0 — Module author tools

- `scripts/estampes-module.js init <dir> <id> [--runtime declarative|wasm]` starts a new module (manifest, a working example, README) and `test <module.json>` validates the manifest and runs its examples the way an install would, so a package is checked before it is packed and signed. See [Writing a module](docs/MODULES.md#writing-a-module).

## 0.13.0 — WebAssembly runtime

- **Isolated WebAssembly modules.** A signed package can carry one `.wasm` file (`estampes.wasm/1`). It must import nothing, so it has no clock, files, network or host functions. Each call runs in its own child process with a time limit (the process is killed), a memory limit (the binary must declare a maximum within `limits.memoryMb`, checked before it ever runs) and an output limit; results go through the usual scene-operation checks. See [Modules](docs/MODULES.md#webassembly-modules) and `examples/modules/wasm-hello`.

## 0.12.0 — Managed module packages

- **Install modules from signed packages.** A package is one JSON file (`estampes.package/1`: manifest, data files, ed25519 signature) that the administrator places in `<storage>/modules/inbox/`. There is no archive format, no download from URLs and no npm, so nothing to unzip or fetch. Installing checks size and path limits, the manifest, the Estampes version and runtime, the sha256 digest, and a signature by a trusted key whose scope covers the module id (`trusted-keys.json`); unsigned packages need `ESTAMPES_MODULE_ALLOW_UNSIGNED=1` and are always high risk.
- **Transactional lifecycle:** install, update, rollback, uninstall and purge. Verified bytes go to an immutable store (`packages/<id>/<version>/`), the module's own examples run as a self-test on a throwaway canvas, and only then is the version activated and recorded in `lock.json`. Every version is kept, rollback restores the exact earlier bytes (also restoring its permissions) and is checked against the lock, and a package whose stored files no longer match is refused at startup. An update that asks for more permissions shows the difference first and never inherits them silently.
- **Separate administrator approval.** Installs, updates and purges need the administrator on the server, not just the user's click: `node scripts/estampes-module.js approve <planId>` proves knowledge of `<storage>/admin-key`, which is separate from the connector key and never passes through the chat. The approval is a single-use file that is consumed on first use, whether or not it is valid.
- `scripts/estampes-module.js` also makes keys, packs and verifies packages, trusts publisher keys for module id prefixes, and lists the inbox. Example: `examples/modules/callout`.
- Declarative modules (scene-operation templates with `$param` placeholders, no code) can be installed.

## 0.11.0 — Analysis engines, workspaces and bundles

- `detect_features`: analysis engines (`components`, `blobs`, `lines`, `circles`, optional `ocr` when tesseract.js is installed) return structured candidate detections with geometry, attributes and a ready mark; engines never write to the canvas. `docs/IMAGE-CAPABILITIES.md` maps every item of the image-preprocessing catalogue to done, plugin, external or later. See [Analysis engines](docs/IMAGE-PIPELINE.md).
- Workspaces ([docs/WORKSPACES.md](docs/WORKSPACES.md)): any number of images in one place, each with its own marks, layers and coordinates. New tools `create_workspace`, `edit_workspace`, `merge_workspaces`, `split_workspace`, `undo_workspace_change` and `get_workspace_state`, and `GET /api/v1/workspaces/<hex>`.
- Merge, split, move, copy and link are non-destructive: they change which canvases a workspace shows, never flatten images, and never delete an image or a mark. Linked marks are shared with the original canvas; copies remember their source. Each change previews first, is checked against the revision it was planned on, can be retried with an idempotency key, is read back and verified against the plan, and can be undone.
- `present_visual { workspaceId }` shows a workspace in the canvas: three or more images side by side (placement and 90° rotation respected), each with its own marks, layers, links and claims; the user can draw, select, move, edit layers and review claims on every image.
- A single canvas or a paired view can be read, merged or split as a workspace without converting it.
- `.estampes` bundles: `export_workspace_bundle` and `import_workspace_bundle` carry a workspace to another server or device as one ZIP (images, marks, layers, claims and links as editable data, with checksums). Import validates everything, never overwrites an existing canvas, is idempotent, and verifies the result against the bundle's totals. `GET /export/ws/<hex>/workspace.estampes` is signed like the other exports.
- Paired-view links are now stored per annotation set, so they also show in workspaces (existing stored links are read unchanged).

## 0.10.1 — PDF pages

- `render_pdf_page`: render one physical PDF page at 36–600 dpi as an ordinary image, with the printed page label, optional embedded text boxes (no OCR needed), and storage of the PDF so a page can be rendered again by hash. Optional: needs `pdfjs-dist` and `@napi-rs/canvas` (`--build-arg ESTAMPES_WITH_PDF=1` for Docker); without them the tool reports it is unavailable. See [PDF pages](docs/IMAGE-PIPELINE.md#pdf-pages).

## 0.10.0 — Modules and the Store

- **Module system, phase 0 and 1.** A module is described by an `estampes.module/1` manifest (capabilities with strict input schemas, permissions, limits) and returns *scene operations* instead of drawing: `object.create`, `object.update`, `object.delete`, `object.publish`. The core validates every batch, applies it all or nothing, assigns ids, records provenance and bumps a per-canvas scene revision. Modules change only their own objects; the user can change anything. See [Modules](docs/MODULES.md).
- **Scene objects** keep their meaning instead of becoming pixels: `axes-2d`, `function-plot` (expression, domain, frame) and generic `shape`. A trusted renderer turns them into drawing primitives for the canvas, the layered SVG export and the preview image. Objects are saved in `canvas.json`, appear in `get_visual_state` (`objects`, `sceneRevisions`) and live in their own layers.
- **Safe expressions.** Formulas are tokenized and parsed by Estampes's own parser (numbers, `+ - * / ^`, implicit multiplication, `|x|`, constants, a fixed function list); there is no `eval`, and anything else is refused with the position of the problem.
- **Built-in Graph module** (`org.estampes.graph`): `plot_function`, `update_plot`, `set_axes`, `plot_points`. `sin(x)` on a new blank canvas keeps its formula; changing it to `sin(2x)` re-computes the curve, from GPT or from a field under the canvas.
- **Estampes Store** (`open_module_store`): an MCP Apps widget with browse, search, detail, permission preview, enable and disable, and an activity tab. Enabling needs a plan the user confirms in the widget (a consent token the model never sees); everything is audited in `<storage>/modules/audit.jsonl`, and module state in `registry.json`.
- Five fixed model tools (`open_module_store`, `list_modules`, `get_module_capabilities`, `execute_module`, `prepare_module_change`), so enabling a module never changes the tool list. Blank canvases are ordinary images, so storage, export and zoom work unchanged.

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

## 0.8.0 — Claims, evidence and verification

- Every note GPT puts on a mark and every link is a claim with three separate parts: GPT's `confidence` (only orders review), `evidence` (what it saw, the kind of clue, and the region on which image, always recorded as the model's own observation) and a verification state that only you, or a tool's evidence, can change.
- Every unverified claim waits for you, not just low-confidence links. Each piece of evidence zooms to its region. GPT's notes on marks can be confirmed or rejected too (`review_visual_finding`), with an optional reason, and withdrawn.
- Rejected claims are remembered apart from their marks, so they survive deleting, redrawing and reset. GPT repeating one at the same place without a new kind of evidence is refused and told why.
- `estampes.visual/2` ([Visual protocol 2](docs/PROTOCOL-V2.md)); version 1 documents are still read.
- Arrows no longer mean "the head is the target" by default. The canvas's default purpose is now free annotation: each arrow is sent with `semanticHint: "unspecified"` and its direction (heading and angle in image pixels), and GPT reads the meaning from your note, so "I think the current flows this way" is discussed as a direction. Only the 「只是指出這裡」 purpose makes the head the referent, and a note that says otherwise still wins. See [What your marks mean](docs/TOOLS.md#what-your-marks-mean).
- Strokes that belong together are recognised without being merged. Each stroke you draw records its order, time since the first stroke of the send and input device; Estampes proposes candidate gesture groups (for example a freehand arrow drawn as a shaft plus a head, with its direction) and labels them as unconfirmed guesses for GPT. Below the canvas you can confirm or reject a candidate, or group and ungroup strokes yourself (`review_gesture_group`); verdicts are saved with the canvas, and `get_visual_state` includes `gestureGroups`.
- New docs: `docs/USAGE.md`, `docs/TOOLS.md`; `docs/ARCHITECTURE.md` rewritten to describe the current system.
- Licensed under the Mozilla Public License 2.0 (`LICENSE`, `package.json`).

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
