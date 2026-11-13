# Estampes — deployment

Estampes is one Node 22 process. ChatGPT (or any MCP client) connects to `https://<your host>/mcp`. There are three supported ways to run it:

| | Docker (self-host) | Heroku | Render |
| --- | --- | --- | --- |
| Start | `docker compose up -d` | Deploy button | Blueprint (`render.yaml`) |
| Data survives restarts | yes (volume `/data`) | no (dyno disk is wiped) | no (free plan) |
| CPU | amd64, arm64 (Raspberry Pi 4/5 64-bit, ARM NAS, Apple Silicon) | amd64 | amd64 |

Each person runs their own server for themselves; nothing is shared or centrally managed. ChatGPT needs a **public https** address to reach it. The quickest way is the built-in temporary tunnel below; for lasting use put a reverse proxy with TLS (Caddy, Traefik, nginx, a NAS's built-in proxy) or a named tunnel (Cloudflare Tunnel, Tailscale Funnel) in front of port 8787.

## Docker

```sh
git clone https://github.com/Curium-3391/Estampes.git
cd Estampes
cp .env.example .env
docker compose up -d
```

### Quick public address (temporary tunnel)

```sh
docker compose --profile tunnel up -d
docker compose logs estampes | grep tunnel
```

The second command prints the ChatGPT connector URL, e.g. `https://calm-words-here.trycloudflare.com/mcp?key=…`; paste it into ChatGPT as a custom MCP server (No authentication). It uses a Cloudflare quick tunnel: no account, no router or firewall changes, nothing listening on your network. The address changes every time the `tunnel` container restarts (then update the connector in ChatGPT), Cloudflare gives it no uptime guarantee, and the log line contains your key, so keep the log to yourself. Stop it with `docker compose --profile tunnel down`. The compose file sets `ESTAMPES_TUNNEL_METRICS` (the tunnel container's metrics address) so the server can find the address the tunnel was given and print the connector URL; leave it unset when you use another way to publish the server.

### Details

- The image is built locally for your machine's CPU. `docker compose ps` shows `healthy` once `/healthz` answers.
- **Access key.** If `.env` has no `ESTAMPES_ACCESS_KEY`, the first start generates one, saves it as `/data/access-key` (mode 600) and prints the connector URL once in the log. Read it again with `docker compose exec estampes cat /data/access-key`; connect ChatGPT to `https://<your host>/mcp?key=<key>`. Delete the file and restart to rotate it. `ESTAMPES_ALLOW_OPEN=1` runs without a key (closed networks only).
- **Only this machine by default.** compose publishes on `127.0.0.1:8787`. Put a reverse proxy or tunnel with https in front (it runs on the same machine), or set `ESTAMPES_BIND=0.0.0.0` to open the port to the network. Behind a proxy, set `ESTAMPES_TRUST_PROXY=1` (one proxy) so rate limiting sees real client addresses.
- Logs: `docker compose logs -f`. Set `ESTAMPES_LOG_FORMAT=json` for one JSON object per line. Docker keeps 3 × 10 MB of logs.
- **Module commands.** `scripts/estampes-module.js` (set API keys, approve plans, sign packages) defaults to the container's storage `/data`, so run it inside the container: `echo "$KEY" | docker compose exec -T estampes node scripts/estampes-module.js secret set <moduleId> <name>`. Outside Docker, set `ESTAMPES_STORAGE_DIR` to your storage folder and run `npm install` first.
- Update: take a backup, then `git pull && docker compose up -d --build`. The data volume is kept; start a new ChatGPT conversation afterwards ([Upgrade](BACKUP-RESTORE.md#upgrade)).
- Stop: `docker compose down`. **`docker compose down -v` deletes all stored images and marks.**
- Backup and restore: the volume `estampes_estampes-data` holds everything, including your keys. Stop the server, archive the volume, and restore into a new volume; the full procedure, what a backup contains, upgrade and rollback rules and what to do when a key leaks are in [Backup and restore](BACKUP-RESTORE.md). Problems: [Troubleshooting](TROUBLESHOOTING.md).
- The container runs as the unprivileged `node` user (uid 1000) with a read-only filesystem except `/data` and a 64 MB `/tmp`, no Linux capabilities, `no-new-privileges` and at most 256 processes, and restarts on failure (`restart: unless-stopped`).
- Prebuilt multi-arch images are published by GitHub Actions to `ghcr.io/curium-3391/estampes` only when a `vX.Y.Z` tag is pushed: `X.Y.Z`, `latest` (the newest stable release) and `sha-<short>`; nothing is published for `main` or pull requests. To use one instead of building, replace `build: .` in `compose.yaml` with `image: ghcr.io/curium-3391/estampes:X.Y.Z` (pin a version; `latest` moves). A GHCR package is private until its owner makes it public in the package settings, so an anonymous pull can fail; building locally always works. See [Releasing](RELEASE.md).
- Docker Hub rate limits: build with `docker compose build --build-arg BASE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim`.

### Calculator container and optional PDF support

`docker compose up -d` starts a second container, `cas`, which runs the SymPy calculator ([CAS](CAS.md)) with no network and a read-only filesystem; only Estampes can reach it, through a Unix socket on the `cas-run` volume. Stop it and only calculations stop working. `/healthz` reports whether it is available. Calculator limits are set on that container (see `.env.example`).

PDF page rendering is optional: build with `docker compose build --build-arg ESTAMPES_WITH_PDF=1` (adds about 60 MB). See [PDF pages](IMAGE-PIPELINE.md#pdf-pages).

### What is stored

With `ESTAMPES_STORAGE_DIR` set (compose sets `/data`) and the default UVA store, images, canvases, workspaces and panels are kept in the store (`uva-pending/` plus the store folder) and no `images/` file is written; see [UVA store](UVA-BETA.md). With `ESTAMPES_CANVAS_STORE=legacy`, every image gets a folder `images/<hash>/`:

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

`app.json` and `Procfile` describe the app: Node 22 (`engines`), the Node.js buildpack, `/healthz` as the success page. Heroku generates `ESTAMPES_ACCESS_KEY` for you; find it under Settings → Config Vars and connect ChatGPT to `https://<app>.herokuapp.com/mcp?key=<key>`.

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

## Connecting Claude

Claude reaches the server from Anthropic's cloud, so it needs the same public https address (a tunnel or reverse proxy; `localhost` does not work for claude.ai).

**claude.ai, Claude Desktop and mobile (Free, Pro, Max):** open **Customize → Connectors → Add custom connector**, name it Estampes and paste `https://<host>/mcp` (without `?key=`). Leave the OAuth fields empty and press **Add**, then **Connect**. A sign-in page from your own server opens: type the access key (`docker compose exec estampes cat /data/access-key`) and press 允許. Claude receives a token; the key itself never leaves the page. Then enable Estampes from the **+** menu in a chat and allow the canvas the first time Claude asks. Connectors added on web or desktop appear on mobile too. Team and Enterprise owners add it under **Organization settings → Connectors → Add → Custom**.

The old URL form `https://<host>/mcp?key=<key>` with no sign-in also connects, but Claude recommends against secrets in URLs; prefer the sign-in.

**Claude Code:** `claude mcp add --transport http estampes https://<host>/mcp`, then `/mcp` to sign in the same way; or skip sign-in with `--header "Authorization: Bearer <key>"`.

What differs from ChatGPT:

- Claude does not pass chat attachments to tools. Ask Claude to open the canvas for an upload (it calls `present_visual` with `upload: true`), then press **選擇圖片／拍照** in the canvas to pick a file or take a photo; the canvas sends it to your server in slices and tells Claude the new `imageId`. Public https image URLs work as in ChatGPT.
- Claude limits a tool result to about 150,000 characters. Estampes keeps every result under `ESTAMPES_MAX_RESULT_CHARS` (default 145,000): images the model sees are re-encoded or reduced to fit, and the canvas first shows a preview, then loads the full image in slices.
- Download links (image, marks SVG) open after a confirmation dialog.

**How sign-in works:** OAuth 2.1 with dynamic client registration or client ID metadata documents, PKCE (S256) and refresh tokens, at `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` and `/oauth/*`. Tokens are signed with a key derived from the access key and last one hour (refresh tokens 90 days); changing the access key signs every client out. These endpoints exist only when the server has an access key.

## Environment variables

All optional. Docker reads them from `.env` (see `.env.example`); Heroku and Render from their dashboards.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Listening port (set by Heroku/Render; fixed inside the container). |
| `ESTAMPES_HOST_PORT` | `8787` | Docker only: host port that compose publishes. |
| `HOST` | `0.0.0.0` | Listening address. |
| `PUBLIC_BASE_URL` | from request | Public https origin used in download links. |
| `ESTAMPES_ACCESS_KEY` | unset (Docker: generated) | When there is a key, `/mcp` and `/api/v1/*` require `?key=`, `Authorization: Bearer <key>` or an OAuth token from the sign-in page (see Connecting Claude), and download links are signed. `/`, `/version`, `/healthz` stay public. |
| `ESTAMPES_REQUIRE_KEY` | `0` (Docker: `1`) | With no `ESTAMPES_ACCESS_KEY`, generate one into the storage folder instead of running open. |
| `ESTAMPES_ALLOW_OPEN` | `0` | `1` = run without any key even when one is required. |
| `ESTAMPES_BIND` | `127.0.0.1` | Docker only: address compose publishes on. |
| `ESTAMPES_TRUST_PROXY` | `0` (Render/Heroku: `1`) | Number of your proxies in front; only then are `X-Forwarded-For/-Proto/-Host` trusted. |
| `ESTAMPES_STORAGE_DIR` | unset (memory only) | Folder for images, canvases, SVGs and history. Docker: `/data`. |
| `ESTAMPES_STORAGE_RETENTION_DAYS` | `0` | Delete stored images untouched for this many days; 0 keeps everything. |
| `ESTAMPES_MAX_IMAGE_MB` | `20` | Largest download or upload accepted. |
| `ESTAMPES_MAX_IMAGE_MEGAPIXELS` | `50` | Largest decoded image. |
| `ESTAMPES_WORKING_LONG_SIDE` | `4096` | Long side of the working copy all coordinates refer to. Changing it does not move existing marks (they are normalized). |
| `ESTAMPES_MAX_ANALYSIS_MEGAPIXELS` | `16` | Largest crop processed at working or native resolution; bigger crops are reduced and the result says so. |
| `ESTAMPES_DERIVED_VIEWS_PER_IMAGE` | `200` | Processed-view recipes remembered per image (`get_derived_view`). |
| `ESTAMPES_CACHE_MB` / `ESTAMPES_CACHE_IMAGES` / `ESTAMPES_CACHE_TTL_MINUTES` | `160` / `12` / `60` | In-memory cache of decoded images (working pixels plus the source file kept for native crops). |
| `ESTAMPES_RATE_LIMIT_PER_MIN` | `120` | Requests per minute per client IP on `/mcp`; `0` disables. |
| `ESTAMPES_CORS_ORIGINS` | `*` | Browser origins allowed by CORS (only browser tools such as MCP Inspector need it). |
| `ESTAMPES_ADMIN_KEY` | generated in `<storage>/admin-key` | Administrator secret for approving module installs, updates and purges (`scripts/estampes-module.js approve`). Separate from the connector key; 32–256 letters, digits, `-` or `_`. See [Modules](MODULES.md). |
| `ESTAMPES_MODULE_ALLOW_UNSIGNED` | `0` | `1` allows installing module packages without a signature (always shown as high risk). |
| `ESTAMPES_MAX_RESULT_CHARS` | `145000` | Largest tool result in characters; model-facing images shrink to fit (Claude drops results above about 150,000). `0` turns it off. |
| `ESTAMPES_LOG_FORMAT` | `text` | `json` for one JSON object per log line. |

Invalid values fall back to the default and are reported in the log at startup.

## Health and logs

- `GET /healthz` → `200 {"ok":true,"version":…,"storage":{"enabled":…,"writable":…}}`, or `503` when the storage folder cannot be written. Docker's `HEALTHCHECK`, compose and Render use it.
- `GET /version` → build and capability summary.
- Each MCP request logs method, status and duration; tool results log their size (`[size]`); storage restores and failures are logged with `[storage]`.
- `SIGTERM` (docker stop, dyno restart) stops accepting requests and finishes pending disk writes before exiting.

## Releasing a new version

`package.json` `version` is the single source of truth. `/version`, the MCP server version, the version shown in the widgets and the versioned `ui://estampes/visual-surface-vXYZ.html` / `visual-evidence-vXYZ.html` URIs are all derived from it. To release, bump `version` (and run `npm install` to update the lockfile), then add the previous tag to `LEGACY_VISUAL_URIS` / `LEGACY_EVIDENCE_URIS` in `server.js` so saved conversations keep resolving. Pushing a `vX.Y.Z` tag publishes the matching multi-arch image. The full order, the pre-release check (`npm run release:check`), failure handling and rollback are in [Releasing](RELEASE.md).

## Caveats

- Render free services sleep when idle; the first request after a pause can take tens of seconds.
- The security model (single owner, one shared key, what the server fetches, what modules may do) is summarised in [SECURITY.md](../SECURITY.md); vulnerabilities are reported privately there.
- Authentication uses one shared owner key, not individual accounts. ChatGPT can use a key-bearing connector URL; OAuth-compatible clients can sign in using the owner key and keep a token. Protect the key, connector URL, and backups.
- `/export/<hash>/…` download links carry a signature (`?sig=`) derived from the access key; without a key they are open and protected only by the image hash.
- CORS stays `*` by default so browser tools work; every `/mcp` call still needs the key.
- The rate limiter is in memory and per instance; it resets on restart.
- One process per storage folder: two containers must not share a volume.
- If the host cannot show a widget, inspect tool discovery, MCP responses, the `ui://` resource, and the MCP Apps bridge handshake.

## UVA store (default)

With `ESTAMPES_STORAGE_DIR` set, canvases, workspaces, panel layouts and
calculator notebooks are committed to the UVA store and restored from it
(`ESTAMPES_CANVAS_STORE=uva`, the default). Existing data move in on first open,
and from then on **no legacy file is written**: the store and the storage folder
together hold your work, so a backup needs both ([Backup](BACKUP-RESTORE.md)).
To go back to `ESTAMPES_CANVAS_STORE=legacy`, stop the server and write the
files back out first with `scripts/uva-to-legacy.mjs`. Servers without storage
keep everything in memory.

- `ESTAMPES_UVA_DIR`: the store's own private folder, never inside or above
  `ESTAMPES_STORAGE_DIR`. Docker uses `/uva-beta` (volume `uva-beta` in
  `compose.yaml`); elsewhere the default is `<storage dir>-uva`.
  `ESTAMPES_UVA_BETA_DIR` is still read as the older name.
- `ESTAMPES_UVA_PROFILE`: `linux-process-crash-test` (default on Linux) survives a
  killed process, **not a power loss**; `linux-local-durable` needs an eligible
  local ext4/XFS mount. Both profiles write with the same fsync barriers; the
  profile states what the host can promise. A simulated power cut at every
  fsync loses no acknowledged result ([UVA-POWERLOSS.md](UVA-POWERLOSS.md));
  whether your disk or Docker Desktop VM honours fsync is outside that test.
  `ESTAMPES_UVA_BETA_PROFILE` is still read as the older name. The UVA lease needs Linux `flock`; where the store cannot start before it
  holds any data, the server logs it and uses the legacy files; once it holds data,
  the server exits instead (see [UVA store](UVA-BETA.md)).
- `ESTAMPES_UVA_ASSET_MAX_MB` (default 1024) caps the store's image copies;
  `ESTAMPES_UVA_MIRROR_IDLE_SEC` (default 15) is the quiet time before a commit;
  `ESTAMPES_UVA_MIRROR_MAX_COMMITS` (default 10000) caps the commits kept in the
  7-day replay window (older history is compacted automatically).
- `uva_store` shows the store's state (`status`) and documents; it never edits.

Details, limits, recovery and the qualification still open are in
[UVA](UVA-BETA.md).
