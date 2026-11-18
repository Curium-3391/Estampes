# Architecture review: can the module system carry third-party Canvas and Panel UIs later?

Status: review only. Nothing here is implemented or scheduled, and nothing in this document changes behaviour. It answers one question from the third-party module acceptance test ([#199](https://github.com/Curium-3391/Estampes/issues/199)): if Estampes later lets a module ship its own interactive HTML/JS Canvas (for example a circuit simulator) and its own Panel renderer, does today's architecture get in the way, and what is the least that has to be settled now?

Method: read the code on `main` at 0.20.1 (`src/modules/*`, `src/scene/*`, `src/surface/*`, `src/documents/schema.js`, `src/uva/*`, `server.js` resource registration, `docs/MODULES.md`, `docs/SURFACES.md`, `docs/modules/*`). Claims about code cite the file. Nothing was run against a real ChatGPT or Claude host for this review, so every statement about what a host's iframe sandbox allows is marked **unverified**.

Two requirements are treated as *unconfirmed*: a third-party Canvas (own data model, own rendering, own interaction; not forced into image-annotation coordinates) and a third-party Panel renderer (own UI, exchanging data with a Canvas through a Host API, not through core internals).

## Verdict

**The module architecture can host both later without a rewrite, and nothing found today blocks the 0.20.x line from continuing as it is.** The reason is that the core already separates three things a UI extension needs separated: *what a module may do* (manifest + grants checked per call), *what it can change* (it returns data, the core applies it), and *what is shown* (a host-owned widget, panels as data naming a renderer that ships with Estampes). A third-party UI is a new kind of renderer on the third leg; it does not need to touch the first two.

The real gaps are all on one side: **there is no place for a third-party *workspace document* in UVA yet, and no execution boundary for third-party *code in the widget*.** Both are new work, not repairs, and both depend on facts that only a real module will show. The only things worth doing now are small: three contract clarifications (section "Do now") and keeping the `panels` extension point from being used for anything else.

Legend for the matrix: **Reuse** = can be used as is · **Small extension** = additive change, no break · **Blocker** = cannot work without a design decision first · **Needs a real module** = the right answer depends on requirements we do not have.

## Compatibility matrix

| Area | Mark | Evidence and reason |
| --- | --- | --- |
| Module manifest (`estampes.module/1`) | **Reuse** (+ small extension when needed) | Strict zod schema (`manifest.js`) refuses unknown fields, so a UI module must be expressed through a *new optional field*, never smuggled into an existing one. `panels[]` already exists with `schema: estampes.panel/1`, `uiSchemaVersion`, `kind`, `capabilityBindings`, `permissions`, and an unknown `kind` is shown as an inert placeholder (`manifest.js`, `docs/SURFACES.md`), which is a graceful-degradation path that already exists. A future `canvasKinds[]` or `ui` block is an optional field; old Estampes versions reject it via `coreCompatibility`, which is the intended mechanism. |
| Module runtime | **Reuse** | Four runtimes (`builtin`, `declarative`, `wasm`, `http`) answer "where does computation run". None of them runs in the widget, and none needs to: a UI is a *presentation* concern, a runtime is a *compute* concern. A circuit simulator module would run its engine in the widget (UI side) or as a `wasm` module (server side); both fit the existing split without changing a runtime. |
| Capability API (`execute_module`) | **Reuse** | One fixed entry point, input checked against `inputSchema`, output `{operations[], summary, data, method}` strictly validated (`router.js` `OutputSchema`). A capability with `target: "none"` returning `data` is already a structured RPC. A panel binding is just another caller of `execute_module`; `capabilityBindings` is already checked to be capabilities of the same module. |
| Canvas / scene operations | **Blocker for a non-image canvas; no change needed for image/graph modules** | Scene ops are defined around a closed set of object types (`OBJECT_TYPES`: `shape`, `axes-2d`, `function-plot`, `info-card`, `image`) with normalized canvas coordinates and a closed `kind` enum on documents (`image`, `graph`; `schema.js:188`). A circuit's data model does not map onto these and should not be bent to (principle: do not unify coordinate models). So a third-party Canvas cannot be expressed as scene operations and must **not** try. See "Canvas data" below. |
| Panel rendering | **Needs a real module** | Panel *placement* (layout, docking, per-device profiles, revision-checked writes) is generic and reusable (`src/surface/*`). Panel *content* is a closed renderer list (`PANEL_KINDS`) compiled into the widget. Adding third-party content means executing third-party code in the widget. That is a security design, not a refactor, and its shape depends on what the first real module needs. |
| UVA / storage / sync | **Small extension (opaque document) and Needs a real module (sync model)** | UVA has `extensions` on documents (`estampes.beta:<name>` namespaced keys, any JSON, size-bounded), revisioned atomic writes, durable ack, and a mirror/record pattern already used for non-visual records (`RECORD_KEY`, `service.js:191`: "a record document holds no visual content"). That is a working precedent for a document that holds module data and no scene. What is missing is a document `kind` for it and a rule for who may write it. Conflict handling for a live simulator (frequent state, not discrete edits) is not covered by the current commit/ack model (`docs/UVA-POWERLOSS.md`) and needs a real workload to size. |
| Module Store / distribution | **Reuse** | Signed single-file packages, scoped keys, source index, plan/consent/admin approval, rollback by digest (`packages.js`, `sources.js`, `lifecycle.js`). A UI asset (HTML/JS) is bytes in the same package (`files` map; `wasm` already ships a `.wasm` this way), so verification, rollback and the audit trail apply unchanged. The 2 MB package limit would constrain a CircuitJS-sized bundle; that is a limit to revisit with a real bundle, not a design flaw. |
| Permission / security boundary | **Small extension (new permission family) and Needs a real module (execution sandbox)** | Grants are per module, checked on every call, and an update that asks for more must be approved again (`permissions.js`, `router.js`). That model carries over: UI code should get a *new, explicit* permission (for example `ui.canvas.custom`, high risk) rather than inheriting `canvas.write`. What does not exist is any statement of what the iframe the code would run in can do. The widget resources are registered with only `mimeType` and no `_meta.ui.csp` (`server.js`), so network and frame policy today is whatever the host (ChatGPT, Claude) applies. **Unverified** across hosts; must be tested before any design depends on it. |
| MCP integration | **Reuse** | The fixed tool set means installing a module never changes the tool list, so a UI module needs no reconnect (`docs/MODULES.md`). App-only tools (`_meta.ui.visibility: ["app"]`) already provide a widget-to-server channel that the model cannot call, which is the right place for a Host API's server side. |

## 1. Can today's architecture contain these UIs?

Yes, with one new thing in each of two places (a document kind, a widget execution boundary), and no change to manifest strictness, the router, or the permission model.

What would *not* work, and why it matters for scope: serving a module's HTML straight into the existing widget. The Visual Surface widget is the one origin that holds the user's session to the Estampes server (`surface_*` and `edit_*` app-only tools). Third-party script in that origin could call every app-only tool, including `store_commit_plan`'s consent flow's inputs. So third-party UI must run in a *separate, nested* browsing context with a message channel as its only link to the widget, not in the widget's own document.

## 2. Contracts stable enough to keep

- `estampes.module/1` manifest: strict, versioned by schema string, `coreCompatibility` range.
- `execute_module` input/output envelope and its all-or-nothing application (revision-checked `expectedRevision`).
- Grants are per module, per call, and widen only through a plan the user approves.
- Plan/consent/admin-approval lifecycle and signed packages.
- `estampes.panel/1`: data-only, unknown `kind` is an inert placeholder, `capabilityBindings` ⊆ own capabilities, opening never grants.
- Surface layout is in surface units, separate from data (`docs/SURFACES.md`), so a third-party panel that is closed or fails never touches canvas data.

## 3. Implicit coupling that could bite later

These are not bugs today. Each is a place where a third-party UI would hit a rule that is only implied by code.

1. **A "canvas" is an image.** `entry.imageId`, `width`, `height`, and `sceneRevision` are the module's whole view of its target (`canvasContext` in `router.js`). A non-image workspace has neither a width/height nor an image id. The coupling is in the *context handed to modules*, not in the manifest. Resolve it by adding a second target kind, not by faking an image.
2. **Closed object and document enums.** `OBJECT_TYPES` and `kind: image|graph` are compiled in and strict. Correct for security; it means a third-party data model can only live in `extensions` (opaque to the core) until the core names a kind for it.
3. **Presentation is conflated with kind in `panels`.** `kind` selects a built-in renderer. If third-party UI reuses `kind` with a new meaning, old hosts show a placeholder (good) but the same field would mean two things. Prefer a new field to widening `kind`.
4. **Permission table lists a permission that does nothing.** `module.storage.write` is declared and shown but no module storage API exists (found while fixing #196). A UI module that needs durable state would reach for it. Settle what it means before a UI module depends on it.
5. **Coordinates are unit-fraction per axis** (canvas x and y are fractions of width and height; documented in `docs/MODULES.md` for #197). That is the right contract for annotation coordinates and the wrong one to inherit for a simulator; a third-party Canvas should declare its own coordinate frame and the Host API should pass it through as data, never convert it.
6. **Module-visible state is the scene.** A module can read `objects` and `marks` of one canvas (needs `canvas.read`); there is no channel for a UI-originated event to reach a module other than a user-triggered `execute_module`. That is safe by default and sufficient for request/response; a streaming simulator needs more (see section 5).

## 4. Responsibility split between runtimes and a UI extension

Keep this rule: **a runtime computes; a UI presents and collects; the core stores and authorizes.**

| Concern | Declarative | WASM | HTTP | Third-party UI (future) |
| --- | --- | --- | --- | --- |
| Where it runs | server, no code | server, sandboxed child | external service | nested browsing context in the widget |
| Produces | scene operations | scene operations, `data` | scene operations, `data` | rendering and user events |
| Persists | via core | via core | via core | only through the Host API into the core |
| Network | none | none | egress-checked allow-list | none by default; any exception is a separate high-risk grant |
| May change canvas data | scene ops only | scene ops only | scene ops only | **only by asking the host to run a capability** |

A UI never writes the document. It *requests*, the host calls the same router, and the router applies the same checks. The advantage is that the existing audit log, revisions and permissions cover UI-originated changes with no new code path.

## 5. Host API between Canvas and Panel (design direction, not a spec)

Smallest shape that follows from the above, if and when needed:

- **Transport:** `postMessage` between the widget and each nested frame, one `MessageChannel` per frame, versioned envelope (`{schema: "estampes.ui/1", id, type, ...}`), a hard size limit per message, an allow-list of message types. The widget validates every message with the same strict-schema habit as the rest of the code (zod, unknown fields refused) and never forwards a raw message to the server.
- **Panel ↔ Canvas** do not talk to each other directly. Both talk to the host, which relays *declared* topics (named in the manifest). That keeps "module A's panel reads module B's canvas" impossible by construction and lets the host drop a misbehaving frame.
- **Reads:** the frame receives a snapshot of *its own module's* document data and the revision; it does not receive other modules' data or session tokens.
- **Writes:** `request({capability, params, expectedRevision})` → the host runs `execute_module` as today. Results come back as data. This reuses revisions, audit and permissions.
- **Frequent state (a running simulation):** keep it in the frame; persist checkpoints only on user actions or on a coarse timer through the request path. Do not design a streaming sync layer until a real module shows the rate.
- **Lifecycle:** `init → ready → (snapshot, request, event)* → dispose`; the host may dispose a frame at any time (module disabled, uninstalled, widget closed) and must be able to re-create it from the stored document alone.

All of the above is **new API**, and every item is **needs a real module** before being written down as a contract.

## 6. Can UVA carry a third-party workspace?

- **Already supported:** durable revisioned documents, atomic multi-record commits, power-loss recovery rules, content-addressed assets (CAS), a documented extension namespace (`extensions`), and a record-only document pattern with an integrity rule (`RECORD_KEY`).
- **Usable through an existing extension point:** keeping a module's private data in `extensions["<publisher>:<name>"]` on a document. The format regex already namespaces keys, and the schema bounds size.
- **Needs new API:** a document `kind` for "module workspace", a rule that only the owning module (through the host) writes it, and a read path the model can see (`get_visual_state` reports image/graph documents today).
- **Not decided, and should not be before a real module exists:** how a high-rate state is versioned, whether a third-party workspace is exported in workspace bundles (and with what compatibility promise), and how it appears in the model-facing text (`inspect_visual`). The model should be able to learn what a canvas contains, which for a module-owned format means the module has to provide the description, not the core.
- **Dependency note:** Phase 4 (Graph as an independent document, #189 and #200) and the CAS decoupling (#174, Phase 5) both touch document kinds and asset ownership. This review recommends doing nothing about a module-workspace kind until those land, so the two do not compete over `kind` and `extensions`.

## 7. Security boundaries third-party HTML/JS would need

Each item is a requirement, not a design; the verifiable ones are marked.

1. **Isolation:** nested cross-origin context (a sandboxed `iframe` with an opaque origin: `sandbox="allow-scripts"` and *no* `allow-same-origin`), loaded from a blob or `srcdoc` whose bytes the host verified against the package digest. **Unverified** that ChatGPT's and Claude's widget iframes permit nested sandboxed frames; this decides whether the whole approach is available and should be the first experiment.
2. **CSP:** the nested frame's own CSP must forbid network (`connect-src 'none'`), forms, and nested frames, and allow only inline/blob script and style. Today widget resources carry no CSP metadata (`server.js`), so the frame's policy would be the host's plus whatever the frame's document declares. **Unverified** that a host honours the frame document's CSP.
3. **Message validation:** structural check, size limit, rate limit, and a closed list of message types; unknown types dropped and logged.
4. **Permissions:** a third-party UI never gets the module's grants automatically. A new explicit permission is needed (high risk, administrator approval like network and secrets), and the UI can only *request* capabilities the manifest binds.
5. **Resource limits:** per-frame memory/CPU cannot be enforced from page script; the practical controls are a watchdog (no heartbeat → dispose), a cap on frames, and a visible "stop" for the user. This is a known limit of browser sandboxes and should be stated rather than promised away.
6. **Lifecycle:** never keep a frame alive when its module is disabled or its grant is revoked; the host drops the frame first, then persists the state it last acknowledged.
7. **Supply chain:** UI code is part of the signed package and the digest is checked at load, so a stored file that changed on disk is refused the way a changed `.wasm` is today. Third-party code never loads from a URL.
8. **Not mitigated by any of the above:** a module that is *malicious inside its own sandbox* can still draw misleading UI (fake buttons, fake confirmation text). The consent step must therefore stay in the host's own widget, never in a frame. This is why the Store flow is not extensible by modules.

## 8. Upgrade, uninstall and incompatible versions without losing data

What already protects users:

- Uninstall keeps canvas objects and stored versions; rollback restores a kept version byte for byte and checks the lock file (`docs/MODULES.md`).
- A module that fails its integrity check is marked failed at startup instead of running.
- Presentation state is separate from data; closing a panel never changes data (`docs/SURFACES.md`).

What a UI module would add, and the minimal rule for each:

- **Data outlives the UI.** A module workspace document must remain readable (as an opaque, labelled blob) after its module is disabled, uninstalled or incompatible. The Store/workspace must say "this workspace needs `<module> ≥ x`" and offer export, never delete or rewrite it.
- **Versioned payload.** The module owns a `dataVersion` inside its own extension data; the host stores it and refuses to open a document whose `dataVersion` the installed module does not declare it can read, rather than letting the module guess.
- **Migration is explicit.** If an update changes the data version, the module offers a migration capability; the host runs it on a *copy* and swaps only when it validates (the same keep-the-old-active pattern as installs).
- **Recovery path.** If a frame crashes or will not start, the host shows the placeholder panel and a "reset view" that clears only presentation state.

## Do now / document now / defer

### Do now (small, evidence-backed)

1. **Keep `module.storage.write` honest.** The #196 documentation fix marks it as reserved in `docs/MODULES.md` (PR #201). Do not add a storage API in this phase; decide it with the first module that needs it.
2. **Keep the manifest strict.** No code change; it is the property that makes a later `ui` field safe. Any future UI field must be optional and gated by `coreCompatibility`.
3. **Do not let `panels[].kind` grow a "custom" value.** A third-party renderer should be a separate, explicitly permissioned concept so existing placeholders and the closed-renderer guarantee in `docs/SURFACES.md` stay true.

### Document now (a paragraph each; no code)

1. In `docs/MODULES.md` and `docs/SURFACES.md`: state that modules cannot ship HTML, script or CSS today and that a future UI extension will run only in a separate sandboxed frame and request capabilities through the host (already implied; say it once).
2. In `docs/ARCHITECTURE.md`: a short note that a "canvas" in scene operations means an image-or-graph document in normalized coordinates, and that other workspace models would need a different target kind. (The coordinate section added to `docs/MODULES.md` for #197 already covers the image/graph side.)

### Defer until a real HTML/JS Canvas or Panel module exists

- Document kind and ownership rule for a module workspace; export/import rules.
- Host API message types, topics, snapshot shape and size limits.
- Sandbox and CSP design, after the host-iframe experiment in section 7 item 1.
- New permission names and risk levels for UI code.
- Streaming or high-rate state, and any real-time sync.
- Package size limit for UI bundles, and asset loading.
- Model-facing description of a module-owned workspace.
- Anything that touches Phase 4 or #174; revisit after those merge.

## Questions this review could not answer from the code

- Whether a host's widget frame allows a nested, sandboxed, script-enabled frame, and what CSP it enforces for it (ChatGPT and Claude may differ). **Unverified**; it is the one experiment worth doing before writing a design, and it needs a real host.
- Whether the first real third-party module wants UI at all, or whether a declarative or `wasm` module drawing scene operations is enough. The acceptance test (#199) succeeded on that path.
- Whether users expect a third-party workspace to be exported with a workspace bundle.
