# Estampes

**Point at the same image, together with AI, without leaving the conversation.**

[繁體中文說明](docs/zh-TW/README.md) · [Deployment](docs/DEPLOYMENT.md) · [Changelog](CHANGELOG.md)

Estampes is an open-source ChatGPT plugin: an MCP server with MCP Apps widgets that shows your picture as a shared canvas inside the chat. GPT draws on the original image, you draw back on the same canvas, and both sides refer to the same marks across turns. It works with any image (photos, scans, handwriting, book pages, diagrams, maps, drawings), and **each person runs their own server**.

Named after Claude Debussy's *Estampes* (1903).

## What it does

Talking about a specific spot in a picture usually means screenshots, circling things in another editor, re-uploading and several rounds of "which one?". Estampes keeps that in the conversation:

- **GPT points for you:** boxes, arrows, polylines, freehand lines and labels over the original image, each with an optional note and status.
- **You point back:** pens, highlighter, boxes and arrows on the same canvas, plus one sentence, then send.
- **The source stays untouched:** marks live in layers you can show, hide, rename, reorder, fade and lock.
- **See the details:** zoom and pan inside the canvas with native-resolution tiles; GPT can enhance contrast, sharpen, denoise, threshold, find edges or overlay a coordinate grid on a region before reading it.
- **Two images side by side:** compare two different pictures (a drawing and the real object, before and after); GPT records which marks correspond and how sure it is, and you confirm or reject each link.
- **Across turns and chats:** marks, layers and change history are stored on your own server and export as an image, a layered SVG (opens in Inkscape) or an `estampes.visual/1` JSON document you can load again.

Images come in only through ChatGPT itself: uploaded or photographed in the chat, or a public URL GPT supplies. Estampes handles pixels and coordinates; **recognition is still GPT's job**, and uncertain locations are shown as such.

## Quick start

Docker on amd64 or arm64 (Raspberry Pi, NAS, mini PC):

```sh
git clone https://github.com/Curium-3391/Estampes.git
cd Estampes
cp .env.example .env
docker compose --profile tunnel up -d
docker compose logs estampes | grep tunnel
```

The last command prints the connector URL, `https://….trycloudflare.com/mcp?key=…`. In ChatGPT web open Plugins → **Add custom MCP server**, paste it and choose **No authentication**. The URL contains your key, so keep it to yourself.

The temporary tunnel gets a new address on every restart. For lasting use, put a reverse proxy or a named tunnel in front of `docker compose up -d`; see [Deployment](docs/DEPLOYMENT.md), which also covers Heroku, Render and every setting.

Local development (Node 22):

```sh
npm ci
npm test
npm start          # http://localhost:8787/mcp
```

## Documentation

| Document | Contents |
| --- | --- |
| [Deployment](docs/DEPLOYMENT.md) | Docker, tunnel, Heroku, Render, connecting ChatGPT, environment variables, what is stored |
| [Visual protocol 1](docs/PROTOCOL-V1.md) | `estampes.visual/1`, the host-neutral JSON document for a whole canvas |
| [Vision](docs/VISION.md) | The problem, user journeys and non-goals |
| [Architecture](docs/ARCHITECTURE.md) | System layers (being rewritten) |
| [Changelog](CHANGELOG.md) | Changes per version |
| [History](docs/history/README.md) | Early milestone notes and old protocol drafts |
| [繁體中文說明](docs/zh-TW/README.md) | Overview and quick start in Traditional Chinese |
| [Contributing](CONTRIBUTING.md) | Contributions that help most |

## Status and limits

The current version is in [`package.json`](package.json) and at `/version` on your server.

- Upload, canvas, marks, layers, zoom and the paired view have been tested live in ChatGPT on web and mobile.
- How well GPT recognises what is in an image is not guaranteed; Estampes does not decide what something is.
- Plugins cannot draw over images ChatGPT itself shows (such as image search results), so images are shown in the Estampes canvas instead.
- The access key is a shared secret in the URL, not per-user sign-in. Do not share your connector URL.
- Self-hosting only; there is no hosted service.

## License

No license has been chosen yet. Until one is committed, please do not assume redistribution rights for the source code.
