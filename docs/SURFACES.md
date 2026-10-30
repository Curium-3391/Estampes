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
  "uiSchemaVersion": 1, "defaultBinding": "surface.casNotebook", "maxInstances": 2,
  "capabilityBindings": ["calculate", "define", "get_notebook", "recompute", "plot_result"],
  "permissions": ["cas.compute", "canvas.read", "canvas.write", "workspace.write"] }
```

A panel is data. `kind` names a renderer that ships with Estampes (`canvas`, `graph`, `calculator`, ...); a manifest cannot carry HTML, script or CSS, unknown fields are refused, and an unknown kind is shown as an inert placeholder. `capabilityBindings` must be capabilities of the same module and `permissions` a subset of the module's. **Opening a panel never enables a module or grants anything**: every action a panel triggers goes through the module router, which checks the module is enabled and the grant covers the capability each time.

## Tools

| Tool | Who | Purpose |
|---|---|---|
| `get_surface_state` | model | open panels, calculator cells with exact results, status, freshness and Graph links (bounded) |
| `manage_surface_panels` | model | open or close a panel on the user's screen (never enables a module) |
| `surface_get_state`, `surface_apply`, `surface_cas` | widget only | read the surface; open/close/arrange panels; run calculator capabilities for a panel |

`surface_apply` ops: `open-panel {module, panel}`, `close-panel {panelId}`, `layout {profile, layout}` where `layout` is one of `add`, `remove`, `focus`, `arrange {panelId, rect, mode?, dock?}`, `minimize`, `restore`, `maximize`, `reorder {order}`, `sheet`, `reset`.

The widget side (window manager, calculator panel) is described in [WORKBENCH.md](WORKBENCH.md).

## Limits of this version

The Graph panel and the photo canvas share one viewport (`p:canvas`); a second, independent Graph viewport is not implemented. Single-user trust boundary: two widgets of the same user cannot overwrite each other silently (revision check), but there is no multi-user editing.
