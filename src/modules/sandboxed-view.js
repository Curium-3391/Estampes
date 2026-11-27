// U3: the payload of the `sandboxed-web` renderer (`estampes.renderer.sandboxed-web/1`) and the package files it names.
//
// A module may draw one of its views with its own HTML and JavaScript, in an isolated frame that the widget builds (public/sandboxed-view.js).
// The payload carries configuration only, never code: the code is in the package's files, which the package signature already covers.
//
//   payload: { entry, assets?, shims?, state? }
//   entry    "ui/<name>.html": a file of the package. The widget inlines the scripts and styles it names with relative `src` / `href`.
//   assets   more files of the package under ui/ (scripts, styles, images, fonts), at most 12.
//   shims    names from SHIMS, which the host injects in front of the module's own code (the module may also ship a patched build and name none).
//   state    { model, report: { action, path, param?, minIntervalMs? } }: where the frame's reported state is kept. `model` is one of the view's
//            `reads`; `action` is one of the view's `actions` and must write that model; the reported value (the part of the frame's state at
//            JSON pointer `path`) goes to the action as input `param` (default "data"), with `id` and `revision` of the bound instance when there is one.
//            The host never writes a model itself: a report is an ordinary execute_module call with every check that has.
// The manifest check needs no JS to run. It needs the permission `ui.sandboxed-frame` and that the files exist (the package check, packages.js).
export const SHIMS = Object.freeze(["no-service-worker", "memory-storage"]);
export const MAX_ASSETS = 12;
export const MAX_UI_BYTES = 1_500_000;
export const MAX_REPORT_INTERVAL_MS = 60_000, MIN_REPORT_INTERVAL_MS = 500;
const ENTRY = /^ui\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,3}\.html$/;
const ASSET = /^ui\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,3}\.(js|css|json|svg|png|jpg|jpeg|webp|gif|woff2|txt)$/;
const POINTER = /^(\/[A-Za-z0-9_-]{1,32}){0,4}$/;
const clean = (p) => !p.split("/").some((s) => s === "." || s === ".." || s === "");
const fail = (where, message) => { throw new Error(where + ": " + message); };

export function validateSandboxedWeb(payload, ctx) {
  const allowed = ["entry", "assets", "shims", "state"];
  for (const k of Object.keys(payload ?? {})) if (!allowed.includes(k)) fail("payload." + k, "is not part of estampes.renderer.sandboxed-web/1");
  if (!(ctx.permissions ?? []).includes("ui.sandboxed-frame")) fail("payload", "a sandboxed-web view needs the permission ui.sandboxed-frame in manifest.permissions");
  if (typeof payload.entry !== "string" || !ENTRY.test(payload.entry) || !clean(payload.entry)) fail("payload.entry", "must be the path of an .html file of the package under ui/");
  const assets = payload.assets ?? [];
  if (!Array.isArray(assets) || assets.length > MAX_ASSETS) fail("payload.assets", "must be a list of at most " + MAX_ASSETS + " package files");
  const seen = new Set([payload.entry]);
  assets.forEach((a, i) => {
    if (typeof a !== "string" || !ASSET.test(a) || !clean(a)) fail("payload.assets[" + i + "]", "must be a package file under ui/ (js, css, json, svg, png, jpg, webp, gif, woff2 or txt)");
    if (seen.has(a)) fail("payload.assets[" + i + "]", "is listed twice");
    seen.add(a);
  });
  const shims = payload.shims ?? [];
  if (!Array.isArray(shims) || new Set(shims).size !== shims.length) fail("payload.shims", "must be a list of distinct shim names");
  for (const s of shims) if (!SHIMS.includes(s)) fail("payload.shims", JSON.stringify(s) + " is not a shim of this host (known: " + SHIMS.join(", ") + ")");
  const st = payload.state;
  if (st !== undefined) {
    if (!st || typeof st !== "object" || Array.isArray(st)) fail("payload.state", "must be an object");
    for (const k of Object.keys(st)) if (!["model", "report"].includes(k)) fail("payload.state." + k, "is not part of estampes.renderer.sandboxed-web/1");
    if (typeof st.model !== "string" || !ctx.view.reads.includes(st.model)) fail("payload.state.model", "must be one of the view's reads");
    const r = st.report;
    if (!r || typeof r !== "object" || Array.isArray(r)) fail("payload.state.report", "must say which action keeps the reported state");
    for (const k of Object.keys(r)) if (!["action", "path", "param", "minIntervalMs"].includes(k)) fail("payload.state.report." + k, "is not part of estampes.renderer.sandboxed-web/1");
    if (typeof r.action !== "string" || !ctx.view.actions.includes(r.action)) fail("payload.state.report.action", "must be one of the view's actions");
    if (!(ctx.actions[r.action]?.writes ?? []).includes(st.model)) fail("payload.state.report.action", "must be a capability that writes " + st.model);
    if (typeof r.path !== "string" || !POINTER.test(r.path)) fail("payload.state.report.path", "must be a JSON pointer of at most 4 plain segments (\"\" is the whole state)");
    if (r.param !== undefined && (typeof r.param !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(r.param))) fail("payload.state.report.param", "must be a plain input name");
    if (r.minIntervalMs !== undefined && (!Number.isInteger(r.minIntervalMs) || r.minIntervalMs < MIN_REPORT_INTERVAL_MS || r.minIntervalMs > MAX_REPORT_INTERVAL_MS)) fail("payload.state.report.minIntervalMs", "must be a whole number from " + MIN_REPORT_INTERVAL_MS + " to " + MAX_REPORT_INTERVAL_MS);
  }
}

// The package files a sandboxed-web view names (entry first), for every view of a manifest.
export const uiPathsOf = (manifest) => [...new Set((manifest.views ?? []).filter((v) => v.renderer.type === "sandboxed-web").flatMap((v) => [v.renderer.payload.entry, ...(v.renderer.payload.assets ?? [])]))];

// Throws when a named file is missing or the UI is larger than a frame may be; returns { path: { encoding, content } } of the files kept for the host.
export function uiFilesOf(manifest, files) {
  const out = {};
  let total = 0;
  for (const path of uiPathsOf(manifest)) {
    const f = files[path];
    if (!f) throw new Error("the sandboxed-web view names " + path + ", which is not a file of the package");
    total += f.encoding === "base64" ? Math.floor(f.content.length * 3 / 4) : Buffer.byteLength(f.content);
    out[path] = f;
  }
  if (total > MAX_UI_BYTES) throw new Error("the sandboxed-web files are larger than " + MAX_UI_BYTES + " bytes");
  return out;
}
