# UVA Experimental Beta

UVA connects the Workbench's image annotation editor and existing visual modules
(such as Graph) to the same persistent document that GPT reads and edits. It is
**off by default**. Legacy images, workspaces, modules and their writer continue
working. No startup migration occurs.

Production qualification: **NOT QUALIFIED**. The native A/B result remains
**INCONCLUSIVE — DEFAULT TO BASELINE**; G2 remains **UNRESOLVED INTERMITTENT**.

## Canvas mirror (optional)

`ESTAMPES_UVA_MIRROR=1` (with the Beta on) copies **checkpoints of the ordinary canvas**
into UVA documents. The canvas stays the only writer, so its editing tools, undo,
links and reviews are unchanged and a slow or full UVA store never delays or loses a
canvas edit. GPT reads the same marks and layers with `experimental_workspace`
(`list`, `open`, `render`).

- A mirror document is read-only through UVA (`prepare` is refused with a message
  that names the canvas). Edit the canvas instead.
- A save is copied after `ESTAMPES_UVA_MIRROR_IDLE_SEC` seconds without another
  save (default 15), and at the latest two minutes after the first unsynced save.
  An unchanged canvas writes nothing. Pending checkpoints are flushed on shutdown.
- A canvas restored from a bundle is mirrored at its next save.
- Only a single image's own canvas is mirrored (not copies or workspaces). A
  canvas the document model cannot hold yet, for example one with an image layer,
  is skipped and listed under `diagnostics.mirror.blocked` in `action: status`.
- Cost: measured on the development machine, one UVA commit used about 136 KB of
  disk and 0.3 to 0.7 s, and enabling automatic maintenance did not reclaim
  space within minutes. The Beta store has a 256 MiB quota, so it holds roughly
  1,900 commits in its lifetime. This is why saves are coalesced, and why the mirror
  is **not** a way to make UVA the writer: that needs the storage cost fixed first
  (qualification issues #88–#91).
- Mirror documents use higher Beta limits (64 workspaces, 512 annotations each).
- **Commit budget.** The store's cold start grows with its whole commit history, and
  the engine refuses a writer that takes longer than 30 s to start. The mirror
  therefore stops after `ESTAMPES_UVA_MIRROR_MAX_COMMITS` commits (default 300) and
  reports `budgetExhausted` in `diagnostics.mirror`. The canvas is unaffected.
  Export what you need and start a new `ESTAMPES_UVA_BETA_DIR` to continue. If a
  UVA store cannot start at all, the server logs it and runs without UVA.

## Enable on Linux

Use Node 22, `/usr/bin/flock` (Debian package `util-linux`), and an existing trusted
parent directory. The Beta directory must be private to the server UID (0700),
without symlinks, and neither inside nor above `ESTAMPES_STORAGE_DIR`.

```sh
npm ci
export ESTAMPES_UVA_BETA=1
export ESTAMPES_UVA_BETA_DIR=/srv/estampes-beta
export ESTAMPES_UVA_BETA_PROFILE=linux-process-crash-test
npm start
```

`linux-process-crash-test` is explicitly **not power-loss durable**. It uses the
existing isolated Linux process-crash engine without upgrading its qualification.
Its schema's `persistence: memory` is the existing non-durable classification;
files survive supported process restarts, subject to filesystem behavior. The
application never changes that historical schema to imply a stronger guarantee.

`linux-local-durable` selects the existing engine's strict Linux ext4/XFS mount
and private-UID checks. It is an experimental native profile, **not production
or power-loss certification**. The stored profile is immutable: switching a
test store to this profile is rejected. Use a new directory instead.

| Deployment | Behavior |
| --- | --- |
| Linux local ext4/XFS | Explicit native profile permitted after actual mount and ownership checks; qualification remains open |
| Docker named volume / bind mount | Separate `/uva-beta` mount; explicit process-crash profile supported. Native profile requires eligible actual mount, never inferred from the host OS |
| OverlayFS | Process-crash profile can be explicitly selected; native profile rejected |
| Network filesystem | Native profile rejected. Process-crash behavior has not been qualified; use a local volume |
| macOS / Windows | Native server activation rejected; use a Linux environment and explicitly choose process-crash mode |
| Docker Desktop / WSL2 | Linux VM filesystem is a distinct environment; no macOS/Windows host durability claim |
| Read-only storage / wrong UID / symlink / incompatible data | Activation fails closed; no fallback writer or automatic directory adoption |

The Docker image includes `flock` and creates `/uva-beta` owned by uid 1000.
The standard Compose file remains legacy-only. To opt in with a separate volume:

```sh
export ESTAMPES_UVA_BETA_PROFILE=linux-process-crash-test
docker compose -f compose.yaml -f compose.uva-beta.yaml up -d --build
```

Do not use `docker compose down -v` to turn Beta off: that deletes volumes.

## Use the Workbench

Open **UVA Experimental Beta** from the existing Workbench, or call
`experimental_workspace` with `action: list` from ChatGPT. Upload one to four
images directly in the editor; each becomes a separate editable visual item.
Existing image/workspace references can be copied in the advanced controls.

Create layers, select an active layer, draw points/boxes/arrows/freehand lines,
select and move annotations, or edit their coordinates, curve vertices, label and color. Layer
visibility, lock, opacity and names are document state. Zoom, pan, selection and
closing the editor are local view state. Select a saved workspace to reopen it.

The module section discovers existing synchronous visual capabilities and their
parameter schemas from the existing registry. Enable modules through the normal
Store consent flow. Module outputs become editable scene objects on the selected
item; their results and image annotations share one authoritative revision.
Graph and image annotation are the demonstrated capabilities. CAS calculators
and legacy Workbench panels remain available in their original path; CAS notebook
persistence is not represented as a UVA scene transaction in this Beta. Async,
network-backed and custom interactive module views need additional adapters
(existing architecture follow-ups [#84](https://github.com/Curium-3391/Estampes/issues/84)
and [#85](https://github.com/Curium-3391/Estampes/issues/85)).

GPT uses `experimental_workspace` to read `open`, discover `modules`, or `render`
actual image/composite pixels. For a write it calls `prepare` with a UUID request
ID, the observed document revision and a typed operation, then `commit` with the
**exact** returned prepared value. The UI does the same through app-only
`uva_user_command`; caller-supplied author fields cannot change the actor.
Prepared commands are signed and survive restart. Retry the original prepared
value unchanged after interruption to obtain the original Ledger ACK. A stale
revision requires refreshing and reviewing the edit. Never automatically rebase
an old visual edit. Failed writes display an error and do not change the view.

## Assets and legacy copies

Original image bytes are copied into the separate content-addressed Beta asset
directory, hash-checked and synced **before** publishing a document reference.
There is no cross-store atomic transaction: a failed preparation can leave an
unreferenced asset, but an annotation ACK alone does not certify external image
bytes. Every image read/export and every commit rechecks referenced assets.
Missing or corrupted images produce an actionable error; document metadata and
saved exports remain accessible.

Legacy image/workspace import is explicit and copy-based. Original bytes, marks,
layers and their local IDs are preserved, scoped to the new scenes. Historical
fields are retained verbatim in document source archives. Unsupported external
links, image/embedded scene objects or unrepresentable geometry block the copy
with a report; they are never silently discarded. The legacy source is not
changed. Imported findings are not upgraded into newly verified claims.

## Limits and maintenance

Fixed limits are four workspaces, four items per workspace, 25 revisions per
workspace (including creation), 128 annotations, 64 objects and 1 MiB of document
JSON, including recovery archives. Each source image is at most 8 MiB; the Beta
asset directory is capped at 64 MiB. Saved exports are capped at 128 MiB. These
limits can reject large legacy copies; export or keep using the source. No-op
commands are rejected, and exact retries do not create additional revisions.
Underlying 256 MiB document-store quota and storage reserve checks remain intact.

Automatic lifecycle maintenance and GC are **disabled** for this bounded Beta.
The original lifecycle code, history, pins, backups, G1/G2 grace and crash tests
are retained. Do not infer maintenance qualification from a small passing UI test.
With the app stopped, administrative verification/checkpoint/document-store
backup is available using the existing lease and maintenance APIs:

```sh
node scripts/uva-maintenance.mjs /srv/estampes-beta linux-process-crash-test verify
node scripts/uva-maintenance.mjs /srv/estampes-beta linux-process-crash-test usage
node scripts/uva-maintenance.mjs /srv/estampes-beta linux-process-crash-test checkpoint '{"name":"before-beta-test"}'
```

`backupStart`/`backupStep`/`backupCancel` retain the original document-store-only
backup contract (destination must satisfy its private `estampes-pr1c-*` profile).
They do **not** back up binary images. Use logical exports for documents + assets.
Restored engine backups remain read-only without continuation proof.

## Export, recover, and return to legacy

Click **保存／匯出** or use action `export`. Save the returned `.uva.zip` outside
the server. It contains the exact editable document, original image assets and
hash manifest. It is a portable logical copy, not a transaction Ledger/history
backup. The saved server artifact remains downloadable at its signed URL after
writer interruption or Beta deactivation, provided the configured Beta directory
and access key remain available. No active writer is needed to download it.

For non-destructive recovery into a **new, empty, separate** directory:

```sh
node scripts/uva-recover.mjs /srv/estampes-beta EXPORT_SHA256 /srv/estampes-beta-recovered linux-process-crash-test
```

This reads the source export without opening its writer. New document/entity
revision history starts at one; the exact original document and audit revisions
remain in the recovery source archive. The original directory is preserved.
Recovery with archives exceeding the 1 MiB Beta bound is rejected explicitly.
Arbitrary foreign archives are not adopted as locally authenticated state.

Set `ESTAMPES_UVA_BETA=0` and restart to return to legacy operation. Keep
`ESTAMPES_UVA_BETA_DIR` configured if existing export links must remain readable.
For Compose, remove the opt-in overlay and retain both volumes; add
`ESTAMPES_UVA_BETA_DIR=/uva-beta` and retain its mount if serving saved exports
while disabled. Re-enabling with the same directory/profile reopens Beta state.

## Durability qualification (what was measured)

`node scripts/uva-qualify.mjs` produces raw evidence for the canvas mirror's store:
a long history, repeated `SIGKILL` of a committing process, a full filesystem, an
export and recovery round trip, and many documents. Results on a Linux 6.18
container (ext4 root, `linux-process-crash-test` profile, Node 22), one image of
640×400 with up to 120 marks:

| Check | Before the engine rework | After |
|---|---|---|
| Acknowledged revision lost after kill | 0 in 6 trials | 0 in 18 trials (180 kills) |
| Store left read-only after a kill | 1 in 6 trials, 3 of 3 earlier probes | 0 in 18 trials |
| 150 commits: one commit | 4.4 s | 1.9 s |
| 300 commits: cold start | over the 30 s limit from about 200 commits | 9.7 s |
| 300 commits: commit latency p50 / p95 | not reachable | 2.2 s / 3.3 s |
| Disk per commit (120-mark canvas) | about 0.5 MB, growing with history | about 0.11 MB, constant |
| Filesystem full | refused with `STORAGE_UNAVAILABLE`, nothing lost; writes resume once space is freed | unchanged |
| Export, then recover into a fresh store | hashes match | unchanged |

What the rework changed (all in `src/persistence/`, owner-authorized; the sealed
hashes and the reason are recorded in
`docs/rfc/unified-visual-architecture/evidence/pr1b-runtime-source-index.json`):

- **Crash safety.** Claim files are written under a `.partial` name and linked into
  place when complete. On open, leftovers that cannot be published (partial claims,
  zero-byte claims, torn temporaries of uncommitted transactions, CURRENT claims of
  transactions that never became members) are closed as aborted instead of leaving
  the store read-only. Anything tied to a committed transaction still fails closed.
- **Bounded store-wide recovery points:** the newest 20 plus named checkpoints, as
  the storage RFC specifies. Every Document's own history stays lossless.
- **Verification that does not grow with history.** Open and commit verify the
  root, every index, the current closure, retained recovery points and the Ledger,
  but reconstruct historical Document versions only when they are read; GC, backup
  and the `verify` maintenance action still verify all history. Settled
  transactions are not re-synced on every open. Verified index pages are reused
  while their physical fingerprint is unchanged, and dependencies are re-checked by
  fingerprint (device, inode, size, mtime, ctime) instead of being hashed again.
- **Shorter delta chains:** a full copy every 32 revisions.

Still open: cold start and commit time still grow slowly with history (the
transaction journal and the Ledger are read in full at open; journal compaction is
part of maintenance, which stays off in the Beta). Not provable in a container:
host power loss, real ext4/XFS fsync ordering, physical ENOSPC, near-64 MiB cold
start (issues #89 and #91).

## Evidence and reporting

See the [full integration report](rfc/unified-visual-architecture/PR-1B-FULL-INTEGRATION-REPORT.md)
and its browser screenshot and real Docker restart evidence. Browser automation
uses Chromium and the real MCP server with a fixture Host relay; live ChatGPT Host
acceptance has **not** been performed by that test.

Known work: [history/drain #88](https://github.com/Curium-3391/Estampes/issues/88),
[large startup/RSS #89](https://github.com/Curium-3391/Estampes/issues/89),
[G2 #90](https://github.com/Curium-3391/Estampes/issues/90), and
[native/capacity/backup qualification #91](https://github.com/Curium-3391/Estampes/issues/91).
Report Beta feedback with profile, observed revision, request/ACK IDs, exact error,
module capability and reproduction steps. Preserve a saved export; never attach
access keys, signing keys or private image bytes to a public issue inadvertently.


Large tool results use immutable, bounded read snapshots. The Workbench assembles
them automatically; GPT can fetch the remaining segments using `read_chunk` with
the returned transport ID and next offset, concatenate the data and parse JSON.
Use the complete signed prepared value for commit/retry. Snapshots expire after
ten minutes; expiration before commit requires reopening/preparing again. The
cache never publishes workspace state. Model render images remain subject to the
existing Host size cap and always use normalized image coordinates for editing.
