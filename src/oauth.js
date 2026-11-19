// Built-in OAuth 2.1 for hosts that sign in to remote MCP servers with OAuth
// (for example Claude's custom connectors), so the access key does not have
// to travel in the connector URL. The owner proves ownership once, on the
// consent page, by typing the server's access key.
//
// Everything is stateless: client ids, authorization codes and tokens are
// HMAC-signed with a key derived from the access key. Rotating the access
// key therefore revokes every client and token at once, and a restart keeps
// clients signed in. Only used authorization codes are remembered (in
// memory, until they expire) so a code works once.
//
// Implemented: protected-resource metadata (RFC 9728), authorization-server
// metadata (RFC 8414), dynamic client registration (RFC 7591), the
// authorization-code grant with PKCE S256 only, and refresh tokens.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sameSecret } from "./security.js";
import { t } from "./i18n/index.js";

const CODE_TTL_S = 300;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 90 * 24 * 3600;
const MAX_BODY = 64 * 1024;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

export function createOAuth({ getKey, fetchClientDocument = null }) {
  const usedCodes = new Map();
  const documents = new Map();
  const signingKey = () => createHmac("sha256", getKey()).update("estampes-oauth-v1").digest();

  function sign(kind, payload) {
    const body = b64u(JSON.stringify({ k: kind, ...payload }));
    const mac = b64u(createHmac("sha256", signingKey()).update(body).digest());
    return kind + "." + body + "." + mac;
  }
  function verify(kind, token) {
    if (typeof token !== "string" || token.length > 8192) return null;
    const [k, body, mac] = token.split(".");
    if (k !== kind || !body || !mac) return null;
    const expected = Buffer.from(b64u(createHmac("sha256", signingKey()).update(body).digest()));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
    if (data?.k !== kind) return null;
    if (typeof data.exp === "number" && data.exp < now()) return null;
    return data;
  }

  const enabled = () => Boolean(getKey());

  /** True when the bearer token is an access token this server issued. */
  function validAccessToken(token) {
    return enabled() && Boolean(verify("eat", token));
  }

  function resourceMetadata(origin) {
    return {
      resource: origin + "/mcp",
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "Estampes",
    };
  }

  function serverMetadata(origin) {
    return {
      issuer: origin,
      authorization_endpoint: origin + "/oauth/authorize",
      token_endpoint: origin + "/oauth/token",
      registration_endpoint: origin + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["estampes"],
      client_id_metadata_document_supported: Boolean(fetchClientDocument),
    };
  }

  function validRedirect(uri) {
    let u;
    try { u = new URL(uri); } catch { return false; }
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    // Native and CLI clients listen on loopback.
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  }

  function register(body) {
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string") : [];
    if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) {
      return { status: 400, body: { error: "invalid_redirect_uri", error_description: "redirect_uris must be 1-10 https (or loopback http) URLs" } };
    }
    const name = String(body?.client_name ?? "").slice(0, 80);
    const clientId = sign("ecl", { r: uris, n: name, iat: now() });
    return {
      status: 201,
      body: {
        client_id: clientId, client_id_issued_at: now(), client_name: name || undefined,
        redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    };
  }

  const client = (clientId) => verify("ecl", clientId);

  // Client ID metadata documents: the client_id is an https URL whose JSON
  // lists the client's redirect URIs. Cached for an hour.
  async function resolveClient(clientId) {
    if (!/^https:\/\//.test(clientId ?? "")) return client(clientId);
    if (!fetchClientDocument) return null;
    const cached = documents.get(clientId);
    if (cached && cached.at > Date.now() - 3600_000) return cached.value;
    let value = null;
    try {
      const doc = await fetchClientDocument(clientId);
      const uris = Array.isArray(doc?.redirect_uris) ? doc.redirect_uris.filter((u) => typeof u === "string" && validRedirect(u)) : [];
      if (doc?.client_id === clientId && uris.length) value = { r: uris.slice(0, 10), n: String(doc.client_name ?? new URL(clientId).host).slice(0, 80) };
    } catch {}
    documents.set(clientId, { at: Date.now(), value });
    if (documents.size > 200) documents.delete(documents.keys().next().value);
    return value;
  }

  // Checks every authorization request parameter. Errors before the redirect
  // URI is trusted are shown on the page, never redirected.
  async function checkAuthorize(params) {
    const c = await resolveClient(params.client_id);
    if (!c) return { page: "This sign-in link is not for this Estampes server (unknown client). Remove the connector and add it again." };
    if (!c.r.includes(params.redirect_uri)) return { page: "The sign-in link has a redirect address this client did not register." };
    const fail = (error, description) => ({ redirect: withQuery(params.redirect_uri, { error, error_description: description, state: params.state }) });
    if (params.response_type !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
    if (params.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(params.code_challenge ?? "")) {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    return { client: c };
  }

  function consentPage(params, { error = "", client: c = null } = {}) {
    const name = c?.n || "an AI app";
    const hidden = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
      .map((k) => params[k] == null ? "" : '<input type="hidden" name="' + k + '" value="' + esc(params[k]) + '">').join("");
    let host = "";
    try { host = new URL(params.redirect_uri).host; } catch {}
    return "<!doctype html><html lang=\"zh-Hant\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>" + t("oauth.title") + "</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 16px;color:#1d1d1f;background:#fafafa}" +
      "input[type=password]{width:100%;font:inherit;padding:.5rem;box-sizing:border-box}button{font:inherit;padding:.5rem 1rem;margin-top:1rem}" +
      ".err{color:#b00020}.small{color:#666;font-size:.9em}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.small{color:#aaa}}</style></head><body>" +
      "<h1>" + t("oauth.title") + "</h1><p>" + t("oauth.asks", { name: esc(name), host: esc(host) }) + "</p>" +
      "<p>" + t("oauth.explain") + "</p>" +
      "<p class=\"small\">" + t("oauth.onlyIfYou") + "</p>" +
      (error ? '<p class="err">' + esc(error) + "</p>" : "") +
      '<form method="post" action="/oauth/authorize">' + hidden +
      '<label>Access key<br><input type="password" name="access_key" autocomplete="current-password" required autofocus></label>' +
      '<br><button type="submit" name="decision" value="allow">' + t("oauth.allow") + '</button> <button type="submit" name="decision" value="deny">' + t("oauth.deny") + "</button></form>" +
      '<p class="small">' + t("oauth.findKey") + "</p>" +
      "</body></html>";
  }

  /** Handles the consent form. Returns {redirect}, {status, html} (try again) or {page} (bad request). */
  async function approve(params) {
    const checked = await checkAuthorize(params);
    if (checked.page || checked.redirect) return checked;
    if (params.decision !== "allow") {
      return { redirect: withQuery(params.redirect_uri, { error: "access_denied", error_description: "the owner declined", state: params.state }) };
    }
    if (!sameSecret(params.access_key, getKey())) return { status: 401, html: consentPage(params, { error: t("oauth.wrongKey"), client: checked.client }) };
    const code = sign("eac", { c: params.client_id, r: params.redirect_uri, ch: params.code_challenge, res: params.resource || undefined,
      n: b64u(randomBytes(9)), exp: now() + CODE_TTL_S });
    return { redirect: withQuery(params.redirect_uri, { code, state: params.state }) };
  }

  function issue(clientId, resource) {
    return {
      access_token: sign("eat", { c: clientId, res: resource, n: b64u(randomBytes(6)), exp: now() + ACCESS_TTL_S }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: sign("ert", { c: clientId, res: resource, n: b64u(randomBytes(6)), exp: now() + REFRESH_TTL_S }),
      scope: "estampes",
    };
  }

  function token(params) {
    const bad = (error, description, status = 400) => ({ status, body: { error, error_description: description } });
    for (const [code, exp] of usedCodes) if (exp < now()) usedCodes.delete(code);
    if (params.grant_type === "authorization_code") {
      const code = verify("eac", params.code);
      if (!code) return bad("invalid_grant", "authorization code is invalid or expired");
      if (usedCodes.has(params.code)) return bad("invalid_grant", "authorization code was already used");
      if (params.client_id && params.client_id !== code.c) return bad("invalid_grant", "code was issued to another client");
      if (params.redirect_uri !== code.r) return bad("invalid_grant", "redirect_uri does not match");
      const verifier = String(params.code_verifier ?? "");
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64u(createHash("sha256").update(verifier).digest()) !== code.ch) {
        return bad("invalid_grant", "PKCE code_verifier does not match");
      }
      usedCodes.set(params.code, code.exp);
      return { status: 200, body: issue(code.c, code.res) };
    }
    if (params.grant_type === "refresh_token") {
      const rt = verify("ert", params.refresh_token);
      if (!rt) return bad("invalid_grant", "refresh token is invalid or expired");
      if (params.client_id && params.client_id !== rt.c) return bad("invalid_grant", "refresh token was issued to another client");
      return { status: 200, body: issue(rt.c, rt.res) };
    }
    return bad("unsupported_grant_type", "use authorization_code or refresh_token");
  }

  return { enabled, validAccessToken, resourceMetadata, serverMetadata, register, checkAuthorize, consentPage, approve, token };
}

function withQuery(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, String(v));
  return u.toString();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Reads a small form or JSON request body. */
export async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const type = String(req.headers["content-type"] ?? "");
  if (type.includes("application/json")) {
    try { return JSON.parse(text || "{}"); } catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
  }
  return Object.fromEntries(new URLSearchParams(text));
}
