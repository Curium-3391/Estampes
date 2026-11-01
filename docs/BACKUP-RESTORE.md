# Backup, restore, upgrade and keys

Everything Estampes keeps lives in one place: the storage folder (`/data` in Docker, the named volume `estampes-data`). This page shows how to back it up, restore it, upgrade and roll back safely, and what to do if a key leaks.

## What was verified, and what was not

| Part | Status |
| --- | --- |
| The data format survives a pack → unpack → new server round trip (canvases, layers, GPT's and the user's marks, links and their review, workspaces, enabled modules, a calculator panel with a notebook cell and its plot) | **Verified** by `node scripts/verify-backup-restore.mjs`, which uses temporary folders and a plain `tar`, and compares what two different servers report. 12 checks passed with the calculator, 9 without it. |
| The Docker commands below (volume names, `busybox`, ownership) | **Not executed** while writing this page: no Docker daemon was available. They use only standard Docker and `tar` features; run the restore once on a spare machine before you rely on it. |
| Rolling back to an older Estampes version | **Not tested.** Older versions are not guaranteed to read data written by newer ones (see below). |

Run the verification yourself any time (needs `npm ci`; the calculator part is skipped without `python3` + SymPy):

```sh
node scripts/verify-backup-restore.mjs
```

## What is in the folder

| Path in `/data` | Content | Needed to restore your work? |
| --- | --- | --- |
| `images/<hash>/` | The original image (`source`), `meta.json`, `canvas.json` (marks, layers, links, reviews, scene objects), `marks.svg`, `history.jsonl`, `derived.json`, `sets/` | Yes |
| `workspaces/` | Workspaces and their history | Yes |
| `documents/` | Stored PDFs | Yes, if you use PDF pages |
| `surfaces/`, `cas/notebooks/` | Open panels, layouts, calculator notebooks | Yes, if you use the workbench |
| `modules/` | `registry.json` (what is enabled and granted), `audit.jsonl`, `secrets.json`, installed `packages/`, `trusted-keys.json`, `inbox/`, `approvals/` | Yes, to keep modules enabled and their keys |
| `access-key` | The connector key (mode 600) | Yes, to keep the same connector URL |
| `admin-key` | The administrator key that approves module installs (mode 600) | Yes |

Not in the folder: the calculator container (it keeps no data), the cloudflared tunnel address, and your `.env` file. Keep `.env` in your own backup.

**A backup contains your keys and every image.** Store it as carefully as the server itself: encrypted disk or encrypted archive, never in a public place, never attached to a chat.

## Back up (Docker)

Stop the main container for a consistent copy; files are written atomically, but a stopped server cannot be half-way through a change. The calculator holds no data and can keep running.

```sh
docker compose stop estampes
docker volume ls | grep estampes-data          # note the exact name, usually estampes_estampes-data
docker run --rm -v estampes_estampes-data:/data:ro -v "$PWD":/backup busybox \
  tar czf /backup/estampes-$(date +%F).tgz -C /data .
docker compose start estampes
tar tzf estampes-$(date +%F).tgz | head          # the archive lists images/, workspaces/, access-key ...
```

Expected: a `.tgz` of the volume's size appears next to your `compose.yaml`, and the listing shows `./images/…` and `./access-key`. A server started again is `healthy` (`docker compose ps`).

Without Docker, stop the server and `tar czf estampes.tgz -C "$ESTAMPES_STORAGE_DIR" .`.

## Restore (Docker)

Restore into a **new, empty** volume, check it, and only then switch to it. That way a bad backup cannot destroy the data you have.

```sh
docker compose down                                   # no -v
docker volume create estampes_estampes-data-restored
docker run --rm -v estampes_estampes-data-restored:/data -v "$PWD":/backup busybox \
  sh -c 'tar xzf /backup/estampes-2026-11-01.tgz -C /data && chown -R 1000:1000 /data'
```

Then point compose at the restored volume. The simplest way is a `compose.override.yaml` next to `compose.yaml`:

```yaml
volumes:
  estampes-data:
    name: estampes_estampes-data-restored
    external: true
```

Run `docker compose up -d`, wait for `healthy`, and check:

1. `docker compose exec estampes ls /data/images | head` lists your images.
2. `curl -s http://127.0.0.1:8787/healthz` shows `"storage":{"enabled":true,"writable":true}`.
3. In ChatGPT (same connector URL, because `access-key` came back) ask GPT to show a canvas you know; marks, layers and notebooks should be there. Imported calculator results may need recomputing ([Workbench](WORKBENCH.md)).

The `chown` matters: the container runs as user `node` (uid 1000) and the key files are mode 600, so files owned by root would make the server unable to read them. Once you are satisfied, remove the override and the old volume yourself (`docker volume rm …`); Estampes never does that for you.

Without Docker: unpack into an empty folder and set `ESTAMPES_STORAGE_DIR` to it. **Two servers must never share one storage folder.**

## Upgrade

```sh
# 1. back up (above)
git pull && docker compose up -d --build           # or: change the pinned image tag and `docker compose pull && docker compose up -d`
curl -s http://127.0.0.1:8787/version               # shows the new version
```

The data volume is kept. After an upgrade, open a **new** ChatGPT conversation: an old one keeps the old tool list and widget. Read the [changelog](../CHANGELOG.md) first for anything marked as changing a stored format; the project is pre-1.0 and formats can change.

### Data compatibility

- Stored files carry format versions (for example `estampes.visual/2` documents; the older `/1` is still read). A newer Estampes is meant to read data written by older ones.
- The reverse is not promised: an older Estampes may ignore or refuse data written by a newer one, and there is no downgrade conversion.
- Therefore: **take a backup before every upgrade**, and treat that backup as the way back.

## Roll back

1. `docker compose down` (no `-v`).
2. Pin the earlier image (`image: ghcr.io/<owner>/estampes:0.19.4`, see [Releasing](RELEASE.md#roll-back)) or check out the earlier tag and rebuild.
3. If the problem is in the data (the old version cannot read it), restore the backup from before the upgrade into a new volume as above.
4. Never delete the data volume to "start clean" unless you have a verified backup. Rolling back the program never requires deleting data.

## If you run without persistent storage

With no `ESTAMPES_STORAGE_DIR`, nothing is written to disk. Canvases live in memory for about an hour (`ESTAMPES_CACHE_TTL_MINUTES`) and are lost on every restart. Heroku's filesystem is also reset at least daily. Export what matters (the result of `present_visual` includes download links for the image and a layered `marks.svg`; a workspace can be exported as a `.estampes` bundle) or use Docker with its volume.

`docker compose down -v` deletes the volume and with it every image and mark. So does removing the volume in Docker Desktop.

## Keys and secrets

| Secret | Where | Rotate | After rotating |
| --- | --- | --- | --- |
| Access key (connector) | `/data/access-key`, or `ESTAMPES_ACCESS_KEY` | Delete the file and restart (`docker compose restart estampes`); the new URL is printed once in the log. If you set `ESTAMPES_ACCESS_KEY`, change it in `.env` and restart. | Replace the connector URL in ChatGPT. Old download links stop working (they were signed with the old key). |
| Administrator key | `/data/admin-key`, or `ESTAMPES_ADMIN_KEY` | Delete the file and restart. | Module approvals made with the old key no longer count; approve pending plans again. |
| Module secrets (for example the Astrometry.net API key) | `/data/modules/secrets.json` or environment | Revoke the key at its provider, then `scripts/estampes-module.js secret set <moduleId> <name>` with the new value. | Run a job that uses it to confirm. |
| Tunnel address | Printed by the `tunnel` container | Restart the tunnel (`docker compose --profile tunnel restart tunnel`) for a new address; the key is still required. | Update the connector. |

### If the access key leaked

Treat the key as giving read access to **every stored image and mark**, and write access to canvases, plus permission to run enabled modules.

1. Rotate the access key now (above) and update the connector. This ends access through the old URL immediately.
2. Remove anything shared that contained the URL (chat transcripts, screenshots, pasted logs; the tunnel log line includes the key).
3. Look for use you did not make: `docker compose logs estampes` for requests, `/data/modules/audit.jsonl` for module runs, plans and approvals, and each canvas's `history.jsonl` for changes by tool.
4. If modules with network permission were enabled, assume data they send could have been triggered by the holder of the key: check the audit log and rotate the module secrets they use.
5. If the images are sensitive, assume they were readable while the key was exposed. Estampes cannot tell you whether they were downloaded.

### If the administrator key leaked

The holder could approve module installs only if they can also reach the server's command line (approvals are files written on the server, not something typed into the chat). Rotate it anyway and review `audit.jsonl` and the installed `packages/`.
