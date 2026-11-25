# Modules

Estampes core is a shared canvas: you, the AI (ChatGPT or Claude) and tools look at the same picture, point at it, annotate it and check claims about it. A **module** adds a capability that produces or analyses things on that canvas, such as plotting a function. Modules extend how people and AI interact, not what GPT can do in general: email or search belong to ChatGPT's own apps.

Status: this page describes what is implemented on `main` (0.20.1 and later): the contract, capability profiles, the built-in Graph, calculator ([CAS](CAS.md)) and plate-solving modules, the Store, managed packages and package sources ([Distributing modules](modules/DISTRIBUTION.md)), declarative, WebAssembly and http modules, background jobs (including `present: false` runs that do not reopen the canvas), info cards, and panels in the workbench. Not implemented: an OCR module, and anything marked planned or "still to come" below. Section headings that name a version say when the feature arrived, not the current state. Live-ChatGPT testing of the newer parts is recorded in the [changelog](../CHANGELOG.md) and each feature's page; where a page says it was not executed, it was not.

## How it fits together

```
AI ── execute_module ──▶ router ──▶ module (returns data only)
                             │            │ scene operations
user ─ Store / canvas ─▶ lifecycle        ▼
                          audit      core: validate, apply all-or-nothing,
                                     revision, provenance, render ──▶ canvas
```

- The model sees a fixed set of module tools: `open_module_store`, `list_modules`, `search_capabilities`, `get_module_capabilities`, `execute_module`, `get_module_job` and `prepare_module_change`. Enabling or installing a module never changes the tool list, so there is nothing to reconnect.
- A module never touches canvas state. It returns scene operations; the core validates them, assigns ids and draws with its own renderer. Modules cannot ship HTML, scripts or SVG.
- Changing what is enabled takes a **plan** the user confirms in the Store. The model can prepare a plan but cannot approve it: committing needs a one-time consent token delivered only to the Store widget.

## Manifest: `estampes.module/1`

Estampes's own format (not an MCP standard). Validated strictly: unknown fields, unknown schema keywords, unbounded strings or arrays, and nested regex quantifiers are refused.

| Field | Meaning |
| --- | --- |
| `schema` | Always `estampes.module/1`. |
| `id` | Reverse-DNS name such as `org.estampes.graph` (3 to 6 dot-separated parts). A name, not proof that the publisher owns the domain. |
| `name`, `nameI18n` | Display name (at most 60 characters) and optional translations by language code (`{"zh-TW": "…"}`, at most 8). The Store currently shows `name` only. |
| `description`, `descriptionI18n` | At most 400 characters, with the same optional translations. |
| `version`, `coreCompatibility` | Module version (`MAJOR.MINOR.PATCH`); range of Estampes versions it works with (for example `>=0.10.0 <1.0.0`). |
| `publisher` | `{name, url?}` (`url` must be https). |
| `license`, `source`, `homepage` | License text; optional https links. |
| `category` | One of `math`, `diagram`, `analysis`, `text`, `astronomy`, `electronics`, `utility`, `other` (default `other`). Any other value is refused. |
| `runtime` | `{kind, entry, abi?}`. `kind`: `builtin` (ships with Estampes; refused in packages), `declarative` (scene-operation templates, no code; `entry` is a label such as `operations`), `wasm` (a WebAssembly file inside a signed package; `entry` is the file, `abi` is `estampes.wasm/1`), `http` (a described request to an approved external service). |
| `permissions` | What it may do, granted when enabled (below). At most 12. |
| `limits` | Optional `timeMs` (50–30000), `memoryMb` (1–256), `outputKb` (1–1024) and `jobMs` (1000–1800000, async capabilities only). |
| `capabilities[]` | `id`, `title`, `description`, `inputSchema` (JSON Schema subset), `target` (`none`, `canvas`, `canvas-or-new`), optional narrower `permissions`, optional `keywords` (up to 12 short words that `search_capabilities` ranks on; they never change what the capability does), optional `profile` / `profileI18n` (below), `async`, `examples` (`description`, `params`, and for tests `expect` and, http only, `mockResponse`; see [Testing modules](modules/TESTING.md#http-specifics)), and the body that fits the runtime: `operations` (declarative) or `request` and `response` (http). |
| `network`, `secrets` | For `http` modules: `network` lists the hosts it may call (`allow`) and says what data leaves (`dataFlow`); `secrets` names API keys the administrator provides. See [Talking to external services](#talking-to-external-services-http-modules). |
| `dependencies`, `panels` | Optional: other modules it needs, and panels it offers inside the Visual Surface (data only; `kind` names a renderer that ships with Estampes). |

Rules the manifest check enforces across fields: a capability whose `target` is not `none` needs `canvas.write`; `target: canvas-or-new` additionally needs `workspace.write` (it may create a new blank canvas); `declarative` capabilities carry `operations`, `http` capabilities carry `request`, and no other runtime may; a capability's own `permissions` must be a subset of the module's.

## Capability profile

An input schema says what a capability accepts, not whether it is the right tool. Each capability can carry a `profile` (and a translated `profileI18n`) with:

- `whenToUse` and `whenNotToUse`: the situations it fits and the ones it does not;
- `inputLimits`: limits beyond the schema (formats, sizes, what makes it work better);
- `cost`: `latency` (`instant`, `seconds`, `minutes`, `hours`), what it uses up and whether it can bill;
- `dataFlow`: whether data leaves the server and what is sent;
- `reliability`: `kind` (`exact`, `estimate`, `heuristic`, `external`), a note on how far to trust the result and how to check it;
- `fallbacks`: what to do when it fails, as `when`/`then` pairs.

`get_module_capabilities` hands the profile to the model, which is told to read it before the first run and to follow the fallbacks when a run fails; the Store shows it (folded) under each capability. It is checked, not decoration: a capability that uses the network must say that data leaves the server and what is sent, one that does not cannot claim it does, a background job cannot be `instant`, and a translation may change only the text, never the cost or the data flow.

## Permissions

| Permission | Risk | Meaning |
| --- | --- | --- |
| `canvas.read` | low | Read objects and mark summaries of the target canvas |
| `canvas.write` | low | Add objects and change its own |
| `workspace.write` | low | Create new blank canvases |
| `asset.read.selected` | medium | Read pixels of the target image or region |
| `module.storage.write` | medium | Keep its own data on the server. Reserved: the permission can be declared and is shown, but no module storage API exists yet, so holding it does nothing today |
| `cas.compute` | medium | Use the local SymPy calculator service (sends only expressions; no internet) |
| `network.request.approved` | high | Send requests to its listed hosts (may upload images) |
| `module.secrets` | high | Use administrator-provided secrets |

The grant is stored when you approve enabling. The router checks it on every call.

## Scene operations: `estampes.scene-ops/1`

`object.create` (type, props, optional `ref` that later operations in the same batch can use as `$ref`, `visibility` `public` or `scratch`), `object.update`, `object.delete` (`cascade` for dependants), `object.publish` (scratch to public). Rules enforced by the core: at most 64 operations and 200 objects per canvas, props validated per object type, `expectedRevision` for optimistic concurrency, no changes in a locked layer, a module may change only objects it created, and the user may change anything.

Object types (full property lists below): `axes-2d` (ranges, grid, `π` ticks, labels), `function-plot` (`expression`, `domain`, `frame` = an axes object) and `shape` (polyline, polygon, dots, circle, rect, arrow, point, text, in canvas or frame space). `info-card` is a fact sheet, not a drawing: a title and up to 24 rows of label, value and an optional https link, listed beside the canvas (see [Info cards](#info-cards)). Coordinates of canvas objects are normalized to the canvas (top left origin) like marks; frame space uses the axes' numeric range with y up. The next section spells out what that means for a module author.

Function plots support `props.labelMode`: `auto` renders `y = ` followed by the current expression; `custom` preserves `props.label` (an empty or omitted label hides it). With no mode, an existing label—including an empty or formula-looking label—is treated as custom; without a label the mode is auto. Setting `label` on an update selects custom unless `labelMode` is also supplied. Switching to auto discards the stored label. Core applies these rules to module operations and direct Canvas edits, even when Graph is disabled. Modes persist with the objects. Graph's `plot_function` and `update_plot` accept `labelMode`; to migrate an old plot explicitly, call `update_plot` with `{ "object": "o2", "labelMode": "auto" }`.

Properties, as validated by the core (`src/scene/objects.js`); unknown properties are refused:

| Type | Properties |
| --- | --- |
| `shape` | `kind` (`polyline`, `polygon`, `dots`, `circle`, `rect`, `arrow`, `point`, `text`); `space` (`canvas`, default, or `frame` with `frame` = an axes id); `points` (`[[x, y], …]`, at most 2000; polyline and polygon need 2, dots 1); `x`, `y` (circle, point, text); `x2`, `y2` (rect and arrow, with `x`, `y`); `r` (circle radius in x units of its space); `text` (at most 80 characters); `size` (text size 6–64); `fill` (a colour); `smooth`; `style` |
| `axes-2d` | `xRange`, `yRange` (`[min, max]`); `region` (`{x, y, x2, y2}` part of the canvas, at least 0.05 each way); `grid`; `xTicks` (`auto`, `pi`); `xLabel`, `yLabel`, `title`; `style` |
| `function-plot` | `expression`; `frame`; `domain`; `label`, `labelMode`; `style` |
| `info-card` | `title`; `rows` (1–24 of `label` ≤ 40, `value` ≤ 240 characters, both text, optional https `href`); `shown` |
| `image` | for built-in modules (a PNG layer) |

`style` is `{color, width (0.2–12), dash (solid, dashed, dotted), opacity (0.1–1)}`. Colours are `#RRGGBB` or one of `gold`, `blue`, `red`, `green`, `yellow`, `magenta`, `cyan`, `white`, `black`, `gray`, `ink`.

### Coordinate semantics (what the renderer does today)

This describes existing behaviour; it is the contract module authors can rely on, and it will not change for existing modules.

- **Canvas space.** `x` and `y` are fractions of the canvas **width** and **height** respectively, origin at the top left, y growing downwards. `(0.5, 0.5)` is the centre of any canvas.
- **Values outside 0..1 are accepted and drawn clipped.** The core only requires finite numbers: a bar from `x = 0.9` to `1.3` is stored as given and the part beyond the right edge is simply not visible. This is intended (a shape may be partly off canvas), so a module that must stay visible should clamp itself, for example `{"$calc": "min(x + l, 0.98)", "with": {...}}`, or narrow its `inputSchema` (`minimum`/`maximum`).
- **x and y have different units.** One unit of x is the canvas width, one unit of y its height, so on a 1600×1000 canvas a step of 0.1 is 160 px across and 100 px down. Lengths and angles computed from fractions are distorted on non-square canvases: an arrow from `(0.1, 0.1)` to `(0.3, 0.3)` is drawn at about 32° on 1600×1000, not 45°. For a true angle θ with canvas aspect `a = height / width` (0.625 for 1600×1000), use `dy = dx · tan(θ) / a`. Declarative templates cannot read the canvas size, so a module that needs real angles takes the aspect as a parameter; `try` uses 1600×1000 (aspect 0.625) unless `--image` is given, and WebAssembly modules receive `canvas.width` and `canvas.height` in the request. Only `arrow` heads and `text` line spacing are corrected for the aspect by the renderer.
- **Sizes are in canvas units.** `size` (text), `style.width` and `r` are measured on a canvas that is 1000 units wide, whatever its pixel size, so they scale with the picture. `circle.r` is a fraction of the canvas width (a circle stays round); in frame space it is in the frame's x units.
- **Text anchor.** A `text` shape is drawn with its left edge at `x` (`anchor: start`) and its vertical centre at `y`; `\n` starts a new line below. There is no align property, so a label cannot be centred or right-aligned without knowing its rendered width; place it beside a point rather than on it, or estimate roughly 0.6 × `size` canvas units per character.
- **Frame space** (`space: "frame"`) uses the numeric ranges of the referenced `axes-2d` object with y up, and is not clipped to the axes region: only function plots are clipped to their axes, so a frame-space shape outside the range is drawn outside the axes (it is still clipped by the canvas edge). Keep such shapes inside the range yourself.
- Not available today, and not promised: reading the canvas size in a template (for example a `$canvas` placeholder) or a text `align` property. They would be additions, not changes to the rules above.

**Scratch objects** are the model's working notes: they are in the model's preview image but not drawn for the user or exported until published. This is not secrecy: scratch objects are still readable by the module that made them and by the model.

## Graph module

| Capability | What it does |
| --- | --- |
| `plot_function` | Plot `y = f(x)`; creates a new blank canvas with axes if you give none |
| `update_plot` | Change a plot's expression, domain, colour or label; the curve is re-computed |
| `set_axes` | Change ranges, grid, `π` ticks, title and labels |
| `plot_points` | Plot data points as a line or dots |

Expressions: `x`, numbers, `+ - * / ^`, implicit multiplication (`2x`, `3(x+1)`, `2pi x`), `|x|`, constants `pi`, `e`, `tau`, and `sin cos tan sec csc cot asin acos atan atan2 sinh cosh tanh exp ln log log2 sqrt cbrt abs sign floor ceil round trunc min max pow hypot mod`. `log` is base 10. They are parsed by Estampes's own parser and never evaluated as JavaScript. Curves are sampled adaptively; asymptotes (`tan`, `1/x`) split the curve instead of being joined.

### Marks fixed to the axes (Graph documents)

A mark on a Graph (`gph:`) stays where it is on the page by default, whatever the axes do. A mark can instead be fixed to an axes object, so it follows the data when the range changes: the assistant passes `anchor: {space: "world"}` on an annotation in `present_visual` and gives its coordinates in axis units (`frame` names the axes object; it can be left out when the canvas has only one). The person chooses the same thing in the selection bar, with **Pin to axes** / **Pin to page** (固定在座標 / 固定在畫面), and `edit_visual_canvas` takes `{id, anchor: {space: "world" | "document"}}`. Switching leaves the mark where it is; moving a mark fixed to the axes moves its place in axis units too. The person cannot drag or pin such a mark outside the axes range (refused with `OUTSIDE_AXES`; fix it to the page first); if the assistant re-places one there in canvas units, it is kept as outside. When the axes range no longer contains the mark, it is kept but not drawn (also not by `render_canvas`), `get_visual_state` reports `anchor.status: "outside"`, and the canvas lists it under **Outside the axes range** (超出座標範圍); it comes back when the range includes it again. A mark the assistant places in axis units outside the current range, or with a `coordinateFrame` as well, is refused. If the axes object is deleted the mark keeps its last place with `anchor.status: "invalid"`. Images have no such choice.

### Marks pinned to a curve (Graph documents)

A mark on a Graph can also follow a function plot: `anchor: {space: "function-x", plot: "<plot id>"}` (the plot can be left out when the canvas has only one). The assistant gives the mark in axis units like a mark fixed to the axes; its first point is moved onto the curve at its x (or at `anchor.x`), and the rest of the mark keeps its shape around it. The person picks **Pin to curve** (固定在曲線) in the selection bar, which pins the mark to the curve nearest to it along the vertical at its x and keeps it where it is, as an offset from the curve; `edit_visual_canvas` takes `{id, anchor: {space: "function-x", plot?}}`. When the formula, the domain or the axes change, the mark moves to the new (x, f(x)) by the same offset. Moving it on the canvas pins it again at its new x; dragging it where the curve is not drawn is refused (`OFF_CURVE`), and pinning where no curve passes is refused (`NO_CURVE`). When the curve point is outside the axes range the mark is kept and not drawn (`anchor.status: "outside"`). When the plot is deleted, or the new domain leaves its x out, or f is not defined there, the mark keeps its place and is still drawn, `get_visual_state` reports `anchor.status: "invalid"`, and the canvas lists it under **Anchor lost** (錨點失效); pinning it to a curve again or to the page (**Pin to page**, which detaches it at its current place) clears that. `get_visual_state` gives such a mark `anchor: {space, plot, x, offset, status}`. A confirmed note on a mark whose curve was re-defined (formula, domain or axes object, not the axes range) becomes a stale confirmation, and a tool's evidence for it no longer counts as verification, until the person confirms it again.

### Provenance of an object

`provenance.method`, `capability`, `module` and `createdAt` record how an object was first made and are written once, when it is created. A later `object.update` changes only `updatedAt` and `editedByUser`. So a Graph plot made by the calculator's `plot_result` keeps the method text naming the first result (`SymPy result cr:… drawn by the Graph renderer`) even after auto-refresh redraws it from a newer result. The result a plot currently follows is the `resultId` of the graph link in its notebook cell (`get_notebook`, `get_surface_state`), not the object's provenance.

## Finding a capability (search_capabilities)

`search_capabilities({query, category?, state?, limit?, cursor?})` finds capabilities by task without reading the whole catalog (issue #244, level L0). It is a deterministic keyword search over module and capability ids, titles, descriptions and categories (CJK text is matched by character and adjacent pair), built from the installed manifests on each call. `state` is `enabled` (default) or `any`; a module that is installed but not enabled is marked, not hidden, and a search hit never lets a module run: `execute_module` still checks the enabled state, the granted permissions and the schema. A page has at most 25 rows (10 by default) and at most 16 KB of rows; when the size limit cuts a page it says `truncatedByBudget`. Every page reports `total`, `returned`, `complete` and, when there is more, `nextCursor`; a cursor is refused if the module catalog changed since (`stale-cursor`) or if it belongs to another query. Each row carries `schemaHash`, a short hash of the capability's input schema, target and permissions, so a caller can tell that a contract it read earlier has changed. A capability can list up to 12 `keywords` in its manifest (additive and optional; v1 and v2). Keywords weigh less than the id and title and more than the module name and description; a package that uses `keywords` needs a server that knows the field (this version or later), as with any manifest field. Titles and summaries are written by module authors and are cut and stripped of control characters; treat them as data. `get_module_capabilities({module, capability})` returns the full contract of exactly one capability (L1, with the same `schemaHash`), and `list_modules({compact: true, limit, cursor})` gives a short paged list of modules; without those arguments both tools answer as before. A typical path is search, then read one contract, then `execute_module`; if a search misses, search with `state: "any"` or read the compact list.

## Manifest v2 (opt-in)

`estampes.module/2` is the manifest format for modules that work on documents (images and Graphs) rather than on an image id (UVA Phase 5A, ADR-005). It is off by default: set `ESTAMPES_MODULE_V2=on` to allow v2 packages to be installed and run. With it off a v2 package is refused with a reason, and a v2 package that was installed earlier is marked failed at startup and is not run (turn the flag back on and enable it again to use it). v1 manifests, their signatures and their behaviour on images do not change either way, and built-in modules stay v1.

Three rules go with it (5A-3). A v1 **package** module cannot work on a Graph document: the call is refused with `target-unsupported`, and a document it creates is an image. Built-in modules are not restricted. A v2 module may not update or delete an object the person has edited (`provenance.editedByUser`); the run is refused with `user-edited` and nothing is applied, and the module should leave the object or create a separate one. Resolving such a conflict (detach, overwrite, fork) is not part of 5A. Finally, an update plan reports `signer: {from, to, changed}`; if the signing key differs from the installed one the plan is high risk and says so.

A v2 manifest differs from v1 in four fields. `schema` is `estampes.module/2`. `runtime.abi` is a required integer (this server supports ABI 1). Each capability's `target` is `none`, `document` or `document-or-new` (v1: `none`, `canvas`, `canvas-or-new`). Each capability lists the permissions it really `needs` (v1: an optional `permissions` subset). The rules that follow are the same as for v1: `needs` stays inside the module's `permissions`, a document target needs `canvas.write`, `document-or-new` also needs `workspace.write`, and a capability that uses the network says what it sends. The `wasm` and `builtin` runtimes are not available for v2. Unknown fields are refused.

**Using another module (`uses`).** A v2 capability may list up to four `uses: [{ "module": "org.example.other", "capability": "draw" }]` (never its own module). A **built-in** module's capability then receives `ctx.use(module, capability, params)`, which runs that capability and returns `{ operations, summary?, method? }` without applying anything; the caller returns the operations as its own result, so they are applied, recorded and undone as the caller's work, under the caller's checks. The call is refused unless the pair is declared, the other module is enabled, and both modules have been granted every permission the used capability needs (it runs with only those). A used capability cannot be a background job and cannot return `derived` or `broadcast`. If the other module is disabled, updated or re-permissioned while the caller works, the result is dropped (`revoked`), like any late answer. Each use is audited as `run.use`. Package modules do not get `ctx.use` yet.

**Module-owned data and views (`models`, `writes`, `views`; module/2, #85 V1-1, format only).** A v2 manifest may declare the *types* of data it owns: `models: [{ id, dataVersion, readsVersions?, schema, maxBytes?, maxInstances? }]`. The schema is an object schema in the same bounded subset as an input schema; `maxBytes` (256 to 65536, default 16384) and `maxInstances` (1 to 64, default 32) bound each type. The instances (`md:<hex>`) are made at run time and are independent of any canvas or view; storing them is a later step (nothing stores or draws anything in this version). A capability that will write them lists `writes: ["<model id>"]`, returns `models` instead of `operations` (never both), and, like the module, needs `module.storage.write`, which is no longer only reserved: declaring models without it is refused. A background job cannot write models yet. `dataVersion` is what the module writes; `readsVersions` lists older versions it can still read, and an instance of any other version is kept untouched and not opened.

**Stored instances (#85 V1-2).** An instance of a model type is one UVA record of kind `model` (`md:<12 hex>`), independent of any canvas or view, owned by one module. A write names the revision it was made against (`expectedRevision`); a change over several instances checks every revision first and then writes them as one all-or-nothing change (the record store's `writeMany`, which survives a crash by rolling forward), so one stale revision fails the whole change and nothing is written. A command id that was already applied answers with the earlier result and writes nothing; reusing it for different data is refused. An undo is a new change with the same precondition: it restores what a command replaced only while that command is still the latest change of every instance it touched, and otherwise reports a conflict (no merging, nothing overwritten); an instance's creation cannot be undone yet. The last few commands of each instance are remembered (at most 20, fewer for large types), so an older command id is no longer recognised. An instance of a data version its module does not read is kept exactly as it is and not opened. Limits: each type has `maxInstances` and `maxBytes`, and all models together are capped (128) because the UVA store shares one document limit with canvases, workspaces and notebooks. There is one writer: a second model store over the same records is refused.

**Writing and reading instances from a capability (#85 V1-3).** A capability whose manifest lists `writes` may return `models` instead of `operations`: either one new instance, `[{ ref: "$m1", model, value }]` (the result names the id the core gave it), or updates of existing ones, `[{ id, model, expectedRevision, value }, ...]` (at most 8; all of them or none, each against the revision it was read at). A result is models or scene operations (or derived objects), never both, and a refused result changes nothing; the one exception is `broadcast`, which may accompany models (#85 V3-A): objects drawn from an instance are ordinary derived objects whose `sourceRef` is the instance id and `sourceRevision` its revision, so a capability that changes the instance announces `broadcast: [{ event: "source-changed", sourceRef: <id> }]` in the same result, this module's bindings to that source turn stale (in every document that holds them), and the person or `update_derived` refreshes them through the declared `derives.refresh` capability, which reads the instance with `ctx.models.read` and returns its revision as `data.sourceRevision`. Nothing marks a binding stale by itself; a module that does not broadcast leaves its drawings as they are; a result may not create and update together, create more than one instance, or write a model its capability did not list. Models are checked after every late-effect check, so a module disabled, updated or re-granted while it ran writes nothing. A capability that needs `module.storage.write` can read its own module's instances with `ctx.models.list(model)` and `ctx.models.read(model, id)`; there is no way to read another module's. Without record storage (no UVA store) a write says storage is unavailable. **Reading instances as the assistant (#85 V1-3b).** For every module that declares `models`, the host adds two read capabilities: `models.list` (the module's instances, no values; optional `model`) and `models.get` (`model`, `id`: one instance with its value and revision). They are the host's, not the module's: found by `search_capabilities` and `get_module_capabilities`, run through `execute_module`, and subject to the same checks as any capability (the module is enabled and holds `module.storage.write`). Their ids contain a dot, which a module's own capability ids never do, so a module cannot shadow them. A listing shows at most 100 instances and never values; a value is at most its type's `maxBytes`. They read only that module's own data. `get_surface_state` also lists the instance index (id, module, type, revision, size, update time, and the module's state; no values). No MCP tool was added. **What happens to stored instances (#85 V1-4).** Instances are never deleted or rewritten because of what happens to their module (there is no delete in this version). A **disabled** module keeps them: its host reads and writes are refused like any capability of a disabled module, `get_surface_state` still lists them with the module's state, and enabling the module brings them back exactly as they were. A **removed** module leaves them as orphans, listed with state `removed`; installing it again (the same module id from the same signer lineage) finds them. A module whose new `dataVersion` does not include the stored one in `readsVersions` neither opens nor changes those instances (`incompatible`); they stay as they were. Taking the data out does not depend on any module running: `node scripts/export-models.mjs <storage dir> [<uva dir>] [--module <id>] [--out <file>]` (server stopped, read-only) writes `estampes.model-export/1` with each instance's owner, type, revision and current value, without history. That is the **only** export of models: workspace bundles and Workspace exports do not carry them yet, so a bundle restored on another server has no model data. There is no import of models yet either.

`views: [{ id, title, reads, actions, ephemeral?, renderer }]` says what a view reads (model ids), which of the module's own capabilities it may ask for (`actions`; each still goes through `execute_module` and every check) and its short-lived state (`ephemeral`, never stored). **How it is drawn is only `renderer: { type, schema, payload }`**, so the same contract serves any renderer. The only type today is `declarative` (`estampes.renderer.declarative/1`), described next; `{}` is still a valid payload (nothing to show). An unknown `type` is refused, and a later type (for example a sandboxed web frame) is added by naming it and its payload schema, gated by `coreCompatibility`; the rest of the view contract does not change. Capability ids never contain a dot, so ids such as `models.list` stay the host's own and a module cannot shadow them.

**The declarative payload (#85 V2-1; the manifest check only, nothing draws it yet).** `payload` is `{}` or `{ root: Node }`, a small tree of fixed controls the host will draw itself (no script, markup or style from the module): `stack` (`children`, `direction` column or row), `text`, `readout` (`label`, `model`, `path`, `format` text, bit or yes-no), and the controls `toggle` (boolean field), `number` (`min`, `max`, `step`), `select` (`options`) and `button`, each with `label` (and `labelI18n`), and for controls an `action` and `params`. `model` must be one of the view's `reads` and `action` one of its `actions`; `path` is a JSON pointer of at most four plain segments that must reach a single value (boolean, number or text) in that model's schema, of the kind the control needs. `params` are scalars or `{ "$": "value" | "instance" | "revision" }`, which the host fills with what the person entered, the id of the instance the view shows and its revision; they must fit the capability's input schema (no unknown input, every required one given). At most 64 nodes, 5 levels, 24 children per stack and 16 options. Anything else, including any field that could carry code, is refused when the manifest is read.

What a v2 module gets when it runs:

- **Only what the capability needs.** The permissions it may use for that call are the ones granted to the module that the capability lists in `needs` (so a module granted `canvas.read` and `canvas.write` whose capability needs only `canvas.write` does not see the document's objects). A v1 module still gets everything granted to it.
- **A document, not an image id.** Its context says what kind of document it works on (`canvas.kind`, `image` or `graph`), the size and the revision, and has no `imageId`.
- **Only that document.** If its input contains the id of any other document (`img:…`, `gph:…` or a copy), the call is refused with the code `cross-document` before the module runs. Its own document's id and ordinary text are fine.

The Store shows the module's ABI (`abi`: `new`, `same`, `upgrade`, `downgrade` or `removed`) in an install or update plan. Packages that come through a module source index are still checked as v1 only. Still to come: the v1 image adapter and Graph refusal, signer lineage and the guard for the person's own edits (5A-3).

## Storage and audit

With `ESTAMPES_STORAGE_DIR`, module data lives in `<storage>/modules/`: `registry.json` (state and grants) and `audit.jsonl` (plans, approvals, refusals, runs and failures; secrets never appear). Without storage, state lives in memory and modules start disabled again after a restart. Objects belong to the canvas (with the default UVA store they are saved in the canvas document inside the UVA store; the legacy store keeps them in the canvas's `canvas.json`; see [Architecture](ARCHITECTURE.md#state-and-persistence)), so they survive a restart even if a module is later disabled; disabling stops new runs but does not delete anything.

## Installing packages

A package is a single JSON file, `estampes.package/1`: the manifest, a map of data files and an ed25519 signature over the sha256 digest of the manifest and files. It is built to be safe to verify: no archive to unpack, no paths that can leave the folder, no URLs to fetch. Only the administrator can put one on the server.

```
# author
node scripts/estampes-module.js keygen mykey
node scripts/estampes-module.js pack module.json --out my.estpkg.json --key mykey.private.pem --key-id mykey
# administrator, on the server (inside Docker: docker compose exec estampes ...)
node scripts/estampes-module.js trust mykey mykey.public.pem "My Name" org.example
node scripts/estampes-module.js copy my.estpkg.json      # into <storage>/modules/inbox/
node scripts/estampes-module.js verify my.estpkg.json
```

Instead of copying files, the administrator can fetch a package from a URL such as a GitHub Release asset (`fetch <url> [--sha256 …]`) or add a publisher's signed index once and pull updates with `source sync`; both only fill the inbox with packages that pass these same checks. See [Distributing modules](modules/DISTRIBUTION.md).

Then open the Store: the package appears under installable packages. Press install, confirm, and approve it on the server with `node scripts/estampes-module.js approve <planId>` (the Store shows the exact command). Installing does not enable: enabling is a second plan that shows the permissions.

| Action | Needs |
| --- | --- |
| install, update, purge | your confirmation **and** administrator approval from the server |
| enable, disable, rollback, uninstall | your confirmation (enabling high-risk permissions also needs administrator approval) |

What the server checks before a version becomes active: size (2 MB) and safe file paths; the manifest and `coreCompatibility`; a runtime this server has (`declarative`, `wasm` or `http`; `builtin` is refused for packages and built-in ids cannot be replaced); the digest; a signature by a key listed in `<storage>/modules/trusted-keys.json` whose `scopes` cover the module id (keys only publish under their own prefixes); then the module's examples run through the same checks as `execute_module` on a throwaway canvas. A failure at any step leaves the old version active.

Layout under `<storage>/modules/`:

```
inbox/*.estpkg.json                     what the administrator offers
packages/<id>/<version>/package.json    verified, never modified (read-only)
lock.json                               active digest per module and the history
trusted-keys.json                       who may publish which ids
approvals/<planId>.json                 single-use administrator approvals
registry.json, audit.jsonl              state, grants, audit log
```

Rollback restores a kept version byte for byte and checks it against `lock.json`; if a stored file was changed on disk, the module is marked failed at startup instead of running. Uninstall leaves canvas objects in place and keeps stored versions; purge deletes the stored versions.

Declarative modules (code-free): each capability lists scene operations with placeholders, filled from the validated input. See `examples/modules/callout` and `examples/modules/markers`.

### Templates

Declarative `operations`, and an http capability's `request` and `response.operations`, are JSON templates. A placeholder is an object with exactly these keys:

| Placeholder | Gives |
| --- | --- |
| `{"$param": "name"}` | the validated input value `name`; left out if absent |
| `{"$response": "a.b.0.c"}` | (http `response` only) that path of the JSON reply |
| `{"$item": "a.b"}`, `{"$item": "."}` | inside `$each`: a field of the current item, or the whole item |
| `{"$index": 1}` | inside `$each`: the item's position plus the number given (`1` numbers from 1) |

Any of them may add `"default": value` (used when the value is absent) and `"as": "string"` (turns a number or boolean into text, for example for an info-card `value` or a text label).

**Arithmetic.** `{"$calc": "x + 0.03", "with": {"x": {"$item": "x"}}}` evaluates an expression over named numbers (at most 8, lower-case names). It uses Estampes's own expression parser, the one function plots use (`+ - * / ^`, `min`, `max`, `abs`, `sqrt`, `round`, trigonometry, `pi` …), never JavaScript. A value that is not a number, or a result that is not finite, fails the call. `"as": "string"` works here too.

**Lists.** An element of a template array of the form `{"$each": <placeholder>, "do": <template>, "max": 20}` is replaced by one copy of `do` per item of the list the placeholder gives (`max` defaults to 64, at most 200). It works for operations (one object per detected thing) and inside props (one info-card row per keyword). Example, one ring per input point:

```json
{ "$each": { "$param": "markers" }, "do": { "op": "object.create", "type": "shape",
  "props": { "kind": "circle", "x": { "$item": "x" }, "y": { "$item": "y" }, "r": 0.02 } } }
```

For example, `examples/modules/markers` puts each label beside its ring with `$calc`, and `examples/modules/regions` lifts a label above its box with `max(y - 0.02, 0)`.

**Referring to an object from the same batch.** Give the creating operation `"ref": "ax"` and use `"$ax"` (a dollar sign and the ref) where an object id is expected, for example a shape's `frame`. See `examples/modules/linefit`.

## Writing a module

A guided walkthrough is in the [module quick start](modules/QUICKSTART.md); [Testing modules](modules/TESTING.md) covers scene operations, permissions, revisions and failure cases. The commands in short:

```
node scripts/estampes-module.js init mymodule org.example.mymodule            # or --runtime wasm / http
node scripts/estampes-module.js test mymodule/module.json                     # manifest + examples, like an install
node scripts/estampes-module.js try mymodule/module.json <capability> --example 1 --out result.png   # one run, offline, with a picture of the result
node scripts/estampes-module.js keygen mykey                                  # once
node scripts/estampes-module.js pack mymodule/module.json --out org.example.mymodule.estpkg.json --key mykey.private.pem --key-id mykey [--file module.wasm=mymodule/module.wasm]
```

Give every capability `examples`: they are what the install self-test runs, and what the Store shows. The administrator then trusts your public key for your id prefix (`trust`) and drops the package in the inbox; see Installing packages above.

## WebAssembly modules

A module that needs real code ships one `.wasm` file in its signed package (`runtime: {kind: "wasm", entry: "file.wasm", abi: "estampes.wasm/1"}`). It runs in its own child process, created for the call and killed afterwards, so nothing carries over between calls and an engine crash (for example an allocation failure) cannot take the server down. The module can import nothing: no clock, files, network or host functions, only the bytes it is handed. Limits come from the manifest `limits`:

- `timeMs` (default 2000): the worker is terminated when it runs out.
- `memoryMb` (default 16): the module's binary must declare a memory maximum no larger than this (and tables of at most 10,000 entries with a declared maximum); a package that declares more, none or shared memory is refused at verification, before anything runs.
- `outputKb` (default 256): a longer reply is refused.

ABI: export `memory`, `alloc(len) -> ptr` and `handle(ptr, len) -> ptr`. The host writes a JSON request `{capability, params, module, canvas}` at the pointer `alloc` returned; `handle` returns a pointer to a 4-byte little-endian length followed by a JSON reply `{operations, summary, data, method}`. The reply goes through the same scene-operation checks as any other module. To refuse a call with a message the user and model can read (bad input your schema cannot express, a computation that has no answer), reply `{"error": "what went wrong"}`; the call then fails with that text (at most 300 characters).

The request: `capability` (the id), `params` (the input after schema validation), `module` (`{id, version}`) and `canvas`: `null` without a target, else `{imageId, kind, width, height, revision}` (`kind` is `"graph"` for a Graph document, `"image"` otherwise), plus `objects`, `marks` and `plot` when the module holds `canvas.read`. `plot` is the plot context: `{version: 1, kind, frames: [{id, xRange, yRange, ...}], plots: [{id, frame, expression, domain, ...}]}`, the axes and function plots of the canvas, the same for both kinds; a module that plots should read it rather than the object list. `alloc` receives the request's byte length, which with `canvas.read` can be large (up to 200 objects); size the buffer it hands out from `limits.memoryMb`, not from your own test inputs. There is no JSON library: `examples/modules/linefit/linefit.c` has a small number-list reader and a number writer in freestanding C that you can copy. A capability whose input has required fields and no `examples` is skipped by the install self-test. Example with a C source and build line: `examples/modules/wasm-hello`.

## Talking to external services (http modules)

An `http` module contains no code. Each capability has a `request` (method GET or POST, a fixed `path`, `query`/`body` filled from the input with `{"$param": name}`, optional `secretHeaders`) and a `response` (scene operations and/or `data` read from the JSON reply with `{"$response": "a.b.0.c"}`). The manifest must list the hosts in `network.allow` and say in `network.dataFlow` what is sent; the Store shows both before anything is enabled, and enabling needs the administrator's approval. Example: `examples/modules/ocr-http`.

Every request goes out through one place, `src/modules/egress.js`, which enforces:

- the module holds `network.request.approved` and the host is one of its `network.allow` names (https, port 443, exact match);
- the name is resolved on the server and every address must be public: loopback, private, link-local (cloud metadata), carrier-grade NAT, multicast and reserved ranges are refused, and the connection is made to the address that was checked, so a DNS answer cannot change afterwards;
- no redirects, no cookies, only `Accept`/`Content-Type` headers plus the declared secret headers, a time limit (`limits.timeMs`), a response size limit (`limits.outputKb`), and a 25 MB request limit;
- API keys are added by the server from `<storage>/modules/secrets.json` (mode 600) or an environment variable (name shown by `secret set` and `secret status`; for example `ESTAMPES_MODULE_SECRET_ORG_DEXAMPLE_DOCR_SAPI_KEY` for `org.example.ocr` / `api_key`, where `_D` stands for a dot, `_M` for a hyphen and `_S` separates the id from the name, so two ids can never share a variable), only for secrets the module declared and only when it holds `module.secrets`. Set one with `echo "$KEY" | node scripts/estampes-module.js secret set <moduleId> <name>`; `secret status <moduleId>` lists which declared secrets are set (names only). Module code never sees them, and they are kept out of the audit log.
- every request is audited (host, status, sizes, time), never its content.

Installing never sends anything: the self-test checks the requests the examples would make and runs each example's `mockResponse` (a recorded reply) through the response mapping, so the conversion from reply to scene operations is tested offline (see [HTTP specifics](modules/TESTING.md#http-specifics)).

Besides JSON, a request can carry a URL-encoded `form` or a `multipart` body with a file part (the image's bytes; needs `asset.read.selected`), and any string in a body may contain `${secret:name}` for a declared secret, which the server fills in. The built-in module below uses these. A declarative `http` module can send the target canvas's **original image** (as stored: JPEG, PNG or WebP; never overlays or other canvases) with a multipart request:

```json
"request": { "method": "POST", "path": "/v1/detect",
  "multipart": { "fields": { "prompt": { "$param": "prompt" } },
                 "file": { "field": "image", "source": "canvas-image" } } }
```

It needs `asset.read.selected` (validated in the manifest), a target canvas, and, like every request, `network.request.approved` and the administrator's approval; `network.dataFlow` and the profile must say the image is uploaded. In `module test` and the install self-test a 1×1 placeholder PNG stands in for the image, so nothing real is read. Example: `examples/modules/regions` (an external detector whose boxes are drawn with `$each`).

## Background jobs

A capability marked `"async": true` returns at once with a job id (`job_` plus 12 hex digits) and does its work in the background, for services that take minutes. The model checks it with the fixed tool `get_module_job` (optionally waiting up to 25 seconds); the result lands on the canvas when the job is done, with no revision check, since the canvas may have moved on. `limits.jobMs` (default 10 minutes, at most 30) stops a job that runs too long, and a stopped job never applies a late result. Jobs are kept in `<storage>/modules/jobs.json` (the last 100, summaries only); one that was running when the server stopped shows as `interrupted`.

## Info cards

Any module can attach a fact sheet to a canvas with an `info-card` object (`title`, `rows` of `label`/`value`/optional `href`, optional `shown`). The widget groups cards by module under the canvas objects. Each card folds open and closed and starts folded. A card with `shown: false` is not displayed until the user brings it back, so a module (or GPT, through a capability parameter such as plate solving's `showCard`) decides what is worth showing; the user can also hide any card and list the hidden ones to show them again. Only `https` links are made clickable. That choice is kept in the user's browser and never changes the canvas; the model still reads every card's rows in the canvas data.

## Plate solving (`org.estampes.astrometry`)

A built-in module that finds where a photo of the sky points, using [Astrometry.net](https://nova.astrometry.net). It uploads the chosen image (marked private there) with the administrator's API key, polls until the solution is ready, then marks the named stars and objects on the canvas (brightest named stars first, overlapping labels skipped) and returns the field's centre (RA/Dec in degrees and hms/dms), size, scale (arcsec per pixel), rotation, radius and parity, with constellation tags, the objects in the field and links (result page, WCS file, Legacy Surveys sky browser). The same facts go on an info card (`showCard: false` keeps it folded away). A second capability, `sky_position`, draws an all-sky map with the field outlined (approximate: it ignores distortion and flipping) from the centre and size, with no network. Optional hints (scale range, rough position) make solving faster. It reads the stored copy of the image, so storage must be on, and it takes JPEG or PNG.

Setup (administrator):

1. Get an API key from your profile on nova.astrometry.net.
2. Store it where the server runs. With Docker: `echo "$KEY" | docker compose exec -T estampes node scripts/estampes-module.js secret set org.estampes.astrometry api_key`. Without Docker: the same command with `ESTAMPES_STORAGE_DIR=<your storage folder>` in front (after `npm install`). Or set the environment variable `ESTAMPES_MODULE_SECRET_ORG_DESTAMPES_DASTROMETRY_SAPI_KEY` for the server. (`secret status` reads installed packages' declared secrets, so it does not list this built-in module's key; check that `<storage>/modules/secrets.json` exists, or run a solve: a missing key is reported by the job.)
3. Enable the module in the Store; it needs the administrator's approval because it sends images to an external host.
4. Give ChatGPT a night-sky photo and ask it to solve it. It starts a job, checks it with `get_module_job`, and when done the canvas shows the named objects. A failed job says why (no key set, key refused, no stored copy of the image, unsupported format, or Astrometry.net could not solve it).

## Roadmap

Each phase is its own change and keeps the rules above.

1. Contract, scene objects, Graph and the Store (0.10.0).
2. Managed packages: signed packages, a version lock file, transactional install, rollback and administrator approval separate from the connector key (0.12.0). Not planned: arbitrary npm packages, shell commands, access to the Docker socket, packages fetched from arbitrary URLs.
3. An isolated WebAssembly runtime with time, memory and output limits (0.13.0).
4. Author tools (0.14.0), the controlled network path for adapters (0.15.0), image upload, background jobs and the Astrometry.net plate-solving module (0.16.0). Still to come: an OCR module.
5. The SymPy calculator module (0.17.0), surfaces and panels (0.18.0), and the workbench with its calculator windows (0.19.x).

## Direct Canvas editing and deletion recovery

The object panel exposes function label modes (`auto` follows the expression, `custom` preserves the supplied label), custom label text, and the axes title as separate fields. Existing titles are user-supplied text and do not automatically change when a function changes.

The widget can restore the last deletion with `edit_scene_object {imageId, restore:true}`. Up to ten deletion batches are saved with the canvas; deleting axes and their dependent objects forms one batch. Restoration preserves object IDs, frame references and creation order, validates props and capacity, and refuses locked layers or ID conflicts atomically. It uses Core only and works with Graph disabled. The recovery button remains visible after the last object is deleted, and recovery history survives storage reload. Deletions predating this history cannot be reconstructed by this mechanism.

## Planned: module translations

Text a module writes (result summaries, info cards) is shown as written today and is not translated. The multilingual RFC (`docs/rfc/i18n/README.md`, §6.3 and D8) makes module locales a required part of the module system v2 design: a `locales/` folder in the package, `{key, params}` outputs, namespaced keys, and module text rendered as untrusted data. Until v2 freezes the view and output contracts, new module output should keep user-visible text in one place so it can move to `locales/` without a contract change. Nothing here changes `estampes.module/1`.
