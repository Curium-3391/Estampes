# Changelog

The version in `package.json` is the single source of truth. Earlier milestone details are in [docs/history/](docs/history/README.md).

## 0.7.2 — Temporary public address

- `docker compose --profile tunnel up -d` opens a Cloudflare quick tunnel and logs the ChatGPT connector URL. No account and no router changes; the address changes on every restart.

## 0.7.1 — Secure defaults for self-hosting

- Without `ESTAMPES_ACCESS_KEY`, Docker generates a key on first start and saves it as `/data/access-key`; `ESTAMPES_ALLOW_OPEN=1` opts out.
- compose binds `127.0.0.1` by default, with a read-only filesystem, no capabilities and `no-new-privileges`.
- `X-Forwarded-*` headers are trusted only with `ESTAMPES_TRUST_PROXY`.
- Signed `/export` links. Heroku generates a key.

## 0.7.0 — Disk storage, Docker and visual protocol 1

- `ESTAMPES_STORAGE_DIR`: each image gets `images/<hash>/` (source, `canvas.json`, `marks.svg`, history), so canvases survive restarts.
- Docker/compose (non-root, `/data` volume, `/healthz`), multi-arch GHCR image (amd64, arm64), Heroku `app.json`.
- Layers can be renamed, reordered, faded and locked.
- Select tool: move, restyle or delete one mark, including marks from earlier turns.
- `estampes.visual/1`: the `get_visual_state` tool and `/api/v1/canvas`.

## 0.6.0 — Paired view

- `pairImage`: two different images side by side; GPT records links between marks with a confidence, and the user reviews them (`review_visual_link`).

## 0.5.x — Real images and the canvas

- 0.5.0: `load_image` (chat file or public https URL), `process_image` (CLAHE, sharpen, denoise, threshold, edges, zoomed regions), `overlay_grid` (labelled coordinate grid).
- 0.5.1: `present_visual` shows the real photo, original by default, with optional processed tabs.
- 0.5.2: canvas tabs no longer snap back to the first view.
- 0.5.3: polylines and freehand drawing, faster processing, GPT notes and status on marks.
- 0.5.4: pens, colours, highlighter, verification image, crop coordinates, marks kept across turns.
- 0.5.5: undo/redo, GPT verification tab, smaller payloads, export `image.jpg` and layered `marks.svg`.
- 0.5.6: late tool input from ChatGPT no longer squashes the photo.
- 0.5.7: zoom and pan in the canvas (pinch, Ctrl+wheel, buttons) with native-resolution tiles.
- 0.5.8: touch drags no longer scroll the chat on phones.
- 0.5.9: layers: every send and every GPT drawing call is a layer you can show or hide.

## Up to 0.4.x — Proof of concept

- M0.3: number line, proving the GPT → widget → user → GPT round trip inside ChatGPT.
- M0.4–0.4.7: points, boxes and arrows on built-in SVG demo scenes, `inspect_visual` giving the model real pixels, merged into one canvas.
- 0.4.8: optional access key, rate limit, CORS allowlist, locked dependencies.
