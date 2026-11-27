# Module data and views: author's guide

How a module keeps its own data (**models**), shows it as a panel (**views**), and links it to what is drawn on a canvas. This is the guide; the exact rules are in [Modules](../MODULES.md) and [Surfaces](../SURFACES.md).

**Who can use this today.** A module whose runtime can return `models` can write data: the **built-in** runtime, and a signed **declarative** package through a `models` template on a capability (see [Modules](../MODULES.md)). Http modules answer with scene operations only, and the WebAssembly runtime is not available for `estampes.module/2`. The working examples are the tests named below (invented modules, run in-process and in a fake-host browser, not on a real ChatGPT or Claude). A declarative package can write and read its data, and can draw a view with its own web page in an isolated frame (section 6). A view drawn that way has been tested only in Chromium with a scripted host; it has not been run on ChatGPT, Claude desktop or mobile, or a non-Chromium browser.

## The three kinds of state

| Kind | Where | Lives |
| --- | --- | --- |
| **Canonical data** (a *model* instance) | the UVA store, record kind `model`, id `md:<12 hex>` | until the owner deletes it (nothing deletes one today); survives restart, disable and removal of the module |
| **View state** (which view a panel shows, which instance it is bound to) | the surface, per workspace | with the surface; carried by bundles (the view, not the binding) |
| **Ephemeral state** (a half-typed number, focus, a pending action) | the widget only | never stored |

Keep the truth in models. A view never stores values: it shows an instance and asks a capability to change it.

## 1. Declare a model

```json
"models": [{ "id": "adder", "dataVersion": 1, "schema": { "type": "object", "additionalProperties": false,
  "required": ["a", "sum"], "properties": { "a": { "type": "boolean" }, "sum": { "type": "integer", "minimum": 0, "maximum": 3 } } } }]
```

The schema uses the same bounded subset as an input schema. `maxBytes` (default 16384) and `maxInstances` (default 32) bound the type; the server holds at most 128 instances in total. When you change the shape, raise `dataVersion` and list the old one in `readsVersions` if you can still read it; an instance of a version you do not list is kept untouched and not opened. Declaring models requires the permission `module.storage.write`.

## 2. Write it from a capability

A capability that lists `writes: ["adder"]` returns `models`: one new instance, `[{ ref: "$m1", model: "adder", value }]`, or updates, `[{ id, model, expectedRevision, value }]` (at most 8, all or none, each against the revision you read). A result is models **or** scene operations, never both. The one exception is `broadcast`, which may come with models (below). Read your own instances with `ctx.models.list(model)` and `ctx.models.read(model, id)`. A retry with the same `commandId` is answered, not repeated; a stale `expectedRevision` is a `conflict` and nothing is written.

## 3. Show it: a view

```json
"views": [{ "id": "adder-view", "title": "Adder", "reads": ["adder"], "actions": ["set"],
  "renderer": { "type": "declarative", "schema": "estampes.renderer.declarative/1",
    "payload": { "root": { "type": "stack", "children": [
      { "type": "readout", "label": "Sum", "model": "adder", "path": "/sum" },
      { "type": "toggle", "label": "A", "model": "adder", "path": "/a", "action": "set", "params": { "id": { "$": "instance" } } } ] } } } }]
```

The tree is made of fixed controls (`stack`, `text`, `readout`, `toggle`, `number`, `select`, `button`; at most 64 nodes, depth 5). The module ships no markup, script or style. A control runs one of the view's own `actions` through `execute_module`, with `$value`, `$instance` and `$revision` filled in; every check of a normal call applies. Values are read through the host's `models.get`. The host adds `models.list` and `models.get` to every module that declares models: the assistant and the widget read instances that way, without running your module's code (they are refused while the module is disabled).

`renderer.type` names the renderer, so a different one (a sandboxed web view, later) can use the same `models`, `reads` and `actions`. An unknown renderer type is refused at manifest time.

## 4. Link a model to what is drawn

An object a capability draws from an instance is an ordinary **derived object** ([Derived bindings](../DERIVED-BINDINGS.md)): the drawing capability returns `derived: [{ object: "$o", sourceRef: <instance id>, sourceRevision: <its revision>, inputsHash }]` and declares `derives.refresh` pointing at a capability that redraws one object from `ctx.models.read` and returns `data.sourceRevision`. A capability that changes the instance returns `broadcast: [{ event: "source-changed", sourceRef: <instance id> }]` **in the same result**; the drawn objects then show as stale, in every document that holds them, and the person (or `update_derived`) refreshes them. Nothing goes stale by itself. If the person edited the drawn object, the refresh pauses as a conflict instead of overwriting it.

## 5. Data that must outlive the module, and leave the server

- Disabling or removing a module never deletes its instances; installing it again finds them.
- `node scripts/export-models.mjs <storage dir> [<uva dir>]` exports every instance without running any module.
- A workspace bundle carries the instances its views are bound to (`models.json`); import puts them back under their own ids and never overwrites an id that exists.

## Examples that run

- `tests/module-declarative-models.test.js`: a signed declarative package creating and updating its own instance.
- `tests/declarative-view.test.js`, `tests/module-models-router.test.js`: the contract and the write path.
- `tests/module-view-e2e.test.js`: a full adder drawn from a declarative tree, all eight input combinations (scripted host).
- `tests/module-models-derived.test.js`: a model change making a drawn object stale and a refresh redrawing it.
- `tests/model-bundle.test.js`: instances in a bundle.

## 6. Draw a view with your own web page (`sandboxed-web`)

A view can name `renderer.type: "sandboxed-web"` (`estampes.renderer.sandboxed-web/1`). The widget then runs a page from your package in an isolated frame. The manifest carries configuration only; the code is files of the signed package.

```json
"permissions": ["module.storage.write", "ui.sandboxed-frame"],
"views": [{ "id": "panel", "title": "Circuit", "reads": ["circuit"], "actions": ["save_circuit"],
  "renderer": { "type": "sandboxed-web", "schema": "estampes.renderer.sandboxed-web/1", "payload": {
    "entry": "ui/index.html", "assets": ["ui/app.js", "ui/app.css"], "shims": ["memory-storage", "no-service-worker"],
    "state": { "model": "circuit", "report": { "action": "save_circuit", "path": "/text", "minIntervalMs": 2000 } } } } }]
```

- `ui.sandboxed-frame` is a **high-risk** permission: the Store shows it as such and an administrator approves it. It carries no network, storage or canvas right.
- `entry` and `assets` are package files under `ui/` (at most 12 assets, 1.5 MB in all; `.js .css .json .svg .png .jpg .webp .gif .woff2 .txt`). Nothing is loaded from a URL. The widget inlines the scripts, styles and images the entry page names with a relative `src` or `href`; anything else it names is dropped. A script in `<head>` runs before `<body>` exists, so put it at the end of `<body>` or wait for `DOMContentLoaded`.
- `shims` are small fixes the host injects before your code, from a fixed list: `memory-storage` (in-memory `localStorage` / `sessionStorage`, because an opaque origin has none) and `no-service-worker` (removes `navigator.serviceWorker`). You can name none and ship a patched build instead.
- `state` says where the frame's state is kept: `report.action` must be one of the view's actions and must write `state.model`. The frame's state at JSON pointer `path` is sent to that action as input `param` (default `data`), with `id` and `revision` of the bound instance when there is one, at most once per `minIntervalMs` (500 to 60000). A report is based on the instance and revision the frame was last told about, so an edit made elsewhere in the meantime makes it a refused conflict rather than an overwrite; stopping, closing or reloading a view cancels the actions and reports still waiting. The assistant reads it with `models.get`; the instance's `updatedAt` and `revision` come from the store, so they say when it was last reported and the frame cannot forge them. An open frame is told about a change made elsewhere at the next refresh (about every 5 seconds).

**What the host fixes, whatever the module says.** The frame is `sandbox="allow-scripts"` and nothing else (the widget reads the attribute back and refuses any other value), so it has an opaque origin: no cookies, no access to the widget or the session. Its document has a CSP with `connect-src`, `frame-src`, `worker-src` and `form-action` set to `'none'` and only the scripts the host hashed allowed (no `eval`). A CSP cannot stop a frame from navigating itself with the data in the address, so the widget also adds `frame-src about:` to its own document before the first frame exists (checked in Chromium: with it a navigation to a local server never reached it; without it the data did), and a frame that loads a second time is stopped. A host that ignores that policy is not verified. Before anything runs, every file is checked against the size and SHA-256 the server computed from the verified package; a mismatch is not loaded. One frame per view, four panels at most.

**The channel** is one `MessageChannel` per frame, versioned `estampes.ui/1`; inside the frame it is `window.estampes`:

| Direction | Type | Content |
| --- | --- | --- |
| frame to host | `ready` | `estampes.ready()` when the page can take data |
| host to frame | `init` | `{ locale, view, title, actions, instance: {id, revision} or null, revision, data }` |
| host to frame | `changed` | `{ revision, data, own }` (`own`: this frame's own action or report caused it) |
| frame to host | `action` | `estampes.action(name, params, expectedRevision)` returns a promise; `name` must be one of the view's `actions` |
| frame to host | `report` | `estampes.report(data)` (throttled, see `state`) |
| host to frame | `result` / `error` | the answer to an action; `error.code` is `not-allowed`, `input`, `conflict`, `busy` or the module's own |

An action runs through `execute_module` with every check an ordinary call has; the frame sees no other capability, module or session. A message over 64 KB, more than 30 a second, or of an unknown type is dropped and counted (`data-dropped` on the view). What the engine in the frame does (loading, running, reading a node) stays in the frame; only an action or a report ever becomes stored data, and a running simulation is never stored.

**Delivery.** The widget fetches the files through the module's host capability `ui.get` (one chunk per call, sized so the whole result stays inside `ESTAMPES_MAX_RESULT_CHARS`, about 49 KB with the default, answered from the verified package). That is one transport, measured at 14.7 s for 1.3 MB on claude.ai web in #220 when each call is an app-only call, so a faster one is expected; it sits behind `wb.svTransport`, so replacing it changes neither the manifest nor the renderer.

**Not there**: network access from the frame, loading code from a URL, a consent screen inside the frame, a live round trip from the assistant into a running frame, Service Workers and Web Workers, and streaming state. The test is `tests/sandboxed-view-e2e.test.js` (a scripted host in Chromium) and `tests/sandboxed-view.test.js` (manifest, package, `ui.get`).

## What is not there yet

No delete or undo of an instance's creation, one new instance per result, no reading another module's instances, and no model data in a view's canvas selection.
