# Derived bindings

A derived binding is the record that says: this object in a document was made by a module capability from a source that can change, and it may be refreshed from that source. It is the generic form of what used to be a calculator-only plot link (UVA Phase 5B). Any module can be the producer. Status: schema, state machine and conflict rule exist (5B-1); nothing writes a derived binding yet, and nothing reads one except document validation. Connecting the calculator is 5B-2.

## What the core knows and what the module owns

The core stores and enforces: the target object, the module and capability that made it, a version number and hash of the source, what the module last wrote (`lastApplied`), the state, and the rule `pause-on-user-edit`. The module owns the meaning of its source: `sourceRef` is an opaque text of up to 200 characters that the core keeps and never parses. The core code in `src/documents/derived-binding.js` names no module and no object type; a test enforces that.

## States and what the person can do

States: `fresh`, `stale`, `recomputing`, `conflict`, `removed`, `unavailable`, `unresolved`, `error`.

Events (reported by the system) move a binding between states: a changed source makes it `stale`; a refresh goes `recomputing` then `fresh` or `error`; a refresh that finds the object edited after the module last wrote it is **paused** and the binding becomes `conflict` (OD-05); a deleted object makes it `removed`; a module that is disabled or missing makes it `unavailable`; a broken reference makes it `unresolved`.

Actions (asked for by the person) are a closed set:

| action | allowed in | result |
| --- | --- | --- |
| `refresh` | fresh, stale, error | recompute from the source |
| `overwrite` | conflict | replace the person's edits with the latest result (after a preview) |
| `fork` | conflict, stale, error | keep the object as it is, detach it, and make a new bound object from the source |
| `reattach` | removed, unresolved | point the binding at another object; it becomes stale |
| `detach` | any | delete the binding; the object stays |

Every other combination is refused with `ILLEGAL_ACTION`, and an action needs the `expectedBindingHash` of the binding the caller read, so an action taken on a stale screen is refused (`STALE_BINDING`). In `conflict` a plain refresh is refused: the object is never overwritten until the person chooses.

## When a refresh must pause

A refresh may overwrite the target only if it is exactly what the module last wrote: the object's `provenance.editedByUser` is not set, its revision equals `lastApplied.objectRevision`, and the hash of its type and props equals `lastApplied.contentHash`. Moving an object between layers does not count as an edit.

## Where a binding lives

A canvas (image or Graph) is saved as a record that the UVA store keeps as a document. Its `derived` list sits next to its `links`, and each entry is the binding with a shortened target (`{ "id": "o1" }`, the object on that canvas). When the canvas is mapped into its document, each entry becomes a `derived` binding in `document.bindings`, with the document and scene filled in, and projecting the document back gives the same entry. A save that does not touch the binding therefore never loses it.

- An entry that cannot be read (unknown version, extra fields, wrong shape), or one that is live but names an object that is not on the canvas, is not dropped and does not block the canvas. It stays in the raw record, the canvas is reported as not fully editable, and nothing refreshes it. A later step is responsible for turning a live binding whose object was deleted into `removed`.
- A copy of a canvas starts with no derived bindings: its objects are ordinary objects, and refreshing the original never touches the copy.
- A workspace bundle carries a canvas's bindings in its set file, and an import brings them in as `unresolved` (see Bundles below).

## The coordinator

`src/documents/derived-coordinator.js` applies these rules to one canvas. It works on the canvas's `derived` list and on what is on the canvas now, and it never runs a module: whatever recomputes an object is handed in as a function that writes the object and returns the new source revision. So any module that can write an object can be a producer, and the file names no module and no object type (a test checks this).

- `register` records a binding as fresh after a module made an object. A canvas holds at most 100; an object has at most one live binding.
- `sourceChanged` marks the matching bindings stale (same module, and the same `sourceRef` when given).
- `reconcile` turns a live binding whose object is gone into `removed`.
- `refreshStale` refreshes stale bindings, at most 20 per call; the rest are reported in `remaining`, never dropped. A binding whose object was edited by a person, or changed by any other route, is paused (`conflict`) and the module is not even asked. A producer that fails leaves the binding in `error` with a short reason and the object as it was.
- `act` carries out the person's choice (refresh, overwrite, fork, detach, reattach) after checking `expectedBindingHash` and the state table.

Nothing saves the canvas inside it; the caller does that. Nothing calls it yet outside tests: connecting a real producer is the next step (5B-2b-2), then the calculator (5B-2b-3).

## How a module becomes a producer

A `estampes.module/2` module needs no change in the core to make derived objects. Three things in its own manifest and output:

- **`derives.refresh`** on a capability names the capability of the same module that recomputes what the first one makes. Both must work on the document, answer at once (not async), differ from each other, and the refresh capability must accept the string fields `sourceRef` and `object`. The manifest is refused otherwise.
- **`derived`** in a capability's output lists `{object: "$ref", sourceRef, sourceRevision, inputsHash}` for objects it just created with `ref`. The core records a binding in the same save. Only a capability that declared `derives` may do this, and at most 50 per call.
- **`broadcast`** in a capability's output (`{event: "source-changed", sourceRef?}`) says that a source of this module changed. It marks only this module's own bindings stale (all of them, or those with that `sourceRef`). It is a hint: `sourceRevision` stays the truth, and a refresh may not broadcast.

A refresh is a call to the declared capability with `{sourceRef, object}`. It may update only that object, must not create objects, make `derived` or broadcast, and must return `data.sourceRevision`; otherwise the binding becomes `error`. If the person edited the object, the refresh is paused as a conflict and the module is not called. The two tools `get_derived_bindings` and `update_derived` read and act on bindings; the core names no module. A module that is disabled shows its bindings as `unavailable` and they return as `stale` when it is enabled; a refresh cut off by a restart is reported as `error`. Subscriptions between modules are not part of this (issues #86 and #174).

Tested in process with stand-in modules and over the router; not tried on a real ChatGPT or Claude host.

### Broadcasts across documents

A module's broadcast also reaches the other documents that hold its bindings. The core keeps a small index (`derived-index.json` in the modules folder: module id to document ids; the id is only a key, the core names no module). A document is added when a binding is registered or when it is listed, and dropped when it holds no live binding of that module. At most 8 other documents are changed per call; the rest are reported as `remainingDocuments`, and a capability that works on no document at all (`target: none`) can still broadcast. The index is only a hint: if the file is lost, broadcasts reach the current document until the others are opened or listed again. A document that cannot be read is reported in `failedDocuments`, not silently skipped.

Built-in modules may use a `estampes.module/2` manifest (a package may not name the `builtin` runtime); they go through the same derived path as a package module.

## The calculator

The calculator (`org.estampes.cas`) is a built-in `estampes.module/2` module and uses exactly the contract above; nothing in the core names it. `plot_result` declares `derives.refresh: refresh_plot` and returns the plot it made as `derived` (`sourceRef` is `<notebook>/<cell>`, `sourceRevision` the cell's revision); `calculate` on an existing cell, `define` and `recompute` broadcast the cells whose result changed; `refresh_plot` recomputes a stale cell and redraws only that plot. The notebook's own graph links are still written beside this (the old path keeps working until its readers move, UVA 5B-4).

One visible change: a plot the person edited by hand is no longer redrawn by an automatic refresh. The refresh reports it as failed with the reason, the hand edit stays, and the plot's link does not claim to be fresh (before this, the edit was silently lost). The `update_derived` tool shows such a plot as a conflict. Choosing overwrite, fork or detach from the widget comes with 5B-3.

## Overwriting a person's edit

`overwrite` replaces an object the person edited with what the module writes now, so it cannot be done blind. `preview` (for a stale, conflict or error binding) asks the module for what it would write, without applying or saving anything, and returns that (`wouldWrite`), the object as it is (`current`), whether the person edited it, and a one-time `previewToken`. `overwrite` must carry that token. The token is kept in the server's memory for 10 minutes, belongs to one binding as it was read (its `bindingHash`) and to the object's revision, and is spent by the first attempt, so any change after the preview, a restart, or a second try needs a new preview. What it proves is that a preview was made for this state; it does not prove who asked, and what is written is what the module produces when the overwrite runs. A preview may make the module recompute its own source (the calculator recomputes a stale cell); it never changes the document. The widget's buttons come later and will tighten this further.

## Bundles

Export writes each set's bindings next to its objects. Import checks each one like a local binding and keeps it only if the object it names arrives in the same set; others, repeats and malformed entries are left out and named in the import warnings. Every kept binding comes in as `unresolved`, whatever its state was: the module's `sourceRef` names a source (a notebook, a file) that is usually not here under that name, and the core cannot tell, so only the module can. `reattach` moves it to `stale`, and the next refresh reads the real source. Until then nothing refreshes it and the object is an ordinary one. Bindings of a canvas that an import reuses (same content already here) are not touched. An older build ignores the extra field and gives plain objects. Tested in process (round trip, restart, malformed entries); real ChatGPT/Claude not verified.

## Compatibility and downgrades

`cas-plot`, the earlier binding kind, was never written by any code, so no stored document contains one and none is migrated. A document that contains a derived binding is not readable by a build that predates the kind: it fails validation and opens read-only. Back up before downgrading once a build starts writing them (5B-2). Format version stays `estampes.document/1`. This is checked at schema level; an older build was not run against such a document.
