# Backup, restore, upgrade and keys

Estampes keeps its data in **two places**, and a backup needs both:

- the storage folder (`/data` in Docker, the named volume `estampes-data`): keys, module state, PDFs, and changes not yet committed to the store;
- the UVA store (`/uva-beta` in Docker, the named volume `uva-beta`; without Docker `ESTAMPES_UVA_DIR`, by default `<storage folder>-uva`): images, canvases, workspaces, panel layouts and calculator notebooks.

With the default store (`ESTAMPES_CANVAS_STORE=uva`), a change is first kept as a pending record in the storage folder and moved into the UVA store a few seconds later; the pending record is then deleted. A backup of the storage folder alone therefore loses most of your work. This page shows how to back up both, restore them, upgrade and roll back safely, and what to do if a key leaks.

## What was verified, and what was not

| Part | Status |
| --- | --- |
| The data format survives a pack → unpack → new server round trip of **both roots** (canvases, layers, GPT's and the user's marks, links and their review, workspaces, enabled modules, a calculator panel with a notebook cell and its plot), both while changes are still pending and after they were committed into the UVA store | **Verified** by `node scripts/verify-backup-restore.mjs` (also run by `npm test`), which uses temporary folders and a plain `tar`, and compares what two different servers report. 27 checks passed with the calculator. It also checks that an archive of the storage folder alone does **not** bring committed work back. |
| The Docker commands below (volume names, `busybox`, ownership) | **Not executed** while writing this page: no Docker daemon was available. They use only standard Docker and `tar` features; run the restore once on a spare machine before you rely on it. |
| Rolling back to an older Estampes version | **Not tested.** Older versions are not guaranteed to read data written by newer ones (see below). |

Run the verification yourself any time (needs `npm ci`; the calculator part is skipped without `python3` + SymPy):

```sh
node scripts/verify-backup-restore.mjs
```

## What is in the two folders

| Path | Content | Needed to restore your work? |
| --- | --- | --- |
| `/uva-beta` (the whole folder) | The UVA store: images, canvases (marks, layers, links, reviews, scene objects), copies, change logs, workspaces, panel layouts, calculator notebooks, data kept by modules (model instances, #85) | **Yes** |
| `/data/uva-pending/` | Changes acknowledged but not yet committed into the UVA store | **Yes** (they are newer than the store) |
| `/data/images/`, `/data/workspaces/`, `/data/surfaces/`, `/data/cas/notebooks/` | Data from before the UVA store; moved in on first open and no longer written. With `ESTAMPES_CANVAS_STORE=legacy` these are the only copy | Yes, keep them with the rest |
| `/data/documents/` | Stored PDFs | Yes, if you use PDF pages |
| `modules/` | `registry.json` (what is enabled and granted), `audit.jsonl`, `secrets.json`, installed `packages/`, `trusted-keys.json`, `inbox/`, `approvals/` | Yes, to keep modules enabled and their keys |
| `access-key` | The connector key (mode 600) | Yes, to keep the same connector URL |
| `admin-key` | The administrator key that approves module installs (mode 600) | Yes |

Module model instances live in the UVA store, so a backup of `/uva-beta` has them; workspace bundles do not carry them yet. To take them out as JSON without running any module, stop the server and run `node scripts/export-models.mjs /data /uva-beta` (see [Modules](MODULES.md)).

Not in the folder: the calculator container (it keeps no data), the cloudflared tunnel address, and your `.env` file. Keep `.env` in your own backup.

**A backup contains your keys and every image.** Store it as carefully as the server itself: encrypted disk or encrypted archive, never in a public place, never attached to a chat.

## Back up (Docker)

Stop the main container: the two folders must be copied at the same moment, and a stopped server cannot be half-way through a change or a commit. The calculator holds no data and can keep running. One archive holds both volumes, as `data/` and `uva-beta/`.

```sh
docker compose stop estampes
docker volume ls | grep -E 'estampes-data|uva-beta'   # note the exact names, usually estampes_estampes-data and estampes_uva-beta
docker run --rm -v estampes_estampes-data:/data:ro -v estampes_uva-beta:/uva-beta:ro -v "$PWD":/backup busybox \
  tar czf /backup/estampes-$(date +%F).tgz -C / data uva-beta
docker compose start estampes
tar tzf estampes-$(date +%F).tgz | grep -E '^(data/access-key|uva-beta/)' | head   # both roots must be listed
```

Expected: a `.tgz` appears next to your `compose.yaml`, and the listing shows `data/access-key` and entries under `uva-beta/`. **If nothing under `uva-beta/` is listed, the backup is incomplete.** A server started again is `healthy` (`docker compose ps`).

Without Docker, stop the server and archive both folders together, for example `tar czf estampes.tgz -C /srv data data-uva` when `ESTAMPES_STORAGE_DIR=/srv/data` and the store is the default `/srv/data-uva`.

## Restore (Docker)

Restore into **new, empty** volumes, check them, and only then switch to them. That way a bad backup cannot destroy the data you have.

```sh
docker compose down                                   # no -v
docker volume create estampes_estampes-data-restored
docker volume create estampes_uva-beta-restored
docker run --rm -v estampes_estampes-data-restored:/data -v estampes_uva-beta-restored:/uva-beta -v "$PWD":/backup busybox \
  sh -c 'tar xzf /backup/estampes-2026-11-01.tgz -C / && chown -R 1000:1000 /data /uva-beta && chmod 700 /uva-beta'
```

Then point compose at the restored volumes. The simplest way is a `compose.override.yaml` next to `compose.yaml`:

```yaml
volumes:
  estampes-data:
    name: estampes_estampes-data-restored
    external: true
  uva-beta:
    name: estampes_uva-beta-restored
    external: true
```

A backup made with the older instructions on this page holds only `/data` (its listing has no `uva-beta/` entries). It restores only what was still pending or never moved into the store; do not delete the old `uva-beta` volume if that is the backup you have.

Run `docker compose up -d`, wait for `healthy`, and check:

1. `docker compose logs estampes | grep canvas-store` shows the store opened (`canvases, images, workspaces, surfaces and notebooks live only in UVA`), not an error.
2. `curl -s http://127.0.0.1:8787/healthz` shows `"storage":{"enabled":true,"writable":true}`.
3. In ChatGPT (same connector URL, because `access-key` came back) ask GPT to show a canvas you know; marks, layers and notebooks should be there. Imported calculator results may need recomputing ([Workbench](WORKBENCH.md)).

The `chown` and `chmod` matter: the container runs as user `node` (uid 1000), the key files are mode 600, and the UVA store refuses to open a folder that is not private to that user, so files owned by root would make the server unable to read them. **Keep `compose.override.yaml`**: it is the only thing that points `/data` and `/uva-beta` at the restored volumes, and Compose reads it together with `compose.yaml` every time. Without it the next `docker compose up` would use the original (older) volume again, or create an empty one. If you prefer, instead change the `estampes-data` volume name in `compose.yaml` itself and delete the override. Remove the old volume (`docker volume rm …`) only after you have run on the restored one for a while and have a fresh backup; Estampes never deletes it for you.

Without Docker: unpack into empty folders, set `ESTAMPES_STORAGE_DIR` and `ESTAMPES_UVA_DIR` to them, and make the store folder private to the server's user (`chmod 700`). **Two servers must never share one storage folder or one store.**

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
3. If the problem is in the data (the old version cannot read it), restore the backup from before the upgrade into new volumes as above (both of them).
4. A release from before the UVA store became the default (0.20.0 or earlier) cannot read the store. To roll back to one, stop the server and first write everything back out with `node scripts/uva-to-legacy.mjs /data /uva-beta` (inside the container: `docker compose run --rm estampes node scripts/uva-to-legacy.mjs /data /uva-beta`), see [UVA](UVA-BETA.md).
5. Never delete the data volumes to "start clean" unless you have a verified backup. Rolling back the program never requires deleting data.

## If you run without persistent storage

With no `ESTAMPES_STORAGE_DIR`, nothing is written to disk. Canvases live in memory for about an hour (`ESTAMPES_CACHE_TTL_MINUTES`) and are lost on every restart. Heroku's filesystem is also reset at least daily. Export what matters (the result of `present_visual` includes download links for the image and a layered `marks.svg`; a workspace can be exported as a `.estampes` bundle) or use Docker with its volume.

`docker compose down -v` deletes both volumes and with them every image and mark. So does removing the volumes in Docker Desktop.

## Keys and secrets

| Secret | Where | Rotate | After rotating |
| --- | --- | --- | --- |
| Access key (connector) | `/data/access-key`, or `ESTAMPES_ACCESS_KEY` | Key file: delete it and restart (`docker compose restart estampes`); the new URL is printed once in the log. If you set `ESTAMPES_ACCESS_KEY` in `.env`: edit it, then **recreate** the container, `docker compose up -d --force-recreate estampes`. A plain `restart` does not re-read `.env`, so the old key would stay active, and an environment value always wins over the key file. Check: the old URL must now answer `401`. | Replace the connector URL in ChatGPT. Old download links stop working (they were signed with the old key). |
| Administrator key | `/data/admin-key`, or `ESTAMPES_ADMIN_KEY` | Key file: delete it and restart. If you set `ESTAMPES_ADMIN_KEY` in `.env`: edit it and `docker compose up -d --force-recreate estampes`. | Module approvals made with the old key no longer count; approve pending plans again. |
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
