// .estampes bundles: a workspace you can carry to another server or device
// and keep editing. A bundle is a ZIP with
//
//   manifest.json          format, generator, totals, and the sha256 and size of every other file
//   workspace.json         items, placement, names (estampes.workspace/1 shape, no secrets)
//   assets/<hash>.<ext>    the image bytes of every item (the original file when the server
//                          still has it, else the working copy as PNG; see manifest `assets`)
//   sets/<n>.json          one annotation set: layers, marks, links, rejected claims, objects
//   surface.json           (optional) the Visual Surface: open panels and one layout per device profile
//   notebooks/<n>.json     (optional) calculator notebooks the surface shows: definitions, cells, Graph links
//
// Marks, layers, claims and links are copied as they are: nothing is
// flattened, re-recognised or re-numbered, so every mark stays selectable and
// editable on the other side. It holds no access key, signed link, chat
// content or URL. Hashes protect against damage; they do not prove who made
// the bundle. Import checks the format, every hash and size, rejects unsafe
// paths and oversized content, validates each mark, and never overwrites:
// canvases that already have different marks get an independent copy.
import { createHash } from "node:crypto";
import sharp from "sharp";
import { zipFiles, unzipFiles } from "./zip.js";
import { canvasMarks, canvasLayers, setKeyOf } from "./canvas-state.js";
import { MARK_TYPES, MAX_POLYLINE_POINTS, MARK_STATUSES, MARK_COLORS, MARK_SIZES, MARK_PENS } from "./scene-catalog.js";
import { entrySharp } from "./image-store.js";
import { serializeCanvas, intakeImage, ensureImage, readSource, saveCanvas, restoreCanvas } from "./storage.js";
import { MODULE_ID } from "./modules/manifest.js";
import { resolveRef, workspaceItems, inspectWorkspace, forkFromData, adoptWorkspace, MAX_ITEMS, WORKSPACE_PROTOCOL, assetInfo, ensureSet } from "./workspace.js";

export const BUNDLE_FORMAT = "estampes.bundle/1";
const MAX_MARKS_PER_SET = 5000, MAX_LAYERS = 200, MAX_LINKS = 5000, MAX_NOTEBOOKS = 20;
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const json = (v) => Buffer.from(JSON.stringify(v, null, 1));
const EXT = { jpeg: "jpg", jpg: "jpg", png: "png", webp: "webp", gif: "gif", tiff: "tif", heif: "heic", avif: "avif" };
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ---- Export ----------------------------------------------------------------
export async function exportBundle(ref, { version = "dev", fileNames = true, extras = null } = {}) {
  const { doc } = await resolveRef(ref);
  const items = await workspaceItems(doc);
  if (!items.length) throw new Error("This workspace has no images to export");
  const files = [], listed = [], assets = [], warnings = [];
  const add = (name, data, store) => { files.push({ name, data, store }); listed.push({ path: name, sha256: sha(data), bytes: data.length }); };
  const done = new Map();
  for (const { entry } of items) {
    if (done.has(entry.imageId)) continue;
    const info = await assetInfo(entry);
    let bytes = await readSource(entry.imageId), sourceIncluded = !!bytes;
    if (!bytes) {
      bytes = await entrySharp(entry).png().toBuffer();
      warnings.push("The original file of " + entry.imageId + " is not stored on this server; its working copy (same orientation, long side up to " + Math.max(entry.width, entry.height) + " px) is included as PNG.");
    }
    let format = "bin";
    try { format = (await sharp(bytes).metadata()).format; } catch {}
    const name = "assets/" + entry.imageId.slice(4) + "." + (EXT[format] ?? "img");
    add(name, bytes, true);
    done.set(entry.imageId, name);
    assets.push(defined({
      id: entry.imageId, file: name, sha256: sha(bytes), bytes: bytes.length, sourceIncluded, mime: format === "bin" ? undefined : "image/" + (format === "jpg" ? "jpeg" : format),
      width: entry.width, height: entry.height, source: entry.source, fileName: fileNames ? entry.fileName ?? undefined : undefined,
      original: entry.original, sourceAssetId: info.sourceAssetId, page: info.page,
    }));
  }
  const setKeys = [...new Set(doc.items.map((it) => it.set))];
  const sets = [];
  for (const [n, key] of setKeys.entries()) {
    const entry = items.find((it) => it.item.set === key).entry;
    const { savedAt: _s, userEdits: _u, ...canvas } = serializeCanvas(entry);
    const body = { key, ...canvas, marks: canvasMarks(entry), layers: canvasLayers(entry).map(({ count: _c, ...l }) => l).concat(
      (entry.layers ?? []).filter((l) => !canvasLayers(entry).some((x) => x.id === l.id))) };
    add("sets/" + (n + 1) + ".json", json(body));
    sets.push({ key, file: "sets/" + (n + 1) + ".json", asset: entry.imageId, marks: body.marks.length });
  }
  const workspace = defined({
    protocol: WORKSPACE_PROTOCOL, name: doc.name, layout: doc.layout, legacy: doc.legacy,
    items: doc.items.map((it) => defined({ id: it.id, asset: it.asset, set: it.set, label: it.label, placement: it.placement })),
  });
  add("workspace.json", json(workspace));
  // Optional extras: the surface and calculator notebooks, as data. The caller
  // owns where they live; the bundle only carries them.
  const extraInfo = {};
  if (extras?.surface) { add("surface.json", json(extras.surface)); extraInfo.surface = "surface.json"; }
  const books = (extras?.notebooks ?? []).slice(0, MAX_NOTEBOOKS);
  if (books.length) {
    extraInfo.notebooks = books.map((nb, n) => { add("notebooks/" + (n + 1) + ".json", json(nb)); return { id: nb.id, file: "notebooks/" + (n + 1) + ".json", cells: nb.cells?.length ?? 0 }; });
  }
  const check = await inspectWorkspace(doc);
  const bundleId = sha(Buffer.from(listed.map((f) => f.path + ":" + f.sha256).sort().join("\n"))).slice(0, 16);
  const manifest = {
    format: BUNDLE_FORMAT, bundleId, generator: "Estampes " + version, createdAt: new Date().toISOString(),
    requires: [WORKSPACE_PROTOCOL, "estampes.visual/2"],
    workspace: { name: doc.name, ...check.totals }, assets, sets, ...(Object.keys(extraInfo).length ? { extras: extraInfo } : {}), files: listed,
    notes: "Marks, layers, claims and links are stored as data, not drawn into the images. Contains no access key, link or chat content.",
  };
  const buffer = zipFiles([{ name: "manifest.json", data: json(manifest) }, ...files]);
  return { buffer, manifest, warnings, fileName: "estampes-" + bundleId + ".estampes" };
}

// ---- Import ------------------------------------------------------------------
const text = (v, max) => typeof v === "string" ? v.slice(0, max) : undefined;
const num01 = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const MARK_TEXT = { label: 64, note: 200, reviewReason: 200 };
const PASS = ["confidence", "evidence", "ambiguities", "review", "previouslyRejected", "derivedFrom", "object", "edited", "grounding",
  "strokeOrder", "relativeStartMs", "relativeEndMs", "pointerType", "role"];

// One mark, whitelisted and checked; null with a reason when it cannot be kept.
function cleanMark(m) {
  if (!m || typeof m !== "object" || typeof m.id !== "string" || !m.id || m.id.length > 64) return { why: "missing id" };
  if (!MARK_TYPES.includes(m.type)) return { why: "unknown mark type " + JSON.stringify(String(m.type).slice(0, 20)) };
  // A polyline is its points; the other types carry corner coordinates.
  const out = { id: m.id, type: m.type };
  if (m.type !== "polyline") {
    if (![m.x, m.y].every(num01) || (m.type !== "point" && ![m.x2, m.y2].every(num01))) return { why: "coordinates outside 0..1" };
    out.x = m.x; out.y = m.y;
    if (m.type !== "point") { out.x2 = m.x2; out.y2 = m.y2; }
  }
  if (m.type === "polyline") {
    if (!Array.isArray(m.points) || m.points.length < 2 || m.points.length > MAX_POLYLINE_POINTS || !m.points.every((p) => p && num01(p.x) && num01(p.y))) return { why: "bad polyline points" };
    out.points = m.points.map((p) => ({ x: p.x, y: p.y }));
    if (m.smooth === true) out.smooth = true;
    if (m.closed === true) out.closed = true;
  }
  for (const [k, max] of Object.entries(MARK_TEXT)) if (typeof m[k] === "string") out[k] = text(m[k], max);
  if (MARK_STATUSES.includes(m.status)) out.status = m.status;
  if (MARK_COLORS.includes(m.color)) out.color = m.color;
  if (MARK_SIZES.includes(m.size)) out.size = m.size;
  if (MARK_PENS.includes(m.pen)) out.pen = m.pen;
  out.author = m.author === "user" ? "user" : "assistant";
  if (typeof m.layer === "string" && /^L\d{1,6}$/.test(m.layer)) out.layer = m.layer;
  for (const k of PASS) if (m[k] !== undefined && !(k in out)) out[k] = m[k];
  return { mark: out };
}

function cleanSet(raw, where, warnings) {
  if (!raw || typeof raw !== "object" || typeof raw.key !== "string") throw new Error(where + ": not an annotation set");
  if (!Array.isArray(raw.marks) || raw.marks.length > MAX_MARKS_PER_SET) throw new Error(where + ": too many or malformed marks");
  const marks = [], unsupported = [], seen = new Set();
  for (const m of raw.marks) {
    const { mark, why } = cleanMark(m);
    if (!mark || seen.has(mark.id)) { unsupported.push({ id: m?.id, why: why ?? "duplicate id" }); continue; }
    seen.add(mark.id); marks.push(mark);
  }
  if (unsupported.length) warnings.push(where + ": " + unsupported.length + " mark(s) were not imported (" + unsupported.slice(0, 3).map((u) => u.id + ": " + u.why).join("; ") + ")");
  const layers = (Array.isArray(raw.layers) ? raw.layers : []).filter((l) => /^L\d{1,6}$/.test(l?.id) && ["user", "assistant"].includes(l.author)).slice(0, MAX_LAYERS)
    .map((l) => defined({ id: l.id, author: l.author, name: text(l.name, 40) || l.id, locked: l.locked === true ? true : undefined,
      visible: l.visible === false ? false : undefined,
      opacity: typeof l.opacity === "number" && l.opacity >= 0 && l.opacity <= 1 ? l.opacity : undefined,
      // The module a layer belongs to (scene objects a module made live in
      // it). Kept so an imported Graph is the same as the exported one.
      module: typeof l.module === "string" && MODULE_ID.test(l.module) ? l.module : undefined }));
  let links = 0;
  const linkMap = {};
  for (const [k, list] of Object.entries(raw.links && typeof raw.links === "object" ? raw.links : {})) {
    if (!Array.isArray(list)) continue;
    linkMap[k] = list.filter((l) => l && typeof l.id === "string" && typeof l.left === "string" && typeof l.right === "string").slice(0, MAX_LINKS)
      .map((l) => defined({ id: l.id.slice(0, 64), left: l.left, right: l.right, label: text(l.label, 64), note: text(l.note, 200),
        confidence: ["high", "medium", "low"].includes(l.confidence) ? l.confidence : "medium", evidence: l.evidence, ambiguities: l.ambiguities,
        review: ["confirmed", "rejected"].includes(l.review) ? l.review : undefined, reviewReason: text(l.reviewReason, 200),
        author: l.author === "user" ? "user" : "assistant", previouslyRejected: l.previouslyRejected, derivedFrom: l.derivedFrom,
        confirmedGeometry: l.review === "confirmed" && l.confirmedGeometry && typeof l.confirmedGeometry.left === "string" && typeof l.confirmedGeometry.right === "string" ? { left: l.confirmedGeometry.left.slice(0, 20000), right: l.confirmedGeometry.right.slice(0, 20000) } : undefined }));
    links += linkMap[k].length;
  }
  return {
    key: raw.key, imageId: raw.imageId, marks, layers, links: linkMap, linkCount: links,
    rejections: Array.isArray(raw.rejections) ? raw.rejections.filter((r) => r && typeof r.kind === "string" && r.from).slice(0, 200) : [],
    gestureDecisions: Array.isArray(raw.gestureDecisions) ? raw.gestureDecisions.filter((d) => d && Array.isArray(d.memberIds) && typeof d.verdict === "string").slice(0, 100) : [],
    objects: Array.isArray(raw.objects) ? raw.objects.slice(0, 500) : undefined,
    sceneRevision: Number.isInteger(raw.sceneRevision) ? raw.sceneRevision : undefined, objectSeq: Number.isInteger(raw.objectSeq) ? raw.objectSeq : undefined, derivedFrom: raw.derivedFrom && typeof raw.derivedFrom === "object" ? raw.derivedFrom : undefined, unsupported,
  };
}

// Key order inside an object does not change its meaning, so scene objects
// and links compare in canonical form (sorted keys, ids in order).
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])])) : value;
const canonicalById = (list) => JSON.stringify(canonical([...(list ?? [])].sort((x, y) => String(x?.id) < String(y?.id) ? -1 : 1)));
// Scene objects (Graph axes, plots, shapes) as they would be exported.
const objectsOf = (entry) => canonicalById(serializeCanvas(entry).objects ?? []);
const bundleObjects = (def) => canonicalById(def.objects ?? []);
// Links compare by what they say (which marks they join and how), not by
// the other set's key, which an import may rename.
const LINK_FIELDS = ["id", "left", "right", "label", "note", "confidence", "review", "reviewReason", "author"];
const linkSig = (l) => JSON.stringify(LINK_FIELDS.map((f) => l?.[f] ?? null));
const linkSigs = (lists) => JSON.stringify(lists.flatMap((list) => [...list].map(linkSig)).sort());
// The same persisted state: marks, layer settings, claims and decisions,
// scene objects, and the links' content.
const sameState = (entry, def) => canonicalById(canvasMarks(entry)) === canonicalById(def.marks)
  && canonicalById(entry.layers ?? []) === canonicalById(def.layers)
  && JSON.stringify(entry.rejections ?? []) === JSON.stringify(def.rejections)
  && JSON.stringify(entry.gestureDecisions ?? []) === JSON.stringify(def.gestureDecisions)
  && objectsOf(entry) === bundleObjects(def)
  && linkSigs([...(entry.pairLinks ?? new Map()).values()].map((m) => [...m.values()])) === linkSigs(Object.values(def.links));

export async function importBundle(buffer, { name, collision = "reuse", allowPartial = false } = {}) {
  if (!["reuse", "copy"].includes(collision)) throw new Error("collision must be reuse or copy");
  const files = unzipFiles(buffer);
  const parse = (file) => {
    const data = files.get(file);
    if (!data) throw new Error("Not a valid .estampes bundle: " + file + " is missing");
    try { return JSON.parse(data.toString("utf8")); } catch { throw new Error("Not a valid .estampes bundle: " + file + " is not valid JSON"); }
  };
  const manifest = parse("manifest.json");
  if (typeof manifest.format !== "string" || !manifest.format.startsWith("estampes.bundle/")) throw new Error("Not an Estampes bundle (format " + JSON.stringify(manifest.format) + ")");
  if (manifest.format !== BUNDLE_FORMAT) throw new Error("This bundle uses " + manifest.format + "; this server reads " + BUNDLE_FORMAT + ". Update Estampes or export it again from a compatible version.");
  if (!Array.isArray(manifest.files)) throw new Error("Not a valid .estampes bundle: the manifest lists no files");
  // Every listed file is present, the right size and the right hash.
  for (const f of manifest.files) {
    const data = files.get(f?.path);
    if (!data) throw new Error("Bundle is incomplete: " + f?.path + " is missing");
    if (data.length !== f.bytes || sha(data) !== f.sha256) throw new Error("Bundle is damaged or was changed: " + f.path + " does not match its checksum");
  }
  const unlisted = [...files.keys()].filter((n) => n !== "manifest.json" && !manifest.files.some((f) => f.path === n));
  const warnings = unlisted.length ? ["Ignored " + unlisted.length + " file(s) not listed in the manifest: " + unlisted.slice(0, 3).join(", ")] : [];
  const ws = parse("workspace.json");
  if (ws.protocol !== WORKSPACE_PROTOCOL) throw new Error("This bundle's workspace uses " + ws.protocol + "; this server reads " + WORKSPACE_PROTOCOL);
  if (!Array.isArray(ws.items) || !ws.items.length || ws.items.length > MAX_ITEMS) throw new Error("The bundle's workspace has no items or too many (max " + MAX_ITEMS + ")");

  const setDefs = new Map();
  for (const s of Array.isArray(manifest.sets) ? manifest.sets : []) {
    const c = cleanSet(parse(s.file), s.file, warnings);
    setDefs.set(c.key, c);
  }
  const used = new Set(ws.items.map((it) => it.set));
  for (const key of used) if (!setDefs.has(key)) throw new Error("Bundle is incomplete: no annotation set for " + key);

  // All-or-nothing by default: refuse before anything is created when marks
  // would be dropped or the manifest's own totals disagree with the content.
  const assetIds = new Set((Array.isArray(manifest.assets) ? manifest.assets : []).map((a) => a?.id));
  for (const key of used) { const img = setDefs.get(key).imageId ?? key.split("#")[0]; if (!assetIds.has(img)) throw new Error("Bundle set " + key + " refers to an image that is not in the bundle"); }
  if (!allowPartial) {
    const dropped = [...used].flatMap((k) => setDefs.get(k).unsupported.map((u) => k + " " + u.id + ": " + u.why));
    if (dropped.length) throw new Error("Bundle not imported: " + dropped.length + " mark(s) are invalid (" + dropped.slice(0, 3).join("; ") + "). Nothing was created. Pass allowPartial:true to import the valid rest.");
    const ex = manifest.workspace ?? {};
    const sum = (f) => ws.items.reduce((n, it) => n + f(setDefs.get(it.set)), 0);
    const actual = { items: ws.items.length, marks: sum((d) => d.marks.length), userMarks: sum((d) => d.marks.filter((m) => m.author === "user").length) };
    const off = Object.keys(actual).filter((k) => typeof ex[k] === "number" && ex[k] !== actual[k]);
    if (off.length) throw new Error("Bundle not imported: its manifest says " + off.map((k) => k + " " + ex[k]).join(", ") + " but the content has " + off.map((k) => actual[k]).join(", ") + ". Nothing was created. Pass allowPartial:true to import anyway.");
  }

  // Images: registered under the id this server derives from the bytes.
  const idMap = new Map(), entries = new Map();
  for (const a of Array.isArray(manifest.assets) ? manifest.assets : []) {
    const bytes = files.get(a?.file);
    if (!bytes || !/^img:[0-9a-f]{16}$/.test(a.id)) throw new Error("Bundle asset " + JSON.stringify(a?.id) + " is malformed");
    const entry = await intakeImage(bytes, { source: "bundle", fileName: typeof a.fileName === "string" ? a.fileName.slice(0, 120) : null });
    if (a.width && (entry.width !== a.width || entry.height !== a.height)) warnings.push("Image " + a.id + " decodes to " + entry.width + "x" + entry.height + " here but was " + a.width + "x" + a.height + " there; normalized marks still line up if the shape is the same.");
    if (a.sourceAssetId && !entry.sourceAssetId) entry.sourceAssetId = a.sourceAssetId;
    if (a.page && !entry.page) entry.page = a.page;
    idMap.set(a.id, entry.imageId); entries.set(a.id, entry);
    if (!a.sourceIncluded) warnings.push("Image " + a.id + " came as a working copy, not the original file; it now has the id " + entry.imageId + ".");
  }
  // Sets: restore an image's own canvas when it is empty here, reuse it when
  // identical, otherwise make an independent copy. Copies stay copies.
  const keyMap = new Map(), touched = [], summary = [];
  // Empty means no marks, no layers and no scene objects: a canvas holding
  // only a Graph is not empty and is never overwritten by a restore.
  const fresh = (entry) => !canvasMarks(entry).length && !(entry.layers ?? []).length && !(serializeCanvas(entry).objects ?? []).length;
  for (const key of used) {
    const def = setDefs.get(key), image = idMap.get(def.imageId ?? key.split("#")[0]);
    if (!image) throw new Error("Bundle set " + key + " refers to an image that is not in the bundle");
    const base = await ensureImage(image);
    const data = { imageId: image, marks: def.marks, layers: def.layers, rejections: def.rejections, gestureDecisions: def.gestureDecisions,
      ...(def.objects !== undefined ? { objects: def.objects, sceneRevision: def.sceneRevision, objectSeq: def.objectSeq } : {}), links: {}, derivedFrom: def.derivedFrom };
    const own = !key.includes("#");
    let target, how;
    if (own && fresh(base)) { restoreCanvas(base, data); target = base; how = "restored"; }
    else if (own && collision === "reuse" && sameState(base, def)) { target = base; how = "reused"; }
    else { target = forkFromData(base, { ...data, derivedFrom: def.derivedFrom ?? (own ? { set: image, at: new Date().toISOString() } : undefined) }); how = "copied"; }
    keyMap.set(key, setKeyOf(target));
    touched.push({ target, def, how });
    summary.push({ key, becomes: setKeyOf(target), how, marks: def.marks.length });
  }
  // Links join sets by key; carry them over under the new keys, only between
  // marks that exist on both ends and only onto sets that were restored or copied.
  for (const { target, def, how } of touched) {
    if (how === "reused") continue;
    for (const [otherKey, list] of Object.entries(def.links)) {
      const to = keyMap.get(otherKey), other = touched.find((t) => setKeyOf(t.target) === to);
      if (!to || !other) continue;
      const store = (target.pairLinks ??= new Map()).get(to) ?? new Map();
      for (const l of list) if (def.marks.some((m) => m.id === l.left) && other.def.marks.some((m) => m.id === l.right)) store.set(l.id, l);
      if (store.size) target.pairLinks.set(to, store);
    }
  }
  const items = ws.items.map((it) => ({ asset: idMap.get(it.asset) ?? idMap.get(setDefs.get(it.set)?.imageId), set: keyMap.get(it.set), label: text(it.label, 40),
    placement: it.placement && typeof it.placement === "object" ? defined({ x: Number(it.placement.x), y: Number(it.placement.y), width: Number(it.placement.width), rotation: [0, 90, 180, 270].includes(it.placement.rotation) ? it.placement.rotation : 0 }) : undefined }));
  for (const it of items) if (!it.asset || !it.set) throw new Error("Bundle workspace item points at something that is not in the bundle");
  const sets = touched.filter((t) => t.how !== "reused" || false).map((t) => t.target);
  const adopted = await adoptWorkspace({ name: name || text(ws.name, 60), items, layout: ws.layout, provenance: { bundleId: manifest.bundleId, importedAt: new Date().toISOString(), format: manifest.format, generator: text(manifest.generator, 60) }, sets });
  if (adopted.repeated !== undefined || adopted.created === undefined) return { ...adopted, repeated: true, warnings, summary, manifest: { bundleId: manifest.bundleId } };
  for (const t of touched) if (t.how === "restored") await saveCanvas(t.target, { tool: "import_workspace_bundle", changed: [], note: "restored from bundle " + manifest.bundleId });
  const expected = manifest.workspace ?? {};
  const t = adopted.check.totals;
  const mismatch = ["items", "marks", "userMarks", "layerInstances", "links"].filter((k) => typeof expected[k] === "number" && expected[k] !== t[k]
    && !(k === "links" && summary.some((s) => s.how === "reused")));
  const unsupported = touched.flatMap((x) => x.def.unsupported);
  // Round trip of the scene: every set the workspace now points at must hold
  // the bundle's scene objects, whether it was restored, copied or reused.
  if (touched.some((x) => objectsOf(x.target) !== bundleObjects(x.def))) mismatch.push("objects");
  const verified = adopted.check.ok && !mismatch.length && !unsupported.length;
  // Surface and notebooks ride along as untrusted data; the server installs
  // them (see installBundleExtras) once the workspace exists.
  const extras = { surface: null, notebooks: [], imageIds: Object.fromEntries(idMap) };
  const ex = manifest.extras;
  if (ex && typeof ex === "object") {
    if (typeof ex.surface === "string" && files.has(ex.surface)) { try { extras.surface = parse(ex.surface); } catch { warnings.push("The surface in the bundle could not be read; it was left out."); } }
    for (const n of (Array.isArray(ex.notebooks) ? ex.notebooks : []).slice(0, MAX_NOTEBOOKS)) {
      if (typeof n?.file !== "string" || !files.has(n.file)) continue;
      try { extras.notebooks.push({ id: String(n.id), raw: parse(n.file) }); } catch { warnings.push("A calculator notebook in the bundle could not be read; it was left out."); }
    }
  }
  return { ...adopted, summary, warnings, mismatch, unsupported, verified, extras, manifest: { bundleId: manifest.bundleId, generator: manifest.generator } };
}
