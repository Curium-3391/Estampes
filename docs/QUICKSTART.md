# Quick start

From nothing to your first mark on an image in ChatGPT. About 15 minutes if Docker is already installed. Each step says how to tell it worked and what to do if it did not. Capability labels: **Implemented** unless noted.

## What you need

- A machine that can run Docker (amd64 or arm64) and stay on while you use Estampes.
- A ChatGPT account that can add a custom MCP server (the menu is called **Plugins → Add custom MCP server** in ChatGPT web at the time of writing; GPT's own settings change often, so check the current wording).
- An image to try. To use the same picture as the tutorials, run `node scripts/make-sample-material.mjs` (needs `npm ci` first) and use `sample-material/sample-board.png`.

## 1. Start the server

```sh
git clone https://github.com/Curium-3391/Estampes.git
cd Estampes
cp .env.example .env
docker compose --profile tunnel up -d
```

**Expected:** `docker compose ps` lists `estampes` (and `cas`, `tunnel`) and `estampes` becomes `healthy` within a minute.

**If not:** `docker compose logs estampes` shows the reason. A build that fails while pulling the base image is usually Docker Hub's rate limit; see the `BASE_IMAGE` build argument in [Deployment](DEPLOYMENT.md#details).

## 2. Get your connector URL

```sh
docker compose logs estampes | grep tunnel
```

**Expected:** a line with `https://<random-words>.trycloudflare.com/mcp?key=<long key>`. That URL contains your key; do not share it. The address changes whenever the `tunnel` container restarts, so this is for trying things out. For lasting use see [Deployment](DEPLOYMENT.md).

**Check it from outside:** open `https://<random-words>.trycloudflare.com/healthz` in a browser. **Expected:** `{"ok":true,...}`. A page that does not load means the tunnel is not up yet (wait a few seconds and retry) or the container is not healthy (step 1).

## 3. Connect ChatGPT

In ChatGPT open Plugins → **Add custom MCP server**, paste the URL from step 2 and choose **No authentication** (the key is already in the URL). Then start a **new conversation**.

**Expected:** the connector appears as available in that conversation.

**If not:** a connector that cannot be created almost always means the URL is unreachable from the internet (repeat the `/healthz` check) or was copied without the `?key=…` part. After you change anything on the server, refresh the connector and open a new conversation; an old conversation keeps the old tool list.

## 4. Your first canvas

Attach `sample-board.png` (or any image) and write, for example: *"Show this image and mark where R12 is."*

**Expected:** a canvas opens inside the chat on your original image, and GPT draws a gold mark on it. You never name a tool; GPT chooses.

**Then try yourself:** pick the pen, circle something, type a short note, press send, and ask *"what is this?"* without describing where. GPT receives your mark's position with the note.

**If not:**

| What you see | What to do |
| --- | --- |
| GPT answers in text only and never opens a canvas | The connector is not enabled in this conversation, or the conversation predates it. Start a new conversation and enable the connector. |
| The canvas is blank or squashed | Ask GPT to show the canvas again, or resize the chat. |
| "unauthorized" / 401 | The URL lost its `?key=` part. Copy it again from step 2. |

More in [Usage](USAGE.md) and the [troubleshooting table](USAGE.md#troubleshooting).

## 5. Keep your work

Without `ESTAMPES_STORAGE_DIR` canvases live in memory for about an hour. The Docker setup turns storage on (`/data` volume), so your marks survive restarts. **`docker compose down -v` deletes that volume.** Back it up before upgrades; use the single command in [Deployment](DEPLOYMENT.md#details).

## Where next

- [Tutorials](tutorials/README.md): annotate a photo, analyse a PDF page, plate-solve a night-sky photo.
- [Compatibility](COMPATIBILITY.md): what has and has not been tried on which ChatGPT clients and MCP hosts.
- [Usage](USAGE.md): layers, zoom, paired images, checking GPT's claims.
