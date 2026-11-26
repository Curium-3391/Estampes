# Module data and views: author's guide

How a module keeps its own data (**models**), shows it as a panel (**views**), and links it to what is drawn on a canvas. This is the guide; the exact rules are in [Modules](../MODULES.md) and [Surfaces](../SURFACES.md).

**Who can use this today.** A module whose runtime can return `models` can write data: the **built-in** runtime, and a signed **declarative** package through a `models` template on a capability (see [Modules](../MODULES.md)). Http modules answer with scene operations only, and the WebAssembly runtime is not available for `estampes.module/2`. The working examples are the tests named below (invented modules, run in-process and in a fake-host browser, not on a real ChatGPT or Claude). A declarative package can write and read its data; a package cannot yet draw a view of its own beyond the built-in renderers.

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

## What is not there yet

No delete or undo of an instance's creation, one new instance per result, no reading another module's instances, no model data in a view's canvas selection, and no renderer other than `declarative`.
