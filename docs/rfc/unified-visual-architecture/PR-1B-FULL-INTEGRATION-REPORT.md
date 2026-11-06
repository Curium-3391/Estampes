# PR-1B full integration report

## Authority and source inventory (M1)

APPROVED: the supplied full integration mission permits opt-in experimental product integration; legacy remains default. CURRENT implementation is the authority for contracts, the mission defines the intended cutover boundary, and historical measurements do not establish production qualification.

- Main baseline: `7fb9b73` (fetched 2026-11-06); clean initial checkout, no user changes.
- PR-1A `7eae7f5`, PR-1C `5549f10`, PR-1D `322038b`, hardening `29d097833688ddb649a88cb2a09f22ba5fadda8e`.
- Selected complete runtime source: `d9aaa49f27d195ed53baeb12e95e434f1a7b10b0`, descendant of hardening; `src/documents`, `src/persistence`, their tests and G2 preservation scripts copied selectively.
- Candidate `4814daf2378e9619f171c02a65792062957a8e99` changes document canonical validation (Optimization B). It is excluded. Rejected Optimization A is absent from the selected runtime.
- Native adjudication `63ced9de6d7562ecc66a19728be2f2cf164f4b37`: **INCONCLUSIVE — DEFAULT TO BASELINE**.
- All UVA, remediation, investigation and evidence remote heads were fetched and inspected. Newest evidence head is `63ced9d`; its only runtime difference from selected baseline is Optimization B. No evidence branch is merged. Original evidence remains available at its exact Git revisions.
- Main has no document/persistence modules. Its newer Workbench, Graph, upload and result-budget work is retained.

## Integration map

| Existing component | PR-1B seam |
| --- | --- |
| `src/storage.js`, `src/workspace.js` | Read-only explicit copy of legacy items and image bytes; original stores remain authoritative for legacy IDs |
| `src/documents/schema.js`, `legacy-shadow.js` | Established document/scene contracts and strict migration projection |
| `src/persistence/lease.js`, `coordinator.js` | Sole writer, OS flock, CommitRoot/CURRENT/Ledger, exact ACK replay |
| `src/persistence/lifecycle.js` | Existing history, pins, checkpoint, backup, GC and recovery retained |
| `server.js` MCP registration | Experimental command adapter, same service for assistant and app-only user calls |
| `public/workbench.js`, `src/surface/widget-source.js` | Opt-in workspace editor on the real Workbench resource |
| `src/modules/registry.js`, `router.js` | Existing discovery, grants, validation and runtimes; detached projection of selected UVA scene |

Existing public tools/workflows remain registered: present_visual, load/inspect/process/render image, marks/scene edits, layers, workspace create/edit/merge/split/undo, bundles, surface panels, module store/execute, Graph and CAS. PR-1B uses a separately named versioned adapter because legacy ws/img identifiers cannot identify UVA doc/scene records without changing their contracts. No legacy ID is reinterpreted as a UVA ID.

## Verification and final delivery

Implementation and measured results will be recorded below. Production qualification: **NOT QUALIFIED**.
