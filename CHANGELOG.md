# Changelog

The version in `package.json` is the single source of truth. Earlier milestone details are in [docs/history/](docs/history/README.md).

## Unreleased

- `server.js` no longer names the calculator module (UVA Phase 5B-4b-3): the note the model gets after `execute_module` (auto-refresh of linked plots) comes from `afterRunNote` in `src/surface/refresh.js`, next to the rest of the calculator's surface code. No behaviour change. A manifest-declared hook, so a second producer gets the same without core code, is a separate design step.
- The calculator's notebook links no longer carry a status of their own (UVA Phase 5B-4b-2): a link now remembers only which plot it is and which revision of its cell it was drawn from (`cellRevision`); whether a plot is waiting is read from that revision, and the bindings hold the state. A deleted plot's link is dropped. Old links with a status are still read (never written), so earlier notebooks and adoption keep working; imported links count as out of date. `get_notebook` links therefore show `cellRevision` and no `status`. Sealed entries amended with a recorded authorization. In-process tests only; real ChatGPT/Claude not verified.
- The calculator's "refresh links" and auto-refresh use the core's derived refresh (UVA Phase 5B-4b, first step): stale cells are still recomputed first, then the plots made from them are redrawn by refreshing the stale bindings of each document (the one on screen, the ones the notebook's cells were drawn on, and ones the core's index knows, at most 8). That is the same rule as the Derived panel: a plot the person edited is paused and reported, a plot they deleted is reported once and not recreated, and an unreadable canvas leaves its plots stale to retry. Visible change: the refresh also redraws other stale derived objects on those documents, and the reasons come from the core ("edited by a person after it was last updated"). The notebook's own link records are still written. `surface/refresh.js` sealed entry amended with a recorded authorization. Tested with a real local server and calculator service, and in process with a fake calculator client; real ChatGPT/Claude not verified.
- Earlier calculator plots become bindings when their document is opened (UVA Phase 5B-4a; chosen by decision card on 2026-11-24): a module/2 capability may declare `derives.adopt`, a capability that names the objects the producer made before bindings existed; the core records them as bindings (stale ones as stale, ones a person had edited as edited), once per document per server run and without duplicates, and the calculator marks the links it adopted so a plot a person stopped following stays that way. The core names no module. Old links are still written; moving the surface refresh onto bindings and removing them is next. Sealed `manifest.js`, `router.js` and the calculator amended with a recorded authorization. Tested in process (stand-in module, and the real calculator module with a fake calculator service); real ChatGPT/Claude not verified.
- The widget shows derived objects and their choices (UVA Phase 5B-3c): under an object that a module made from a source, the objects panel shows its state (up to date, source changed, you edited it too, needs checking...) and offers 更新, 預覽變更 (shows the object as it is and what the source would write, changes nothing), 覆蓋我的修改 (only after a preview), 重新連結 and 停止連動. Each choice is sent with the hash the page was shown, so a stale page is refused, not applied. Sealed `visual-surface.html` amended with a recorded authorization. Tested with a real server, the real calculator and a fake host in a browser; real ChatGPT/Claude not verified.
- Bundles carry derived bindings (UVA Phase 5B-3b): export already wrote them into each set; import now reads them, keeps only those whose object arrives in the same set, and brings them in as `unresolved` (the module's source reference may not exist here under that name; reattach moves one to stale). Left-out entries are named in the import warnings. Sealed `bundle.js` amended with a recorded authorization. Tested in process (round trip, restart, tampered set); real ChatGPT/Claude not verified.
- Overwriting a person's edit needs a preview first (UVA Phase 5B-3a; chosen by decision card on 2026-11-24): `update_derived` has a new `preview` action that shows what the module would write and the object as it is now, changes nothing, and returns a one-time `previewToken`; `overwrite` is refused without the token of a preview made just before for the same binding and object. Also fixed: the derived flow's running-refresh and preview state now live on the host, because the server may build the tools again for every connection. Sealed `router.js`, `index.js`, `mcp-tools.js` amended with a recorded authorization. Tested in process and over a real local server with the calculator; the widget's buttons and bundles carrying bindings are the next steps; real ChatGPT/Claude not verified.
- A test now keeps the derived-binding code generic (UVA Phase 5B-2b-3c): `tests/derived-core-names-no-module.test.js` fails if the binding core, coordinator, index, broadcast, flow or the router's derived section names a module id, a capability or an object type. The calculator joined the contract without any of those files knowing it. Not done on purpose: the surface's own refresh still redraws plots from the notebook's graph links, because plots made before 5B-2b-3b have a link but no derived binding; it moves onto the derived path with the migration in 5B-4. Test only, no behaviour change.
- The calculator uses the derived-binding contract (UVA Phase 5B-2b-3b): it is now a built-in `estampes.module/2` module. A plot made from a cell is recorded as a derived object, the calculator tells the core which cells changed, and `refresh_plot` redraws one plot. Visible change: a plot the person edited by hand is no longer overwritten by an automatic refresh; the refresh reports it as failed with the reason and the edit stays (the 5B-0 test that pinned the old overwrite is flipped). The old notebook links are still written beside this. Not yet: the widget's choices for such a plot (5B-3) and moving the surface refresh onto the derived path (5B-2b-3c). Sealed `manifest.js` and `cas/index.js` amended with a recorded authorization. Tested with a real local server and calculator service; real ChatGPT/Claude not verified.
- Broadcasts reach every document that holds the module's bindings, and built-in modules may use a module/2 manifest (UVA Phase 5B-2b-3a; both chosen by decision card on 2026-11-23): the core keeps a small, self-healing index of which documents hold which module's bindings, so a capability that works on no document can still tell all of them that a source changed (at most 8 documents per call, the rest reported). Nothing declares this yet (the calculator moves in 5B-2b-3b), so existing behaviour is unchanged. Sealed `manifest.js`, `registry.js`, `router.js`, `index.js` and `mcp-tools.js` amended with a recorded authorization. In-process tests with stand-in modules; real ChatGPT/Claude not verified.
- Modules can make derived objects (UVA Phase 5B-2b-2; the contract was chosen by decision card on 2026-11-23, and the module broadcast was the user's suggestion): a `estampes.module/2` capability may declare `derives.refresh`, and its output may carry `derived` (the objects it made and their sources) and `broadcast` (a source of this module changed). The core records the bindings in the same save, marks only that module's own bindings stale on a broadcast, and refreshes by calling the declared refresh capability, which may touch only its own object and must report `data.sourceRevision`. Two new tools, `get_derived_bindings` and `update_derived`, read and act on bindings (64 tools now). A person's edit still pauses a refresh. The core names no module. Nothing in the repository declares `derives` yet (the calculator joins in 5B-2b-3), so existing modules and canvases are unchanged. Sealed `manifest.js`, `router.js` and `mcp-tools.js` amended with a recorded authorization. Tested in process with stand-in modules; real ChatGPT/Claude not verified.
- The derived-binding coordinator (UVA Phase 5B-2b-1): `src/documents/derived-coordinator.js` registers bindings, marks them stale when a source changes, refreshes them in bounded batches, pauses instead of overwriting an object a person edited (or anything changed by another route), reports a deleted object as removed, and carries out the person's choices with the hash check. It runs any producer handed to it as a function and names no module or object type. Nothing calls it outside tests yet, so no behaviour changes. In-process tests only.
- Derived bindings are stored with the canvas (UVA Phase 5B-2a; where they live was chosen by decision card on 2026-11-23): a canvas record carries a `derived` list next to its `links`, it maps into `document.bindings` and projects back unchanged, survives edits, restarts and a kill before commit, and a copy starts without them. An unreadable entry, or a live one whose object is gone, stays in the raw record instead of blocking the canvas. Nothing writes these bindings yet, so existing canvases are unchanged; this needs amendments to the sealed `legacy-shadow.js`, `storage.js` and `workspace.js` (recorded). Only in-process and real-server tests with a stand-in module name; not tried on a real ChatGPT or Claude host.
- Derived bindings, the generic record behind calculator-linked plots (UVA Phase 5B-1; the design, including replacing the calculator-only `cas-plot` kind with a module-agnostic `derived` kind, was approved 2026-11-21 with generality and stability as acceptance criteria): `src/documents/derived-binding.js` adds the schema, the state machine (every state x event and state x action cell is tested against a table written by hand), `expectedBindingHash` checking and the pause-on-user-edit rule (OD-05) as pure core code that names no module and no object type. `cas-plot` is removed from the document schema; nothing ever wrote one, so no stored document is affected. Nothing writes a derived binding yet and nothing reads one except document validation: the calculator is connected in 5B-2, and until then nothing changes for users. A document that contains a derived binding will not open in an older build (read-only recovery); back up before downgrading once 5B-2 ships. Sealed files `src/documents/schema.js` and `integrity.js` were amended with a recorded authorization. Tested at the schema, state-machine and document-validation level only; an older build was not run against such a document and no real host was involved. See docs/DERIVED-BINDINGS.md.
- UVA Phase 5B-0, a test only (no behaviour change): `tests/cas-user-edit-refresh.test.js` pins what happens today when a calculator-linked plot has been edited by hand and the notebook then refreshes automatically: the plot is redrawn from the notebook, the person's edit is lost, the link says fresh and nothing reports a conflict. This is the gap OD-05 (pause on user edit) closes; the assertions are marked GAP and are flipped in 5B-2. Tested through the module host and the surface tools on a local stack; the real ChatGPT/Claude hosts and the widget were not involved.
- Capability search (issue #244, PR-244-1, level L0 of progressive discovery; plan approved 2026-11-20): a new read-only MCP tool `search_capabilities` finds module capabilities by task. It ranks by keyword over ids, titles, descriptions and categories, returns small fixed rows (module, capability, summary, enabled, risk, target, `schemaHash`), is capped at 25 rows and 16 KB per page, and always reports `total`, `complete` and `nextCursor` (and `truncatedByBudget` when the size limit cut a page); a cursor from a changed catalog or another query is refused. `state` defaults to `enabled`; modules that are not enabled show up with `state: any` and are marked. Execution, permissions and approvals are unchanged: a search hit grants nothing. Module-authored text is cut and cleaned. Existing tools and their output are unchanged. Tested on synthetic catalogs of 10, 100 and 300 modules (a page is about 1,000 estimated tokens at every size, against about 98,000 for the 300-module manifests; top-5 recall 100% on planted topics) and over MCP on a real server; token counts are bytes/4 estimates, not a host's tokenizer, and no real ChatGPT/Claude host was involved. Not in this PR: reading one capability's contract, compact `list_modules`, the optional `keywords` manifest field (later PRs of #244).
- Module v2 rules for old modules and the person's edits (UVA Phase 5A, PR-5A-3): a v1 **package** module is now refused on a Graph document with `target-unsupported` (it was written for images), and a new document it asks for is always an image; built-in modules, including the Graph module, and v2 modules are not affected. A v2 module can no longer update or delete an object the person has edited (`provenance.editedByUser`): the call is refused with `user-edited` and nothing is applied; this is only the guard's interface, and the resolution flow (detach, overwrite or fork with a preview) comes with CAS bindings in 5B. An update plan now shows whether the signing key changed (`signer: {from, to, changed}`); a changed key makes the plan high risk with a note. Tests use the module host and router, not a real host; real ChatGPT/Claude not verified.
- Module manifest v2 runs, behind a flag (UVA Phase 5A, PR-5A-2): `ESTAMPES_MODULE_V2=on` (default off) lets `estampes.module/2` packages be installed and run. A v2 capability is given only the permissions it needs (the ones granted to the module that it lists in `needs`), a context that says what kind of document it works on with no image id, and cannot name another document: an input that contains the id of a different image, Graph or copy is refused with `cross-document` before the module runs. Install and update plans carry the ABI change (`new`, `same`, `upgrade`, `downgrade`, `removed`) and the module catalog shows `abi` and the document target. With the flag off a v2 package is refused with a reason and one that was installed earlier is marked failed at startup and not run; v1 modules, signatures and image behaviour are unchanged either way. Module source indexes still accept v1 only. Not in this PR: the v1 image adapter, Graph refusal for v1 modules, signer lineage and the guard for the person's own edits (5A-3). Tests use the module host and router, not a real host.
- Module manifest v2, format only (UVA Phase 5A, PR-5A-1, ADR-005 approved 2026-11-20): `estampes.module/2` is a strict manifest of its own. A capability names the document it works on (`target`: `none`, `document` or `document-or-new`) and the permissions it really `needs`, and `runtime.abi` is a required integer (this server supports ABI 1). The same permission rules as v1 apply to it (`needs` stays inside the module's permissions, a document target needs `canvas.write`, `document-or-new` also `workspace.write`), and the wasm and builtin runtimes are not available for v2. `abiChange` lets the Store say whether a module's ABI is new, the same, upgraded, downgraded or removed. Nothing runs a v2 module yet and nothing installs one: `validateManifest` refuses a v2 manifest unless the caller passes `v2: true`, and no caller does. v1 manifests, their signatures and their image behaviour are unchanged. Target context, the permission intersection and cross-document denial come in 5A-2, the v1 image adapter in 5A-3; the Store's ABI display waits for 5A-2, when a v2 package can be installed. Fake host not involved (no UI change). Real hosts not verified.
- Multilingual support, live test on ChatGPT Web (2026-11-20): Verified on live ChatGPT Web: Estampes in Automatic mode follows changes to the host app language between Traditional Chinese and English. The exact locale transport and raw locale tag were not independently captured. Also verified there: the manual Language override and its persistence across refresh, the localized sentence plus English block of the annotation message (the assistant parsed the event correctly in both languages), and default workspace, layer and split-copy names showing in the viewer's language with the stored names unchanged after a switch. Not yet verified: Claude as host, the locale transport and tag, known error sentences on a live host, bundle and restart round trips on a live host, documents made before keys existed, and the copy badge. See `docs/I18N.md` ("Verification status"). Fixed from the test: English counts now use singular and plural forms ("1 image", not "1 images") in the workspace caption, info card groups and the calculator refresh message. Layer names a module creates (Graph 「函數圖」, calculator 「科學計算機 (CAS)」) stay in the server's language; that is module runtime text, deferred to module translations (RFC §6.3), and nothing changed in the module architecture.
- Multilingual support, live test on ChatGPT Web (2026-11-20): Verified on live ChatGPT Web: Estampes in Automatic mode follows changes to the host app language between Traditional Chinese and English. The exact locale transport and raw locale tag were not independently captured. Also verified there: the manual Language override and its persistence across refresh, the localized sentence plus English block of the annotation message (the assistant parsed the event correctly in both languages), and default workspace, layer and split-copy names showing in the viewer's language with the stored names unchanged after a switch. A split copy's nested default name was verified the same way, and the widget's own locked-layer guard held (no server error appeared, so the `LAYER_LOCKED` sentence was not seen). Not yet verified: Claude as host, the locale transport and tag (including whether `_meta["openai/locale"]` reaches the server), a byte-for-byte comparison across locales, known error sentences on a live host, bundle and restart round trips on a live host, documents made before keys existed, renaming away a key on a live host, and the copy badge and suffix text. See `docs/I18N.md` ("Verification status"). Fixed from the test: English counts now use singular and plural forms ("1 image", not "1 images") in the workspace caption, info card groups and the calculator refresh message. Layer names a module creates (Graph 「函數圖」, calculator 「科學計算機 (CAS)」) stay in the server's language; that is module runtime text, deferred to module translations (RFC §6.3), and nothing changed in the module architecture.
- Provenance contract (docs only, plus a regression test): `provenance.method`, `capability` and `createdAt` of a scene object are written when it is created and never rewritten, so a plot made from a calculator result keeps naming the result it was first drawn from after auto-refresh redraws it. The result a plot currently follows is the `resultId` in the notebook cell's graph link. `tests/scene-ops.test.js` now pins this. Found in the 2026-11-20 live ChatGPT test; a separate “current result” record on the object would need an amendment of the sealed `legacy-shadow.js` provenance allowlist and is not done.
- Eraser (UVA Phase 4, closes the eraser item of the Phase 4 exit list, OD-02 whole-mark eraser): a new **橡皮擦** (Eraser) tool next to 手繪. Touching a mark, or dragging across several, deletes each whole mark; the drag looks at every few pixels between pointer samples, so a fast sweep does not skip a mark. It works on the AI's marks and yours, on images and Graphs, and a mark in a locked layer stays (the status line says why). Each delete is the same edit as Delete: sent marks go through `edit_visual_canvas` (so the AI is told what was erased), unsent ones are removed locally, and 上一步 undoes it. No new server tool or schema. Tested with a mouse in a browser; touch uses the same pointer events but was not tested separately. Fake host only; real ChatGPT/Claude hosts not verified.
- Graph anchors, model round trip (UVA Phase 4B, PR-4B-5): a browser test runs the whole loop on a Graph. The model draws one mark fixed to the axes and one pinned to a curve, the person drags one in the widget, and the model reads its new place in axis units. The model then changes the axes and the formula, and `get_visual_state`, the pixels of `render_canvas` and the reopened widget all show both marks at the same place. `present_visual` now tells the model when to use which anchor: none for page notes, `world` for data points and regions, `function-x` for features of one curve. It also tells the model what `anchor.status` ok, outside and invalid mean. A new “Anchors on a Graph” section in the usage guide (and a paragraph in the Traditional Chinese guide) explains the three buttons and the two notices. The same loop was run live in ChatGPT web on 2026-11-20 through the tools (data layer); the widget, `render_canvas` pixels and the reopened widget were checked only with the fake host. Real Claude hosts not verified.
- Marks pinned to a curve (UVA Phase 4B, PR-4B-4): a mark on a Graph can follow a function plot at an x value. The assistant asks for it with `anchor: {space: "function-x", plot}` and axis units; the person picks **Pin to curve** (固定在曲線) in the selection bar, next to **Pin to axes** and **Pin to page**. When the formula, domain or axes change, the mark moves with (x, f(x)) and keeps its offset and shape; moving it pins it again at its new x, and dragging it off the curve is refused (`OFF_CURVE`; `NO_CURVE` when pinning where no curve passes). When the plot is deleted or no longer defined at its x the mark is kept in place, still drawn, reported as `anchor.status: "invalid"` and listed under “Anchor lost” (錨點失效) until it is pinned again (reanchor) or pinned to the page (detach). A confirmed note on such a mark becomes a stale confirmation when its curve is re-defined (a new axes range does not count), and tool evidence no longer verifies a stale claim; confirming again clears it (new mark field `stale`, kept by bundles). Undo covers pinning to and from a curve. As in 4B-3, the anchor is a field of the canvas mark, not the UVA anchor schema, so the plan's preview hash for a reanchor does not apply. Live ChatGPT web test (2026-11-20, data layer only): the mark followed `update_plot` (x^2 to 2*x^2), went `outside` and recovered exactly, went `invalid` at a singularity (1/(x-2)) and recovered by itself, a confirmed note became a stale confirmation after `update_plot`, and the chain CAS define → automatic recompute → Graph refresh → anchor reprojection → stale claim worked. Not live-tested: deleting a plot or axes, re-pin, detach, undo, the Pin-to-curve button, and the 錨點失效 and stale-confirmation displays in the widget. Real Claude hosts not verified.
- Marks fixed to a Graph's axes (UVA Phase 4B, PR-4B-3): a mark on a Graph can follow the data instead of the page. The assistant asks for it per mark with `anchor: {space: "world"}` and coordinates in axis units; the person switches between **Pin to axes** and **Pin to page** (固定在座標 / 固定在畫面) in the selection bar. The default stays on the page (OD-02). Its place in axis units is kept with the mark and its canvas place is redrawn when the axes range or region changes; moving it on the canvas moves its axis place. Outside the axes range it is kept, not drawn (also not by `render_canvas`), reported as `anchor.status: "outside"` and listed under “Outside the axes range” (超出座標範圍) until the range includes it again; with its axes deleted it is `invalid` and stays put. The assistant is told when the person attaches or detaches a mark. Undo covers both a move of such a mark and switching it between axes and page, and a workspace bundle and a restored marks SVG keep the anchor (a malformed one is dropped, the mark kept); the downloadable marks SVG does not draw a mark outside the range. Axis units are kept at full precision, and the range check is relative to the range, so tiny ranges work. The person cannot drag or pin a mark fixed to the axes outside their range (`OUTSIDE_AXES`, “固定在座標的標記要留在座標範圍內”). `get_visual_state` marks carry `anchor` only when fixed to the axes. The anchor is stored as a field of the canvas mark; the UVA document still stores the mark's page geometry, and moving it to the UVA `world` anchor schema is left for later. Live ChatGPT web test (2026-11-20, data layer only): creating a Graph with page, axes and curve anchors, a human drag read back through `get_visual_state` (`editedByUser`, history author `user`, other marks unchanged), and reprojection after an axes change all passed. Not live-tested: hiding an outside mark in the widget and `render_canvas`, bundles, restart persistence, undo. Real Claude hosts not verified.
- Read-only Graphs (UVA Phase 4B, PR-4B-2): `ESTAMPES_GRAPH_DOCUMENTS=readonly` finishes the Graph rollback from Phase 4A. No new Graph is made (the default new canvas becomes a blank image; an explicit `kind: "graph"` and a bundle that carries a Graph are refused before anything is made), and every change to an existing Graph or a copy of one (marks, labels, layers, module runs, copies) is refused with `GRAPH_READ_ONLY` and a message that names the setting; the canvas in memory goes back to its stored state. Reading, `render_canvas` and bundle export still work, and images are not affected. In the widget the refusal reads “Graphs are read-only on this server”. Default `on`: nothing changes for existing deployments. Fake host only; real ChatGPT/Claude hosts not verified.
- Graph panel (UVA Phase 4B, PR-4B-1, from #228): opening the Graph module's `graph` panel no longer adds an empty window. A Graph is drawn in the canvas panel itself (a photo or a `gph:` document), so `manage_surface_panels` open `org.estampes.graph`/`graph` now brings the canvas forward (restoring it if minimized, and un-maximizing a window over it), and an empty Graph window saved by an older version is dropped. The workbench launcher gets a **Graph** button next to **+ Scientific calculator** that does the same. Sealed `src/surface/service.js` amended. Fake host only; real ChatGPT/Claude hosts not verified.
- Shared tools on a Graph (UVA Phase 4B, PR-4B-1): the widget tests for moving, resizing, reshaping and turning marks, quadrilaterals, vector text, label and note edits, dragging a sent shape, polling and two viewers now run on a Graph (`gph:`) as well as on an image, and a new test covers freehand with the highlighter, undo/redo, zoom and pan (nothing stored changes), layer visibility and opacity, and a server restart on a Graph. Two Graph fixes came out of it: the caption under a Graph said “Photo gph:…” and now says “Graph gph:…” (new key `vs.caption.graph`), and the module-objects panel no longer offers “Add image/canvas layer” on a Graph, which `add_image_layer` refuses. There is no separate eraser tool on either kind of canvas; marks are removed with Delete or Clear, as before. Fake host only; real ChatGPT/Claude hosts not verified.
- Multilingual support, Phase 4 (layers): a default layer name the server makes up (「AI · 第2次」, imported and replayed layers, text and module layers, copied-canvas layers) is now stored as the literal name plus optional `nameKey`/`nameParams` layer fields, so the canvas shows it in the viewer's language. The literal `name` stays the name of record and is what the assistant reads. Renaming a layer drops the key (it is then the person's own text). The document format stays `estampes.document/1`; old documents are not rewritten and keep showing their literal name. **Rollback note: a build older than this change refuses layers that carry these fields and opens such a canvas read-only (recovery). Back up the storage directory before downgrading.** Bundles and the `estampes.visual/2` export carry the fields; an import keeps them only when they match the catalog. 
- Multilingual support, Phase 4 (workspaces): default workspace names ("Workspace", "Canvas img:…", "Compare … + …", "… (split)") are stored the same way, as the literal `name` plus `nameKey`/`nameParams` on the workspace record, and shown in the viewer's language. Renaming a workspace to other text drops the key; a name typed at creation, split or import is never keyed. `workspace.json` in a bundle and the workspace state carry the fields; an import without a name keeps them. Workspace records have no strict schema, so older builds simply ignore the two fields (no rollback concern here).
- Multilingual support, Phase 3 (PR 3-3): when the server refuses a change from the canvas with a known code (`LAYER_LOCKED`, `HISTORY_CONFLICT`, `STALE_CANVAS`, `SAVE_FAILED`, `RECOVERY_REQUIRED`, `STORAGE_UNAVAILABLE`), the status line now says what happened in the person's language instead of the server's English text. The code comes from the error result's `structuredContent.code`, or a `[CODE]` tag in its text; any other error is shown as the server wrote it, as before. Nothing changes for the assistant.
- Multilingual support, Phase 3 (PR 3-2): every other message the canvas posts as the person now has the same form: a sentence in the person's language, then an English block for the assistant. This covers reviews of the assistant's claims and stroke groups, hand edits (layers, moved or deleted marks), the fallback sent when the server cannot validate a send, and the number line. The builders live in `src/surface/user-voice.js`, which the widget inlines and tests import; the person's notes, reasons and labels are passed through as typed. No widget text is fenced with `i18n-ignore` any more.
- Multilingual support, Phase 3 (PR 3-1): the message the canvas posts as the person when they send marks is now two parts. First comes a short sentence in the person's language (how many places, the intent, and their own note, quote and mark notes as typed). Then comes an English block for the assistant that is the same in every language: how to read the marks, which tools to use, and the structured event (RFC decision D4, so the model reads the same instructions whatever the person's language). The widget names its language to the server in `_meta["estampes/locale"]`; without it the sentence uses `ESTAMPES_DEFAULT_LOCALE`. Before, the whole message, including the instructions to the model, was in Chinese. To go back, revert this change; there is no switch for it.
- Multilingual support, Phase 2 (PR 2-4): the README and the Traditional Chinese guide describe the two interface languages, the **Language** menu and `ESTAMPES_DEFAULT_LOCALE`, including the upgrade note (set `ESTAMPES_DEFAULT_LOCALE=zh-TW` to keep a Chinese interface when the chat app reports no language), and say that following the chat app's language has only been tested with fake hosts. The English README names the upload button by its English label.
- Multilingual support, Phase 2 (PR 2-3): a **Language** menu in the canvas and Store headers (Automatic, English, 繁體中文); the choice is kept in this browser only and never written into a shared canvas. Changing language redraws every view in place, including the caption, layer list, counters, diagnostics, workbench panels, open calculators (rebuilt in the new language, keeping what was typed, chosen and opened) and the Store's tabs, categories and badges (start-up lookup tables now read the current language on every use, `i18nMap`). Text the page has since rewritten, such as the status line, keeps its language until it next changes. A host that switches to a language Estampes does not ship falls back to the instance default instead of keeping the previous one. The OAuth sign-in page follows the browser's `Accept-Language`. `i18n:check` also resolves keys inside `i18nMap({...})`.
- Multilingual support, Phase 2 (PR 2-2): the interface language is now resolved per view: a language the person picked in this browser, then the chat app's language (MCP Apps `hostContext.locale`, or `window.openai.locale` in ChatGPT), then the new `ESTAMPES_DEFAULT_LOCALE`, then English. Widgets switch in place when the host reports or changes its language. **Upgrade note: a deployment that used to show Chinese should set `ESTAMPES_DEFAULT_LOCALE=zh-TW`;** otherwise a chat app that reports no language gets English, and new default names (layers, copies, workspaces) are English. `ESTAMPES_LOCALE_FROM_HOST=0` ignores the chat app's language. Not yet verified on a live host whether ChatGPT and Claude report a locale. The test suite pins zh-TW through `tests/helpers/locale.mjs` (`npm test` and the CI runner load it).
- Multilingual support, Phase 2 (PR 2-1): the English catalog is complete (all 792 keys, same parameters as zh-TW, checked by `npm run i18n:check` and a test). Nothing switches to English yet; the next PR adds locale selection.
- Server icon: the butterfly logo (`public/estampes-icon.png`, 128px) is advertised in the MCP `initialize` result as `serverInfo.icons` (a URL on the server's own public origin, not an inline image: the SDK copies `serverInfo` into every tool result) with `serverInfo.title` "Estampes", and is served unauthenticated at `/icon.png` and `/favicon.ico`. Hosts that read server icons show it automatically, so no manual logo import. Tested against this server's own HTTP responses only; whether ChatGPT or Claude display it is up to each host.
- Surface widget (#222): window mode (canvas + calculator) no longer stops at 820px in a large user-sized frame. Until the user drags the height grip, the panel area takes the frame height minus the toolbar (measured the same way as the single canvas), never below 520px; a dragged `--wb-h` still wins. Hosts that size the frame to the content keep their behaviour.
- Multilingual support, Phase 1 done (PRs 1-4b and 1-5): the legacy number-line widget and evidence viewer take their text from the catalog (37 zh-TW keys), with the same text shown (checked in a browser before and after). With nothing hard-coded left, CI now runs `npm run i18n:check -- --strict`, and a test keeps the repository passing it. Every surface is still pinned to zh-TW; Phase 2 adds locale selection and the English catalog.
- Multilingual support, Phase 1 (PR 1-4a): server-side default names (layers such as 「AI · 第2次」, imported and replayed layers, text objects, module layers, copied-canvas layers, the marks-file user layer, workspace and split names) and module permission descriptions take their text from the catalogs (26 zh-TW keys, 9 en keys for permissions). Stored documents keep whatever name they already have. The annotation message sent to the AI as the user's words (class T2) is fenced with `i18n-ignore-start`/`end` until Phase 3, and model-facing descriptions that name a zh-TW button are marked for Phase 2. `npm run i18n:check` lists text in built-in modules as deferred to module locales (RFC §6.3) instead of counting it. Amendment records cover the two sealed files touched (permissions.js, bundle-extras.js).
- Multilingual support, Phase 1 (PR 1-3d): the rest of the Visual Surface script takes its text from the catalog (29 zh-TW keys): host display-mode and readiness notices, the LibreChat upload button, send statuses, the diagnostics panel and the offline notice. The verdict and edit messages sent to the AI as the user's words (RFC class T2) stay in place behind `i18n-ignore-start`/`i18n-ignore-end` until Phase 3 splits them. `npm run i18n:check` now honours those block markers and no longer counts `lang="__ESTAMPES_LANG__"` as a hard-coded language. Still pinned to zh-TW: the 18 browser tests show the same text before and after, apart from transient messages caught at different moments.
- Multilingual support, Phase 1 (PR 1-3c): the Visual Surface's captions, zoom label, module objects and info cards, loading and photo/workspace status, the check view, mark selection and editing, the text editor, drawing and dragging notices and the upload flow take their text from the catalog (148 zh-TW keys), including the upload note sent to the AI (still zh-TW until Phase 3). Still pinned to zh-TW: across all 18 browser tests the Chinese text, titles, labels and placeholders shown are the same before and after, apart from transient messages caught at different moments.
- Multilingual support, Phase 1 (PR 1-3b): the Visual Surface's script takes its evidence, review, layer, link, finding-list and gesture text from the catalog (106 zh-TW keys), including the user-voice intent labels sent with a mark (still zh-TW until Phase 3 splits them). The widget runtime also exposes `i18nT` for code where a local `t` shadows the translator. Still pinned to zh-TW: across all 18 browser tests, the set of Chinese text, titles, labels and placeholders the pages showed is the same before and after (only debug-panel ids and timings differ).
- Multilingual support, Phase 1 (PR 1-3a): the Visual Surface's static markup (view tabs, tools, pens, zoom, text editor, context form, buttons, status lines; 103 zh-TW keys under `vs.*`) names its text by key with `data-i18n`, `data-i18n-html` and `data-i18n-title`/`-aria-label`/`-placeholder`/`-alt`, and the server fills it in when the widget is served (`localizeHtml` in `src/i18n/index.js`), so the page shows its chrome without waiting for a script. `<html lang>` comes from the locale too (Visual Surface and Store). Still pinned to zh-TW: the served markup is identical to before once the markers are removed, and the workbench browser run shows the same text, titles, labels and placeholders. `i18n:check` also resolves `data-i18n` keys.
- Multilingual support, Phase 1 (PR 1-2): the scientific calculator (`public/calculator.js`) and the workbench panels (`public/workbench.js`) take every visible string from the catalog (194 new zh-TW keys, `calc.*` and `wb.*`); `visual-surface.html` now gets the i18n runtime. Still pinned to zh-TW: the workbench browser test's full run (solo canvas, two calculators, results, a stopped calculation, plotting, definitions with auto-update, dragging, phone tabs) was captured as visible text, titles, labels and placeholders before and after, and only timestamps and revision ids differ.
- Multilingual support, Phase 1 begins (docs/rfc/i18n §9, PR 1-1): a small message runtime (`src/i18n/runtime.js`, a subset of ICU MessageFormat: parameters, plural, select) and catalogs in `src/i18n/locales/` (`zh-TW.json` complete, `en.json` partial until Phase 2). Widgets get the runtime and catalogs inlined at the `__ESTAMPES_I18N__` placeholder. The Module Store page and the OAuth consent page now take every visible string from the catalog. The locale is pinned to zh-TW, so nothing users see changes: the Store's DOM was compared before and after across 13 states (list, three detail pages, enable plans and commits, every tab) and the consent page's HTML is byte-identical. `npm run i18n:check` now also fails on catalog errors (a message that does not parse, a key outside zh-TW, parameters that differ between locales, a `t("key")` no catalog has).
- A new canvas is a Graph by default (UVA Phase 4A, PR-4A-4d): `execute_module` with `newCanvas` and no `kind`, and `manage_surface_panels` with no canvas, now create a Graph document (`gph:`) when the UVA canvas store is on. `kind: "image"` or a `background` preset still makes a blank image, and so does a server without the canvas store. `ESTAMPES_NEW_CANVAS=image` turns the default back to blank images for the whole server (an explicit `kind: "graph"` still works). Sealed `src/modules/mcp-tools.js` amended (description text only). Fake host only; real ChatGPT/Claude hosts not verified.
- Calculator beside a Graph (UVA Phase 4A, PR-4A-4c2): the Visual Surface tools (`manage_surface_panels`, `get_surface_state` and the widget's `surface_*` tools) take a Graph id (`gph:`), so a Graph has a surface of its own: the scientific calculator opens beside it and `plot_result` draws onto it. The widget no longer shows a Graph as a bare canvas; it loads the Graph's own panels and layouts. Sealed `src/surface/mcp-tools.js` amended (id pattern only). Fake host only; real ChatGPT/Claude hosts not verified.
- Graphs in bundles (UVA Phase 4A, PR-4A-4c): `export_workspace_bundle` now exports a workspace (or a bare Graph) that holds Graphs. A Graph travels as data: a manifest asset with `kind: "graph"` and no file, plus its set (colour, vector axes and plots, marks). `import_workspace_bundle` makes a new Graph for each and restores its set; importing the same bundle again makes no second Graph; a server without the UVA canvas store refuses before creating anything. A Graph in a paired view stays refused (a workspace shows a Graph beside an image instead). Fake host only; real ChatGPT/Claude hosts not verified.
- Fix: the module audit log's `read()` (`src/modules/audit.js`) could miss entries recorded just before it, because it read `audit.jsonl` without waiting for pending appends; `tests/packages.test.js` failed now and then in CI because of it. `read()` now waits for them first (sealed file, amendment recorded with the owner's approval).
- Copies of a Graph (UVA Phase 4A, PR-4A-4b): `merge_workspaces`/`split_workspace` with `mode: copy` now copy a Graph too. The copy is `gph:<hex>#c<hex>`, starts with the Graph's marks, objects and colour, keeps its own marks from then on, is drawn as its colour plus vector axes, is refused by pixel tools like the Graph, and lives in the UVA store (it comes back after a restart). Still refused: a Graph in a paired view, and bundle export. Fake host only; real ChatGPT/Claude hosts not verified.
- Graphs in workspaces (UVA Phase 4A, PR-4A-4a): `create_workspace` and `edit_workspace` take a Graph id (`gph:`) in `canvases`, and a Graph is a valid source in `from` and `merge_workspaces`/`split_workspace` (linked). A Graph item keeps its own marks and objects, comes to the widget as its colour plus its axes (vector), and survives a restart. Not yet, each refused before anything changes: copies of a Graph (`mode: copy`), a Graph in a paired view (`gph:+img:`), and a bundle export of a Graph or of a workspace that shows one. Fake host only; real ChatGPT/Claude hosts not verified.
- Fix: the font check (`scripts/check-fonts.mjs`) could report fonts as present on a machine with none, about one run in six, so its test failed now and then. With no font, librsvg draws a string as boxes or, at random, as nothing, and two boxed renders can differ in light anti-aliasing. The check now fails when either sample is blank and compares the samples as black-and-white masks. Locally, 40 runs with no font: 40 failures as expected (before: 5 of 40 wrongly passed).
- One shared height grip (#181 live ChatGPT report): the grip now shows for the single canvas as well as window mode, and both layouts use the same value (stored as `--wb-h` on the workbench, so it is no longer an inline style that stayed behind when switching layouts, which left a shrunk panel area after going back from two windows to one). Double-click, arrow keys and 重設版面 reset it. Live retest needed in ChatGPT.
- Wording (#194–#198 follow-up): schema errors say `at least 1 character` / `1 item` instead of `1 characters`, and the administrator-approval comment and the sign-in page's access-key hint no longer assume Docker. No behaviour change. `admin.js`, `oauth.js` and `json-schema.js` joined the authorized PR-1B seams for this.
- Graph documents, tool part (UVA Phase 4A, PR-4A-2b): `execute_module` with `newCanvas: {kind: "graph", color?, width?, height?}` creates a Graph document (`gph:`) with no image; without `kind` the new canvas is still the blank image as before. Canvas tools take a Graph id: `present_visual`, `get_visual_state`, `load_visual_canvas`, `render_canvas`, `edit_visual_canvas`, the review tools, `validate_visual_annotations`, the layer, text and scene-object tools, `execute_module` and the command/change lookups. Pixel tools (`inspect_image`, `process_image`, `measure_image`, `detect_features`, `load_visual_pixels`, ...) refuse it with an error that names `render_canvas`. The widget opens a Graph on its colour (single canvas), showing the canvas alone: switching to a Graph clears a calculator or window layout left from the previous image. A Graph gets no image/marks download links (they would not resolve), cannot be one side of a paired view yet and has no processed `views` (both refused before any change, the latter naming `render_canvas`). The widget drops a workbench or calculator answer that arrives after it switched canvas. Workspaces, surfaces, paired views and copies of a Graph do not take it yet (4A-4). A test lists every tool argument that names a canvas or image and fails until a new one is classified. Fake host only; real ChatGPT/Claude hosts not verified.
- Plot context for modules (UVA Phase 4A, PR-4A-3): a module with `canvas.read` now also gets `canvas.plot`, the axes and function plots of its canvas (`src/modules/plot-context.js`), and every module gets `canvas.kind` (`graph` or `image`). The graph module reads axes and plots only through it, so a Graph document and a blank image canvas give it the same context and the same drawing (tested on both). Parser, sampler and capabilities are unchanged. The graph module is a sealed file: its fingerprint is updated with an amendment record. CAS moves to this context in Phase 5 (#174).
- Fix (#195): a Store install plan survives a widget reload. Asking again for the same pending change returns the same plan, so the administrator's approval still applies; only an identical, unexpired, uncommitted plan is reused, and any difference (version, permissions, package digest) makes a new plan that needs its own approval. The approve command the Store shows no longer assumes Docker. `lifecycle.js` and `module-store.html` joined the authorized PR-1B seams for this.
- Fixes from the third-party module acceptance test (#199): `source sync` now resolves package file names against the URL the source was added with, not the address after redirects, so packages next to a GitHub Release index are found (#194; the test now serves the index and the packages through redirects to storage paths like GitHub does). (#195 is fixed separately, below.) The server's access-key log lines no longer assume Docker. Docs: `docs/MODULES.md` manifest fields, runtimes, categories, permissions, module tools and canvas-store wording match the code (#196); a coordinate-semantics section documents clipping, unit differences and text anchors as they behave today, with no behaviour change (#197); the module quick start has PowerShell and Node pointers, `estampes-module.js --help` prints the command list, schema messages say `1 character`/`1 item`, TESTING lists common messages, and DEPLOYMENT names the current Claude connector dialog choices (#198).
- Window mode height (#178, #181 live report in ChatGPT: no way to resize the widget): ChatGPT gives an inline widget no resize handle, so a grip under the panel area now lets the user drag its height (double-click or arrow keys also work; the choice is remembered in the browser). The size report also calls `window.openai.notifyIntrinsicHeight`, as the Apps SDK documents, next to `ui/notifications/size-changed`. Live retest needed in ChatGPT.
- Traditional Chinese labels in server-side renders: the image now also ships Noto Sans CJK Regular (only that one collection file from `fonts-noto-cjk`, about 20 MB more), and a fontconfig rule makes Han characters default to its Traditional Chinese face. English and Traditional Chinese labels in `render_canvas` and PNG exports work without extra setup. The Docker build checks both (`scripts/check-fonts.mjs --require cjk,cjk-tc`). Other scripts still use the mounted font folder. Not yet verified on a live host.
- Fix: server-side renders could not draw any text in the Docker image. The image (`node:22-bookworm-slim`) had no fonts, so every letter of mark labels in `render_canvas` and PNG exports became a missing-glyph box, English included (confirmed on a live deployment: `/usr/share/fonts` did not exist). The image now installs `fonts-dejavu-core` and `fontconfig-config` (about 3 MB: Latin, Greek, Cyrillic, basic Arabic/Hebrew), and the build fails if `scripts/check-fonts.mjs` finds that two different strings render identically. Chinese, Japanese and Korean labels still need extra fonts (see the multilingual RFC). Not yet verified on a rebuilt image on a live host.
- Graph documents, storage part (UVA Phase 4A, PR-4A-2a): a Graph can be a document of its own with id `gph:<16 hex>` instead of a blank PNG. It has a solid background and no image: creating, editing and restoring one writes no image bytes, no asset and no image file. Its record goes through the UVA canvas store only (the default with a storage folder); without it a Graph is refused with a clear error. In the UVA document it is `kind: "graph"` with a solid background, and its marks are anchored to the document in document units, not to an image. Pending Graph records use their own `gph-` file names and are recovered at startup like image canvases. No tool creates a Graph yet and nothing changes for existing canvases; tools accepting `gph:`, pixel tools refusing it, and switching the Graph module's new canvas come in the next PRs. In-process tests only; real ChatGPT/Claude hosts unaffected so far.
- Canvas background as data (UVA Phase 4A, PR-4A-1): a canvas can record `background: {kind: "solid", color: "#rrggbb"}`. A solid canvas sends the widget only its colour and size (no image bytes); the widget draws it as a vector `<rect>`, and `render_canvas` fills the output with that colour (`sourceKind: "solid"`, `included.base: false`). The background is saved and restored with the canvas, enters the canvas revision only when solid, and any missing or invalid value means the image, so every existing canvas renders, saves and hashes exactly as before. Render verification crops show the colour too (the stored image is not read for them); pixel analysis tools still read the stored image. Bundles carry the background (a different colour is copied, never reused or restored over local state), set copies snapshot it, and a promoted base (`baseAsObject`) is never drawn. Nothing creates a solid canvas yet; the Graph document (`gph:`) that uses it comes next. Graph axes, plots and labels were already vector paths and text; a new test keeps it that way. Fake host only; real ChatGPT/Claude hosts are not verified.
- Fix: a mark no longer springs back to its previous place for a moment after a drop (#70). A poll snapshot fetched before the viewer's own edit finished could be applied while that edit was still on its way to the server; the widget now holds snapshots while an edit is in flight and drops ones fetched before it completed (a fresh poll follows). Regression test reproduces the flicker; live-host behaviour not yet verified.
- Diagnostics for a live drag/refresh report (#70: an AI-made quadrilateral looks moved while interacting but is back at its first place after a refresh, although the server holds the moved geometry): tapping the status line under the canvas now shows a small text block with where the marks on screen came from (host result), how often the widget polled the server and the last error, the last applied snapshot revision and time, and the last edit (command id, send and answer time, first vertex sent and returned, or the server's refusal). Hidden by default, no layout change, no data sent anywhere. The cause is still not found: a widget rebuilt from the old tool result does show the moved place in the browser test host. A live retest copying this block is needed.
- Widget in a user-sized frame (#181): the 820px width caps are gone and the canvas height cap is `max(640px, 100vh - measured toolbar height)`, so a frame the user drags large gives the canvas more room, while small frames and hosts that size the frame to the content behave as before. Height changes ease in over 0.18 s (off with reduced motion). Live retest needed in Claude and ChatGPT.
- Dragging a mark (#70, live ChatGPT report: an AI-made quadrilateral follows the pointer but returns to its place on release): the cause is not yet confirmed (not reproduced in the browser test host with AI-made or user-made, unsent or sent, turned or drawn quadrilaterals, desktop and touch, slow host). When the browser or host cancels a drag (`pointercancel`, or the canvas resizing mid-drag) the mark is restored as before, but the status line now says so, so the next live run shows whether that is what happens. New browser tests cover drop, re-render, poll and reload for these shapes.
- Widget window size (#178): the widget never told the host how big its content was, so some hosts (Claude) left the frame clipped or let it follow whatever image was loaded. It now sends `ui/notifications/size-changed` with its real content size whenever that changes, and the canvas keeps a minimum height (`min(320px, 60vh)`) so a very small or very wide picture no longer collapses the whole widget. Live retest needed in Claude and ChatGPT: real host resizing cannot be checked with the fake host.
- Viewer budgets (UVA Phase 3, PR-3C): a new browser test file opens 1, 2 and 5 viewers on one document and fails if idle polling exceeds one request per 2 s round (plus one) or an unchanged poll answer reaches 1,500 characters (measured about 298 in every case); it also opens and closes a viewer 20 times and fails if document/window/viewer-root listeners, live viewer timers or animation frames do not return to baseline. Mount, apply and cumulative-size numbers are printed only, not asserted. No code change. The host-request guard timer (12 s, one per host call, expires by itself) is not counted as a viewer timer. Fake host only; real ChatGPT/Claude hosts and snapshot-size caps (to be set after measuring a real canvas) are not covered.
- Dragging a turned box (#70, regression from the rotate handle): after a box was turned into a quadrilateral, it could only be grabbed by its edge lines, not by its body as a box can, so dragging it from inside did nothing. Inside any closed shape (quadrilateral, loop) now counts as near when picking a mark, the same rule as inside a box; ink right under the finger still wins. Rotation, vertex handles and the stored format are unchanged. Tested in a fake host on desktop and touch; real ChatGPT/Claude hosts are not verified.
- Widget recreation test (UVA Phase 3, PR-3B-2, runtime case UVA-35): a new browser case rebuilds the widget from an old tool result after a newer mark exists. The widget shows the newer canvas from the server, sends no edit, and no image, canvas or document directory is added under the storage root. No code change was needed. Not covered: unsent marks do not survive recreation (the draft policy is separate), and real ChatGPT/Claude hosts are not verified.
- Lost-ACK handling, widget side (UVA Phase 3, PR-3B-2): every layer, mark-edit and undo/redo the widget sends through `edit_visual_canvas` carries a command id. If no answer arrives, the widget asks `commands_get_status` for that id and sends the same id again; the server applies it once and answers a known id with the current canvas. If the second try also gets no answer, the widget says it is not sure the edit was saved. Not covered yet: the other mutating tools (`review_*`, `edit_scene_object`, `edit_canvas_text`, `add_image_layer`, mark send) send no id; after a replayed answer the widget's list of unsent edits does not include that edit (the server still keeps it for the assistant). Tested with a fake host that drops one reply; real ChatGPT/Claude hosts are not verified.
- Rotating boxes (#70, live test PARTIAL): a selected box (`rect`) now has the round turn handle too. Turning it makes it a quadrilateral (closed four-corner polyline, the same representation as the 四邊形 tool), keeping its id, author, label, note, style and layer; the AI reads `shape: "quadrilateral"` and `corners`. `edit_visual_canvas` takes `type: "polyline"` only for this rect → closed 4-point polyline change; any other change of type is refused. No new mark field or storage format.

- Editing the text of the AI's marks (#82, live test failure): the label and note of the AI's marks were read-only in the widget and refused by `edit_visual_canvas`, so users could not change AI-created labels/notes (only their own). Now any unlocked mark's label and note can be rewritten; author, style, geometry and id stay, a rewritten note drops the AI's old confidence/evidence, and the AI is told the before/after wording (`userEdits` kind `edit-text`). Tapping a mark's drawn label selects it. A tap to select no longer nudges a mark: handle drags got a start threshold too, and the threshold is measured in real CSS pixels (10 px touch, 4 px mouse).
- Lost-ACK handling, server side (UVA Phase 3, PR-3B-2): `edit_visual_canvas` takes an optional `commandId`; the id and a hash of the edits are written into the canvas's change-log line in the same durable record as the edit, so a retry with the same id is applied once (the answer is the current canvas with `replayed: true`) and the same id with different edits is refused. New app-only `commands_get_status` says which ids were applied. Calls without an id behave as before. The widget does not send ids yet, and other tools are not covered yet.
- Surface widget (UVA Phase 3, PR-3B-2, second part): when the poll cannot reach the server the viewer keeps the last snapshot and says so (and that new marks are not saved), then recovers on its own; new runtime tests cover offline, one poll serving two viewers on a document, redelivery of the same result, and the size of an unchanged poll (about 300 characters). Lost-ACK lookup by command id is not part of this change.
- Docs refresh for 0.20.x: README and the Chinese guide describe editing the AI's marks, quadrilaterals, text, undo of sent edits and live updates, and index every user-facing page (UVA store, power-loss simulation, module distribution and acceptance, AGENTS.md, community files); the stray "UVA store" section after the license moved into Status. USAGE covers every canvas tool by its on-screen name, selection and editing, live updates and background work, and says "the AI" instead of GPT so it reads for Claude too. ARCHITECTURE and DEVELOPMENT list `src/uva`, `src/persistence`, `src/visual`, `src/documents`, OAuth and the widget's HostBridge/DocumentStore, and no longer say there is no upload UI. The photo tutorial is now `docs/tutorials/PHOTO-ANNOTATION.md`. A second, never-released *Unreleased* heading in this changelog was folded into 0.20.1.
- Surface widget (UVA Phase 3, PR-3B-2, first part): the widget now polls `documents_get_changes` about every 2 s while visible, at once on focus, on becoming visible and after any finished tool call, through one shared `DocumentStore`. A polled snapshot replaces only what the server owns (other authors' marks, layers, objects, gesture verdicts, links); unsent marks, camera, tool and selection are never touched, a snapshot that changes nothing does not rebuild the view, and one that arrives while the user is dragging, drawing or typing waits for a later tick. Paired views are not polled yet; a workspace whose items changed is reloaded instead of patched. Not yet done: lost-ACK lookup by command id, restore-after-recreate audit, de-duplication by result id.
- Background canvas work (#81): `execute_module` takes `present: false` for iterative runs, and polling a still-running job with `get_module_job` is treated the same way: the widget shows a one-line note ("AI 正在背景更新或檢查畫布") with a 顯示畫布 button instead of reopening the canvas, while the model still gets its preview and revision checks. `present_visual` and finished jobs open the canvas as before; `render_canvas` stays model-only.
- Perspective-aware annotation (#70): new **四邊形** tool. Drag a box, then move each corner on its own (perspective) or turn the whole shape with its round handle (rotated box); any closed shape can be turned. A quadrilateral is a closed four-vertex polyline, so no format changes: exports, bundles, workspaces and transforms keep its exact corners. The AI sees `shape: "quadrilateral"` and `corners` in canvas reads, and `present_visual` documents drawing one; `rect` stays axis-aligned and unchanged.
- Shared annotation editing (#69): in 選取 mode the AI's marks can now be dragged, and every unlocked mark shows handles: box corners/sides resize, arrow ends and polyline vertices reshape (mouse and touch). The AI's label, note and style stay its own, its author, ID, layer and evidence are kept, and the mark is flagged `editedByUser`. Edit reports distinguish `move` / `resize` / `reshape` (`change`) and carry the mark's `author` and `before`/`after` geometry, so the AI is told e.g. "resized YOUR mark box from … to …". Locks and undo/redo apply as before.
- Tool-use reliability (#87): the server now sends MCP `instructions` naming the follow-up tools (uploaded image → `inspect_image` then `present_visual` on the same `imageId`; running job → `get_module_job`; own check → `render_canvas`) and asking the model to report "not attempted / failed with this error / running / done" instead of guessing that tools are unavailable. Every error result gets a second text block saying which Estampes tool replied (the first block, shown to users by widgets, is unchanged). The canvas upload message now says the tools are connected and no re-upload is needed.
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

### Also in 0.20.1

These entries sat under a second *Unreleased* heading that was never folded into a version. They were on `main` before 0.20.1 was released, so they shipped in 0.20.1 at the latest.

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
