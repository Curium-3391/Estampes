import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

async function start(env) {
  const port = await freePort();
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_ACCESS_KEY: "", ...env }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
  return { base, stop: () => handle.kill() };
}

const form = (data) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data).toString(), redirect: "manual" });

test("OAuth sign-in: discovery, registration, consent with the access key, PKCE, tokens", { timeout: 30000 }, async () => {
  const { base, stop } = await start({ ESTAMPES_ACCESS_KEY: "owner-secret-key" });
  try {
    const challenge401 = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(challenge401.status, 401);
    assert.match(challenge401.headers.get("www-authenticate"), /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);

    const prm = await (await fetch(base + "/.well-known/oauth-protected-resource/mcp")).json();
    assert.equal(prm.resource, base + "/mcp");
    assert.deepEqual(prm.authorization_servers, [base]);
    const meta = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
    assert.equal(meta.registration_endpoint, base + "/oauth/register");

    const badReg = await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
    assert.equal(badReg.status, 400);
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const reg = await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Claude" }) });
    assert.equal(reg.status, 201);
    const { client_id } = await reg.json();

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = { client_id, redirect_uri: redirectUri, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "xyz" };
    const page = await fetch(base + "/oauth/authorize?" + new URLSearchParams(params));
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Claude/);
    assert.match(pageHtml, /name="access_key"/);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(pageHtml, /<html lang="zh-Hant">/, "no Accept-Language: the instance default");
    // The page follows the browser's language; the form and its checks do not change.
    const english = await (await fetch(base + "/oauth/authorize?" + new URLSearchParams(params), { headers: { "accept-language": "en-US,en;q=0.9" } })).text();
    assert.match(english, /<html lang="en">/);
    assert.match(english, /name="access_key"/);

    // Unregistered redirect: shown on the page, never redirected.
    const wrongRedirect = await fetch(base + "/oauth/authorize?" + new URLSearchParams({ ...params, redirect_uri: "https://evil.example/cb" }), { redirect: "manual" });
    assert.equal(wrongRedirect.status, 400);
    // No PKCE: error goes back to the registered redirect.
    const noPkce = await fetch(base + "/oauth/authorize?" + new URLSearchParams({ ...params, code_challenge_method: "plain" }), { redirect: "manual" });
    assert.equal(noPkce.status, 302);
    assert.match(noPkce.headers.get("location"), /error=invalid_request/);

    const wrongKey = await fetch(base + "/oauth/authorize", form({ ...params, access_key: "nope", decision: "allow" }));
    assert.equal(wrongKey.status, 401);
    const denied = await fetch(base + "/oauth/authorize", form({ ...params, access_key: "", decision: "deny" }));
    assert.match(denied.headers.get("location"), /error=access_denied/);

    const ok = await fetch(base + "/oauth/authorize", form({ ...params, access_key: "owner-secret-key", decision: "allow" }));
    assert.equal(ok.status, 302);
    const back = new URL(ok.headers.get("location"));
    assert.equal(back.origin + back.pathname, redirectUri);
    assert.equal(back.searchParams.get("state"), "xyz");
    const code = back.searchParams.get("code");

    const badVerifier = await fetch(meta.token_endpoint, form({ grant_type: "authorization_code", code, client_id, redirect_uri: redirectUri, code_verifier: randomBytes(32).toString("base64url") }));
    assert.equal(badVerifier.status, 400);
    const tokenRes = await fetch(meta.token_endpoint, form({ grant_type: "authorization_code", code, client_id, redirect_uri: redirectUri, code_verifier: verifier }));
    assert.equal(tokenRes.status, 200);
    const tokens = await tokenRes.json();
    assert.equal(tokens.token_type, "Bearer");
    assert.ok(!tokens.access_token.includes("owner-secret-key"));
    const reuse = await fetch(meta.token_endpoint, form({ grant_type: "authorization_code", code, client_id, redirect_uri: redirectUri, code_verifier: verifier }));
    assert.equal(reuse.status, 400);

    const refreshed = await (await fetch(meta.token_endpoint, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }))).json();
    assert.ok(refreshed.access_token);
    // A refresh token is not an access token.
    const misuse = await fetch(base + "/api/v1/canvas/0123456789abcdef", { headers: { authorization: "Bearer " + tokens.refresh_token } });
    assert.equal(misuse.status, 401);

    const client = new Client({ name: "oauth-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: "Bearer " + refreshed.access_token } } }));
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "present_visual"));
    await client.close();
  } finally { stop(); }
});

test("an open server (no access key) has no OAuth endpoints", { timeout: 30000 }, async () => {
  const { base, stop } = await start({ ESTAMPES_ALLOW_OPEN: "1" });
  try {
    assert.equal((await fetch(base + "/.well-known/oauth-protected-resource")).status, 404);
    assert.equal((await fetch(base + "/oauth/register", { method: "POST", body: "{}" })).status, 404);
  } finally { stop(); }
});

test("client ID metadata documents: an https client_id is checked against its own redirect URIs", async () => {
  const { createOAuth } = await import("../src/oauth.js");
  const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
  const oauth = createOAuth({ getKey: () => "k", fetchClientDocument: async (u) => ({ client_id: u, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) });
  assert.equal(oauth.serverMetadata("https://x").client_id_metadata_document_supported, true);
  const base = { client_id: clientId, response_type: "code", code_challenge: "a".repeat(43), code_challenge_method: "S256" };
  assert.ok((await oauth.checkAuthorize({ ...base, redirect_uri: "https://claude.ai/api/mcp/auth_callback" })).client);
  assert.ok((await oauth.checkAuthorize({ ...base, redirect_uri: "https://evil.example/cb" })).page);
  const liar = createOAuth({ getKey: () => "k", fetchClientDocument: async () => ({ client_id: "https://other.example/", redirect_uris: ["https://evil.example/cb"] }) });
  assert.ok((await liar.checkAuthorize({ ...base, redirect_uri: "https://evil.example/cb" })).page);
});

test("the MCP SDK's own OAuth client signs in end to end", { timeout: 30000 }, async () => {
  const { UnauthorizedError } = await import("@modelcontextprotocol/client");
  const { base, stop } = await start({ ESTAMPES_ACCESS_KEY: "owner-secret-key" });
  try {
    const redirectUrl = "http://localhost:9/callback";
    let info, tokens, verifier, authUrl;
    const provider = {
      get redirectUrl() { return redirectUrl; },
      get clientMetadata() { return { client_name: "SDK test", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; },
      clientInformation: () => info, saveClientInformation: (i) => { info = i; },
      tokens: () => tokens, saveTokens: (t) => { tokens = t; },
      redirectToAuthorization: (url) => { authUrl = url; },
      saveCodeVerifier: (v) => { verifier = v; }, codeVerifier: () => verifier,
    };
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), { authProvider: provider });
    const client = new Client({ name: "sdk-oauth", version: "0" });
    await assert.rejects(client.connect(transport), UnauthorizedError);
    assert.ok(authUrl, "sent to the sign-in page");
    // The owner approves on the consent page.
    const params = Object.fromEntries(authUrl.searchParams);
    const approved = await fetch(base + "/oauth/authorize", form({ ...params, access_key: "owner-secret-key", decision: "allow" }));
    const code = new URL(approved.headers.get("location")).searchParams.get("code");
    await transport.finishAuth(code);
    const again = new Client({ name: "sdk-oauth", version: "0" });
    await again.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { authProvider: provider }));
    assert.ok((await again.listTools()).tools.length > 10);
    await again.close();
  } finally { stop(); }
});
