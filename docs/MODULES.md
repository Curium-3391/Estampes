# Modules

Estampes core is a shared canvas: you, GPT and tools look at the same picture, point at it, annotate it and check claims about it. A **module** adds a capability that produces or analyses things on that canvas, such as plotting a function. Modules extend how people and AI interact, not what GPT can do in general: email or search belong to ChatGPT's own apps.

Status: this page describes what is implemented in 0.12.0 (the contract, the built-in Graph module, the Store and managed packages). Isolated runtimes and adapters are planned and marked below.

## How it fits together

```
GPT ── execute_module ──▶ router ──▶ module (returns data only)
                             │            │ scene operations
user ─ Store / canvas ─▶ lifecycle        ▼
                          audit      core: validate, apply all-or-nothing,
                                     revision, provenance, render ──▶ canvas
```

- The model sees five fixed tools. Enabling a module never changes the tool list, so there is nothing to reconnect.
- A module never touches canvas state. It returns scene operations; the core validates them, assigns ids and draws with its own renderer. Modules cannot ship HTML, scripts or SVG.
- Changing what is enabled takes a **plan** the user confirms in the Store. The model can prepare a plan but cannot approve it: committing needs a one-time consent token delivered only to the Store widget.

## Manifest: `estampes.module/1`

Estampes's own format (not an MCP standard). Validated strictly: unknown fields, unknown schema keywords, unbounded strings or arrays, and nested regex quantifiers are refused.

| Field | Meaning |
| --- | --- |
| `id` | Reverse-DNS name such as `org.estampes.graph`. A name, not proof that the publisher owns the domain. |
| `version`, `coreCompatibility` | Module version; range of Estampes versions it works with (for example `>=0.10.0 <1.0.0`). |
| `runtime` | `builtin` (ships with Estampes), `declarative` (scene-operation templates, no code), later `wasm`. |
| `permissions` | What it may do, granted when enabled (below). |
| `capabilities[]` | `id`, description, `inputSchema` (JSON Schema subset), `target` (`none`, `canvas`, `canvas-or-new`), optional narrower `permissions`, examples. |
| `network`, `secrets` | Reserved for adapters: hosts it may call with a description of what data leaves, and named secrets the administrator provides. |

## Permissions

| Permission | Risk | Meaning |
| --- | --- | --- |
| `canvas.read` | low | Read objects and mark summaries of the target canvas |
| `canvas.write` | low | Add objects and change its own |
| `workspace.write` | low | Create new blank canvases |
| `asset.read.selected` | medium | Read pixels of the target image or region |
| `module.storage.write` | medium | Keep its own data on the server |
| `network.request.approved` | high | Send requests to its listed hosts (may upload images) |
| `module.secrets` | high | Use administrator-provided secrets |

The grant is stored when you approve enabling. The router checks it on every call.

## Scene operations: `estampes.scene-ops/1`

`object.create` (type, props, optional `ref` that later operations in the same batch can use as `$ref`, `visibility` `public` or `scratch`), `object.update`, `object.delete` (`cascade` for dependants), `object.publish` (scratch to public). Rules enforced by the core: at most 64 operations and 200 objects per canvas, props validated per object type, `expectedRevision` for optimistic concurrency, no changes in a locked layer, a module may change only objects it created, and the user may change anything.

Object types: `axes-2d` (ranges, grid, `π` ticks, labels), `function-plot` (`expression`, `domain`, `frame` = an axes object) and `shape` (polyline, polygon, dots, circle, rect, arrow, point, text, in canvas or frame space). Coordinates of canvas objects are normalized to the canvas (top left origin) like marks; frame space uses the axes' numeric range with y up.

**Scratch objects** are the model's working notes: they are in the model's preview image but not drawn for the user or exported until published. This is not secrecy: scratch objects are still readable by the module that made them and by the model.

## Graph module

| Capability | What it does |
| --- | --- |
| `plot_function` | Plot `y = f(x)`; creates a new blank canvas with axes if you give none |
| `update_plot` | Change a plot's expression, domain, colour or label; the curve is re-computed |
| `set_axes` | Change ranges, grid, `π` ticks, title and labels |
| `plot_points` | Plot data points as a line or dots |

Expressions: `x`, numbers, `+ - * / ^`, implicit multiplication (`2x`, `3(x+1)`, `2pi x`), `|x|`, constants `pi`, `e`, `tau`, and `sin cos tan sec csc cot asin acos atan atan2 sinh cosh tanh exp ln log log2 sqrt cbrt abs sign floor ceil round trunc min max pow hypot mod`. `log` is base 10. They are parsed by Estampes's own parser and never evaluated as JavaScript. Curves are sampled adaptively; asymptotes (`tan`, `1/x`) split the curve instead of being joined.

## Storage and audit

With `ESTAMPES_STORAGE_DIR`, module data lives in `<storage>/modules/`: `registry.json` (state and grants) and `audit.jsonl` (plans, approvals, refusals, runs and failures; secrets never appear). Without storage, state lives in memory and modules start disabled again after a restart. Objects are part of each canvas's `canvas.json`, so they survive a restart even if a module is later disabled; disabling stops new runs but does not delete anything.

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

Then open the Store: the package appears under installable packages. Press install, confirm, and approve it on the server with `node scripts/estampes-module.js approve <planId>` (the Store shows the exact command). Installing does not enable: enabling is a second plan that shows the permissions.

| Action | Needs |
| --- | --- |
| install, update, purge | your confirmation **and** administrator approval from the server |
| enable, disable, rollback, uninstall | your confirmation (enabling high-risk permissions also needs administrator approval) |

What the server checks before a version becomes active: size (2 MB) and safe file paths; the manifest and `coreCompatibility`; a runtime this server has (`declarative`; `builtin` is refused for packages and built-in ids cannot be replaced); the digest; a signature by a key listed in `<storage>/modules/trusted-keys.json` whose `scopes` cover the module id (keys only publish under their own prefixes); then the module's examples run through the same checks as `execute_module` on a throwaway canvas. A failure at any step leaves the old version active.

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

Declarative modules (code-free): each capability lists scene operations with `{"$param": "name"}` placeholders (optionally `"default"`), filled from the validated input. See `examples/modules/callout`.

## Roadmap

Each phase is its own change and keeps the rules above.

1. Contract, scene objects, Graph and the Store (0.10.0).
2. Managed packages: signed packages, a version lock file, transactional install, rollback and administrator approval separate from the connector key (0.12.0). Not planned: arbitrary npm packages, shell commands, access to the Docker socket, packages fetched from arbitrary URLs.
3. An isolated WASM runtime with CPU, memory, output and time limits.
4. Adapters for external engines and services (OCR, plate solving), and an author SDK.
