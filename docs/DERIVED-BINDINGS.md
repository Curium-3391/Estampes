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

## Compatibility and downgrades

`cas-plot`, the earlier binding kind, was never written by any code, so no stored document contains one and none is migrated. A document that contains a derived binding is not readable by a build that predates the kind: it fails validation and opens read-only. Back up before downgrading once a build starts writing them (5B-2). Format version stays `estampes.document/1`. This is checked at schema level; an older build was not run against such a document.
