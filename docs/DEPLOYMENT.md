# Estampes — deployment

Estampes is one Node 22 process. ChatGPT (or any MCP client) connects to `https://<your host>/mcp`. There are three supported ways to run it:

| | Docker (self-host) | Heroku | Render |
| --- | --- | --- | --- |
| Start | `docker compose up -d` | Deploy button | Blueprint (`render.yaml`) |
| Data survives restarts | yes (volume `/data`) | no (dyno disk is wiped) | no (free plan) |
| CPU | amd64, arm64 (Raspberry Pi 4/5 64-bit, ARM NAS, Apple Silicon) | amd64 | amd64 |

ChatGPT needs a **public https** address. A home server needs a reverse proxy with TLS (Caddy, Traefik, nginx, a NAS's built-in proxy) or a tunnel (Cloudflare Tunnel, Tailscale Funnel) in front of port 8787.

## Docker

```sh
git clone https://github.com/Curium-3391/Estampes.git
cd Estampes
cp .env.example .env
docker compose up -d
```

- The image is built locally for your machine's CPU. `docker compose ps` shows `healthy` once `/healthz` answers.
- Logs: `docker compose logs -f`. Set `ESTAMPES_LOG_FORMAT=json` for one JSON object per line. Docker keeps 3 × 10 MB of logs.
- Update: `git pull && docker compose up -d --build`. The data volume is kept.
- Stop: `docker compose down`. **`docker compose down -v` deletes all stored images and marks.**
- Backup: the volume `estampes_estampes-data` holds everything, e.g. `docker run --rm -v estampes_estampes-data:/data -v "$PWD":/backup busybox tar czf /backup/estampes.tgz /data`.
- The container runs as the unprivileged `node` user (uid 1000) and restarts on failure (`restart: unless-stopped`).
- Prebuilt multi-arch images are published by GitHub Actions to `ghcr.io/curium-3391/estampes` (`latest` from `main`, `X.Y.Z` from `vX.Y.Z` tags). To use one instead of building, replace `build: .` in `compose.yaml` with `image: ghcr.io/curium-3391/estampes:latest`. A new GHCR package is private until its visibility is changed in the package settings.
- Docker Hub rate limits: build with `docker compose build --build-arg BASE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim`.

### What is stored

With `ESTAMPES_STORAGE_DIR` set (compose sets `/data`), every image gets a folder `images/<hash>/`:

| File | Content |
| --- | --- |
| `source` | the image bytes exactly as received |
| `meta.json` | source (chat file or URL), file name, original and working size |
| `canvas.json` | marks, layers (name, order, lock, opacity), links between paired images, pending user edits; rewritten atomically after every change |
| `marks.svg` | the same marks as a layered SVG (one Inkscape layer per Estampes layer) |
| `history.jsonl` | one line per change: time, tool, author (user or assistant), changed ids |

Memory stays the working copy (`ESTAMPES_CACHE_*`). When the cache drops an image or the server restarts, the next call that names its `imageId` reloads it and its canvas from disk; attaching the same file again in a new chat also brings its canvas back. `ESTAMPES_STORAGE_RETENTION_DAYS` removes folders that have not changed for that many days (0 = keep forever). Without a storage dir nothing is written to disk.

## Heroku

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://www.heroku.com/deploy?template=https://github.com/Curium-3391/Estampes)

`app.json` and `Procfile` describe the app: Node 22 (`engines`), the Node.js buildpack, `/healthz` as the success page. Fill `ESTAMPES_ACCESS_KEY` to protect the server, then connect ChatGPT to `https://<app>.herokuapp.com/mcp?key=<key>`.

- The Deploy button only works while the GitHub repository is **public**. For a private repository, create the app in the Heroku dashboard and connect it to GitHub (Deploy → GitHub), or `git push heroku main` from a clone.
- Heroku's filesystem is reset on every restart (at least daily), so marks last only as long as the dyno. Use Docker for lasting data.
- Download links take their origin from incoming requests; set `PUBLIC_BASE_URL` if you use a custom domain.

## Render Blueprint

`render.yaml` configures a single Node web service on the free plan. Render installs with `npm ci` from the committed `package-lock.json`, runs the test suite, and deploys `main` automatically on every push.

1. Open [Render Dashboard](https://dashboard.render.com/) and sign in.
2. Select **New → Blueprint**.
3. Connect GitHub and grant Render access to `Curium-3391/Estampes`.
4. Select the repository and the `main` branch, review `render.yaml` and approve creation. Check the plan before approving any cost.
5. Render asks for `ESTAMPES_ACCESS_KEY`. Set a long random string to protect the endpoint (recommended), or leave it empty for an open test server.
6. Wait for **Live**, then open `https://<service>.onrender.com/version` and confirm the expected `version` and `accessKeyRequired`.

## Connecting ChatGPT

In ChatGPT **web**, open Plugins → **Add custom MCP server**, and use:

- with a key: `https://<host>/mcp?key=<ESTAMPES_ACCESS_KEY>`
- without a key: `https://<host>/mcp`
- Authentication: **No authentication** (the key travels in the URL).

After each deploy that changes tool definitions or widgets, refresh the connector in ChatGPT and start a **new conversation**, so cached templates are not reused.

## Environment variables

All optional. Docker reads them from `.env` (see `.env.example`); Heroku and Render from their dashboards.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Listening port (set by Heroku/Render; fixed inside the container). |
| `ESTAMPES_HOST_PORT` | `8787` | Docker only: host port that compose publishes. |
| `HOST` | `0.0.0.0` | Listening address. |
| `PUBLIC_BASE_URL` | from request | Public https origin used in download links. |
| `ESTAMPES_ACCESS_KEY` | unset | When set, `/mcp` and `/api/v1/*` require `?key=` or `Authorization: Bearer <key>`. `/`, `/version`, `/healthz` stay public. |
| `ESTAMPES_STORAGE_DIR` | unset (memory only) | Folder for images, canvases, SVGs and history. Docker: `/data`. |
| `ESTAMPES_STORAGE_RETENTION_DAYS` | `0` | Delete stored images untouched for this many days; 0 keeps everything. |
| `ESTAMPES_MAX_IMAGE_MB` | `20` | Largest download or upload accepted. |
| `ESTAMPES_MAX_IMAGE_MEGAPIXELS` | `50` | Largest decoded image. |
| `ESTAMPES_WORKING_LONG_SIDE` | `4096` | Long side of the working copy all coordinates refer to. Changing it does not move existing marks (they are normalized). |
| `ESTAMPES_CACHE_MB` / `ESTAMPES_CACHE_IMAGES` / `ESTAMPES_CACHE_TTL_MINUTES` | `160` / `12` / `60` | In-memory cache of decoded images. |
| `ESTAMPES_RATE_LIMIT_PER_MIN` | `120` | Requests per minute per client IP on `/mcp`; `0` disables. |
| `ESTAMPES_CORS_ORIGINS` | `*` | Browser origins allowed by CORS (only browser tools such as MCP Inspector need it). |
| `ESTAMPES_LOG_FORMAT` | `text` | `json` for one JSON object per log line. |

Invalid values fall back to the default and are reported in the log at startup.

## Health and logs

- `GET /healthz` → `200 {"ok":true,"version":…,"storage":{"enabled":…,"writable":…}}`, or `503` when the storage folder cannot be written. Docker's `HEALTHCHECK`, compose and Render use it.
- `GET /version` → build and capability summary.
- Each MCP request logs method, status and duration; tool results log their size (`[size]`); storage restores and failures are logged with `[storage]`.
- `SIGTERM` (docker stop, dyno restart) stops accepting requests and finishes pending disk writes before exiting.

## Releasing a new version

`package.json` `version` is the single source of truth. `/version`, the MCP server version, the version shown in the widgets and the versioned `ui://estampes/visual-surface-vXYZ.html` / `visual-evidence-vXYZ.html` URIs are all derived from it. To release, bump `version` (and run `npm install` to update the lockfile), then add the previous tag to `LEGACY_VISUAL_URIS` / `LEGACY_EVIDENCE_URIS` in `server.js` so saved conversations keep resolving. Pushing a `vX.Y.Z` tag publishes the matching multi-arch image.

## Caveats

- Render free services sleep when idle; the first request after a pause can take tens of seconds.
- The access key is a shared secret in a URL, not per-user auth. Anyone with the connector URL can call the server. Add OAuth before any public distribution.
- `/export/<hash>/…` download links need no key: the hash is derived from the image content.
- The rate limiter is in memory and per instance; it resets on restart.
- One process per storage folder: two containers must not share a volume.
- If the host cannot show a widget, inspect tool discovery, MCP responses, the `ui://` resource, and the MCP Apps bridge handshake.
