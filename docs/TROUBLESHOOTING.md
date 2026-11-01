# Troubleshooting

Start at the symptom. Each flow says how to check, what the usual cause is and the fix. The checks use only `curl` and Docker; replace `127.0.0.1:8787` with your public address when you test from outside. Messages quoted in "quotes" are the server's own wording.

Status: the flows follow the code and the server's real messages. They were not replayed against a live ChatGPT account or a Docker host while this page was written.

## 1. ChatGPT cannot reach the server ("MCP unreachable")

Run these in order and stop at the first that fails.

| Check | Expected | If it fails |
| --- | --- | --- |
| `docker compose ps` | `estampes` is `healthy` | `docker compose logs estampes` for the reason. A restart loop usually means the storage volume is not writable (`/healthz` then answers 503) or a setting is invalid (the log lists values that fell back to defaults). |
| `curl -s http://127.0.0.1:8787/healthz` | `{"ok":true,…}` | No answer: the port is not published here (check `ESTAMPES_HOST_PORT` / `ESTAMPES_BIND`) or the container is down. |
| `curl -s https://<your public host>/healthz` | the same | Works locally but not here: tunnel or proxy problem. For the quick tunnel, the address changed after a restart (`docker compose logs estampes \| grep tunnel`), or Cloudflare is down. Behind a proxy set `ESTAMPES_TRUST_PROXY=1`. |
| `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<host>/mcp` | `401` (the key is required) | `404`/`502`: the proxy does not forward `/mcp`. `200` with no key: the server is open (`ESTAMPES_ALLOW_OPEN=1`); fix that. |
| Connector URL contains the current `?key=…` | yes | After rotating the key or restoring from a backup with another key, update the connector in ChatGPT. |
| `429` | — | The per-minute limit (`ESTAMPES_RATE_LIMIT_PER_MIN`, default 120 per client address) was hit. Behind a proxy without `ESTAMPES_TRUST_PROXY`, every user looks like one address. |

Then refresh the connector and **start a new conversation**; an existing one keeps its old tool list.

## 2. An image will not load

| Message or sign | Cause | Fix |
| --- | --- | --- |
| "Only https image URLs are accepted" | `http:` or another scheme | Give an https address, or attach the file in the chat. |
| "Image URL must resolve to a public address" | The host resolves to a private, loopback or link-local address | Estampes refuses these on purpose. Attach the file instead. |
| "Image URLs with credentials are not accepted" | `user:pass@` in the URL | Use a link that does not need a login. |
| "Download is larger than … MB" / "(or exceeds … megapixels)" | Over `ESTAMPES_MAX_IMAGE_MB` (20) or `ESTAMPES_MAX_IMAGE_MEGAPIXELS` (50) | Reduce the file, or raise the limits in `.env` if your server can afford it. |
| "The file is not a supported image" | Not a decodable image, or a PDF (PDFs go through the PDF tool) | Convert it to PNG or JPEG. |
| "Image download failed with HTTP …" / "Too many redirects" | The remote site refused or loops | Download it yourself and attach it. |
| "Unknown or expired imageId …; call load_image again" | Without storage the server forgets images after the cache time (about 60 minutes) and on restart | Attach the image again. Turn storage on to keep them ([Backup](BACKUP-RESTORE.md#if-you-run-without-persistent-storage)). |
| Loads, but zoom is blurry | Working copy or interpolation, not a fault | See [Zoom and pan](USAGE.md#zoom-and-pan). |

## 3. The canvas or widget looks broken

1. Does the model answer with tool results but no widget appears? The host may not support MCP Apps; try ChatGPT web, and see [Compatibility](COMPATIBILITY.md).
2. Blank or squashed canvas: resize the chat, or ask GPT to show the canvas again.
3. An old widget after an upgrade: open a **new conversation** (the widget address contains the version).
4. The image vanishes after zooming: ask GPT to show the canvas again; the widget reloads the image by its id.
5. Marks missing: they are stored per image. Ask for the canvas of the same image; with storage off, they may have expired.
6. Still wrong: open the browser console on the ChatGPT page and look for errors from the widget iframe; include them and your version (`/version`) in an issue.

## 4. The calculator is unavailable

| Check | Meaning |
| --- | --- |
| `curl -s http://127.0.0.1:8787/healthz` shows `"cas":{"available":true,…}` | Fine. |
| `"available":false` with a `reason` | The `cas` container is down or its socket is missing. Only calculations fail; canvases, marks and plots keep working. |
| `docker compose ps cas` | Should be `healthy`. If not: `docker compose logs cas`. |
| `docker compose up -d cas` | Starts it again. |
| Running without Docker | The calculator needs the Python service (`cas-service/`) and `ESTAMPES_CAS_SOCKET` pointing at its socket. |
| The calculator panel is missing | The module is not enabled: enable "Scientific CAS" in the Store, then ask GPT to open the calculator. |
| A result shows as stale | An imported or edited definition changed; press 重算 (recompute) ([Workbench](WORKBENCH.md)). |

## 5. Module permission and Store errors

| Message | Meaning | Fix |
| --- | --- | --- |
| "<module> is installed. Only the user can enable it: call open_module_store …" (or "is disabled") | The module is not enabled | Open the Store and confirm the enable plan. GPT cannot do this for you. |
| "… was not granted <permission>; the user must approve it again in the Store" | The module now asks for more than you approved earlier (after an update, or a capability that needs another permission) | Review the permission screen in the Store and approve again, or leave it off. |
| Installing or enabling waits for approval | High-risk permissions or installs need the administrator | Run `docker compose exec estampes node scripts/estampes-module.js approve <planId>` (the Store shows the exact id), then press Confirm. |
| Install refused: unsigned or unknown signer | Packages must be signed by a key you trust | `scripts/estampes-module.js trust …`, or for local development `ESTAMPES_MODULE_ALLOW_UNSIGNED=1` (shown as high risk). |
| A network capability fails | The host is not in the module's `network.allow`, a secret is missing (`secret set`), or the server has no internet access | Plate solving: see [its tutorial](tutorials/ASTROMETRY.md#failure-and-degraded-paths). |
| "it took longer than …" | The capability exceeded its time limit | Retry with a smaller input; background capabilities report through `get_module_job`. |
| Job "interrupted" | The server restarted while it ran | Start it again. |
| "the canvas changed since revision …; read it again and retry" | Someone (you in the widget, or another call) changed the canvas meanwhile | Ask GPT to read the canvas again and repeat. |

Module state lives in `/data/modules/registry.json`; the audit log `/data/modules/audit.jsonl` records every plan, approval, refusal and run (no secrets).

## 6. Still stuck

Collect `curl -s http://127.0.0.1:8787/version`, `docker compose ps`, the last 50 lines of `docker compose logs estampes` (remove the connector key, which the log can contain) and open an issue. For a security problem, do not open an issue: see [SECURITY.md](../SECURITY.md).
