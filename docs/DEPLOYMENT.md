# Estampes — cloud deployment (M0)

## Render Blueprint

This repository includes `render.yaml`, configured for a single Node web service with a free-tier plan. The service is experimental: it has **no application-layer authentication** yet. Use only non-sensitive test data; do not treat this as a production-ready public MCP endpoint.

1. Open [Render Dashboard](https://dashboard.render.com/) and sign in.
2. Select **New → Blueprint**.
3. Connect GitHub and grant Render access to `Curium-3391/Estampes`. **The repository is currently private**, so Render requires explicitly granted GitHub access.
4. Select the repository and the `main` branch, review the `render.yaml` settings and approve creation. Check the plan before approving any cost.
5. Wait for the deployment status to say **Live**. Copy the service's HTTPS URL and add `/mcp` (for example `https://your-service.onrender.com/mcp`).
6. From ChatGPT **web**, open Plugins → **Add custom MCP server**, paste that endpoint and follow the authentication/setup prompts. Use the resulting private plugin only for this proof of concept.

Ask ChatGPT: **“@Estampes, show the number line and point to 2.”** Tap `-1`, then **傳給 GPT**. The structured position should be `x=0.375`.

## Caveats

- Render free services can sleep when idle and may restart slowly. Check current Render free-tier terms before deployment.
- The current server is unauthenticated. Restrict use to a private test, and add authentication and rate limiting before public distribution.
- The first model-to-user widget and user-to-model event require confirmation on the actual ChatGPT host; the code has not yet been verified there.
- If the host cannot show the UI, inspect tool discovery, MCP responses, the `ui://` resource, and the MCP Apps UI bridge handshake.
