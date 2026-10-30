# Modules

Estampes core is a shared canvas: you, GPT and tools look at the same picture, point at it, annotate it and check claims about it. A **module** adds a capability that produces or analyses things on that canvas, such as plotting a function. Modules extend how people and AI interact, not what GPT can do in general: email or search belong to ChatGPT's own apps.

Status: this page describes what is implemented in 0.17.0 (the contract, the built-in Graph and CAS modules ([CAS](CAS.md)), the Store, managed packages and the WebAssembly runtime). Adapters are planned and marked below.

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
| `runtime` | `builtin` (ships with Estampes), `declarative` (scene-operation templates, no code), `wasm` (a WebAssembly file inside a signed package), `http` (a described request to an approved external service). |
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

Function plots support `props.labelMode`: `auto` renders `y = ` followed by the current expression; `custom` preserves `props.label` (an empty or omitted label hides it). With no mode, an existing label—including an empty or formula-looking label—is treated as custom; without a label the mode is auto. Setting `label` on an update selects custom unless `labelMode` is also supplied. Switching to auto discards the stored label. Core applies these rules to module operations and direct Canvas edits, even when Graph is disabled. Modes persist with the objects. Graph's `plot_function` and `update_plot` accept `labelMode`; to migrate an old plot explicitly, call `update_plot` with `{ "object": "o2", "labelMode": "auto" }`.

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

## Writing a module

```
node scripts/estampes-module.js init mymodule org.example.mymodule            # or --runtime wasm
node scripts/estampes-module.js test mymodule/module.json                     # manifest + examples, like an install
node scripts/estampes-module.js keygen mykey                                  # once
node scripts/estampes-module.js pack mymodule/module.json --out org.example.mymodule.estpkg.json --key mykey.private.pem --key-id mykey [--file module.wasm=mymodule/module.wasm]
```

Give every capability `examples`: they are what the install self-test runs, and what the Store shows. The administrator then trusts your public key for your id prefix (`trust`) and drops the package in the inbox; see Installing packages above.

## WebAssembly modules

A module that needs real code ships one `.wasm` file in its signed package (`runtime: {kind: "wasm", entry: "file.wasm", abi: "estampes.wasm/1"}`). It runs in its own child process, created for the call and killed afterwards, so nothing carries over between calls and an engine crash (for example an allocation failure) cannot take the server down. The module can import nothing: no clock, files, network or host functions, only the bytes it is handed. Limits come from the manifest `limits`:

- `timeMs` (default 2000): the worker is terminated when it runs out.
- `memoryMb` (default 16): the module's binary must declare a memory maximum no larger than this (and tables of at most 10,000 entries with a declared maximum); a package that declares more, none or shared memory is refused at verification, before anything runs.
- `outputKb` (default 256): a longer reply is refused.

ABI: export `memory`, `alloc(len) -> ptr` and `handle(ptr, len) -> ptr`. The host writes a JSON request `{capability, params, module, canvas}` at the pointer `alloc` returned; `handle` returns a pointer to a 4-byte little-endian length followed by a JSON reply `{operations, summary, data, method}`. The reply goes through the same scene-operation checks as any other module. A capability whose input has required fields and no `examples` is skipped by the install self-test. Example with a C source and build line: `examples/modules/wasm-hello`.

## Talking to external services (http modules)

An `http` module contains no code. Each capability has a `request` (method GET or POST, a fixed `path`, `query`/`body` filled from the input with `{"$param": name}`, optional `secretHeaders`) and a `response` (scene operations and/or `data` read from the JSON reply with `{"$response": "a.b.0.c"}`). The manifest must list the hosts in `network.allow` and say in `network.dataFlow` what is sent; the Store shows both before anything is enabled, and enabling needs the administrator's approval. Example: `examples/modules/ocr-http`.

Every request goes out through one place, `src/modules/egress.js`, which enforces:

- the module holds `network.request.approved` and the host is one of its `network.allow` names (https, port 443, exact match);
- the name is resolved on the server and every address must be public: loopback, private, link-local (cloud metadata), carrier-grade NAT, multicast and reserved ranges are refused, and the connection is made to the address that was checked, so a DNS answer cannot change afterwards;
- no redirects, no cookies, only `Accept`/`Content-Type` headers plus the declared secret headers, a time limit (`limits.timeMs`), a response size limit (`limits.outputKb`), and a 25 MB request limit;
- API keys are added by the server from `<storage>/modules/secrets.json` (mode 600) or an environment variable (name shown by `secret set` and `secret status`; for example `ESTAMPES_MODULE_SECRET_ORG_DEXAMPLE_DOCR_SAPI_KEY` for `org.example.ocr` / `api_key`, where `_D` stands for a dot, `_M` for a hyphen and `_S` separates the id from the name, so two ids can never share a variable), only for secrets the module declared and only when it holds `module.secrets`. Set one with `echo "$KEY" | node scripts/estampes-module.js secret set <moduleId> <name>`; `secret status <moduleId>` lists which declared secrets are set (names only). Module code never sees them, and they are kept out of the audit log.
- every request is audited (host, status, sizes, time), never its content.

Installing never sends anything: the self-test only checks the requests the examples would make.

Besides JSON, a request can carry a URL-encoded `form` or a `multipart` body with a file part (the image's bytes; needs `asset.read.selected`), and any string in a body may contain `${secret:name}` for a declared secret, which the server fills in. The built-in module below uses these; declarative `http` modules do not send image pixels yet.

## Background jobs

A capability marked `"async": true` returns at once with a job id (`job_` plus 12 hex digits) and does its work in the background, for services that take minutes. The model checks it with the fixed tool `get_module_job` (optionally waiting up to 25 seconds); the result lands on the canvas when the job is done, with no revision check, since the canvas may have moved on. `limits.jobMs` (default 10 minutes, at most 30) stops a job that runs too long, and a stopped job never applies a late result. Jobs are kept in `<storage>/modules/jobs.json` (the last 100, summaries only); one that was running when the server stopped shows as `interrupted`.

## Plate solving (`org.estampes.astrometry`)

A built-in module that finds where a photo of the sky points, using [Astrometry.net](https://nova.astrometry.net). It uploads the chosen image (marked private there) with the administrator's API key, polls until the solution is ready, then marks the named stars and objects on the canvas and returns the field's centre (RA/Dec in degrees), scale (arcsec per pixel), rotation, radius and parity. Optional hints (scale range, rough position) make solving faster. It reads the stored copy of the image, so storage must be on, and it takes JPEG or PNG.

Setup (administrator):

1. Get an API key from your profile on nova.astrometry.net.
2. Store it where the server runs. With Docker: `echo "$KEY" | docker compose exec -T estampes node scripts/estampes-module.js secret set org.estampes.astrometry api_key`. Without Docker: the same command with `ESTAMPES_STORAGE_DIR=<your storage folder>` in front (after `npm install`). Or set the environment variable `ESTAMPES_MODULE_SECRET_ORG_DESTAMPES_DASTROMETRY_SAPI_KEY` for the server. `secret status org.estampes.astrometry` shows whether it is set.
3. Enable the module in the Store; it needs the administrator's approval because it sends images to an external host.
4. Give ChatGPT a night-sky photo and ask it to solve it. It starts a job, checks it with `get_module_job`, and when done the canvas shows the named objects. A failed job says why (no key set, key refused, no stored copy of the image, unsupported format, or Astrometry.net could not solve it).

## Roadmap

Each phase is its own change and keeps the rules above.

1. Contract, scene objects, Graph and the Store (0.10.0).
2. Managed packages: signed packages, a version lock file, transactional install, rollback and administrator approval separate from the connector key (0.12.0). Not planned: arbitrary npm packages, shell commands, access to the Docker socket, packages fetched from arbitrary URLs.
3. An isolated WebAssembly runtime with time, memory and output limits (0.13.0).
4. Author tools (0.14.0), the controlled network path for adapters (0.15.0), image upload, background jobs and the Astrometry.net plate-solving module (0.16.0). Still to come: an OCR module.

## Direct Canvas editing and deletion recovery

The object panel exposes function label modes (`auto` follows the expression, `custom` preserves the supplied label), custom label text, and the axes title as separate fields. Existing titles are user-supplied text and do not automatically change when a function changes.

The widget can restore the last deletion with `edit_scene_object {imageId, restore:true}`. Up to ten deletion batches are saved with the canvas; deleting axes and their dependent objects forms one batch. Restoration preserves object IDs, frame references and creation order, validates props and capacity, and refuses locked layers or ID conflicts atomically. It uses Core only and works with Graph disabled. The recovery button remains visible after the last object is deleted, and recovery history survives storage reload. Deletions predating this history cannot be reconstructed by this mechanism.
