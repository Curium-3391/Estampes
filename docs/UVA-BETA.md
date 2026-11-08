# UVA Experimental Beta

UVA connects the Workbench's image annotation editor and existing visual modules
(such as Graph) to the same persistent document that GPT reads and edits. It is
**off by default**. Legacy images, workspaces, modules and their writer continue
working. No startup migration occurs.

Production qualification: **NOT QUALIFIED**. The native A/B result remains
**INCONCLUSIVE — DEFAULT TO BASELINE**. The G2 intermittent (#90) is reproduced,
explained and fixed; see the [root cause](rfc/unified-visual-architecture/PR-1D-G2-ROOT-CAUSE.md).

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
- Cost: since index pages are reclaimed (see the changelog), a commit uses about
  0.07 MB of disk and 1–2 s on the development machine, so 1000 commits fit in
  about 73 MB of the 256 MiB Beta quota. Saves are still coalesced because of the
  commit time.
- Mirror documents use higher Beta limits (64 workspaces, 512 annotations each).
- **Commit budget.** The store's cold start grows with its whole commit history, and
  the engine refuses a writer that takes longer than 30 s to start. The mirror
  therefore stops after `ESTAMPES_UVA_MIRROR_MAX_COMMITS` commits (default 1800) and
  reports `budgetExhausted` in `diagnostics.mirror`. The canvas is unaffected.
  Export what you need and start a new `ESTAMPES_UVA_BETA_DIR` to continue. If a
  UVA store cannot start at all, the server logs it and runs without UVA.

## Canvas store: commit canvases to UVA (optional, phase 1)

`ESTAMPES_CANVAS_STORE=uva` (needs the Beta and `ESTAMPES_STORAGE_DIR`; the default
is `legacy`) makes an image's own canvas **committed to its UVA document and
restored from it**. The canvas editor, its tools, undo and the widget are
unchanged; only where the canvas is kept moves. It replaces the mirror for those
canvases (`ESTAMPES_UVA_MIRROR` is then not needed).

- **Save.** Every save writes a record durably (file and folder fsync) to
  `<storage>/uva-pending/<hex>.json`, then a coalesced background commit puts it in
  the UVA document (`ESTAMPES_UVA_MIRROR_IDLE_SEC`, default 15 s, at most two
  minutes). Once the document holds exactly that content the pending file is
  removed. A killed server loses nothing: pending files are committed at the next
  start. **A save is acknowledged only when its pending record is durable**: if it
  cannot be written, the tool call fails with that reason, even though
  `canvas.json` may already hold the edit.
- **Order.** Each record carries a per-image sequence number that grows by one
  with every accepted save; between the UVA document and the pending record the
  higher number wins. Clock times are never compared.
- **The legacy copy.** `canvas.json` has no sequence number, so each record also
  keeps the content `canvas.json` held when the record was written. On restore,
  and for every stored canvas at startup, `canvas.json` is adopted (as the next
  number) only when it holds content the latest record does not know, which is a
  save that bypassed the server; a stale, damaged or missing copy is rewritten
  from the record instead. With no record at all, it is migrated.
- **Three states per image.** `diagnostics.mirror.canvasStore.images[<imageId>]`
  reports them apart: `legacy` (`matches`, `differs` or `missing` when the last
  record was written), `pendingSeq` (the last durable record), `committedSeq` (the
  last record in the UVA document) and `failedSeq` (a save that was refused).
- **What the document holds.** Marks, layers, scene objects, gesture decisions and
  rejections are stored as document structure. Anything the structure cannot
  reproduce exactly (archived legacy fields such as user-edit records) is kept as a
  small exact patch next to it, and every commit first proves that
  structure + patch gives back the canvas byte for byte (canonical hash).
  `diagnostics.mirror.lastResidualBytes` shows the size of that patch; it is 0 for
  ordinary marks and layers.
- **Migration** is lazy: a legacy canvas becomes a UVA document the first time it
  is opened. Startup only checks canvases the store already holds.
- **Not yet in UVA** (phase 2 and later): canvases with links to other canvases,
  image layers, copies made by workspaces, more than 512 marks or 64 objects, or a
  store over its limits. Such a canvas keeps its pending file, which then wins on
  restore, and is listed under `diagnostics.mirror.blocked`.
- **Still written:** `canvas.json`, `marks.svg` and `history.jsonl`, so switching
  back to `ESTAMPES_CANVAS_STORE=legacy` keeps every edit. Image bytes are also
  still kept in legacy storage; the UVA copy is capped by
  `ESTAMPES_UVA_ASSET_MAX_MB` (default 1024, 32 MiB per image).
- The workspace and bundle modules load and save canvases themselves. Canvases a
  tool call or a workspace HTTP route names (or that are in a workspace it names)
  are loaded from the store first and committed afterwards if they changed. Any
  image entry that reaches memory another way is restored the first time the
  server touches it. Because `canvas.json` is kept equal to the record, modules
  that read it directly see the committed canvas too, and a save that still
  bypasses the server is adopted at the next restore.
- `diagnostics.mirror.canvasStore` also counts writes, refused writes, commits,
  restores by source, migrations, adopted bypassing saves, repaired legacy copies
  and the last error.

- **Lifetime limit.** Measured with `node scripts/uva-qualify.mjs --only history
  --history 2000 --store 1` (one 120-mark canvas, development machine, partly
  under load): 1915 commits fit before the store's capacity admission refused the
  next one (108 MB on disk; the 256 MiB quota keeps a 64 MiB reserve and working
  space). Cold start at 1915 commits was 9.3 s; a commit took 3.3 s (p50). The
  commit budget (default 1800) therefore stops first, with a clear message. After
  that, or after any refused commit, saves stay in their pending files and the
  canvas is unaffected; export and start a new `ESTAMPES_UVA_BETA_DIR`. History
  compaction, which would remove this limit, is not built yet. Its G2 blocker
  (#90) is fixed.

Production qualification is unchanged: **NOT QUALIFIED** (power loss #89/#91).

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

| Check | Before the engine rework | First pass (2026-11-06) | Second pass (2026-11-07) |
|---|---|---|---|
| Acknowledged revision lost after kill | 0 in 6 trials | 0 in 18 trials (180 kills) | 0 in 10 trials (100 kills) |
| Store left read-only after a kill | 1 in 6 trials, 3 of 3 earlier probes | 0 in 18 trials | 0 in 10 trials |
| 150 commits: one commit | 4.4 s | 1.9 s | |
| 300 commits: cold start | over the 30 s limit from about 200 commits | 9.7 s (8.7 s re-measured) | 3.7 s |
| 300 commits: one commit after open | not reachable | 2.2 s | 1.1 s |
| About 920 commits: cold start / one commit | not reachable | not reachable | 4.9 s / 1.2–1.3 s |
| New index pages per commit | | 31 | 12 |
| Disk per commit (120-mark canvas) | about 0.5 MB, growing with history | about 0.11 MB, constant | about 0.12 MB, constant |
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

The second pass came from profiling a 300-commit store (open 8.7 s, commit 2.2 s):

- At open, only ACKs whose registry is still retained are re-checked against that
  registry; each ACK was checked when its own commit was verified. Retained
  recovery registries are checked structurally (pages, closure hash, Locator
  coverage); their Documents are rebuilt when one is restored or by `verify`.
- A recovery resolver row is written once, while its registry is current, and is
  resolved through the current Locator, which only ever gains rows. Rewriting all
  20 rows on every commit had made most of each commit's new index pages.
- An index update starts from the writer's verified snapshot instead of reading
  every page of that index again.
- Capacity admission still lists every entry, but reuses the size of
  content-addressed records, which are never modified in place.
- One open walks and audits the tree once (it was twice), restores quarantine only
  when a GC plan exists, re-syncs files only when the selected root's outcome is
  missing, and fully re-checks only the newest 20 journal transactions.
- A cached version proof is re-checked by physical fingerprint instead of reading
  and hashing the file again, so commits do not slow down the longer a process
  runs.

**Index page reclamation (2026-11-08).** Every 32 commits, on the writer's serialized
queue and after the ACK, the engine marks every index page and commit root that
can still be reached from CURRENT: the current, retained and checkpoint roots with
all their pages, the registry of every ACK still in the Ledger, selected CURRENT
publication evidence, roots of transactions that still own a claim, backup lists
and reader pins. It then unlinks the rest of `visual-registry/pages` and
`visual-registry/roots`. Document history in `visual-history` and
`visual-documents` is never touched. A sweep that is interrupted only leaves
garbage for the next one. The `reclaimPages` maintenance action runs it on demand.

| Check | Before reclamation | After |
|---|---|---|
| 256 MiB Beta store | full at 913 commits | 1000 commits, 72.8 MB |
| Disk per commit | about 0.12 MB | about 0.07 MB |
| A full store from before, swept once | | index files 11,218 → 2,827, 160 → 93 MB; full history `verify` passes and commits resume |
| 1000 commits: cold start | not reachable | 6.0 s |
| SIGKILL with sweeps in progress | | 0 wedged, 0 false ACK in 10 trials (100 kills) |

A sweep takes about 0.7 s on a 900-commit store, and one commit in 32 waits for it.

Still open: listing the tree and the journal at open, and capacity admission on each
commit, still grow with the number of files, so cold start reaches about 6 s at
1000 commits. Journal compaction runs through G2, whose blocker (#90) is fixed, but
is not scheduled automatically yet. Not
provable in a container:
host power loss, real ext4/XFS fsync ordering, physical ENOSPC, near-64 MiB cold
start (issues #89 and #91).

## Evidence and reporting

See the [full integration report](rfc/unified-visual-architecture/PR-1B-FULL-INTEGRATION-REPORT.md)
and its browser screenshot and real Docker restart evidence. Browser automation
uses Chromium and the real MCP server with a fixture Host relay; live ChatGPT Host
acceptance has **not** been performed by that test.

Known work: [history/drain #88](https://github.com/Curium-3391/Estampes/issues/88),
[large startup/RSS #89](https://github.com/Curium-3391/Estampes/issues/89),
[G2 #90](https://github.com/Curium-3391/Estampes/issues/90) (fixed), and
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
