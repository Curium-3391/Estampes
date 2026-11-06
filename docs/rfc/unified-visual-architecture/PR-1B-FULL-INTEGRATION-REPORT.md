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

## Implemented integration (M2–M7)

CURRENT: `src/uva/service.js` is the product boundary. A workspace is an existing
`estampes.document/1`; its image items are scenes, backgrounds are typed asset
references, layers retain ordered memberships, and annotations retain normalized
geometry and scoped stable IDs. No contract or engine source was changed from
`d9aaa49f`: `pr1b-runtime-source-index.json` checks every selected runtime file.

The service opens the existing exclusively leased worker, using its original
format, profiles and testing purpose. It does not relabel that isolated engine as
a qualified production writer. CURRENT, Ledger, CommitRoot, archive, lifecycle,
FD/path checks, recovery fencing and read-only restored-backup behavior are
unchanged. The service holds no writable document cache and never writes engine
files. It reads verified snapshots and sends validated signed commands to that
worker. Private Beta metadata contains only a persisted plan-signing key/profile;
it is not another document or transaction authority.

Preparing an operation produces a complete signed command, without publishing a
document. Committing sends the exact payload through the coordinator. UI/GPT
actor attribution comes from separate server registrations, not user-supplied
provenance. Exact retries remain bound to the same principal/payload and Ledger
ACK across restarts. When a newer revision proves an old command can only replay
or conflict, later module revocation or missing image bytes cannot replace the
original ACK; the resulting view separately reports asset errors. New effects
still require current grants and verified assets. No-op preparations are rejected
so they cannot bypass the bounded revision/command workload.

CURRENT Workbench capabilities in `public/uva-workbench.js`:

- Create from the native file chooser; add images later; select among up to four
  visual items; list/open/select/rename/close/reopen saved workspaces.
- Render real stored source pixels and module-produced scene objects. Zoom/pan
  remain view state; pointer geometry is normalized against the transformed image.
- Create/select layers; visibility, lock, opacity and names persist with content.
- Draw points, rectangles, arrows and freehand lines; select/move GPT or user
  marks; edit coordinates, labels and color; delete unlocked, unreferenced marks.
- Persist every accepted edit through the same service; poll authoritative state
  for GPT changes. Form drafts are not automatically rebased over newer revisions.
- Display loading/write errors, stale revisions, unsupported operations, storage
  and read-only/recovery diagnostics; retry the exact prepared transaction.
- Export an editable logical document + original binary assets and download it.

The editor is inlined into the existing visual-surface Workbench resource, with an
opt-in launcher and return to existing panels. Existing tools, upload, canvas,
Graph/CAS, image pipelines and workspace APIs remain operational. The versioned
`experimental_workspace` tool is an explicit adapter rather than reinterpreting
legacy `ws:` or `img:` references. `uva_user_command` is its app-only equivalent.
`open` returns the authoritative revision/document; `render` returns real
composite pixels to GPT and separate image/object projections to the editor.

### Module proof

Image annotation and the existing Graph capability are demonstrated on the same
scene. Registry discovery supplies capabilities/input schemas; the generic
command UI has no Graph-specific runtime. A detached scene projection enters the
existing router, which enforces enablement, grants, input/output schemas, scene
ownership and layer locks. Its results return as editable UVA objects through one
CommitRoot command. There is no second module runtime or implicit enablement.
Unsupported async/nonvisual capabilities reject explicitly; their original
legacy path survives. General custom interactive module views and reactive CAS
state remain the existing #85/#84 follow-ups, not claimed as implemented here.

### Assets, legacy compatibility and safety boundary

Assets are separate immutable hash-named files, limited and verified before
publishing document references. Source bytes and dimensions preserve the existing
image pipeline's oriented/working coordinate frame. No image binaries are hidden
inside document JSON. There is no cross-store atomic transaction or asset GC;
failed preparations may leave unreferenced assets. Every read/export/commit
rechecks references, and saved exports stay readable after active asset failure.

Explicit legacy import copies sources and preserves scoped annotation/layer IDs.
The existing strict `mapLegacyCanvas` boundary validates content; verbatim source
sidecars live in bounded document extensions. Unsupported external links,
embedded/image scene objects or other unmappable content block the copy with an
explanation. Nothing deletes, overwrites or bulk-migrates the source. The original
legacy tools and HTTP contracts continue addressing their original writer.

Beta activation requires `ESTAMPES_UVA_BETA=1`, a separate private
`ESTAMPES_UVA_BETA_DIR`, and explicit `ESTAMPES_UVA_BETA_PROFILE`. Empty trusted
paths initialize; unknown data, missing established store components, profile
changes, symlinks, unsafe ownership and read-only storage fail closed. Default
installations register no Beta tools and retain the legacy writer. Disabling does
not remove files. Platform-specific behavior is in [UVA-BETA.md](../../UVA-BETA.md).

Fixed workload: four workspaces, four scenes each, 25 revisions each, 128
annotations, 64 objects, 1 MiB JSON, 8 MiB/image, 64 MiB assets, 128 MiB exports;
existing document-store quota is 256 MiB. Automatic maintenance/GC is disabled;
existing engine lifecycle code and invariants remain intact. Administrative
verify/checkpoint/document-store backup uses the original lease. Logical export
includes binaries; the original engine backup explicitly does not.

### Export and recovery

Exports contain document JSON, source images and hash manifests, stored separately
from the writer. Their signed URLs still work with Beta disabled and after writer
failure. `scripts/uva-recover.mjs` reads a saved local export without opening the
source writer and restores into an empty separate directory through the same
coordinator. New history starts at one; exact original revisions/provenance remain
in the recoverable source archive. Original files remain intact. A recovery that
exceeds the Beta JSON limit fails explicitly. No foreign archive is silently
promoted to authenticated local state.

## Observed verification (M8)

| Verification | Actual result |
| --- | --- |
| Node 22.23.4 complete suite, concurrency 2 | 530 tests: 527 pass, 0 fail, 3 skip |
| Focused final Beta backend + Chromium/MCP | 8 tests: 8 pass, 0 fail, 0 skip |
| Final selected-runtime/legacy source contract tests | 34 tests: 34 pass, 0 fail |
| Python CAS | 17 tests: 17 pass |
| Docker image build, Node 22, private named volumes, read-only root | Build passes; 10 smoke checks pass |
| Base and opt-in Compose config | Both pass; explicit profile required |
| Documentation and release consistency | Both pass |
| Native host/power-loss acceptance | NOT RUN / NOT QUALIFIED |
| Live ChatGPT Host acceptance | NOT RUN; browser Host relay is a fixture |

Full-suite skips are one optional PDF renderer test (pdfjs-dist/canvas absent),
native ext4/XFS durable ACK restart, and native historical binding restore. The
two native cases refused an unapproved mount; process-crash counterparts ran.
Tests whose historical names contain "native" but use the process-crash fixture
do not count as native acceptance. No G2 or production qualification is inferred
from this passing bounded run.

The initial Node 24 run had 530 tests: 520 pass, 7 fail, 3 skip. Those seven
failures came from three omitted fault-injection fixture modules during selective
source integration. They were restored byte-for-byte from the selected source;
no crash assertion was weakened. Its raw log is preserved compressed. The final
Node 22 full run is the regression result. Subsequent ACK-replay changes were
covered by the focused final Beta run, including revocation/asset-loss retries.
The old PR-1A isolation-only production hash seal is retained in its original
`source-index.json`; its test now protects newer main outside an enumerated list
of authorized PR-1B seams (including the added CI browser coverage), and checks
all document/persistence runtime hashes exactly against the selected baseline.

Browser debugging exposed iframe UUID availability and an overwritten status
message; both were fixed and tested. Docker debugging exposed imported source
file mode 0600 and random published-port reassignment after restart: the image
now normalizes readable, root-owned application files, and the smoke harness
rediscovers the port after restart. These are not native durability findings.

### Mandatory scenarios

| Scenario | Executable evidence |
| --- | --- |
| A GPT annotation → UI → editable reopen | `uva-integration.test.js`, `uva-workbench-e2e.test.js`: real PNG asset, tool edit, revision/geometry, browser DOM and reopen |
| B User edits GPT annotation → GPT read | Browser selection, label/color/coordinate save, authoritative tool assertions |
| C Layers | Two independent layers/marks, hidden visibility, editable reopen; Graph adds its own layer |
| D Concurrent stale edits | Signed stale commit rejects; stale UI form rejects after GPT edit; no silent overwrite |
| E Interrupted write | Real leased worker SIGKILL at `after-publication-durable`; restart, one selected state, exact repeated ACK/Ledger count |
| F Legacy | Original canvas JSON and GPT-visible state unchanged; explicit copied scene remains editable |
| G Modules | Existing Graph router executes/updates shared scene objects; annotation reads reflect the same revision; revoked grant preserves accepted ACK |
| H Unsupported profile | Unknown/private/profile/native-mount activation rejects; process-crash mode explicitly labeled non-durable |
| I Failure/export/disable | Saved archive survives missing active asset; restores to separate store; Docker restart retains state/ACK; Beta off retains legacy and export download |

Evidence: [results](evidence/pr1b/results.json), [full Node 22 TAP](evidence/pr1b/node22-full.tap),
[final Beta log](evidence/pr1b/beta-integration.log),
[Docker smoke](evidence/pr1b/docker-smoke.json),
[browser screenshot](evidence/pr1b/uva-beta-workbench.png), and
[exact source refs](evidence/pr1b/source-refs.json).
The screenshot shows stored image pixels, Graph objects, a human-edited GPT box
and a subsequently GPT-created point on the shared scene.

## Known work and GitHub tracking (M9)

Repository issues were searched before creating scoped follow-ups:

- [#88](https://github.com/Curium-3391/Estampes/issues/88): 200/1,000-command
  history, checkpoint eligibility, sustained maintenance drain and profile approval.
- [#89](https://github.com/Curium-3391/Estampes/issues/89): near-64 MiB cold startup/RSS.
- [#90](https://github.com/Curium-3391/Estampes/issues/90): G2 **UNRESOLVED INTERMITTENT**,
  failure preservation, grace and pressure qualification.
- [#91](https://github.com/Curium-3391/Estampes/issues/91): full reader/backup pressure,
  physical ENOSPC recovery, exact filesystem/host and power-loss qualification.
- Existing [#84](https://github.com/Curium-3391/Estampes/issues/84) and
  [#85](https://github.com/Curium-3391/Estampes/issues/85): wider reactive math and
  custom module-owned interactive views; not duplicated.

These are open work, not fixed claims. Stable release remains blocked on production
qualification. They do not reopen unlimited storage research for the bounded Beta.
No unverified repository labels were invented.

## Build, commits and delivery

`npm ci` and `npm start` use Node 22. Native `flock` is required only when Beta is
activated. [UVA-BETA.md](../../UVA-BETA.md) documents direct and Docker setup,
profiles, limits, backups/exports, recovery, rollback and feedback. The default
Compose deployment remains legacy-only. The opt-in overlay mounts a separate
private volume. No release tag, image publication, deployed-user activation or
legacy migration is part of this delivery.

Reviewable implementation commits:

1. `68ad3b2`: selected baseline contracts/engine and inventory.
2. `5e7c669`: signed authoritative adapter, assets, copies and integration tests.
3. `338aeec`: real Workbench editor, module commands and browser tests.
4. `65098bf`: isolated deployment/recovery/maintenance and CI browser coverage.
5. Follow-up correctness/evidence commits are listed in the integration PR history.

Local classification: **FULL EXPERIMENTAL INTEGRATION COMPLETE** for the bounded,
explicitly non-native process-crash Beta profile tested above. Live Host and
native qualification remain separate, unperformed gates. Production guarantees:
**NOT QUALIFIED**. Final PR URL, CI and main integration status are recorded in
the delivery addendum below; local completion does not bypass CI/review policy.
