// The canvas.json view of a UVA canvas document, and the exact difference that
// the document's structure does not carry.
//
// projectCanvas reads marks, layers, objects, gesture decisions, rejections and
// the background straight from the document's structure. Whatever that cannot
// reproduce byte for byte (archived legacy fields such as userEdits, a mark's
// role, a missing author) is kept as a small patch next to the document:
//
//   canvas = applyPatch(projectCanvas(document), patch)
//
// The writer checks that equation against the canvas hash before every commit,
// so a projection gap can never lose data: it only makes the patch bigger, and
// the size of the patch is reported.

const FINDING = ["note", "status", "confidence", "ambiguities", "review", "reviewReason", "previouslyRejected", "findingUpdatedAt"];
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const define = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
const canonical = (v) => JSON.stringify(sort(v));
function sort(v) {
  if (Array.isArray(v)) return v.map(sort);
  if (!isObject(v)) return v;
  const out = {};
  for (const k of Object.keys(v).sort()) define(out, k, sort(v[k]));
  return out;
}

export function projectCanvas(document, { unlayeredLayerId } = {}) {
  const scene = document.scenes[0], imageId = document.provenance.legacySetKey;
  const layerOf = (id) => (id === unlayeredLayerId ? {} : { layer: id });
  const layers = scene.layers.filter((l) => l.id !== unlayeredLayerId).map((l) => ({
    id: l.id, ...(l.author === "unknown" ? {} : { author: l.author }), ...(l.name === undefined ? {} : { name: l.name }),
    ...(l.module === undefined ? {} : { module: l.module }),
    // The canvas code only writes these once they are changed.
    ...(l.opacity === 1 ? {} : { opacity: l.opacity }), ...(l.visible ? {} : { visible: false }), ...(l.locked ? { locked: true } : {}),
  }));
  const marks = scene.annotations.map((a) => {
    const p = a.provenance, m = { id: a.id };
    if (p.author === "user" || p.author === "assistant") m.author = p.author;
    m.grounding = p.grounding; // the canvas code always writes it
    m.type = a.type;
    Object.assign(m, clone(a.geometry), layerOf(a.layerId));
    if (a.label !== undefined) m.label = a.label;
    Object.assign(m, clone(a.style));
    for (const k of FINDING) if (a.finding?.[k] !== undefined) m[k] = clone(a.finding[k]);
    if (a.finding?.evidence) m.evidence = a.finding.evidence.map((e) => clone(e.original));
    if (a.stroke?.order !== undefined) m.strokeOrder = a.stroke.order;
    for (const k of ["relativeStartMs", "relativeEndMs", "pointerType"]) if (a.stroke?.[k] !== undefined) m[k] = a.stroke[k];
    if (p.editedByUser) m.edited = true;
    return m;
  });
  const objects = scene.objects.map((o) => {
    const p = o.provenance, provenance = { author: p.author };
    if (p.createdBy?.kind === "module") { provenance.module = p.createdBy.moduleId; if (p.createdBy.version) provenance.moduleVersion = p.createdBy.version; }
    return { id: o.id, type: o.type, ...(o.label === undefined ? {} : { label: o.label }), props: clone(o.props), revision: o.revision,
      ...layerOf(o.layerId), visibility: o.visibility, provenance, ...(o.evidence === undefined ? {} : { evidence: clone(o.evidence) }) };
  });
  return {
    ...(scene.background.kind === "transparent" ? { baseAsObject: true } : {}),
    version: 1, imageId, width: scene.extent.width, height: scene.extent.height, marks, layers, links: {},
    ...(scene.rejections.length ? { rejections: clone(scene.rejections) } : {}),
    ...(scene.gestureDecisions.length ? { gestureDecisions: scene.gestureDecisions.map((g) => clone(g.original)) } : {}),
    ...(objects.length ? { objects } : {}),
  };
}

// A patch turns `base` into `target`. Shapes: undefined (equal), { v } (replace),
// { o, d } (object: patched keys, deleted keys), { ids, items } (array of
// records with unique string ids: new order, patched records).
const ids = (list) => {
  if (!Array.isArray(list) || !list.every((x) => isObject(x) && typeof x.id === "string")) return null;
  const out = list.map((x) => x.id);
  return new Set(out).size === out.length ? out : null;
};
export function diffJson(base, target) {
  if (canonical(base) === canonical(target)) return undefined;
  if (isObject(base) && isObject(target)) {
    const o = {}, d = Object.keys(base).filter((k) => !Object.hasOwn(target, k));
    for (const k of Object.keys(target)) {
      const p = Object.hasOwn(base, k) ? diffJson(base[k], target[k]) : { v: clone(target[k]) };
      if (p) define(o, k, p);
    }
    return { ...(Object.keys(o).length ? { o } : {}), ...(d.length ? { d } : {}) };
  }
  const a = ids(base), b = ids(target);
  if (a && b) {
    const byId = new Map(base.map((x) => [x.id, x])), items = {};
    for (const x of target) {
      const p = byId.has(x.id) ? diffJson(byId.get(x.id), x) : { v: clone(x) };
      if (p) define(items, x.id, p);
    }
    return { ...(a.join("\0") === b.join("\0") ? {} : { ids: b }), ...(Object.keys(items).length ? { items } : {}) };
  }
  return { v: clone(target) };
}
export function applyPatch(base, patch) {
  if (!patch) return clone(base);
  if (Object.hasOwn(patch, "v")) return clone(patch.v);
  if (patch.ids || patch.items) {
    const list = Array.isArray(base) ? base : [], byId = new Map(list.map((x) => [x.id, x]));
    return (patch.ids ?? list.map((x) => x.id)).map((id) => applyPatch(byId.get(id), patch.items?.[id]));
  }
  const out = clone(isObject(base) ? base : {});
  for (const k of Object.keys(patch.o ?? {})) define(out, k, applyPatch(out[k], patch.o[k]));
  for (const k of patch.d ?? []) delete out[k];
  return out;
}
