# Visual Surface, panels and layouts

A **Surface** is the one place where the photo / Graph canvas and module panels (today: the scientific calculator) are shown together. Modules extend one shared visual state; they are not separate apps. This page describes `estampes.surface/1` and `estampes.panel/1`..

Both formats are Estampes's own, not part of MCP.

## Three kinds of state

| What | Where | Closing a panel... |
|---|---|---|
| Data: images, marks, Graph objects, calculator notebooks | canvas store, `<storage>/cas/notebooks` | ...never touches it |
| Computation: SymPy results, Graph curves | modules | ...never touches it |
| Presentation: which panels are open, where, how big | `<storage>/surfaces/<id>.json` | ...only changes this |

Geometry is in **surface units** (0..1 of the work area), never in image coordinates, so moving a panel cannot move a mark. Each device profile (`desktop` >= 900 px wide, `tablet`, `mobile`) has its own layout; changing one never rewrites another. Profiles are chosen from the host's real container size, not the user agent.

## `estampes.surface/1`

A surface is keyed by what it shows (`imageId` or `ws:` workspace id), so reopening a canvas finds the same surface. Fields: `surfaceId` (`sf:...`), `revision`, `panels[]` (`panelId`, `module`, `panel`, `kind`, `open`, `notebook?`), `layouts{desktop,tablet,mobile}` (`placements[panelId] = {rect{x,y,w,h}, z, mode docked|floating|minimized|maximized, dock}`, `order`, `active`, `sheet`).

Rules: the canvas panel (`p:canvas`) always exists and cannot be closed; a panel can be dragged only inside the work area and never below a minimum size (so it can always be reached); edges snap to the work area and neighbours; closing keeps the notebook; at most 12 panels. Writes are atomic and revision-checked (`expectedRevision`), with `idempotencyKey` for replays.

## `estampes.panel/1` (in `estampes.module/1` manifests)

```json
{ "schema": "estampes.panel/1", "id": "calculator", "title": "Scientific CAS", "kind": "calculator",
  "uiSchemaVersion": 1, "defaultBinding": "surface.casNotebook", "maxInstances": 4,
  "capabilityBindings": ["calculate", "define", "get_notebook", "recompute", "plot_result"],
  "permissions": ["cas.compute", "canvas.read", "canvas.write", "workspace.write"] }
```

A panel is data. `kind` names a renderer that ships with Estampes (`canvas`, `graph`, `calculator`, ...); a manifest cannot carry HTML, script or CSS, unknown fields are refused, and an unknown kind is shown as an inert placeholder. `capabilityBindings` must be capabilities of the same module and `permissions` a subset of the module's. **Opening a panel never enables a module or grants anything**: every action a panel triggers goes through the module router, which checks the module is enabled and the grant covers the capability each time.

## Tools

| Tool | Who | Purpose |
|---|---|---|
| `get_surface_state` | model | open panels, calculator cells with exact results, status, freshness and Graph links (bounded) |
| `manage_surface_panels` | model | open or close a panel and show the surface: on the given `imageId`, or with no canvas given the calculator alone (a blank canvas stays behind it, one click away). `notebook` attaches a calculation the model already made. Never enables a module |
| `surface_get_state`, `surface_apply`, `surface_cas` (also `set_options`, `refresh_links`), `surface_cas_cancel` | widget only | read the surface; open/close/arrange panels; run calculator capabilities for a panel; stop a running calculation |

`surface_apply` ops: `open-panel {module, panel}`, `close-panel {panelId}`, `layout {profile, layout}` where `layout` is one of `add`, `remove`, `focus`, `arrange {panelId, rect, mode?, dock?}`, `minimize`, `restore`, `maximize`, `reorder {order}`, `sheet`, `reset`.

The widget side (window manager, calculator panel) is described in [WORKBENCH.md](WORKBENCH.md).

## Limits of this version

The Graph panel and the photo canvas share one viewport (`p:canvas`); a second, independent Graph viewport is not implemented. Single-user trust boundary: two widgets of the same user cannot overwrite each other silently (revision check), but there is no multi-user editing. Opening the `graph` panel (button or `manage_surface_panels`) therefore does not add a window: it brings `p:canvas` forward, restoring it if minimized or covered by a maximized window.

## Module views as panels (#85 V2-2)

A view declared in a module/2 manifest (`views[]`, see [Modules](MODULES.md)) is offered as a panel of kind `module-view` with id `view-<view id>` (up to 4 open at once), without the module writing a `panels[]` entry. Opening it is an ordinary surface action: it needs the module enabled, never enables it and grants nothing. The surface stores on the panel only which view it shows (`view`) and, if the open op named them (`models: { <model id>: <instance id> }`, checked against the module's own instances), which instance of each model it is bound to; bundles carry the view but not instance bindings, which belong to the server they were made on.

`surface_get_state` and `surface_apply` (the widget's app-only tools) add `moduleViews` for open module-view panels: the view's `reads`, `actions` and renderer envelope, and for each model the bound instance (the explicit one, else the module's most recently changed instance, else none) and up to 20 instances to choose from. The assistant's `get_surface_state` adds only `views`: each open view's panel, module, view and bound instances (no payload, no values). Values are read through the host's `models.get` capability. A panel whose module is disabled keeps its place and its data; one whose module or view is gone shows as unavailable. Nothing draws the panel yet (V2-3).
