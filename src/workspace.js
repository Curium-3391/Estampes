// Workspaces (estampes.workspace/1): any number of images in one place.
//
// The pieces, from the bottom up:
//   asset           an image, by its content id (img:<hash>); bytes never change
//   annotation set  the marks, layers, links and rejected claims drawn on one
//                   asset. Every image has its own set, keyed by its imageId
//                   (what a single or paired canvas shows). A Copy makes a new
//                   set, keyed "<imageId>#c<hex>", that remembers where it came from.
//   workspace item  one set shown in one workspace, with where it sits
//   workspace       an ordered list of items, a name and a revision
//
// A workspace stores only references and placement. Marks stay in their set,
// normalized to their own image, so moving, resizing or re-arranging an item
// never touches a mark, and the same set can be shown in several workspaces
// (Link): an edit made in one shows in all of them. Merge, split, move, copy
// and detach only change workspace documents (and, for Copy, add sets); they
// never delete an image or a set. Every change can be previewed first, is
// checked against the revision it was planned on, can be retried with the
// same idempotency key without applying twice, and returns an undo token.
//
// A single canvas (imageId) or a paired view (imageId + pairImageId) is read
// as a workspace without converting anything (legacy adapter); a change that
// adds to one creates a new workspace that links its sets, and the original
// canvas keeps working as before.
import { canvasBackground } from "./visual/background.js";
import { randomBytes, createHash } from "node:crypto";
import { canvasMarks, canvasLayers, setKeyOf, workspaceLinks, linksOf, pairLinks } from "./canvas-state.js";
import {
  ensureImage, saveCanvas, readSet, readMeta, restoreCanvas, saveWorkspaceFiles, readWorkspaceFile, workspaceHistory, listWorkspaceFiles, SET_ID,
} from "./storage.js";
import { serializeObjects, restoreObjects } from "./scene/scene-ops.js";
import { protocolMark } from "./protocol.js";
import { verificationOf } from "./assessment.js";

export const WORKSPACE_PROTOCOL = "estampes.workspace/1";
export const MAX_ITEMS = 24;
export const WORKSPACE_ID = /^ws:[0-9a-f]{16}$/;
const IMAGE_ID = /^img:[0-9a-f]{16}$/;
const ITEM_ID = /^wi-\d{1,4}$/;
const NAME_MAX = 60, LABEL_MAX = 40, UNDO_KEEP = 10, KEYS_KEEP = 30, PREVIEW_TTL = 15 * 60000;
const ROTATIONS = [0, 90, 180, 270];

const workspaces = new Map();
const forks = new Map();
const previews = new Map();
const hex = (bytes) => randomBytes(bytes).toString("hex");
const now = () => new Date().toISOString();
const clone = (v) => structuredClone(v);

// One workspace change at a time: a plan and its commit never interleave
// with another change.
let chain = Promise.resolve();
const serial = (job) => { const next = chain.then(job, job); chain = next.catch(() => {}); return next; };

// ---- Annotation sets --------------------------------------------------------
// A copy shares the image's pixels (its prototype is the image entry) and
// owns everything that canvas-state keeps per canvas.
function makeFork(base, setId, data) {
  const fork = Object.create(base);
  Object.assign(fork, {
    baseAsObject:false, background: canvasBackground(base), markHistory:{past:[],future:[]}, textHistory:{past:[],future:[]}, layerHistory:{past:[],future:[]}, deletedObjectBatches:[], setId, setKey: base.imageId + "#" + setId, marks: new Map(), layers: [], userEdits: [], rejections: [],
    pairLinks: new Map(), gestureDecisions: [], objects: undefined, lastViews: undefined, lastCheck: undefined, derivedFrom: undefined,
  });
  if (data) restoreCanvas(fork, data);
  return fork;
}

export function parseSetKey(key) {
  const [imageId, setId, extra] = String(key ?? "").split("#");
  if (!IMAGE_ID.test(imageId) || extra !== undefined || (setId !== undefined && !SET_ID.test(setId))) {
    throw new Error("Not an annotation set: " + JSON.stringify(key) + " (an imageId, or imageId#c<hex> for a copy)");
  }
  return { imageId, setId };
}

// The entry holding a set's marks: the image itself, or a copy of its canvas.
export async function ensureSet(key) {
  const { imageId, setId } = parseSetKey(key);
  const base = await ensureImage(imageId);
  if (!setId) return base;
  let fork = forks.get(key);
  if (!fork) {
    const data = await readSet(imageId, setId);
    if (!data) throw new Error("Unknown annotation set " + key + " (copies live in memory unless server storage is on)");
    fork = makeFork(base, setId, data);
    forks.set(key, fork);
  } else if (Object.getPrototypeOf(fork) !== base) Object.setPrototypeOf(fork, base);
  return fork;
}

// A new set with the same marks, layers and rejected claims. Marks keep
// their ids (ids are per set) and say which set they were copied from.
function copySet(entry) {
  const setId = "c" + hex(6);
  const fork = makeFork(entry.setId ? Object.getPrototypeOf(entry) : entry, setId);
  const from = setKeyOf(entry);
  fork.marks = new Map(canvasMarks(entry).map((m) => [m.id, { ...clone(m), derivedFrom: { set: from, mark: m.id } }]));
  fork.baseAsObject=!!entry.baseAsObject;
  // The colour is copied, not inherited: the copy stays as it is when the original changes.
  fork.background = canvasBackground(entry);
  fork.layers = clone(entry.layers ?? []);
  fork.rejections = clone(entry.rejections ?? []);
  fork.gestureDecisions = clone(entry.gestureDecisions ?? []);
  if (entry.objects?.size) {
    restoreObjects(fork, clone(serializeObjects(entry)));
    fork.sceneRevision = entry.sceneRevision ?? 0; fork.objectSeq = entry.objectSeq ?? 0;
  }
  fork.derivedFrom = { set: from, at: now() };
  forks.set(fork.setKey, fork);
  return fork;
}

const setSummary = (entry) => {
  const marks = canvasMarks(entry);
  return { marks: marks.length, userMarks: marks.filter((m) => m.author === "user").length, layers: canvasLayers(entry).length };
};

// ---- Documents -------------------------------------------------------------
async function loadWorkspace(id) {
  if (!WORKSPACE_ID.test(id)) throw new Error("Not a workspace id: " + JSON.stringify(id));
  let doc = workspaces.get(id);
  if (!doc) {
    doc = await readWorkspaceFile(id);
    if (!doc) throw new Error("Unknown workspace " + id + " (workspaces live in memory unless server storage is on)");
    workspaces.set(id, doc);
  }
  if (doc.archived) throw new Error("Workspace " + id + " was removed by an undo; undo that again or create a new one");
  return doc;
}

// "ws:<hex>" a workspace; "img:<hex>" a single canvas; "img:<a>+img:<b>" a
// paired view (left + right). The latter two are read without conversion.
export async function resolveRef(ref) {
  const text = String(ref ?? "").trim();
  if (WORKSPACE_ID.test(text)) return { ref: text, doc: await loadWorkspace(text), legacy: false };
  const ids = text.split("+").map((s) => s.trim());
  if (!ids.length || ids.length > 2 || !ids.every((s) => IMAGE_ID.test(s))) {
    throw new Error("Not a workspace or canvas: " + JSON.stringify(ref) + " (use ws:<id>, an imageId, or imageId+pairImageId)");
  }
  if (ids[0] === ids[1]) throw new Error("A paired view needs two different images");
  return { ref: ids.join("+"), doc: await legacyWorkspace(ids[0], ids[1]), legacy: true };
}

// The legacy adapter: a single or paired canvas as a read-only workspace.
export async function legacyWorkspace(imageId, pairImageId) {
  const items = [{ id: "wi-1", asset: imageId, set: imageId }];
  if (pairImageId) items.push({ id: "wi-2", asset: pairImageId, set: pairImageId });
  for (const it of items) await ensureSet(it.set);
  const doc = { protocol: WORKSPACE_PROTOCOL, id: null, legacy: { imageId, ...(pairImageId ? { pairImageId } : {}) },
    name: pairImageId ? "對照 " + imageId + " + " + pairImageId : "畫布 " + imageId, revision: 0, layout: "auto", items, nextItem: items.length + 1 };
  await layoutAll(doc);
  return doc;
}

// Items with their set entries, in workspace order.
export async function workspaceItems(doc) {
  return Promise.all(doc.items.map(async (it) => ({ id: it.id, item: it, entry: await ensureSet(it.set) })));
}

// ---- Layout ------------------------------------------------------------------
// Workspace units: each image is `width` units wide (default 1000), its
// height follows its aspect ratio; rotation turns it in 90° steps around
// its top-left corner, which then sits at x, y. Auto layout fills rows of
// up to `cols` items; manual placement is kept.
const GAP = 60;
const extent = (it, entry) => {
  const w = it.placement.width, h = w * entry.height / entry.width;
  return it.placement.rotation % 180 ? { w: h, h: w } : { w, h };
};
async function layoutAll(doc) {
  const entries = await Promise.all(doc.items.map((it) => ensureSet(it.set)));
  const cols = doc.items.length <= 3 ? Math.max(1, doc.items.length) : Math.ceil(Math.sqrt(doc.items.length));
  let x = 0, y = 0, rowH = 0;
  doc.items.forEach((it, i) => {
    it.placement = { width: it.placement?.width ?? 1000, rotation: it.placement?.rotation ?? 0, x: 0, y: 0 };
    if (i && i % cols === 0) { x = 0; y += rowH + GAP; rowH = 0; }
    const e = extent(it, entries[i]);
    it.placement.x = Math.round(x); it.placement.y = Math.round(y);
    x += e.w + GAP; rowH = Math.max(rowH, e.h);
  });
}
async function placeAfter(doc, it) {
  const entries = await Promise.all(doc.items.map((i) => ensureSet(i.set)));
  const right = doc.items.reduce((m, i, n) => i === it ? m : Math.max(m, i.placement.x + extent(i, entries[n]).w), -GAP);
  it.placement = { x: Math.round(right + GAP), y: 0, width: it.placement?.width ?? 1000, rotation: it.placement?.rotation ?? 0 };
}

// ---- Validation --------------------------------------------------------------
// What a workspace holds, checked against its sets: every item's set loads,
// no set is shown twice, and the totals. Used after each change and by
// get_workspace_state.
export async function inspectWorkspace(doc) {
  const problems = [], items = [], seen = new Map();
  let marks = 0, layers = 0, userMarks = 0;
  for (const it of doc.items) {
    let entry;
    try { entry = await ensureSet(it.set); } catch (error) { problems.push(it.id + ": " + error.message); items.push({ id: it.id, set: it.set, ok: false }); continue; }
    if (seen.has(it.set)) problems.push(it.id + " shows the same canvas as " + seen.get(it.set));
    seen.set(it.set, it.id);
    const s = setSummary(entry);
    marks += s.marks; layers += s.layers; userMarks += s.userMarks;
    items.push({ id: it.id, asset: it.asset, set: it.set, ...s, ok: true });
  }
  const resolved = (await Promise.all(doc.items.map(async (it) => ({ id: it.id, entry: await ensureSet(it.set).catch(() => null) })))).filter((x) => x.entry);
  const links = workspaceLinks(resolved).length;
  return { ok: !problems.length, items, totals: { items: doc.items.length, marks, userMarks, layerInstances: layers, links }, problems };
}

// ---- Changes -----------------------------------------------------------------
const strip = (doc) => { const { undo: _u, keys: _k, ...rest } = doc; return clone(rest); };

function newDoc(name) {
  return { protocol: WORKSPACE_PROTOCOL, id: "ws:" + hex(8), name: cleanName(name) || "工作區", revision: 0, layout: "auto",
    createdAt: now(), updatedAt: now(), items: [], nextItem: 1, undo: [], keys: [] };
}
const cleanName = (s) => String(s ?? "").trim().slice(0, NAME_MAX);
const cleanLabel = (s) => String(s ?? "").trim().slice(0, LABEL_MAX);

function addItem(doc, { asset, set, label, placement }) {
  if (doc.items.length >= MAX_ITEMS) throw new Error("A workspace holds at most " + MAX_ITEMS + " images");
  const it = { id: "wi-" + doc.nextItem++, asset, set, ...(label ? { label: cleanLabel(label) } : {}),
    placement: { x: 0, y: 0, width: 1000, rotation: 0, ...(placement ?? {}) } };
  doc.items.push(it);
  return it;
}

// Write the changed documents and copied sets, remember how to undo, and
// remember the idempotency key. `before` maps id → document before (null
// for a workspace this change created).
async function commitDocs({ kind, before, after, sets = [], key, result }) {
  const token = "u-" + hex(6), at = now();
  if (result) result.undoToken = token;
  const record = { token, kind, at, before: [...before].map(([id, doc]) => ({ id, doc: doc ? strip(doc) : null })),
    after: after.map((d) => ({ id: d.id, revision: d.revision + 1 })) };
  const saved = after.map((doc) => ({ doc, revision: doc.revision, updatedAt: doc.updatedAt, undo: doc.undo, keys: doc.keys,
    held: workspaces.has(doc.id), prev: workspaces.get(doc.id), indexed: key ? keyIndex.get(key) : undefined }));
  for (const doc of after) {
    doc.revision += 1; doc.updatedAt = at;
    doc.undo = [...(doc.undo ?? []), record].slice(-UNDO_KEEP);
    if (key) { doc.keys = [...(doc.keys ?? []), { key, token, result }].slice(-KEYS_KEEP); keyIndex.set(key, doc.id); }
    workspaces.set(doc.id, doc);
  }
  try {
    // Copied sets first: a crash after them leaves only unreferenced copies.
    // The workspaces are then saved as one change (saveWorkspaceFiles): all
    // of them, or none.
    for (const entry of sets) await saveCanvas(entry, { tool: "workspace", changed: [], note: kind + " from " + entry.derivedFrom?.set });
    await saveWorkspaceFiles(after.map((doc) => ({ doc, line: { at, kind, token, revision: doc.revision, items: doc.items.length } })));
  } catch (error) {
    // Not saved: forget the change and its idempotency key, so a retry
    // with the same key runs again instead of being acknowledged unsaved.
    for (const r of saved) {
      Object.assign(r.doc, { revision: r.revision, updatedAt: r.updatedAt, undo: r.undo, keys: r.keys });
      if (r.held) workspaces.set(r.doc.id, r.prev); else workspaces.delete(r.doc.id);
      if (key) { if (r.indexed === undefined) keyIndex.delete(key); else keyIndex.set(key, r.indexed); }
    }
    throw error;
  }
  return { undoToken: token, revisions: Object.fromEntries(after.map((d) => [d.id, d.revision])) };
}

// A retried change: what it returned the first time, with the workspace as it is now.
async function repeat(prior) {
  const workspace = await loadWorkspace(prior.result.workspaceId);
  return { ...prior.result, repeated: true, workspace, check: await inspectWorkspace(workspace) };
}

function checkRevision(doc, expected, what = "workspace") {
  if (expected !== undefined && doc.revision !== expected) {
    throw new Error("The " + what + " " + doc.id + " changed (revision " + doc.revision + ", expected " + expected + "); read it again and retry");
  }
}
// Idempotency keys live on the documents a change wrote; this index finds
// the document again (after a restart, by reading the stored workspaces).
const keyIndex = new Map();
async function seenKey(docs, key) {
  if (!key) return undefined;
  const hit = docs.flatMap((d) => d?.keys ?? []).find((k) => k.key === key);
  if (hit) return hit;
  let id = keyIndex.get(key);
  if (!id) for (const d of await listWorkspaceFiles()) if ((d.keys ?? []).some((k) => k.key === key)) { id = d.id; break; }
  const doc = id && (workspaces.get(id) ?? await readWorkspaceFile(id));
  return doc?.keys?.find((k) => k.key === key);
}

export function createWorkspace({ name, items = [], key }) {
  return serial(async () => {
    const prior = await seenKey([], key);
    if (prior) return repeat(prior);
    const doc = newDoc(name);
    for (const it of items) {
      const entry = await ensureSet(it.set ?? it.asset);
      if (doc.items.some((x) => x.set === setKeyOf(entry))) continue;
      addItem(doc, { asset: entry.imageId, set: setKeyOf(entry), label: it.label });
    }
    await layoutAll(doc);
    doc.revision = -1;
    const result = { workspaceId: doc.id, created: true };
    const done = await commitDocs({ kind: "create", before: new Map([[doc.id, null]]), after: [doc], key, result });
    return { ...result, ...done, workspace: doc, check: await inspectWorkspace(doc) };
  });
}

// Add, detach, re-arrange or rename. Detaching removes the item from this
// workspace only: its image and its marks stay (and stay in other
// workspaces and in the image's own canvas).
export function editWorkspace(id, { add = [], remove = [], arrange = [], order, name, autoLayout = false, expectedRevision, key }) {
  return serial(async () => {
    const doc = await loadWorkspace(id);
    const prior = await seenKey([doc], key);
    if (prior) return repeat(prior);
    checkRevision(doc, expectedRevision);
    const before = strip(doc), next = clone(doc);
    const skipped = [];
    for (const r of remove) {
      const i = next.items.findIndex((it) => it.id === r);
      if (i < 0) throw new Error("remove: no item " + JSON.stringify(r) + " in " + id);
      next.items.splice(i, 1);
    }
    const added = [];
    for (const a of add) {
      const entry = await ensureSet(a.set ?? a.asset);
      const set = setKeyOf(entry), dup = next.items.find((it) => it.set === set);
      if (dup) { skipped.push({ set, reason: "already shown as " + dup.id }); continue; }
      const it = addItem(next, { asset: entry.imageId, set, label: a.label });
      if (next.layout !== "auto") await placeAfter(next, it);
      added.push(it.id);
    }
    for (const a of arrange) {
      const it = next.items.find((x) => x.id === a.item);
      if (!it) throw new Error("arrange: no item " + JSON.stringify(a.item) + " in " + id);
      if (a.label !== undefined) { const l = cleanLabel(a.label); if (l) it.label = l; else delete it.label; }
      const p = it.placement;
      if (a.x !== undefined || a.y !== undefined || a.width !== undefined || a.rotation !== undefined) {
        if (a.rotation !== undefined && !ROTATIONS.includes(a.rotation)) throw new Error("arrange: rotation must be 0, 90, 180 or 270");
        Object.assign(p, Object.fromEntries(Object.entries({ x: a.x, y: a.y, width: a.width, rotation: a.rotation }).filter(([, v]) => v !== undefined)));
        if (!(p.width >= 50 && p.width <= 20000)) throw new Error("arrange: width must be 50..20000 workspace units");
        if (a.x !== undefined || a.y !== undefined) next.layout = "manual";
      }
    }
    if (Array.isArray(order)) {
      if (new Set(order).size !== order.length || order.length !== next.items.length || order.some((o) => !next.items.some((it) => it.id === o))) {
        throw new Error("order must list every item id exactly once");
      }
      next.items = order.map((o) => next.items.find((it) => it.id === o));
    }
    if (name !== undefined) next.name = cleanName(name) || next.name;
    if (autoLayout) next.layout = "auto";
    if (next.layout === "auto") await layoutAll(next);
    const result = { workspaceId: id, added, removed: remove, skipped };
    const done = await commitDocs({ kind: "edit", before: new Map([[id, before]]), after: [next], key, result });
    return { ...result, ...done, workspace: next, check: await inspectWorkspace(next) };
  });
}

// ---- Transfer: merge, split, move, copy, link --------------------------------
// One primitive covers them all: take some items of a source (a workspace,
// or a single/paired canvas) and put them into a target (a workspace, a
// canvas, or a new workspace). mode link = show the same sets (shared
// edits); copy = new sets with the same marks (independent). removeFromSource
// turns it into a move (workspaces only; a canvas never loses its image).
// Items whose canvas the target already shows, or already holds a copy of,
// are skipped, so merging the same thing twice adds nothing.
async function planTransfer({ source, target, items, mode = "link", removeFromSource = false, name }) {
  if (!["link", "copy"].includes(mode)) throw new Error("mode must be link or copy");
  const src = await resolveRef(source);
  const tgt = target === "new" ? null : await resolveRef(target);
  if (tgt && tgt.ref === src.ref) throw new Error("source and target are the same");
  if (removeFromSource && src.legacy) throw new Error("removeFromSource needs a workspace as source; a single or paired canvas always keeps its images (use link or copy)");
  const pick = items?.length ? items.map((id) => {
    const it = src.doc.items.find((x) => x.id === id || x.asset === id || x.set === id);
    if (!it) throw new Error("items: " + JSON.stringify(id) + " is not an item of " + src.ref + " (items: " + src.doc.items.map((x) => x.id).join(", ") + ")");
    return it;
  }).filter((it, i, all) => all.indexOf(it) === i) : src.doc.items;
  const targetItems = tgt ? tgt.doc.items : [];
  const targetEntries = await Promise.all(targetItems.map((it) => ensureSet(it.set)));
  const add = [], skipped = [], warnings = [];
  for (const it of pick) {
    const entry = await ensureSet(it.set);
    const same = targetItems.find((t) => t.set === it.set);
    const copied = targetEntries.find((e) => e.derivedFrom?.set === it.set);
    if (mode === "link" && same) { skipped.push({ item: it.id, set: it.set, reason: "the target already shows this canvas as " + same.id }); continue; }
    if (mode === "copy" && copied) { skipped.push({ item: it.id, set: it.set, reason: "the target already holds a copy of this canvas (" + copied.setKey + ")" }); continue; }
    if (targetItems.length + add.length >= MAX_ITEMS) throw new Error("The target would hold more than " + MAX_ITEMS + " images");
    add.push({ from: it, entry, ...setSummary(entry) });
  }
  // Pages of one document shown from two different renders.
  const pageOf = (entry) => entry.page?.documentSha256 ? entry.page.documentSha256 + "#" + entry.page.pageIndex : null;
  const all = [...targetEntries, ...add.map((a) => a.entry)];
  for (const a of add) {
    const p = pageOf(a.entry);
    const other = p && all.find((e) => e !== a.entry && pageOf(e) === p && e.imageId !== a.entry.imageId);
    if (other) warnings.push("item " + a.from.id + " and " + other.imageId + " are two different renders of the same PDF page; their marks are not shared (re-anchor by hand if needed)");
  }
  // Links that come along: in link mode they are shared stores and simply
  // show; in copy mode those between two copied sets, or between a copied
  // set and a set the target already shows, are copied; others stay behind.
  const keys = new Set(add.map((a) => a.from.set)), targetKeys = new Set(targetItems.map((t) => t.set));
  let linksCarried = 0, linksLeft = 0;
  const seenLinks = new Set();
  for (const a of add) {
    for (const [otherKey] of a.entry.pairLinks ?? []) {
      const other = await ensureSet(otherKey).catch(() => null);
      if (!other) continue;
      const n = pairLinks(a.entry, other).length;
      if (!n) continue;
      if (keys.has(otherKey) || targetKeys.has(otherKey)) linksCarried += n; else linksLeft += n;
    }
    for (const t of targetEntries) if (!keys.has(setKeyOf(t)) && t.pairLinks?.has(a.from.set) && !seenLinks.has(setKeyOf(t))) {
      seenLinks.add(setKeyOf(t)); linksCarried += pairLinks(t, a.entry).length;
    }
  }
  const targetSummary = await Promise.all(targetEntries.map(async (e) => setSummary(e)));
  const sum = (list, k) => list.reduce((n, s) => n + s[k], 0);
  const plan = {
    mode, removeFromSource,
    source: { ref: src.ref, revision: src.doc.revision, items: src.doc.items.length },
    target: tgt ? { ref: tgt.ref, revision: tgt.doc.revision, items: targetItems.length, createsWorkspace: tgt.legacy } : { ref: "new", createsWorkspace: true },
    add: add.map((a) => ({ item: a.from.id, asset: a.from.asset, set: a.from.set, label: a.from.label, marks: a.marks, userMarks: a.userMarks, layers: a.layers,
      becomes: mode === "copy" ? "a new copy of this canvas" : "the same canvas (edits show in both places)" })),
    skipped, warnings,
    result: {
      items: targetItems.length + add.length,
      marks: sum(targetSummary, "marks") + sum(add, "marks"),
      userMarks: sum(targetSummary, "userMarks") + sum(add, "userMarks"),
      layerInstances: sum(targetSummary, "layers") + sum(add, "layers"),
    },
    links: { carried: linksCarried, ...(mode === "copy" ? { leftBehind: linksLeft } : {}) },
    sharedEditing: mode === "link" ? "Linked: a change to these marks here also shows in " + src.ref + " and anywhere else they are shown" : "Copied: the copies change independently of " + src.ref,
    sourceItemsAfter: removeFromSource ? src.doc.items.filter((it) => !pick.includes(it)).length : src.doc.items.length,
  };
  return { plan, src, tgt, pick, add, name };
}

// The fingerprint covers the workspaces' revisions and the marks, layers and
// links of every canvas involved, so a preview is refused if any of them changed.
async function stateOf({ src, tgt }) {
  const sets = [...new Set([...src.doc.items, ...(tgt ? tgt.doc.items : [])].map((it) => it.set))];
  const parts = [];
  for (const key of sets) {
    const e = await ensureSet(key);
    parts.push([key, canvasMarks(e), e.layers ?? [], [...(e.pairLinks ?? [])].map(([k, m]) => [k, [...m.values()]])]);
  }
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
}
const previewIdOf = (args, plan, state) => "p-" + createHash("sha256").update(JSON.stringify([args, plan.source.revision, plan.target.revision ?? null, state])).digest("hex").slice(0, 12);

export function previewTransfer(args) {
  return serial(async () => {
    const planned = await planTransfer(args);
    const { plan } = planned;
    const previewId = previewIdOf(args, plan, await stateOf(planned));
    previews.set(previewId, { args, at: Date.now() });
    for (const [id, p] of previews) if (Date.now() - p.at > PREVIEW_TTL) previews.delete(id);
    return { previewId, plan };
  });
}

// Commit a previewed transfer (previewId) or plan and commit in one step.
// A preview whose source or target changed since is refused.
export function commitTransfer({ previewId, key, ...direct }) {
  return serial(async () => {
    const saved = previewId ? previews.get(previewId) : null;
    if (previewId && !saved) throw new Error("Unknown or expired previewId " + previewId + "; preview again");
    const args = saved ? saved.args : direct;
    // A retry with a key already used returns that result, even though the
    // commit itself made the preview stale.
    const earlyDocs = (await Promise.all([args.source, args.target].filter((r) => r && r !== "new").map((r) => resolveRef(r).then((x) => x.doc, () => null)))).filter(Boolean);
    const early = await seenKey(earlyDocs, key);
    if (early) return repeat(early);
    const planned = await planTransfer(args);
    const { plan, src, tgt, pick, add } = planned;
    if (saved && previewIdOf(args, plan, await stateOf(planned)) !== previewId) throw new Error("The source or target changed since the preview; preview again");
    const docs = [src.legacy ? null : src.doc, tgt && !tgt.legacy ? tgt.doc : null].filter(Boolean);
    const prior = await seenKey(docs, key);
    if (prior) return repeat(prior);
    const before = new Map();
    // Target: an existing workspace, or a new one (that also shows the
    // target canvas's own images first when the target is a canvas).
    let target;
    // Work on copies: the live documents change only when everything worked.
    if (tgt && !tgt.legacy) { before.set(tgt.doc.id, strip(tgt.doc)); target = clone(tgt.doc); }
    else {
      target = newDoc(args.name || (tgt ? tgt.doc.name : src.doc.name + "（拆出）"));
      before.set(target.id, null);
      for (const it of tgt?.doc.items ?? []) addItem(target, { asset: it.asset, set: it.set, label: it.label });
    }
    const sets = [], idMap = [];
    const copies = new Map();
    for (const a of add) {
      let set = a.from.set;
      if (plan.mode === "copy") { const fork = copySet(a.entry); copies.set(a.from.set, fork); sets.push(fork); set = fork.setKey; }
      const it = addItem(target, { asset: a.from.asset, set, label: a.from.label });
      if (target.layout !== "auto") await placeAfter(target, it);
      idMap.push({ from: a.from.id, to: it.id, set });
    }
    if (plan.mode === "copy") {
      // Links between copied sets, and from a copied set to a set the
      // target shows, are copied onto the new sets.
      for (const [fromKey, fork] of copies) {
        const original = add.find((a) => a.from.set === fromKey).entry;
        for (const [otherKey] of original.pairLinks ?? []) {
          const toFork = copies.get(otherKey);
          const shown = target.items.some((it) => it.set === otherKey) && !copies.has(otherKey);
          if (!toFork && !shown) continue;
          const other = await ensureSet(otherKey);
          const list = pairLinks(original, other);
          const store = linksOf(fork, toFork ? toFork.setKey : otherKey);
          for (const l of list) store.set(l.id, { ...clone(l), derivedFrom: { set: fromKey, link: l.id } });
        }
        for (const it of target.items) {
          if (copies.has(it.set) || it.set === fork.setKey || [...copies.values()].some((f) => f.setKey === it.set)) continue;
          const shownEntry = await ensureSet(it.set);
          if (!shownEntry.pairLinks?.has(fromKey)) continue;
          const store = linksOf(shownEntry, fork.setKey);
          for (const l of pairLinks(shownEntry, original)) store.set(l.id, { ...clone(l), derivedFrom: { set: setKeyOf(shownEntry), link: l.id } });
          sets.push(shownEntry);
        }
      }
    }
    if (target.layout === "auto") await layoutAll(target);
    const after = [target];
    if (args.removeFromSource) {
      before.set(src.doc.id, strip(src.doc));
      const moved = new Set(pick.map((it) => it.id)), source = clone(src.doc);
      source.items = source.items.filter((it) => !moved.has(it.id));
      if (source.layout === "auto") await layoutAll(source);
      after.push(source);
    }
    if (before.get(target.id) === null) target.revision = -1;
    const check = await inspectWorkspace(target);
    const result = { workspaceId: target.id, created: before.get(target.id) === null, mode: plan.mode, itemMap: idMap, skipped: plan.skipped };
    const done = await commitDocs({ kind: plan.mode + (args.removeFromSource ? "-move" : ""), before, after, sets: [...new Set(sets)], key, result });
    Object.assign(result, done);
    // Planned and actual totals must agree; if not, say so instead of
    // claiming success (the change is kept so nothing is half-undone).
    const mismatch = ["items", "marks", "userMarks", "layerInstances"].filter((k) => check.totals[k] !== plan.result[k]);
    return { ...result, plan, check, verified: check.ok && !mismatch.length, ...(mismatch.length ? { mismatch } : {}), workspace: target };
  });
}

// Undo one change by its token: every workspace it touched goes back to how
// it was, and a workspace it created is archived. Refused if one of them
// changed again since (undo the later change first). Copied sets stay on
// disk, unreferenced; nothing is ever deleted.
export function undoChange(workspaceId, token) {
  return serial(async () => {
    const doc = await loadWorkspace(workspaceId).catch(async (error) => {
      const raw = workspaces.get(workspaceId) ?? await readWorkspaceFile(workspaceId);
      if (raw) return raw;
      throw error;
    });
    const record = (doc.undo ?? []).find((u) => u.token === token);
    if (!record) throw new Error("No change " + JSON.stringify(token) + " to undo on " + workspaceId + " (the last " + UNDO_KEEP + " are kept)");
    const current = new Map();
    for (const { id, revision } of record.after) {
      const d = workspaces.get(id) ?? await readWorkspaceFile(id);
      if (!d) continue;
      if (d.revision !== revision) throw new Error("Workspace " + id + " changed again after this (revision " + d.revision + "); undo the later change first");
      current.set(id, d);
    }
    const after = [], snapshot = new Map([...current].map(([id, d]) => [id, clone(d)]));
    for (const { id, doc: was } of record.before) {
      const d = current.get(id);
      if (!d) continue;
      const keep = { undo: (d.undo ?? []).filter((u) => u.token !== token), keys: d.keys ?? [], revision: d.revision };
      // Undoing restores the state an earlier change left behind, so that
      // change's record now expects the new revision.
      if (was) for (const u of keep.undo) for (const a of u.after) if (a.id === d.id && a.revision === was.revision) a.revision = d.revision + 1;
      if (was) { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, clone(was), keep); }
      else { d.archived = true; Object.assign(d, keep); }
      after.push(d);
    }
    const at = now();
    for (const d of after) { d.revision += 1; d.updatedAt = at; workspaces.set(d.id, d); }
    try {
      await saveWorkspaceFiles(after.map((d) => ({ doc: d, line: { at, kind: "undo", token, revision: d.revision } })));
    } catch (error) {
      // Not saved: none of the workspaces was written, so none is changed here either.
      for (const [id, d] of current) { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, snapshot.get(id)); }
      throw error;
    }
    return { undone: token, kind: record.kind, workspaces: after.map((d) => ({ id: d.id, revision: d.revision, ...(d.archived ? { archived: true } : {}) })) };
  });
}

// ---- The document ------------------------------------------------------------
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const listOrNone = (l) => Array.isArray(l) && l.length ? l : undefined;

export async function assetInfo(entry) {
  const meta = await readMeta(entry.imageId);
  return defined({
    id: entry.imageId, width: entry.width, height: entry.height, source: entry.source, fileName: entry.fileName ?? undefined,
    original: entry.original, sourceAssetId: entry.sourceAssetId ?? meta?.sourceAssetId, page: entry.page ?? meta?.page,
  });
}

// The whole workspace as one estampes.workspace/1 document: items with
// placement, the assets they show, each set's layers and marks (as in
// estampes.visual/2), links between items, rejected claims, and a check.
export async function workspaceDocument(doc, { history = 0 } = {}) {
  const items = await workspaceItems(doc);
  const assets = new Map(), sets = [];
  for (const { item, entry } of items) {
    if (!assets.has(entry.imageId)) assets.set(entry.imageId, await assetInfo(entry));
    sets.push(defined({
      key: item.set, asset: entry.imageId, derivedFrom: entry.derivedFrom,
      layers: canvasLayers(entry).map((l, order) => defined({ id: l.id, author: l.author, name: l.name, order, count: l.count, locked: l.locked ? true : undefined, visible: l.visible, opacity: l.opacity })),
      marks: canvasMarks(entry).map((m) => defined({ ...protocolMark(m, entry.imageId), derivedFrom: m.derivedFrom })),
      rejections: listOrNone(entry.rejections), objects: entry.objects?.size ? serializeObjects(entry) : undefined,
    }));
  }
  const links = workspaceLinks(items).map((l) => defined({
    id: l.id, from: { item: l.fromItem, mark: l.from }, to: { item: l.toItem, mark: l.to }, label: l.label, note: l.note,
    confidence: l.confidence, evidence: listOrNone(l.evidence), ambiguities: listOrNone(l.ambiguities),
    verification: defined({ state: verificationOf(l), reason: l.reviewReason }), review: l.review, author: l.author, derivedFrom: l.derivedFrom,
  }));
  return defined({
    protocol: WORKSPACE_PROTOCOL, coordinateSystem: "normalized-top-left", id: doc.id ?? undefined, legacy: doc.legacy,
    name: doc.name, revision: doc.revision, layout: doc.layout, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
    items: doc.items.map((it) => defined({ id: it.id, asset: it.asset, set: it.set, label: it.label, placement: it.placement })),
    assets: [...assets.values()], sets, links,
    layerBindings: items.map(({ item, entry }) => ({ item: item.id, set: item.set, layers: canvasLayers(entry).map((l) => l.id) })),
    undo: listOrNone((doc.undo ?? []).map((u) => ({ token: u.token, kind: u.kind, at: u.at }))),
    check: await inspectWorkspace(doc),
    history: history && doc.id ? await workspaceHistory(doc.id, history) : undefined,
  });
}

// A copy of a canvas made from stored data (a bundle import).
export function forkFromData(base, data) {
  const fork = makeFork(base, "c" + hex(6), { ...data, imageId: base.imageId });
  forks.set(fork.setKey, fork);
  return fork;
}

// A workspace made from a bundle: items already point at sets that exist.
// The bundle's id is kept as provenance so importing it again returns this
// workspace instead of making a second one.
export function adoptWorkspace({ name, items, layout, provenance, sets = [] }) {
  return serial(async () => {
    const known = await findByProvenance(provenance?.bundleId);
    if (known) return { ...(await repeat({ result: { workspaceId: known.id } })), workspaceId: known.id };
    const doc = newDoc(name);
    doc.layout = layout === "manual" ? "manual" : "auto";
    for (const it of items) addItem(doc, it);
    if (doc.layout === "auto") await layoutAll(doc);
    doc.provenance = provenance;
    doc.revision = -1;
    const result = { workspaceId: doc.id, created: true };
    const done = await commitDocs({ kind: "import", before: new Map([[doc.id, null]]), after: [doc], sets, result });
    return { ...result, ...done, workspace: doc, check: await inspectWorkspace(doc) };
  });
}
async function findByProvenance(bundleId) {
  if (!bundleId) return null;
  for (const d of workspaces.values()) if (!d.archived && d.provenance?.bundleId === bundleId) return d;
  for (const d of await listWorkspaceFiles()) if (!d.archived && d.provenance?.bundleId === bundleId) { workspaces.set(d.id, d); return d; }
  return null;
}

export const getWorkspace = (id) => loadWorkspace(id);
// Tests start from an empty registry.
export function clearWorkspaces() { workspaces.clear(); forks.clear(); previews.clear(); keyIndex.clear(); }
