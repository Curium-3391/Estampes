# The calculator's boundary with the core (decision record, issue #174)

Status: **proposed**. The target below is waiting for the maintainer's confirmation; nothing in this page changes behaviour.

## Target

The calculator (`org.estampes.cas`) is a **removable built-in module**: it ships with Estampes and may use more than a third-party module can (it is registered in `src/modules/index.js` and runs in the server process), but the core, Graph and the Workbench must keep working when it is disabled, its service is unreachable, or it is removed. It is **not** promised to be an independently installable package; that would need a package runtime for the SymPy service, notebook storage and panels, and is a separate decision.

The SymPy service (`cas-service/`) stays a separate, network-disabled process reached over a Unix socket. Nothing here changes its sandbox or limits.

## Who owns what

| Piece | Owner | Notes |
| --- | --- | --- |
| Module registry, router, permissions, jobs, audit | platform | knows no module id |
| Derived bindings, refresh, broadcast, index | platform | generic; `tests/derived-core-names-no-module.test.js` enforces it |
| Scene operations, object types, expression parser | platform | the calculator uses them, never the reverse |
| Panel kinds (`PANEL_KINDS`, includes `calculator`) | platform | the kind is a platform concept; what a calculator panel does is the calculator's |
| Notebooks (`src/cas/notebooks.js`), SymPy client (`src/cas/client.js`), plot check (`src/cas/bridge.js`) | calculator | live outside the module directory today, used only by it and by its host wiring |
| Calculator capabilities (`src/builtin-modules/cas/`) | calculator | |
| Graph drawing operations | Graph | the calculator reaches them only through a documented contract (174-2) |

## Where the calculator still shows in host code (the inventory)

- `src/builtin-modules/cas/index.js` imports `../graph/index.js` and calls `graph.run("plot_function" | "update_plot")`. **A private dependency; replaced in 174-2:** the calculator now declares `uses` for Graph's `plot_function` and `update_plot` in its manifest and calls them through `ctx.use`. Graph must be enabled for plotting.
- `src/modules/index.js`: static list of built-in modules. Intended; built-ins are registered this way.
- `server.js`: builds the SymPy client and the notebook store, passes them to the module (`configureCas`), reports `casStatus` in health, includes notebooks in bundle export/import, and gives the calculator's surface tool the client. Calculator-specific wiring; candidate for module-declared initialization (174-4).
- `src/surface/refresh.js`, `src/surface/mcp-tools.js`: the calculator panel's own tool (`surface_cas`) and refresh button. First-party panel code; allowed to name the module.
- `src/uva/record-store.js`: reads notebooks as a record kind, never changes them.
- `public/calculator.js`: the panel's front end.
- Already generic: derived bindings and the router's derived section. In `server.js` the note after `execute_module` (`afterRunNote`) no longer names the module.

## Rules that stay

Notebook ids and revisions, link records (`cellRevision`), stale and recompute semantics, exports and imports, the UVA formats and the SymPy sandbox do not change. No privilege is added.

## Planned steps

1. This page (174-1).
2. The calculator asks the host for Graph's drawing operations through a declared use of a capability instead of importing Graph (174-2).
3. Tests for the calculator being absent: disabled, removed, service down, re-enabled (174-3, `tests/cas-absence.test.js`; done). They cover the module host; the wiring still in `server.js` is not exercised there.
4. Moving the calculator's server wiring behind module-declared hooks, only if 174-2 and 174-3 show it is worth it (174-4).
