# UVA power-loss simulation

Issue #91 asks whether a power cut can take back a result Estampes has already
acknowledged. A process crash (SIGKILL, `docker compose restart`) cannot. The
operating system still holds every write in its page cache. A power cut is
harder: only data the filesystem was told to flush (`fsync`) is guaranteed to
be on disk.

`scripts/powerloss/` checks this by simulation. You need Linux and no special
hardware.

## How it works

1. A workload runs with `scripts/powerloss/trace.mjs` preloaded into every
   Node process, including the store's writer process. Whenever a file or
   directory is fsynced, the preload records the file's bytes or the
   directory's entries. It does this in order, before the fsync returns to the
   caller. The workload also records each acknowledged result: a commit, an
   uploaded image, a drawn mark, an image layer or a workspace.
2. For each chosen crash point, `scripts/powerloss/model.mjs` rebuilds the
   folders as a power cut right after that record could leave them:
   - each directory holds only the entries from its last fsync, and none if it
     was never fsynced;
   - each file holds only the bytes from its last fsync, and is empty if it
     was never fsynced.

   This is the most pessimistic state a filesystem that honours fsync can
   produce. ext4 and XFS keep more than this.
3. The store or server is started on the rebuilt folders. The crash point
   passes when all three of these hold:
   - it opens without manual repair;
   - every result acknowledged before the cut is there with its acknowledged
     content;
   - it accepts a new write.

Run:

```bash
# The store alone: commits, a restart in the middle, history compaction after 64 commits
node scripts/powerloss/simulate.mjs --dir /path/on/ext4 --profile linux-local-durable --commits 80 --points 150
# The whole server through its MCP tools: uploads, marks, an image layer, a workspace
node scripts/powerloss/server.mjs --dir /path/on/ext4 --profile linux-local-durable --edits 16 --points 80
```

`--profile linux-local-durable` requires the folder to be on a local ext4 or
XFS mount. Without it, the test profile works on any filesystem. `--out
report.json` saves the report. `tests/uva-powerloss.test.js` runs small
versions in CI.

## Results (2026-11-10)

All runs used Linux 6.18 and Node 22, on a real ext4 filesystem in a loop
device, with the `linux-local-durable` profile.

| Run | Records (fsyncs and results) | Crash points | Passed |
| --- | --- | --- | --- |
| Store, 6 commits, restart in the middle | 775 | 335 | 335 |
| Store, 80 commits, restart, history compaction and GC | 8,567 | 819 | 819 |
| Server, 2 uploads, 16 edits, an image layer, a workspace, UVA commits during the run | 1,979 | 139 | 139 |

A rebuilt crash state is a copy, so its files have new inode numbers; a real
power cut keeps them. One store check compares inode identity (the GC
candidate ownership check in `src/persistence/gc.js`), so the checker runs
from a copy of the source with only that comparison relaxed; its content-hash
check stays. Before that, the 80-commit run reported 169 failures, all of them
this comparison on copied files, none a lost result.

The simulation found four gaps. All four are fixed:

- **New UVA folder not fsynced into its parent.** The folder the server
  creates (`<storage>-uva` by default) was created without fsyncing the folder
  above it, so a power cut could drop the whole store after commits were
  acknowledged. Every new folder now fsyncs its parent.
- **Interrupted first start blocked the store.** A cut during the very first
  start left a half-made store that every later start refused ("Unrecognized
  Beta directory"). Nothing in it was ever acknowledged, because the format
  file is written last and only then does the service answer. Such a folder
  is now started again. A folder holding anything else is still refused.
- **Uploaded images not fsynced.** The legacy store writes image files without
  fsync, so an upload could be answered and then lost. With the UVA store on,
  the image files and their folders are now fsynced before the upload is
  answered.
- **Damaged legacy image copy had no fallback.** If the legacy image file is
  missing, empty or torn after a cut, the image now comes back from the UVA
  asset store, which keeps a verified copy. The legacy file is repaired too.

## What this does not prove

- That a given disk, controller, hypervisor or Docker Desktop VM honours
  fsync. On macOS and Windows, Docker keeps data inside a Linux VM whose
  virtual disk the host may cache. A real power cut there is outside what any
  software test in the container can show.
- Torn writes inside one fsynced file. The model keeps whole files. The store
  verifies hashes, so a torn page is detected, not silently used.
- Physical ENOSPC and full reader/backup pressure (#91). `scripts/uva-qualify.mjs`
  covers ENOSPC on a size-limited filesystem.

So `uva_store status` still reports `production: NOT QUALIFIED`. For a native
Linux host on local ext4/XFS with a disk that honours flushes, these results
are the software half of the qualification.
