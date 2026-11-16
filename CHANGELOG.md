# Changelog

## Unreleased

- Surface widget (UVA Phase 3, PR-3B-2, first part): the widget now polls `documents_get_changes` about every 2 s while visible, at once on focus, on becoming visible and after any finished tool call, through one shared `DocumentStore`. A polled snapshot replaces only what the server owns (other authors' marks, layers, objects, gesture verdicts, links); unsent marks, camera, tool and selection are never touched, a snapshot that changes nothing does not rebuild the view, and one that arrives while the user is dragging, drawing or typing waits for a later tick. Paired views are not polled yet. Not yet done: lost-ACK lookup by command id, restore-after-recreate audit, de-duplication by result id.
- Surface widget (UVA Phase 3, PR-3B-1): new app-only `documents_get_changes` poll tool (up to 12 documents, answers unchanged / snapshot / gap / missing) with ordered `{epoch, counter, hash}` revisions next to the canvas content hash, and a shared widget `DocumentStore` (get / subscribe / hydrate / reconcile / release) whose rules ignore older or duplicate revisions, treat a same-revision different-hash answer as an integrity error, and keep the last snapshot marked stale when offline. Nothing polls yet; the scheduler, host de-duplication and restore are PR-3B-2.

## 0.20.1 — Surface viewers, workspace and module fixes

- Module gaps from the acceptance run: `{"$calc": …, "with": …}` arithmetic in
  templates (Estampes's own expression parser, never JavaScript); declarative
  http modules can upload the target canvas's original image with
  `request.multipart.file` (`source: "canvas-image"`, needs
  `asset.read.selected`), with reference module `examples/modules/regions`;
  `estampes-module try` runs one capability offline on a scratch canvas or
  your own picture and writes a PNG of the result.
- Module tests for http modules: an example can carry a `mockResponse` (a
  recorded reply: status and JSON or raw text), which `module test` and the
  install self-test run through the same response mapping a real call uses, so
  OCR/AI/API modules are tested end to end offline. A `$response` path missing
  from the mock reply is an error. Any example can state `expect` (operation
  count, a `data` pattern with float tolerance, `summary`, or the `error` it must
  fail with). `init --runtime http` writes a starter that passes as it is. Real
  calls are unchanged; fixtures are not shown to the model.
- Module distribution: publishers can host a signed index (`estampes.index/1`,
  built with `index`) next to their packages on a GitHub Release.
  Administrators `source add` it once, accept the key fingerprint explicitly
  (the key is then pinned for the publisher's id prefixes), and `source sync`
  brings the newest verified package of each module into the inbox. `fetch
  <url> [--sha256]` imports one release asset. Fetches are https-only, to
  public addresses, with checked redirects and size limits, and run only in
  the administrator CLI; installing still needs the user's and the
  administrator's approval. See docs/modules/DISTRIBUTION.md.
- Module templates: `{"$each": …, "do": …}` makes one object (or row) per item
  of an input or reply list, with `$item`, `$index` and `"as": "string"`. A
  WebAssembly module can refuse a call with `{"error": "…"}`. Docs now list
  every object property and the WebAssembly request contents.
- External-developer acceptance (docs/modules/ACCEPTANCE.md): three reference
  modules (`markers` declarative, `linefit` WebAssembly least squares,
  `keywords` http analysis service) run from a clean folder through test, sign,
  source, install, enable and run in CI. The recorded run was an internal
  clean-room run; an outside developer's run is still open.
- Surface widget (UVA Phase 3, PR-3A-2): extra viewers can be mounted next to the page viewer in an open shadow root (`window.estampesSurface.mountViewer`), each with its own camera, tool, selection, pointers and keys (a key goes only to the viewer it was typed in). `dispose()` cancels gestures, clears timers and frames, drops late host answers and removes listeners and its DOM; a resize ends a stroke in progress. The layout code (`public/workbench.js`) and the calculator panels (`public/calculator.js`) are now separate sources, inlined in the same order as before. New browser tests mount two viewers (different images and the same image twice). Real-host behaviour is not verified by the fake host.
- Workspaces: a merge, split or move (and its undo) changes two workspaces as
  one unit. It is written first as one durable intent and rolled forward on the
  next start or by the retry timer, so a crash or a failed write no longer
  leaves one workspace changed and the other not (architecture review A04).
  Reads of a workspace with an unfinished intent return the intent's value.
- Workbench: a layout or panel change that hit a revision conflict retried
  behind itself in the change queue, so it never finished and every later
  move, resize, open or close in that widget waited forever (architecture
  review A09). The retry now runs inside the same queued change.
- Calculator plots: a canvas that cannot be read during a refresh (a storage
  error) no longer marks the plot's link "removed" for good; the link stays
  stale and is retried on the next refresh. Only a canvas that was read and
  lacks the plot counts as deleted. Saving a new plot's link to its notebook
  is retried on a passing error (architecture review A08).

- Image, bundle, PDF and OAuth client-metadata downloads now check the address
  the connection actually uses, on every redirect hop, with the same address
  policy as module egress (architecture review A07). Before, a hostname was
  resolved and checked, and `fetch()` then resolved it again for the
  connection, so DNS rebinding could reach a private address. The early check
  now also refuses the extra reserved ranges egress already refused
  (documentation, NAT64, 6to4, Teredo).

- Backup and restore cover both data roots (architecture review A01). With the
  default UVA store, images, canvases, workspaces, surfaces and notebooks live
  in the store (`/uva-beta`), not in `/data`, and pending records are deleted
  once committed, so the documented `/data`-only backup lost committed work.
  `docs/BACKUP-RESTORE.md` now archives and restores both volumes (with the
  ownership and mode the store needs) and explains rolling back to a release
  that cannot read the store. `scripts/verify-backup-restore.mjs` checks both
  roots, with changes still pending and after they were committed, and that a
  `/data`-only archive is not enough; `npm test` runs it.
  `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md` and `compose.yaml` no longer say
  legacy files are kept up to date in UVA mode.

- Calculator: a result is published as fresh only if the notebook's
  definitions, assumptions, angle and precision are still the ones it was
  computed with; a definition changed during the calculation leaves the result
  stale (so it cannot be plotted until recomputed), also for `recompute`
  (architecture review A02). Overlapping `calculate` calls with the same
  `idempotencyKey` on one notebook now compute once and add one cell; the
  others are replays.

- A canvas save that fails (UVA store) no longer leaves the failed change in
  memory (architecture review A03). Before, a refused `present_visual`,
  `execute_module` or object edit stayed visible to later reads, with the
  scene revision already raised, and the next successful save persisted it.
  The canvas now goes back to its last durable state before the error is
  returned. When a later save of the same canvas was already under way, the
  earlier call reports that save's outcome, since it carries the same change.

- Bundle import: a canvas is reused only when it holds the same marks, layers,
  claims, scene objects (Graph axes, plots, shapes) and link content as the
  bundle; before, a changed Graph was reused and reported `verified: true`
  while it still showed the local scene (architecture review A05). A canvas
  holding only scene objects no longer counts as empty, so a restore never
  replaces it; `verified` now also checks every imported set's scene objects
  (`mismatch` lists `objects` otherwise), and a layer's owning module is kept
  through export/import. Comparison ignores key order, so identical canvases
  are now reused instead of copied.

- Module registry: an enable/disable whose `registry.json` write fails no
  longer leaves the module in the new state in memory, and one failed write no
  longer makes every later save fail until a restart (architecture review A06).
  A change is published only after its file is written; queued writes each
  report their own outcome.

- Canvas text entry (#82): select a user annotation to edit/clear its label and
  multiline note, or choose Text to place an editable standalone vector object.
  Text supports dragging, size/color, locked layers, revision checks and its own
  persistent undo/redo, including rotated workspace copies. Changed notes drop
  old evidence/review; source geometry and creator provenance are preserved.

- Surface widget (UVA Phase 3, PR-3A-1): the viewer is now a factory (`createViewer`) over one `HostBridge` that owns the host conversation (requests, handshake, `window.openai` globals); the viewer markup lives in a `<template>`, keyboard handling is routed to the focused viewer only. Behaviour is unchanged for the single viewer (all browser E2E pass untouched); this is the groundwork for several viewers in one widget.
- `register_images` (#68): automatic registration now aligns oblique, defocused,
  unevenly lit views turned by any angle, where it gave up before. It keeps five
  feature scales, votes on the common rotation, and then matches again near the
  rough transform (guided matching), so repeated structure such as rows of pins
  no longer drops out at the ratio test. On a synthetic board with known
  transforms (rotation 10-290 degrees, scale 0.7-1.25, strong perspective,
  gamma, vignetting, blur, noise, JPEG, glare) the old matcher aligned 11 of 21
  to within 6 px and reported the other 10 as failed or, for two, as ok at
  6-6.5 px; the new one aligned 21, 19 and 20 of 21 on three random boards, every
  accepted one within 6.5 px, and accepted none of 40 unrelated boards. One
  strongly tilted, shrunk case still fails (it reports failed, not a wrong fit).
  Acceptance now compares the supporters with what shifted copies of the
  transform reach by chance (`quality.chanceInliers`), and a fit that mirrors the
  image is refused with a hint. The inlier ratio is now the share of A's features
  inside B that found a partner, not inliers over putative matches, so it is
  lower than before for good fits (0.1-0.35 on hard pairs, `minInlierRatio` is
  optional and no longer defaults to 0.25).
- `register_images` result: `quality.heldOut` (error at points the fit did not use:
  leave-one-out for landmarks, split-half for auto) and `alignmentConfidence`
  (`high`/`medium`/`low`/`unverified`/`none`) with `confidenceReasons`, separate
  from `status`. Four landmarks always fit a homography exactly and now rate
  `unverified`; landmarks in one corner, a landmark that does not fit, or a
  held-out error above the threshold lower it. `REGISTER_VERSION` is "2", so
  registration ids change. Only a synthetic board was tested; the PCB photographs
  of #68 are not in the repository.

- Keep a locally uploaded photo visible when the host replays the original
  waiting-for-upload result through notifications or ChatGPT globals (#66).
  Changed host output or metadata still updates the canvas. Browser tests
  cover desktop/mobile replay, large portraits, repeated uploads and failures.

- Added `get_visual_layers` and `edit_visual_layers` for assistant layer opacity,
  visibility and ordering, with revision checks, lock protection and persistent
  appearance undo/redo. The canvas visibility checkbox now updates shared state;
  rendering and portable exports preserve it, including fully transparent layers.

- Internal: the server's mark drawing (`markSvg`, verification crops and the
  canvas render) now draws from the shared RenderPlan (`src/visual/`) instead of
  its own copy of the ink rules. Output is unchanged byte for byte, checked
  against a fixture captured before the switch (`tests/visual-render-golden.test.js`).
- `present_visual` takes `dryRun: true` (one image's canvas): it runs every
  check of a real call (locked layers, stale `ifMatch`, invalid marks) and
  reports the refusal, or what would change, without saving anything (#72).
- A `CONFLICT` refusal now includes the mark's current note, status and place
  and the etag to pass on a retry, so the assistant can decide without another
  read (#74).
- `detect_features` on processed views (#115): pass `derivedViewId` and the
  engine reads that view's pixels (after its geometry and ops, before the
  delivery resize and codec) instead of the source. Before, detection always
  read source pixels, whatever `process_image` had done. Detections carry image
  coordinates and `view` pixel coordinates from the view's own mapping; under
  rotation or perspective a box becomes a four-corner `polygon` and a
  closed-polyline mark, and detections in a view's fill are flagged
  `outsideSource`. A view of another image, an unknown or stale view, or
  `region`/`sampling` together with a view is refused. Calls without
  `derivedViewId` are unchanged.
- New engine `regions` and segmentation primitives (part of #117,
  `src/image/segment.js`): exact Euclidean distance transform, shape-based
  splitting of touching blobs (a watershed of the distance transform with a
  depth criterion), hole filling, per-region statistics (area, Crofton
  perimeter, equivalent diameter, second-moment axes, eccentricity,
  circularity, frame contact) and pixel-edge outlines simplified to closed
  polylines. Split regions say which blob they came from and how weak the
  split is; every region is unverified. Real units appear only with a
  `calibrate_scale` for the space the engine ran in. Not included yet:
  seeded watershed from user markers, mask boolean operations, the optical
  density transform, and a persistent editable region set (#116).
- Fix (#74): stale edits no longer overwrite silently. Every mark in
  `get_visual_state` / `get_workspace_state` carries an `etag`; pass it back as
  `ifMatch` on an `annotations` or `findings` entry of `present_visual`. If the
  mark changed since (another conversation, or the user), the whole call is
  refused with `CONFLICT` (error text ends with `[CONFLICT]`) and nothing is written. Without `ifMatch` the old
  last-write-wins behaviour is unchanged.
- Hardening (#72): every refusal to touch a locked layer carries the code
  `LAYER_LOCKED`, and importing marks no longer overwrites a mark in a locked
  layer. Tests now cover each write path (annotations, remove, new marks into
  a locked layer, user move/delete, batches, reset, import). Policy, unchanged
  and now documented in tests: notes and status (findings) may still be
  attached to a locked mark; geometry, style and deletion may not.
- Integrity (#71): a link the user confirmed stays attached when an end mark
  is moved or reshaped, but its verification becomes `stale-confirmation`
  (shown in the canvas, with the confirm button again) until the user confirms
  it again. The geometry seen at confirmation is stored with the link and
  travels in bundles.

- The canvas's Undo / Redo buttons now also undo and redo edits you already
  sent (move, resize, restyle, relabel, delete of a mark), through
  `edit_visual_canvas` `history`. Each step restores the exact mark and is
  refused, with the reason, if the mark changed since or its layer is locked.
  The AI is told about an undo or redo on its next call. Layer edits (rename,
  lock, opacity, order) are not part of this history. History is kept in
  memory per image, up to 50 steps, and is not shown again after the widget
  reloads until the next edit.
- A server whose UVA store holds data but cannot open now exits with the reason
  instead of running on legacy files that lack what was saved to the store. A
  store that never held anything still falls back with a warning.
- Images, their canvases and workspace copies now live only in the UVA store
  when it is on: no `images/<hex>/` file is written. Each record holds the
  canvas, its change log, the image's metadata and its processed-view recipes;
  the image's bytes are a verified asset written durably before the upload is
  acknowledged. Images an older version stored move in, with their change log,
  the first time they are opened. `scripts/uva-to-legacy.mjs` now also writes
  images, canvases and copies back before switching to legacy. Fix: a
  workspace copy's change log was looked up in the wrong folder when migrated.
- Workspaces (with their change logs), panel layouts and calculator notebooks now live
  only in the UVA store when it is on: their modules read and write through it
  and no `workspaces/`, `surfaces/` or `cas/notebooks/` file is written. A save
  is acknowledged once its record is durable, and fails when it cannot be.
  Files an older version wrote are migrated in once, the first time they are
  read. With `ESTAMPES_CANVAS_STORE=legacy` nothing changes.
- Removed the UVA Beta editor (`experimental_workspace`, the app-only
  `uva_user_command`, the Workbench's UVA editor and `compose.uva-beta.yaml`)
  and the read-only canvas mirror (`ESTAMPES_UVA_BETA`, `ESTAMPES_UVA_MIRROR`).
  The UVA canvas store, which replaced both, is unchanged; `uva_store` remains
  the read-only view of it.
- Power-loss simulation for the UVA store (issue #91, `scripts/powerloss/`,
  docs/UVA-POWERLOSS.md). Every fsync is recorded and each crash point is
  rebuilt as a power cut could leave the folders. The store, or the whole
  server through its tools, must reopen with every acknowledged result and
  accept new writes. It found four gaps, all fixed:
  - a new UVA folder was not fsynced into its parent;
  - a first start interrupted by a power cut blocked the store forever (it is
    now started again when it carries the store's own `init.json` mark, under
    a lock that keeps a second process out; nothing in it was ever
    acknowledged);
  - uploaded images were answered before their files were fsynced;
  - an image whose legacy copy was lost had no fallback (it now comes back
    from the UVA asset store and the legacy file is repaired).
- Fix (#73): `import_workspace_bundle` is now all-or-nothing. A bundle with
  invalid marks, or whose manifest totals (items, marks, user marks) disagree
  with its content, is refused before any workspace is created. Pass
  `allowPartial: true` to import the valid part and see what was dropped.
- Fix (#75): re-using a mark id in `present_visual` changes only the fields the
  call states. Omitted `label`, `color`, `size`, `pen`, `note` and `status`
  keep their stored values; `label: ""` clears the label.
- UX (#76): each row of the layer panel shows the stable layer id (`L6`);
  clicking it copies the id.
- Fix: a canvas with an image layer (`add_image_layer`, a promoted base image
  or a copied canvas) made every result about it overflow the host's
  145,000-character limit (`add_image_layer`, `get_visual_state`,
  `get_workspace_state`, `present_visual` on its workspace, panels showing it).
  Image layers kept their whole PNG inline in each result. Results now carry a
  small preview of each layer and the canvas fetches the full PNG itself
  (`load_visual_pixels` with `object`); `get_visual_state` and
  `get_workspace_state` list image layers without their pixels
  (`props.pixels.omitted`, read them with `render_canvas`). Stored canvases are
  unchanged.
- Canvas store phase 5: the UVA store is the default. With
  `ESTAMPES_STORAGE_DIR` set, canvases, workspaces, panel layouts and notebooks
  are committed to UVA without further settings: `compose.yaml` mounts the
  `uva-beta` volume at `/uva-beta` (the image's default folder), elsewhere
  the folder defaults to `<storage dir>-uva`, and the profile to
  `linux-process-crash-test` on Linux (survives a killed process, not a power
  loss; qualification #88, #89, #91 is still open). Existing data move in on
  first open. `ESTAMPES_CANVAS_STORE=legacy` switches back; the legacy files are
  still written. New read-only tool `uva_store` (status, list, open, render,
  export). The Beta editor (`experimental_workspace`) is now only offered with
  `ESTAMPES_UVA_BETA=1`. New names `ESTAMPES_UVA_DIR` and `ESTAMPES_UVA_PROFILE`;
  the `ESTAMPES_UVA_BETA_*` names are still read.
- Canvas store phase 4: workspaces, panel surfaces (layouts) and calculator
  notebooks are committed to UVA as record documents and restored from them, with
  the same durable pending copy, seq ordering and startup repair or adoption as
  canvases (`src/uva/record-store.js`). Bundle export waits until every changed
  record is recorded. The workspace audit log (`history.jsonl`) stays legacy.
- Canvas store phase 3: links between canvases (paired views, workspace links)
  and their reviews are stored as relation bindings in the UVA document instead of
  blocking the canvas; the link record is kept verbatim, so the canvas round-trips
  exactly. Workspace copies (`mode: copy`) are committed under their set key
  `img:<hex>#<setId>` and their set file is restored from UVA. Fixed on the way:
  mirror mode failed with "Expected finite JSON data" on a canvas whose in-memory
  link had an undefined field. The workspace record itself stays legacy.
- Canvas store phase 2: image layers go into UVA. Canvases with image objects
  (`add_image_layer`, a promoted base image, a copied canvas) used to stay in
  their pending file as blocked. Each inline PNG is now verified (decodes as PNG,
  canonical base64), stored once in the content-addressed asset folder and
  referenced from the document; restore rebuilds the canvas byte for byte. Moving
  or editing an image layer is an ordinary object commit. Mirror documents with a
  promoted base image (transparent background) can be rendered and exported, and
  exports carry every referenced image. Still blocked: links to other canvases
  and workspace copies (phase 3). Assets are not garbage-collected yet.
- UVA engine, compaction latency (#107): history compaction runs as single units
  (one GC step, ACK batch, prune, page sweep or GC plan of at most 256 files) instead
  of one pass every 64 commits, so a commit waits for at most one unit. Units run
  while the writer has been idle for 3 s (`compactionIdleMs`); under sustained
  load one runs after every 8 commits while there is work. Over 2500 back-to-back
  commits p99 fell from 27 s to 8.0 s and the worst commit from 56 s to 9.6 s.
- UVA engine, automatic history compaction (#106): the canvas store and mirror
  no longer have a lifetime commit limit. History that no recovery point,
  checkpoint or reader needs, and that is older than the 7-day ACK replay window,
  is retired every 64 commits; its files are deleted after the 1-day G2 grace.
  Over 2500 commits (25 simulated days) the store stayed at 13–18 MB, where 1915
  commits used to fill it. A forgotten request that is retried gets `CONFLICT`
  and never applies twice. `ESTAMPES_UVA_MIRROR_MAX_COMMITS` now defaults to 10000
  commits retained in the replay window. Also fixed on the way: the GC mark
  re-read every index page per recovery point, page reclamation paused whenever a
  GC plan was active, and a large GC plan could exceed the maintenance write
  budget and fence the writer. Design:
  docs/rfc/unified-visual-architecture/HISTORY-COMPACTION.md.
- UVA engine, long-running commit latency: a process that kept committing
  re-validated every version proof it had ever cached on each load, so commit
  time grew with the number of commits made in that process (551 ms to 1642 ms
  over 700 commits). Loads without history now keep only the proofs the next load
  needs (the live registry's versions and their delta bases). Settled transaction
  folders are listed once for the capacity walk. Over 1200 single-edit commits the
  p50 settles near 960 ms (was 1.6 s at 700 and rising). The canvas store's
  default commit budget rises from 1500 to 1800, just under the 1915 commits at
  which the 256 MiB quota refuses the next one. History compaction is still not
  built, so the budget remains a lifetime limit.
- UVA engine, G2 fix (#90): a GC plan could stall forever after the grace,
  returning `quarantining` on every step. Index pages and generation files are
  named by their content, so a later commit, or the plan's own publication, can
  write a candidate's path again; that candidate could then never be moved. Such a
  candidate is now released from the plan and kept. When the path is written
  again after the candidate was quarantined, the plan's copy is unlinked after
  the grace and the new live file stays, so the plan can finish. Grace, re-mark
  and unlink checks are unchanged. The failing store is kept as
  evidence, with a test that checks it. See
  docs/rfc/unified-visual-architecture/PR-1D-G2-ROOT-CAUSE.md.

- Canvas store, phase 1 (`ESTAMPES_CANVAS_STORE=uva`, Beta, default `legacy`): an
  image's own canvas is committed to its UVA document and restored from it. Each
  save is acknowledged only once it is written durably to `uva-pending/`, then
  committed in the background. Records are ordered by a per-image sequence
  number, not by clock; `canvas.json` is adopted only when it holds content no
  record knows (a save that bypassed the server) and is otherwise kept equal to
  the record. Marks,
  layers and objects are stored as document structure, with an exact patch for
  archived legacy fields, and every commit proves the canvas round-trips
  byte for byte. Legacy canvases migrate when opened; canvases with links or
  image layers stay pending and are reported. `canvas.json` is still written, so
  switching back is safe. The mirror commit budget default rises from 300 to 1500.
  See docs/UVA-BETA.md.

- UVA engine: unreachable index pages and commit roots are reclaimed every 32
  commits, after a mark of everything still reachable from CURRENT, retained and
  checkpoint roots, Ledger ACKs, crash evidence, backups and pins. Document history
  is never touched. A 256 MiB Beta store that used to fill at about 900 commits now
  holds 1000 commits in 73 MB, and a 100-kill SIGKILL run still left no store
  read-only and no ACK lost. New maintenance action `reclaimPages`.

- UVA engine, second pass (owner-authorized, from profiling a 300-commit store).
  Open no longer re-checks every ACK against its historical registry or rebuilds
  the Documents of every retained recovery point, and it walks the tree once.
  Commits no longer rewrite all 20 recovery resolver rows, re-read whole indices or
  lstat every history file for capacity admission, and they do not slow down the
  longer a process runs. At 300 commits cold start is 3.7 s (was 8.7 s) and a
  commit 1.1 s (was 2.2 s); at about 920 commits, 4.9 s and 1.2–1.3 s. New index
  pages per commit fall from 31 to 12.

- UVA storage engine rework (owner-authorized change to the sealed engine). Crash
  leftovers that can never have been published are closed at open instead of
  leaving the store read-only (180 SIGKILLs, no wedge, no lost ACK). Store-wide
  recovery points are bounded to the newest 20 plus named checkpoints, and open and
  commit no longer re-verify all history: at 300 commits cold start is 9.7 s (was
  over 30 s from about 200) and a commit about 2 s; disk per commit is constant.
  The mirror's commit budget default rises from 60 to 300.

- UVA durability qualification: `scripts/uva-qualify.mjs` (history, SIGKILL, full
  filesystem, export/recovery, many documents) and the measured results in
  `docs/UVA-BETA.md`. The mirror now stops at `ESTAMPES_UVA_MIRROR_MAX_COMMITS`
  commits (default 60), because a store with about 200 commits could not start within
  the engine's 30 s limit, and a UVA store that cannot start no longer stops the
  server.

- Opt-in UVA Experimental Beta: shared GPT/Workbench image workspaces, editable
  annotations and layers, existing visual-module execution, signed revision-safe
  CommitRoot transactions, explicit legacy copies and saved logical export/recovery.
- Legacy remains default. Beta uses separate storage, conservative limits and
  explicit profiles; production durability/performance qualification remains open.
- Fix: in ChatGPT the canvas view of an `experimental_workspace` result showed
  "timed out". ChatGPT puts the result on `window.openai` before the widget script
  runs; the widget applied it synchronously, reached the inlined UVA code before
  its declarations, threw, and never sent `ui/initialize`. The result is now
  applied after the script has finished, and every bridge request other than
  `ui/initialize` waits for the handshake. The browser test host can deliver
  results the ChatGPT way and refuses requests sent before the handshake.
- Fix: the canvas widget URI now also carries a hash of the HTML served
  (`visual-surface-vXYZ-<hash>.html`). ChatGPT caches templates by URI, so a widget
  fix without a version bump never reached it. The plain versioned URI stays
  registered for saved conversations.
- Fix: UVA `create`/`item.add` from `imageIds` start from the images' pixels only.
  An image whose legacy canvas had an image layer was refused with
  `UNSUPPORTED_TARGET` ("Legacy PNG object needs verified asset intake");
  migrating legacy marks and layers stays the job of `import`.
- UVA canvas mirror (`ESTAMPES_UVA_MIRROR=1`, default off): checkpoints of the
  ordinary canvas are copied, coalesced, into read-only UVA documents, so GPT reads
  the same marks and layers through `experimental_workspace`. The canvas stays the
  only writer. Measured cost of a UVA commit (about 136 KB, 0.3 to 0.7 s) is why it
  is a mirror and not yet the writer; see `docs/UVA-BETA.md`.
- Fix: inline in ChatGPT the UVA view collapsed to a thin strip. The host sizes
  the frame from the content, and the view capped its own height in `vh`, which
  shrank with the frame. The caps are now content-based (stage at least 480px).


The version in `package.json` is the single source of truth. Earlier milestone details are in [docs/history/](docs/history/README.md).


## Unreleased

- A server whose UVA store holds data but cannot open now exits with the reason
  instead of running on legacy files that lack what was saved to the store. A
  store that never held anything still falls back with a warning.
- Docs: `npm run docs:check` (`scripts/check-docs.mjs`, no install, no Docker) checks local links and anchors, duplicate headings and index entries, tool names against the registered tools, `ESTAMPES_*` names against the code, versions and image tags, statements known to be stale, and shell examples. Runs in `node-tests` and in a new light docs-only workflow; `docs/DOCUMENTATION-MAINTENANCE.md` explains it. It found and fixed an undocumented `ESTAMPES_TUNNEL_METRICS`.
- Docs: `docs/DEVELOPMENT.md` (setup, tests, code tour, public interfaces versus internals), `docs/modules/QUICKSTART.md` and `docs/modules/TESTING.md` (declarative, WebAssembly and http paths). New `tests/module-authoring.test.js` runs the author walkthrough for real (init, test, sign, trust, install with administrator approval, enable, run, refused input) and every bundled example module.
- Docs: `SECURITY.md` (single-owner security model, private vulnerability reporting), `docs/BACKUP-RESTORE.md` (what is stored, backup, restore into a new volume, upgrade, rollback, key rotation and leak response) and `docs/TROUBLESHOOTING.md`. New `scripts/verify-backup-restore.mjs` packs a storage folder with `tar`, restores it into another and compares what two servers report (canvases, marks, links, workspaces, module state, calculator notebooks). The Docker commands themselves were not run.
- Docs: `docs/QUICKSTART.md`, `docs/tutorials/` (annotate a photo, analyse a PDF page, plate-solve a sky photo, each with a success and a failure path) and `docs/COMPATIBILITY.md` (what is tested where; automated passes are not live ChatGPT tests). New `scripts/make-sample-material.mjs` writes the sample board image and two-page PDF the tutorials use.
- Release: the Docker workflow now really tags `latest` (stable `v*` tags only; the old `is_default_branch` condition was never true for a tag push) and runs a new pre-release check first. New `docs/RELEASE.md` and `npm run release:check` (`scripts/check-release.mjs`); DEPLOYMENT and README describe the tags that are actually produced.
- Docs consistency: WORKBENCH no longer says `.estampes` cannot carry notebooks and surfaces; USAGE separates working copy, detail tile and interpolated zoom; the surface/notebook bundle section moved under bundles in WORKSPACES; MODULES states what 0.19.5 implements; the two 0.10.0 entries are one release; zh-TW index de-duplicated and completed; CONTRIBUTING describes the project's real maturity.
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

## 0.19.8 — Smoother zoom and pan

- Zooming or panning a photo used to rebuild the whole scene on every frame: the photo was re-created (and its data URL decoded again) and every mark, layer list and panel was redrawn, dozens of times a second. Now the camera only moves the viewBox; the photo element is reused, and the full render runs at most every 140 ms while the camera moves (marks keep their on-screen size), plus once when it stops. A 40-event wheel burst went from 80 scene rebuilds to none.
- Tests: `tests/zoom-perf.test.js` (browser).

## 0.19.7 — Auto-refresh follows every change

- Auto-refresh used to run only for changes made in the calculator panel and only for the canvas on screen. Now the same follow-up runs for **any** change: the model's `execute_module` calls (`define`, `calculate`, `recompute`) report "Auto-refresh: recomputed N cell(s), redrew M plot(s)", and plots on **every** canvas a notebook is linked to are redrawn (before, a cell that turned fresh left its plots on other canvases stale for good).
- Turning auto-refresh on redraws links that are already stale.
- More than 20 stale cells are recomputed in rounds (up to 100); `refresh.remaining` reports what is left instead of leaving it silent.
- A plot you deleted is no longer retried and re-reported on every refresh: its link becomes **removed** ("圖形已刪除") and the cell offers 畫在 Graph again.
- Tests: `tests/surface-refresh.test.js`.

## 0.19.6 — A way back to the Graph

- With the calculator open alone (minimized or covered canvas), the launcher shows **＋ 函數圖／畫布**; it lays the windows out side by side again. It replaces the easy-to-miss 「還原：畫布」 chip.
- `manage_surface_panels open` on a panel that is already open just shows it instead of opening another window; more windows come from the launcher.
- Tests: `tests/surface-open.test.js`.

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

## 0.10.0 — Modules and the Store, geometry, registration and measurement

The 0.10.0 release combined two changes that were developed on separate branches (the modules branch was numbered 0.9.0 until it was merged and released as 0.10.0). No git tags exist yet, so the version history here follows `package.json` at each merge.

### Modules and the Store

- **Module system, phase 0 and 1.** A module is described by an `estampes.module/1` manifest (capabilities with strict input schemas, permissions, limits) and returns *scene operations* instead of drawing: `object.create`, `object.update`, `object.delete`, `object.publish`. The core validates every batch, applies it all or nothing, assigns ids, records provenance and bumps a per-canvas scene revision. Modules change only their own objects; the user can change anything. See [Modules](docs/MODULES.md).
- **Scene objects** keep their meaning instead of becoming pixels: `axes-2d`, `function-plot` (expression, domain, frame) and generic `shape`. A trusted renderer turns them into drawing primitives for the canvas, the layered SVG export and the preview image. Objects are saved in `canvas.json`, appear in `get_visual_state` (`objects`, `sceneRevisions`) and live in their own layers.
- **Safe expressions.** Formulas are tokenized and parsed by Estampes's own parser (numbers, `+ - * / ^`, implicit multiplication, `|x|`, constants, a fixed function list); there is no `eval`, and anything else is refused with the position of the problem.
- **Built-in Graph module** (`org.estampes.graph`): `plot_function`, `update_plot`, `set_axes`, `plot_points`. `sin(x)` on a new blank canvas keeps its formula; changing it to `sin(2x)` re-computes the curve, from GPT or from a field under the canvas.
- **Estampes Store** (`open_module_store`): an MCP Apps widget with browse, search, detail, permission preview, enable and disable, and an activity tab. Enabling needs a plan the user confirms in the widget (a consent token the model never sees); everything is audited in `<storage>/modules/audit.jsonl`, and module state in `registry.json`.
- Five fixed model tools (`open_module_store`, `list_modules`, `get_module_capabilities`, `execute_module`, `prepare_module_change`), so enabling a module never changes the tool list. Blank canvases are ordinary images, so storage, export and zoom work unchanged.

### Geometry, registration, quality and measurement

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
