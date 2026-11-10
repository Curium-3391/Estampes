# UVA store

UVA is the store where Estampes commits canvases, workspace copies, workspaces,
panel layouts and calculator notebooks. It is **on by default** whenever
`ESTAMPES_STORAGE_DIR` is set. GPT reads it through `uva_store` (read-only);
edits go through the ordinary canvas, workspace, surface and calculator tools.

Production qualification: **NOT QUALIFIED**. The native A/B result remains
**INCONCLUSIVE — DEFAULT TO BASELINE**. The G2 intermittent (#90) is reproduced,
explained and fixed; see the [root cause](rfc/unified-visual-architecture/PR-1D-G2-ROOT-CAUSE.md).
A power cut is simulated at every fsync in [UVA power loss](UVA-POWERLOSS.md).

## Canvas store: commit canvases to UVA (default)

`ESTAMPES_CANVAS_STORE=uva` (the default; needs `ESTAMPES_STORAGE_DIR`, and turns
the UVA store on by itself with `ESTAMPES_UVA_DIR` or its default; `legacy`
switches back) keeps every image, its canvas and its workspace copies **only in
the UVA store**: no `images/<hex>/` file (`source`, `meta.json`, `canvas.json`,
`marks.svg`, `history.jsonl`, `derived.json`, `sets/`) is written. The canvas
editor, its tools, undo and the widget are unchanged; only where the canvas is
kept moves.

- **Save.** Every save writes a record durably (file and folder fsync) to
  `<storage>/uva-pending/<hex>.json`, then a coalesced background commit puts it in
  the UVA document (`ESTAMPES_UVA_MIRROR_IDLE_SEC`, default 15 s, at most two
  minutes). Once the document holds exactly that content the pending file is
  removed. A killed server loses nothing: pending files are committed at the next
  start. **A save is acknowledged only when its pending record is durable**: if it
  cannot be written, the tool call fails with that reason (`was not saved`).
- **Order.** Each record carries a per-image sequence number that grows by one
  with every accepted save; between the UVA document and the pending record the
  higher number wins. Clock times are never compared.
- **What a record holds.** The canvas, its change log (the last 200 lines), the
  image's metadata (where it came from, its size) and its processed-view recipes
  and calibrations. The image's bytes are a verified, content-addressed asset of
  the store, written durably before the upload is acknowledged.
- **States per image.** `diagnostics.mirror.canvasStore.images[<imageId>]`
  reports them apart: `pendingSeq` (the last durable record), `committedSeq` (the
  last record in the UVA document) and `failedSeq` (a save that was refused).
- **What the document holds.** Marks, layers, scene objects, gesture decisions and
  rejections are stored as document structure. Anything the structure cannot
  reproduce exactly (archived legacy fields such as user-edit records) is kept as a
  small exact patch next to it, and every commit first proves that
  structure + patch gives back the canvas byte for byte (canonical hash).
  `diagnostics.mirror.lastResidualBytes` shows the size of that patch; it is 0 for
  ordinary marks and layers.
- **Migration** is lazy: an image an older version stored (`images/<hex>/`) moves
  into the store, bytes, metadata, canvas, processed views and change log, the
  first time it is opened, and a workspace copy (`sets/<setId>.json`) the first
  time its workspace is. After that its files are never read or written again
  (they are left on disk, untouched).
- **Image layers** (`add_image_layer`, a promoted base image, a copied canvas)
  are stored as verified assets. On commit each inline PNG must decode and
  re-encode to exactly the same base64 text; its bytes go to the content-addressed
  asset folder and the document keeps only a reference, so a canvas with image
  layers stays small. On restore the PNG is read back and checked against its hash.
  A canvas whose base image was promoted has a transparent background; its marks
  stay anchored to the source image, which must still verify. Assets are never
  deleted (no asset GC yet), so removing an image layer does not free its bytes.
- **Links to other canvases** (paired views, workspace links) are relation
  bindings in the document. The far end names the other canvas's own document
  and mark; it stays `unresolved` because each document holds one canvas, and the
  link record (label, confidence, the user's review) is kept verbatim, so the
  canvas comes back exactly. Gesture decisions and rejected claims are document
  structure too.
- **Workspace copies** (`mode: copy`) are committed under their set key
  `img:<hex>#<setId>`, one document per copy, with their own change log.
- **Workspaces, their change logs, panel surfaces and calculator notebooks** live
  only in the store; no file of theirs is written. Each is one UVA document (kind
  `graph`, one empty scene) whose `estampes.beta:record` extension holds the
  record's JSON, its hash and its seq, so it shares the store's history, recovery
  points and compaction. Their modules read and write through the store
  (`src/uva/record-store.js`): a save is acknowledged once it is written durably
  to `uva-pending/records/` with the next seq (and fails when it cannot be), then
  a coalesced commit puts it in its document. A read takes the higher seq of the
  pending copy and the document. A workspace's change log keeps its last 200
  lines. Files an older version wrote (`workspaces/<hex>.json` and its
  `.history.jsonl`, `surfaces/sf_<hex>.json`, `cas/notebooks/nb_<hex>.json`) are
  migrated in the first time their id is read and never read or written again.
  `diagnostics.mirror.recordStore.records` lists, per record, the pending seq and
  the committed seq. These documents are not listed by `uva_store`.
- **Not yet in UVA**: more than 512 marks or 64 objects per
  canvas, malformed links (for example one without its far end), or a store over
  its limits. Such a canvas keeps its pending file, which then wins on
  restore, and is listed under `diagnostics.mirror.blocked`.
- **Limits.** Image bytes are capped by `ESTAMPES_UVA_ASSET_MAX_MB` (default
  1024, 32 MiB per image). Each image is one document, and the store holds at
  most 512 documents; a canvas past that keeps its pending record (which reads
  still return) and is listed under `diagnostics.mirror.blocked`.
  `ESTAMPES_STORAGE_RETENTION_DAYS` does not apply to the store. PDFs
  (`documents/`) and module state are still files.
- **History compaction.** The store keeps what its 20 recovery points, named
  checkpoints and readers need, plus about the last 7 days of commits (the ACK
  replay window). Older history is retired automatically in small steps, mostly
  while the writer is idle, and its files are deleted after a 1-day grace. See
  [history compaction](rfc/unified-visual-architecture/HISTORY-COMPACTION.md).
  `ESTAMPES_UVA_MIRROR_MAX_COMMITS` (default 10000) only caps commits retained in
  that window; it is not a lifetime limit. When it is reached the store reports
  `budgetExhausted` in `diagnostics.mirror`. If the store cannot start at all,
  the server logs it and runs on the legacy files, which do not have what was
  saved to the store; run `scripts/uva-to-legacy.mjs` first (see below).
- `diagnostics.mirror.canvasStore` also counts writes, refused writes, commits,
  reads by source (`uva` or `pending`) and the last error.

- **No lifetime limit.** Measured with `node scripts/uva-qualify.mjs --only history
  --history 2500 --store 1 --edit one --day-every 100` (one 120-mark canvas, one
  simulated day every 100 commits, development machine): all 2500 commits
  succeeded, disk levelled off at 13–18 MB (before compaction, 1915 commits filled
  the store at 108 MB), a commit took 1.3 s (p50, flat after about 1000 commits)
  and cold start was 7.2 s. Compaction now runs as single units (#107), so a
  commit waits for at most one: with saves back to back, p99 fell from 27 s to
  8.0 s and the worst from 56 s to 9.6 s (p50 0.98 s). Saves are acked from their
  pending file first, so the canvas does not wait for it.

Production qualification is unchanged: **NOT QUALIFIED** (power loss #89/#91).

## Enable on Linux

Use Node 22, `/usr/bin/flock` (Debian package `util-linux`), and an existing trusted
parent directory. The store directory must be private to the server UID (0700),
without symlinks, and neither inside nor above `ESTAMPES_STORAGE_DIR`. Without
`ESTAMPES_UVA_DIR` it is `<storage dir>-uva`.

```sh
npm ci
export ESTAMPES_STORAGE_DIR=/srv/estampes
export ESTAMPES_UVA_DIR=/srv/estampes-uva            # optional
export ESTAMPES_UVA_PROFILE=linux-process-crash-test # the default on Linux
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

The Docker image includes `flock`, creates `/uva-beta` owned by uid 1000 and makes
it the default store folder (as `ESTAMPES_UVA_BETA_DIR`, so an explicit
`ESTAMPES_UVA_DIR` or `ESTAMPES_UVA_BETA_DIR` still wins). `compose.yaml` mounts the `uva-beta` volume there, so
the canvas store is on with `docker compose up -d`.

Do not use `docker compose down -v`: that deletes volumes.

## Assets and legacy copies

Original image bytes are copied into the separate content-addressed asset
directory, hash-checked and synced **before** publishing a document reference.
There is no cross-store atomic transaction: a failed preparation can leave an
unreferenced asset, but an annotation ACK alone does not certify external image
bytes. Every image read/export and every commit rechecks referenced assets.
Missing or corrupted images produce an actionable error; document metadata and
saved exports remain accessible.

## Limits and maintenance

Limits per store: 512 documents, 512 annotations and 64 objects per canvas, and
1 MiB of document JSON, including recovery archives. Each image is at most
32 MiB; the asset directory is capped by `ESTAMPES_UVA_ASSET_MAX_MB` (default
1024). Saved exports are capped at 128 MiB. A canvas over these limits keeps its
pending record (see above). Exact retries do not create additional revisions.
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

Use `uva_store` action `export`. Save the returned `.uva.zip` outside
the server. It contains the exact editable document, original image assets and
hash manifest. It is a portable logical copy, not a transaction Ledger/history
backup. The saved server artifact remains downloadable at its signed URL after
writer interruption or with `ESTAMPES_CANVAS_STORE=legacy`, provided the store
directory and access key remain available. No active writer is needed to download it.

For non-destructive recovery into a **new, empty, separate** directory:

```sh
node scripts/uva-recover.mjs /srv/estampes-beta EXPORT_SHA256 /srv/estampes-beta-recovered linux-process-crash-test
```

This reads the source export without opening its writer. New document/entity
revision history starts at one; the exact original document and audit revisions
remain in the recovery source archive. The original directory is preserved.
Recovery with archives exceeding the 1 MiB Beta bound is rejected explicitly.
Arbitrary foreign archives are not adopted as locally authenticated state.

To return to legacy operation, stop the server, write the records that live only
in the store back to their files, then set `ESTAMPES_CANVAS_STORE=legacy` and
start it again:

```sh
node scripts/uva-to-legacy.mjs /srv/estampes            # the store: /srv/estampes-uva
node scripts/uva-to-legacy.mjs /data /uva-beta           # inside the Docker image
```

It writes every image (`source`, `meta.json`, `canvas.json`, `history.jsonl`,
`derived.json`) and workspace copy (`sets/`) from the higher seq of its document
and its pending record, then workspaces, surfaces and notebooks. `marks.svg` is
not written; the legacy store writes it again on the next save. Keep the store directory and its mount if
existing export links must remain readable. Switching back to `uva` with the same
directory and profile reopens the store.

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
