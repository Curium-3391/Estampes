# Compatibility

What has been tried where. This page records evidence, not hopes: a row says **Tested** only when the check was actually run, and says what kind of check it was. "Automated" means our own test suite, which uses a fake host for the widget (`tests/helpers/widget-host.js`) and the MCP SDK client for the protocol; an automated pass is **not** a test in a real ChatGPT conversation.

Labels: **Implemented** (in the code and covered by tests), **Optional** (needs extra setup), **Not tested** (no check run), **Unsupported** (known not to work), **Planned**.

## Clients

| Client | Tools over `/mcp` | Widgets (canvas, Store, calculator) | Evidence |
| --- | --- | --- | --- |
| ChatGPT web | Implemented | Implemented | Maintainer live sessions are recorded for the early canvas (0.4.x–0.6.x: images, marks, undo, zoom, layers, paired view). For everything added since (workspaces, modules and the Store, the calculator and workbench, bundles with surfaces) a live ChatGPT test is **Not tested**; the changelog and each feature page repeat this where it applies. |
| ChatGPT mobile apps | — | **Not tested** | No live check recorded. The workbench has a phone layout profile, checked only in the automated browser test with a fake host. A manual script is in [Workbench](WORKBENCH.md). |
| ChatGPT desktop apps | — | **Not tested** | No live check recorded. |
| LibreChat v0.8.9-rc1 | Tested in the report below | Canvas and public image URL tested. Local canvas upload unavailable. | [Issue #148](https://github.com/Curium-3391/Estampes/issues/148) and fake-host upload regression tests. |
| Open WebUI | Streamable HTTP tools reported working in Issue #148 | Older versions may only show tools. Open WebUI added MCP Apps in 0.13.0. | The reporter did not identify their Open WebUI version. Current Estampes canvas and upload behavior is **Not tested**. |
| Other MCP hosts (Claude, IDEs, custom clients) | Implemented as plain MCP over Streamable HTTP; automated protocol tests use the MCP SDK client | **Not tested** | Widgets are MCP Apps (`ui://` resources). A host without MCP Apps support still gets every tool and its text and image results, but no canvas to draw on; the app-only tools are hidden from the model by design. |

The connector must be reachable from wherever the client runs. For ChatGPT this means public HTTPS reachable by OpenAI's servers. For self-hosted LibreChat the MCP connection can stay on a private Docker network. See [Deployment](DEPLOYMENT.md).

### LibreChat v0.8.9-rc1

[Issue #148](https://github.com/Curium-3391/Estampes/issues/148) records a live Windows Docker Desktop test with Estampes 0.20.0 (`c68cb8b`) and LibreChat commit `9363db5`. The reporter saw the tool count go from 38 to 59 with Apps enabled and confirmed the canvas rendered and `present_visual(imageUrl: …)` worked for a public image. Canvas file selection failed before the server received an upload call. Chat attachments were available to the model in that setup, but did not reach the MCP tools. The error handling and LibreChat detection described here were tested with a fake host. The revised widget has **not been tested live** in LibreChat.

[In this release](https://github.com/LibreChat-AI/LibreChat/blob/v0.8.9-rc1/docs/mcp-apps.md), `mcpAppSandbox.maxActionPreviewChars` defaults to 16,384 and can be set up to 131,072 UTF-16 code units. The Host checks the whole serialized tool argument object, which includes the base64 slice and its metadata, before showing an approval. An Estampes slice of 240,000 characters exceeds even the highest setting. Even at the maximum, an image with 3 million base64 characters takes at least 23 calls and 23 approvals. At the default it takes at least 184. Lowering the slice size does not remove the approval requirement. [The bridge](https://github.com/LibreChat-AI/LibreChat/blob/v0.8.9-rc1/client/src/hooks/MCP/useAppBridge.ts) returns the same empty error for an oversized request and a declined approval.

Estampes now detects LibreChat from the MCP Apps handshake and shows an explanation where it would offer local upload. It sends no image data via the upload tool in this host. Use `present_visual(imageId: …)` for an image already in the same Estampes instance, or `imageUrl` for material that is already public. Keep sensitive images private. [Issue #149](https://github.com/Curium-3391/Estampes/issues/149) tracks a separate authenticated upload page with explicit file submission, CSRF protection and storage access controls.

### Open WebUI

[Open WebUI's 0.13.0 changelog](https://github.com/open-webui/open-webui/blob/v0.13.0/CHANGELOG.md) announces MCP Apps in a sandboxed iframe. Its [MCP documentation](https://docs.openwebui.com/features/extensibility/mcp/#mcp-apps) describes a 5 MB HTML resource limit, confirmation for each tool call from the app, and text-only app messages. The Open WebUI check in Issue #148 verified Streamable HTTP tools and reported no canvas. The Estampes canvas and image upload on 0.13.0 and later are **Not tested**.

## Server platforms

| Platform | Status |
| --- | --- |
| Docker/compose on amd64 and arm64 | Implemented. Compose smoke test runs in CI on version tags only (`docker.yml`); multi-arch image build likewise. Not run on every pull request. |
| Node 22 directly (`npm start`) | Implemented; unit and integration tests run in CI. |
| Heroku, Render | Documented ([Deployment](DEPLOYMENT.md)); Render is used by the maintainer as test hosting. No automated check. |
| Windows or macOS without Docker | **Not tested** |

## Optional features

| Feature | Needs | Status without it |
| --- | --- | --- |
| PDF pages | `pdfjs-dist` and `@napi-rs/canvas` (Docker build arg `ESTAMPES_WITH_PDF=1`) | The PDF tool reports it is unavailable; nothing else changes. Its tests skip on a machine without the packages. |
| Scientific calculator | The `cas` container (SymPy) | Only calculations fail; `/healthz` reports it. |
| Plate solving | Storage, an Astrometry.net key, administrator approval, internet access from the server | Job fails with the reason. |
| OCR analysis engine | `npm i tesseract.js`; language data download on first use | Engine listed as unavailable. |
| Module Store installs | Administrator key on the server | Installs cannot be approved. |

## What counts as tested in this repository

| Check | Where | Real ChatGPT? |
| --- | --- | --- |
| `npm test` (units, MCP over HTTP, widget contract; PDF tests run because CI installs the optional PDF packages) | CI `node-tests` | No |
| Calculator Python tests | CI `cas-tests` | No |
| Browser tests: workbench, layers, surface (real server, real SymPy, real widget in Chrome, fake host) | CI `cas-tests` | No |
| Compose smoke test, secure defaults, CAS container checks | CI on `v*` tags | No |
| Maintainer sessions in ChatGPT web | Not automated; recorded in the changelog | Yes, only where a changelog entry or feature page says so |

If you run a live check on a client or version listed above as **Not tested**, an issue with the Estampes version, client, what you did and what you saw is the most useful contribution.
