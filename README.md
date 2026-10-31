<div align="center">

<p><sub>OPEN-SOURCE VISUAL INSTRUMENT · MCP APPS</sub></p>

<h1>Estampes</h1>

<p><strong>A shared visual language for humans and AI.</strong></p>

<p>Point at the same image. Keep the marks. Work out what they mean—together.</p>

<p>
  <a href="docs/USAGE.md">Explore the canvas</a> ·
  <a href="#quick-start">Get started</a> ·
  <a href="docs/zh-TW/README.md">繁體中文</a>
</p>

<p><code>MCP Apps</code> · <code>Node.js 22</code> · <code>Self-hosted</code> · <code>MPL-2.0</code></p>

</div>

---

## Make “look here” part of the conversation.

An image should not require five screenshots, two editors, and a paragraph of directions just to discuss one detail.

**Estampes brings a shared visual canvas directly into a ChatGPT conversation.** GPT can point at a region of your image; you can mark it back without leaving the chat. The image remains untouched, while marks, layers, notes, and corrections remain accessible across turns.

It is a self-hosted **MCP server with MCP Apps widgets**—a visual interaction layer, **not** a new vision model or a replacement chatbot.

## Observe. Annotate. Verify.

| 01 / OBSERVE | 02 / ANNOTATE | 03 / VERIFY |
| :--- | :--- | :--- |
| Bring a photo, scan, schematic, or PDF page into the conversation. Zoom and process regions when details matter. | GPT draws boxes, arrows, paths, and labels; you respond with your own marks on the **same canvas**. | Review claims, inspect their evidence regions, correct links, and keep the decisions for later turns. |

**A typical exchange**

> **You:** “Which part of this board matches the symbol in the schematic?”  
> **GPT:** Points to a candidate and records the evidence behind the match.  
> **You:** Circles a different component and asks it to reconsider.  
> **Together:** Keep both the correction and the annotated image—without flattening the result.

That is the idea: **less describing where, more reasoning about what.** Recognition is still the model's responsibility; Estampes keeps the spatial context and its uncertainty explicit.

## Built for work that happens on images

| Capability | What you can do |
| :--- | :--- |
| **Bidirectional annotation** | Draw boxes, arrows, polylines, freehand strokes, and labels. Select and edit marks from earlier turns. |
| **Non-destructive layers** | Show, hide, rename, reorder, fade, and lock annotation layers without changing the source. |
| **High-detail inspection** | Zoom using source-native tiles when available; enhance contrast, sharpen, denoise, threshold, find edges, or add a coordinate grid. |
| **Evidence-aware claims** | Store confidence, evidence regions, and verification states for notes and cross-image links. User rejections are remembered. |
| **Comparison and measurement** | View two images side by side, register them, compare differences, calibrate a scale, and measure dimensions with uncertainty reporting. |
| **Portable workspaces** | Organize up to 24 images, move or copy annotation sets, and export an editable `.estampes` bundle for another server. |
| **Extendable instruments** | Optional modules add function plots, an isolated SymPy calculator, and plate solving, with explicit capability permissions. |

*PDF rendering, OCR, and some domain capabilities depend on optional installs or external services. See the [image capability map](docs/IMAGE-CAPABILITIES.md) for what is built in, optional, or not implemented.*

## Your source stays your source.

- **Original pixels remain untouched.** Annotations are separate data, with image-relative coordinates independent of zoom or screen size.
- **Corrections do not evaporate.** With persistent storage enabled, images, marks, layers, claims, and history survive restarts and can be reopened across chats.
- **Bring your work elsewhere.** Export a layered SVG, a visual-protocol JSON document, or an `.estampes` workspace bundle; layers do not have to become one flattened image.
- **You run the server.** Estampes is self-hosted, with no centrally hosted Estampes service.

## Quick start

**Requirements:** Docker Compose; an environment where ChatGPT can connect to a public HTTPS MCP endpoint. Docker runs on amd64 and arm64 machines (including suitable Raspberry Pi, NAS, and mini PCs).

```bash
git clone https://github.com/Curium-3391/Estampes.git
cd Estampes
cp .env.example .env
docker compose --profile tunnel up -d
docker compose logs estampes | grep tunnel
```

The last command displays a connector URL resembling:

```text
https://<temporary-address>.trycloudflare.com/mcp?key=<your-access-key>
```

In **ChatGPT on the web**, open **Plugins → Add custom MCP server**, paste that URL, and select **No authentication** (the access key is already in the URL). Then attach an image and ask GPT to point something out.

> [!IMPORTANT]
> The URL contains a bearer secret. **Do not publish or share it.** The quick tunnel address changes when it restarts; for regular use, configure your own reverse proxy or named tunnel. Estampes currently uses a single-owner access model, not per-user accounts.

See the [deployment guide](docs/DEPLOYMENT.md) for persistent hosting, Render/Heroku, PDF support, storage, and security limitations.

<details>
<summary><strong>Local development (Node.js 22)</strong></summary>

```bash
npm ci
npm test
npm start          # http://localhost:8787/mcp
```

The SymPy calculator is a separate optional service; see [CAS](docs/CAS.md) for running it.

</details>

## One canvas, clear responsibilities.

```text
Human  ── points, edits, confirms ──────┐
                                       ▼
ChatGPT / MCP client  ◀─────────▶  Estampes MCP server
       │                               │
       │ understands images            ├── shared canvas + workspaces
       │ proposes marks & claims       ├── image processing + coordinate maps
       │                               ├── persistent layers + evidence
       ▼                               └── permissioned modules
  MCP Apps widget  ◀───────────────────┘
       └── shows the original image and editable overlays inside the chat
```

**GPT interprets. Estampes validates coordinates, preserves state, renders overlays, and carries the conversation's visual references forward.** Read the [architecture](docs/ARCHITECTURE.md) and [product vision](docs/VISION.md) for design decisions and boundaries.

## Documentation

| If you're here to… | Start with |
| :--- | :--- |
| **Use the canvas** | [Usage guide](docs/USAGE.md) · [Image capabilities](docs/IMAGE-CAPABILITIES.md) · [Workspaces](docs/WORKSPACES.md) |
| **Deploy and maintain** | [Deployment](docs/DEPLOYMENT.md) · [Configuration & storage](docs/DEPLOYMENT.md#environment-variables) |
| **Build on Estampes** | [Architecture](docs/ARCHITECTURE.md) · [MCP tools](docs/TOOLS.md) · [Modules](docs/MODULES.md) · [Visual protocol v2](docs/PROTOCOL-V2.md) |
| **Read in Chinese** | [繁體中文說明](docs/zh-TW/README.md) |

<details>
<summary><strong>Complete technical documentation</strong></summary>

- **Imaging:** [Image pipeline](docs/IMAGE-PIPELINE.md), [Image capability map](docs/IMAGE-CAPABILITIES.md), [Canvas reads](docs/CANVAS-READS.md)
- **Composition:** [Workspaces](docs/WORKSPACES.md), [Surfaces](docs/SURFACES.md), [Workbench](docs/WORKBENCH.md)
- **Extensions:** [Modules and Store](docs/MODULES.md), [Scientific CAS](docs/CAS.md)
- **Interfaces:** [Tools and endpoints](docs/TOOLS.md), [Visual protocol v2](docs/PROTOCOL-V2.md), [Visual protocol v1](docs/PROTOCOL-V1.md)
- **Project:** [Vision](docs/VISION.md), [Architecture](docs/ARCHITECTURE.md), [Changelog](CHANGELOG.md), [Development history](docs/history/README.md), [Contributing](CONTRIBUTING.md)

</details>

## What is tested—and what isn't

- Image upload, canvas annotations, layers, zoom, and paired-image views have been tested in live ChatGPT web and mobile sessions.
- Newer features—including the workbench, calculator, plate solving, and workspaces—have automated coverage. **Not all have been validated in a live ChatGPT host.**
- Estampes does not guarantee the accuracy of GPT's visual recognition; an unverified model claim remains unverified.
- MCP Apps cannot draw directly over images displayed by ChatGPT itself. Estampes renders images inside **its own in-chat canvas**.
- This is a **single-owner, self-hosted** project. The access key protects the endpoint but does not provide individual user identities.

The version in use is recorded in [`package.json`](package.json) and exposed at `/version` on your server.

## License and origin

Licensed under the [Mozilla Public License 2.0](LICENSE). You can use, modify, and distribute Estampes, including in commercial products, subject to MPL-2.0's file-level obligations.

The name comes from Claude Debussy's *Estampes* (1903): three musical impressions, each rendering a different place through sound.

**A shared visual language for humans and AI.**