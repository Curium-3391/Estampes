# Compatibility

What has been tried where. This page records evidence, not hopes: a row says **Tested** only when the check was actually run, and says what kind of check it was. "Automated" means our own test suite, which uses a fake host for the widget (`tests/helpers/widget-host.js`) and the MCP SDK client for the protocol; an automated pass is **not** a test in a real ChatGPT conversation.

Labels: **Implemented** (in the code and covered by tests), **Optional** (needs extra setup), **Not tested** (no check run), **Unsupported** (known not to work), **Planned**.

## Clients

| Client | Tools over `/mcp` | Widgets (canvas, Store, calculator) | Evidence |
| --- | --- | --- | --- |
| ChatGPT web | Implemented | Implemented | Maintainer live sessions are recorded for the early canvas (0.4.x–0.6.x: images, marks, undo, zoom, layers, paired view). For everything added since (workspaces, modules and the Store, the calculator and workbench, bundles with surfaces) a live ChatGPT test is **Not tested**; the changelog and each feature page repeat this where it applies. |
| ChatGPT mobile apps | — | **Not tested** | No live check recorded. The workbench has a phone layout profile, checked only in the automated browser test with a fake host. A manual script is in [Workbench](WORKBENCH.md). |
| ChatGPT desktop apps | — | **Not tested** | No live check recorded. |
| Other MCP hosts (Claude, IDEs, custom clients) | Implemented as plain MCP over Streamable HTTP; automated protocol tests use the MCP SDK client | **Not tested** | Widgets are MCP Apps (`ui://` resources). A host without MCP Apps support still gets every tool and its text and image results, but no canvas to draw on; the app-only tools are hidden from the model by design. |

The connector must be reachable over https from wherever the client runs (OpenAI's servers for ChatGPT), with the access key in the URL. See [Deployment](DEPLOYMENT.md).

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
