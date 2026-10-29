// Estampes visual protocol 1 ("estampes.visual/1"): one JSON document for
// everything on a canvas, independent of ChatGPT and of any subject. Images
// are referenced by content hash, every coordinate is normalized to its own
// image (top-left origin), marks say who made them and how sure that is,
// layers carry order/lock/opacity, and links pair marks across two images.
// The same document comes out of get_visual_state, /api/v1/canvas and the
// storage folder's canvas.json can be rebuilt from it; it can be attached
// back as a marks file. See docs/PROTOCOL-V1.md.
import { canvasMarks, canvasLayers, pairLinks } from "./canvas-state.js";

export const VISUAL_PROTOCOL = "estampes.visual/1";
export const COORDINATES = "normalized-top-left";

const geometryOf = (m) => m.type === "point" ? { x: m.x, y: m.y }
  : m.type === "polyline" ? { points: m.points, ...(m.smooth ? { smooth: true } : {}), ...(m.closed ? { closed: true } : {}), bbox: [m.x, m.y, m.x2, m.y2] }
  : { x: m.x, y: m.y, x2: m.x2, y2: m.y2 };

const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function protocolMark(m, image) {
  const style = defined({ color: m.color, size: m.size, pen: m.pen });
  const finding = defined({ note: m.note, status: m.status });
  return defined({
    id: m.id, image, type: m.type, geometry: geometryOf(m), label: m.label, layer: m.layer,
    style: Object.keys(style).length ? style : undefined,
    finding: Object.keys(finding).length ? finding : undefined,
    // author: who drew it; grounding: how it was placed (user-pointer = the
    // user pointed; unverified = a model's coordinates; replayed-unverified =
    // re-sent without proof; scene-anchor = a known demo landmark).
    provenance: defined({ author: m.author, grounding: m.grounding, editedByUser: m.edited ? true : undefined }),
  });
}

const imageInfo = (entry, role) => defined({
  id: entry.imageId, role, width: entry.width, height: entry.height, source: entry.source,
  fileName: entry.fileName ?? undefined, original: entry.original,
});

// One image, or a left/right pair. `history` is optional (storage only).
export function canvasDocument(left, right = null, { history } = {}) {
  const sides = right ? [["left", left], ["right", right]] : [["single", left]];
  const layers = [], marks = [];
  for (const [role, entry] of sides) {
    canvasLayers(entry).forEach((l, order) => layers.push(defined({
      id: l.id, image: entry.imageId, author: l.author, name: l.name, order, count: l.count,
      locked: l.locked ? true : undefined, opacity: l.opacity,
    })));
    marks.push(...canvasMarks(entry).map((m) => protocolMark(m, entry.imageId)));
  }
  const links = right ? pairLinks(left, right).map((l) => defined({
    id: l.id, from: { image: left.imageId, mark: l.left }, to: { image: right.imageId, mark: l.right },
    label: l.label, note: l.note, confidence: l.confidence, review: l.review, author: l.author,
  })) : [];
  return defined({
    protocol: VISUAL_PROTOCOL, coordinateSystem: COORDINATES,
    images: sides.map(([role, entry]) => imageInfo(entry, role)),
    layers, marks, links, history,
  });
}

// A protocol document → flat marks for one image (for marks-file import).
// The caller validates every mark, as with any other untrusted file.
export function marksFromDocument(doc, { width, height } = {}) {
  if (doc?.protocol !== VISUAL_PROTOCOL || !Array.isArray(doc.images) || !Array.isArray(doc.marks)) {
    throw new Error("Not an " + VISUAL_PROTOCOL + " document");
  }
  // Pick the image with the same aspect ratio as the one being shown.
  const image = doc.images.find((i) => width && height && Math.abs(i.width / i.height - width / height) < 0.01) ?? doc.images[0];
  if (!image) throw new Error("The document has no images");
  const marks = doc.marks.filter((m) => m?.image === image.id).map((m) => {
    const g = m.geometry ?? {};
    const box = Array.isArray(g.bbox) ? { x: g.bbox[0], y: g.bbox[1], x2: g.bbox[2], y2: g.bbox[3] } : {};
    return defined({
      id: m.id, type: m.type, ...box, x: g.x ?? box.x, y: g.y ?? box.y, x2: g.x2 ?? box.x2, y2: g.y2 ?? box.y2,
      points: g.points, smooth: g.smooth, closed: g.closed, label: m.label, layer: m.layer,
      ...(m.style ?? {}), ...(m.finding ?? {}), author: m.provenance?.author,
    });
  });
  const layers = (doc.layers ?? []).filter((l) => l?.image === image.id).map((l) => ({ id: l.id, author: l.author, name: l.name }));
  return { imageId: image.id, width: Number(image.width), height: Number(image.height), marks, layers };
}
