# Estampes — cloud deployment

## Render Blueprint

This repository includes `render.yaml`, configured for a single Node web service on the free plan. Render installs with `npm ci` from the committed `package-lock.json`, runs the test suite, and deploys `main` automatically on every push.

1. Open [Render Dashboard](https://dashboard.render.com/) and sign in.
2. Select **New → Blueprint**.
3. Connect GitHub and grant Render access to `Curium-3391/Estampes` (the repository is private, so access must be granted explicitly).
4. Select the repository and the `main` branch, review `render.yaml` and approve creation. Check the plan before approving any cost.
5. Render asks for `ESTAMPES_ACCESS_KEY`. Set a long random string to protect the endpoint (recommended), or leave it empty for an open test server.
6. Wait for **Live**, then open `https://<service>.onrender.com/version` and confirm the expected `version` and `accessKeyRequired`.
7. In ChatGPT **web**, open Plugins → **Add custom MCP server**, and use:
   - with a key: `https://<service>.onrender.com/mcp?key=<ESTAMPES_ACCESS_KEY>`
   - without a key: `https://<service>.onrender.com/mcp`
   - Authentication: **No authentication** (the key travels in the URL).

After each deploy that changes tool definitions or widgets, refresh the connector in ChatGPT and start a **new conversation**, so cached templates are not reused.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Set by Render. |
| `ESTAMPES_ACCESS_KEY` | unset | When set, `/mcp` requires `?key=` or `Authorization: Bearer <key>`; otherwise 401. `/` and `/version` stay public. |
| `ESTAMPES_RATE_LIMIT_PER_MIN` | `120` | Requests per minute per client IP on `/mcp`; `0` disables. Returns 429 when exceeded. |
| `ESTAMPES_CORS_ORIGINS` | `*` | Comma-separated browser origins allowed by CORS. ChatGPT calls `/mcp` server-to-server and does not need CORS; this only matters for browser tools such as MCP Inspector. |

## Releasing a new version

`package.json` `version` is the single source of truth. `/version`, the MCP server version, the version shown in the widgets and the versioned `ui://estampes/visual-surface-vXYZ.html` / `visual-evidence-vXYZ.html` URIs are all derived from it. To release, bump `version` (and run `npm install` to update the lockfile), then add the previous tag to `LEGACY_VISUAL_URIS` / `LEGACY_EVIDENCE_URIS` in `server.js` so saved conversations keep resolving.

## Caveats

- Render free services sleep when idle; the first request after a pause can take tens of seconds.
- The access key is a shared secret in a URL, not per-user auth. Anyone with the connector URL can call the server. Add OAuth before any public distribution.
- The rate limiter is in memory and per instance; it resets on restart.
- If the host cannot show a widget, inspect tool discovery, MCP responses, the `ui://` resource, and the MCP Apps bridge handshake.
