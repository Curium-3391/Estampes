# Development guide

How to set up a working copy, run every kind of test, find your way around the code and pick a first task. Commands here were run on Linux with Node 22 while writing this page; counts are from that run and will drift.

## Set up

| You need | For | How |
| --- | --- | --- |
| Node 22 and `npm ci` | everything | `git clone … && cd Estampes && npm ci` |
| Python 3.13 with SymPy | the calculator service and its tests | `python3 -m venv .venv && .venv/bin/pip install -r cas-service/requirements.lock`, then `export PYTHON=$PWD/.venv/bin/python` for the tests |
| `pdfjs-dist@4.10.38` and `@napi-rs/canvas` | PDF pages and their tests | `npm install --no-save pdfjs-dist@4.10.38 @napi-rs/canvas` (the version CI and the Docker image use) |
| `playwright-core` and Chrome/Chromium | browser tests of the widget | `npm install --no-save playwright-core`; set `CHROME_BIN` to a Chrome binary if Playwright cannot find one |
| Docker | the compose smoke test, the image build | optional; only the release workflow needs it |

`npm install --no-save …` replaces earlier `--no-save` installs, so install the optional packages in one command when you want several. Nothing optional is required to start the server or run the main test suite; tests that need a missing piece **skip** and say why.

## Run the server

```sh
ESTAMPES_ALLOW_OPEN=1 ESTAMPES_STORAGE_DIR=$(mktemp -d) npm start      # http://127.0.0.1:8787/mcp, no key
```

Without `ESTAMPES_STORAGE_DIR` everything stays in memory. With the calculator, start the service too and point the server at its socket:

```sh
ESTAMPES_CAS_SOCKET=/tmp/cas.sock PYTHONPATH=cas-service .venv/bin/python -m estampes_cas &
ESTAMPES_CAS_SOCKET=/tmp/cas.sock ESTAMPES_ALLOW_OPEN=1 npm start
```

To use a local server from ChatGPT you need an https address; see the tunnel profile in [Deployment](DEPLOYMENT.md). `/healthz` and `/version` tell you what is available.

## Run the tests

```sh
unset ESTAMPES_STORAGE_DIR ESTAMPES_ACCESS_KEY        # see below
npm test                                                # node --test: everything in tests/
node --test tests/workspace.test.js                    # one file
node --test --test-name-pattern "workspace" tests/*.test.js   # by name
.venv/bin/python -m unittest discover -s cas-service/tests    # calculator, 17 tests
```

| Kind | Where | Needs | Notes |
| --- | --- | --- | --- |
| Unit | `tests/*.test.js` (geometry, canvas state, protocol, scene ops, image tools, workspaces, bundles, expressions…) | nothing | In-process, fast |
| Integration over MCP | `*-mcp.test.js`, `mcp-http.test.js`, `modules-mcp.test.js`, `packages.test.js`, `surface.test.js` | nothing (calculator ones: SymPy) | Start the real `server.js` on a free port, talk to it with the MCP SDK client |
| Browser | `workbench-e2e`, `layers-e2e`, `surface-open`, `surface-refresh`, `cards-e2e`, `finding-list`, … via `tests/helpers/widget-host.js` | `playwright-core`, Chrome; calculator ones also SymPy | The real server and the real widget in a browser, with a **fake ChatGPT host** that plays the MCP Apps bridge |
| Quick PR regression | `node scripts/ci-fast-tests.mjs` | Node 22, `npm ci` | Omits expensive persistence/UVA stress cases except the default-store smoke test |
| Full PR / weekly checks | `.github/workflows/m0.yml` | Node, Python, browser dependencies | Required for high-risk PRs; weekly schedule; manual dispatch |
| Compose smoke test | `.github/workflows/docker.yml` | Docker | Runs on `v*` tags only, after full tests pass |

Without any optional piece, `npm test` on the reference run (263 tests) gave 246 passed, 0 failed, 17 skipped (the calculator, browser and PDF tests) in about 21 seconds. With SymPy, `playwright-core` and Chromium, the calculator and browser files (`node --test tests/cas-module.test.js tests/surface.test.js tests/bundle-extras.test.js tests/workbench-e2e.test.js tests/layers-e2e.test.js tests/surface-open.test.js tests/surface-refresh.test.js`) ran 23 tests, all passing, with none skipped. CI uses an always-present `baseline` job in `.github/workflows/pr-baseline.yml`. Documentation-only PRs run syntax/documentation checks; visual/UI-only changes run the quick Node suite; changes to storage, UVA, server, security, dependencies, test infrastructure, or unknown paths call the complete `m0.yml` suite before `baseline` can pass. Full tests also run weekly and before release images are published. Branch pushes do not duplicate PR test runs. The risk classifier is `scripts/ci-change-scope.mjs`; it fails closed to full tests if a diff cannot be classified.

**Unset `ESTAMPES_*` variables before running tests.** Some tests assert the defaults (for example "storage is off") and fail if your shell exports `ESTAMPES_STORAGE_DIR`. This was observed: an exported storage folder made `mcp-http.test.js` fail.

A passing automated test is not a result from a real ChatGPT host. See [Compatibility](COMPATIBILITY.md).

## Tour of the code

| Where | What lives there |
| --- | --- |
| `server.js` | Registers MCP tools, widget resources and HTTP routes (the file is large; search for `registerTool("name"`). App-only tools carry `_meta.ui.visibility: ["app"]`. |
| `src/image-store.js`, `src/storage.js` | Image intake, hashing, cache; optional disk storage |
| `src/image-ops.js`, `src/image/*` | Pixel operations, derived views, transforms, registration, measurement, PDF, analysis engines |
| `src/canvas-state.js`, `src/protocol.js`, `src/marks-file.js`, `src/mark-render.js` | Marks, layers, links, the `estampes.visual/2` document, SVG export, verification crops |
| `src/workspace.js`, `src/bundle.js`, `src/zip.js` | Workspaces and `.estampes` bundles |
| `src/scene/*` | Scene objects, scene operations, expression parser, rendering |
| `src/modules/*`, `src/builtin-modules/*` | Manifests, registry, lifecycle, packages, runtimes (declarative, WebAssembly, http), egress, jobs; Graph, calculator, plate solving |
| `src/cas/*`, `cas-service/` | Calculator client and notebooks; the SymPy service (separate container) |
| `src/surface/*`, `public/` | Panels and layouts; the widgets (`visual-surface.html` is one self-contained page, no build step) |
| `scripts/` | `estampes-module.js` (module author and administrator CLI), `check-release.mjs`, `verify-backup-restore.mjs`, `make-sample-material.mjs` |
| `docs/history/` | Archived milestone notes and the first protocols; not the current behaviour |

[Architecture](ARCHITECTURE.md) explains how the parts fit together.

### Public extension interfaces versus internals

You may build on these; they are versioned and documented, and changes are announced in the [changelog](../CHANGELOG.md):

- the module manifest `estampes.module/1`, capability schemas, permissions and package format `estampes.package/1` ([Modules](MODULES.md));
- scene operations `estampes.scene-ops/1` and the scene object types;
- the MCP tools and HTTP endpoints in [Tools](TOOLS.md);
- the data formats `estampes.visual/2`, `estampes.workspace/1`, `estampes.bundle/1`.

Everything else (the files under `src/`, the widget's internal messages, `server.js` structure, the order of fields in `canvas.json`) is internal and may change in any release. Do not import from `src/` in a module; modules talk to Estampes only through operations.

## First tasks for contributors

- **Reproduce a bug as a test.** Most behaviours have a small test file; add a failing case next to it first.
- **Add a missing test case** for an edge in coordinate transforms, protocol parsing or bundle import.
- **Improve a document**: run the commands in it; fix any that do not behave as written, then run `npm run docs:check` ([Documentation maintenance](DOCUMENTATION-MAINTENANCE.md)).
- **Write a module** with the [module quick start](modules/QUICKSTART.md) and offer it as an example.
- **Live-host test**: run a feature in real ChatGPT and report what you saw, with the version and client; this is the largest gap in [Compatibility](COMPATIBILITY.md).

Before a large change, open an issue first ([Contributing](../CONTRIBUTING.md)).
