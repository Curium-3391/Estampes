# Estampes

**Point at the same image, together with AI, without leaving the conversation.**

[繁體中文說明](docs/zh-TW/README.md) · [Quick start](docs/QUICKSTART.md) · [Deployment](docs/DEPLOYMENT.md) · [Changelog](CHANGELOG.md)

Estampes is an open-source ChatGPT plugin: an MCP server with MCP Apps widgets that shows your picture as a shared canvas inside the chat. GPT draws on the original image, you draw back on the same canvas, and both sides refer to the same marks across turns. It works with any image (photos, scans, handwriting, book pages, diagrams, maps, drawings), and **each person runs their own server**.

Named after Claude Debussy's *Estampes* (1903).

## What it does

Talking about a specific spot in a picture usually means screenshots, circling things in another editor, re-uploading and several rounds of "which one?". Estampes keeps that in the conversation:

- **GPT points for you:** boxes, arrows, polylines, freehand lines and labels over the original image, each with an optional note and status.
- **You point back:** pens, highlighter, boxes and arrows on the same canvas, plus one sentence, then send.
- **The source stays untouched:** marks live in layers you can show, hide, rename, reorder, fade and lock.
- **See the details:** zoom and pan inside the canvas with native-resolution tiles; GPT can enhance contrast, sharpen, denoise, threshold, find edges or overlay a coordinate grid on a region before reading it.
- **Two images side by side:** compare two different pictures (a drawing and the real object, before and after); GPT records which marks correspond and how sure it is, and you confirm or reject each link.
- **Evidence, not guesses:** every note and link GPT adds is a claim with its confidence, the evidence behind it (which image, where) and a verification state that only you or a tool can change. Claims you reject are remembered.
- **Many images, one place:** a workspace holds up to 24 images side by side, each with its own marks and coordinates; merge, split, copy and link them without flattening anything, and carry a whole workspace to another server as one `.estampes` file.
- **Measure and align:** register two images (with honest quality reporting), overlay or difference them, assess sharpness and noise, calibrate a scale and measure distance, area or angle with uncertainty, render PDF pages, and detect candidate shapes, lines, circles or text.
- **Modules on the same canvas:** an optional Store adds capabilities that put *objects* on the canvas instead of pixels: plot a function (Graph), compute exactly with SymPy in a separate sandboxed container (calculator, with results you can plot), or plate-solve a photo of the sky. Each module asks for explicit permissions, and you approve every change.
- **Across turns and chats:** marks, layers and change history are stored on your own server and export as an image, a layered SVG (opens in Inkscape) or an `estampes.visual/2` JSON document you can load again.

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
| [Quick start](docs/QUICKSTART.md) | First deployment to first mark, with what to expect at each step and what to do when it fails |
| [Tutorials](docs/tutorials/README.md) | Annotate a photo, analyse a PDF page, plate-solve a sky photo; sample material you can generate |
| [Compatibility](docs/COMPATIBILITY.md) | Which clients, platforms and optional features have been tested, and how |
| [Deployment](docs/DEPLOYMENT.md) | Docker, tunnel, Heroku, Render, connecting ChatGPT, environment variables, what is stored |
| [Backup and restore](docs/BACKUP-RESTORE.md) | What is stored, back up, restore, upgrade and roll back, rotate keys after a leak (round trip verified by a script) |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Server unreachable, image will not load, broken widget, calculator down, module permission errors |
| [Security policy](SECURITY.md) | Single-owner security model and how to report a vulnerability privately |
| [Development guide](docs/DEVELOPMENT.md) | Set up, run every kind of test, code tour, public interfaces versus internals, first tasks |
| [Module quick start](docs/modules/QUICKSTART.md) · [Testing modules](docs/modules/TESTING.md) | Build, test, sign and install a module; declarative, WebAssembly and http paths |
| [Releasing](docs/RELEASE.md) | For maintainers: version order, Docker image tags, pre-release check, rollback |
| [Usage](docs/USAGE.md) | Using the canvas in ChatGPT: marking, layers, zoom, paired view, export |
| [Tools](docs/TOOLS.md) | The MCP tools and HTTP endpoints |
| [Image pipeline](docs/IMAGE-PIPELINE.md) | Source files, derived views, exact coordinate transforms, PDF pages, analysis engines |
| [Image capabilities](docs/IMAGE-CAPABILITIES.md) | What the image tools do and do not cover, and what needs a plugin or an external service |
| [Canvas reads](docs/CANVAS-READS.md) | `render_canvas`: reading the saved canvas as pixels |
| [Workspaces](docs/WORKSPACES.md) | Several images in one place; merge, split, copy, link; `.estampes` bundles |
| [Modules](docs/MODULES.md) | The module system, the Store, packages, WebAssembly and http modules, background jobs, plate solving |
| [Scientific calculator](docs/CAS.md) | The SymPy calculator module and its isolated container |
| [Surfaces](docs/SURFACES.md) | Panels and per-device layouts (`estampes.surface/1`) |
| [Workbench](docs/WORKBENCH.md) | The canvas and the calculator as windows inside one widget |
| [Visual protocol 2](docs/PROTOCOL-V2.md) | `estampes.visual/2`, the host-neutral JSON document for a whole canvas, with evidence and verification for every claim |
| [Visual protocol 1](docs/PROTOCOL-V1.md) | The earlier version, still read |
| [Vision](docs/VISION.md) | The problem, user journeys and non-goals |
| [Architecture](docs/ARCHITECTURE.md) | How the server, canvas widget and GPT fit together |
| [Changelog](CHANGELOG.md) | Changes per version |
| [History](docs/history/README.md) | Early milestone notes and old protocol drafts |
| [繁體中文說明](docs/zh-TW/README.md) | Overview and quick start in Traditional Chinese |
| [Contributing](CONTRIBUTING.md) | Contributions that help most |

## Status and limits

The current version is in [`package.json`](package.json) and at `/version` on your server.

- Upload, canvas, marks, layers, zoom and the paired view have been tested live in ChatGPT on web and mobile. Newer parts (workbench, calculator, plate solving, workspaces) are covered by automated tests; each page says whether it has been tried in a live ChatGPT host.
- How well GPT recognises what is in an image is not guaranteed; Estampes does not decide what something is.
- Plugins cannot draw over images ChatGPT itself shows (such as image search results), so images are shown in the Estampes canvas instead.
- The access key is a shared secret in the URL, not per-user sign-in. Do not share your connector URL.
- Self-hosting only; there is no hosted service.

## License

[Mozilla Public License 2.0](LICENSE). You may use, modify and redistribute Estampes, including inside closed-source or commercial products; changes to Estampes's own files must be released under MPL 2.0 when you distribute them.
