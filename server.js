import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { valueToX } from "./src/geometry.js";
import {
  resolveSceneAnnotation, resolveCoordinateAnnotation, replayUserAnnotation, MARK_TYPES, MAX_POLYLINE_POINTS, MARK_STATUSES,
  MARK_COLORS, MARK_SIZES, MARK_PENS,
} from "./src/scene-catalog.js";
import { INTENTS, buildAnnotationEvent, formatAnnotationChatMessage } from "./src/interaction-protocol.js";
import { createVisualEvidence } from "./src/visual-input.js";
import {
  applyCanvasChanges, canvasMarks, canvasLayers, snapshotCanvas, storeUserMarks, importMarks,
  applyPairChanges, pairLinks, reviewLink, reviewFinding, LINK_CONFIDENCE, LINK_REVIEW, editCanvas, takeUserEdits, LAYER_NAME_MAX,
} from "./src/canvas-state.js";
import { CONFIDENCE, EVIDENCE_KINDS, evidenceCount, verificationOf, needsReview, rejectionText } from "./src/assessment.js";
import { renderVerification, inkReport } from "./src/mark-render.js";
import { exportMarksSvg, parseMarksFile } from "./src/marks-file.js";
import { downloadImage, entrySharp } from "./src/image-store.js";
import { config, configWarnings, log } from "./src/config.js";
import { VISUAL_PROTOCOL, canvasDocument } from "./src/protocol.js";
import { watchQuickTunnel } from "./src/tunnel.js";
import { resolveAccessKey, sameSecret, clientIp, exportSignature, exportAllowed } from "./src/security.js";
import { intakeImage, ensureImage, saveCanvas, saveDerived, checkStorage, flushStorage, sweepStorage, readHistory } from "./src/storage.js";
import { renderView, rememberView, findView, frameFromView, SAMPLING_MODES, OUTPUT_FORMATS, VIEW_API, MAX_DELIVERY_SIDE } from "./src/image/view.js";
import { scale as scaleMatrix, roundMatrix } from "./src/image/transform.js";
import {
  overlayGrid, previewImage, cellCenter, rowLabel, displayImage, compactForDisplay, regionTile,
} from "./src/image-ops.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
// package.json is the single source of truth for the release version.
// Widget HTML uses __ESTAMPES_VERSION__ and versioned ui:// URIs derive from
// it, so a release bump only touches package.json.
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const BUILD_VERSION = "m" + VERSION;
// Public origin for download links: PUBLIC_BASE_URL (Render sets
// RENDER_EXTERNAL_URL), else the origin the last /mcp request came in on,
// which covers Heroku, Docker behind a tunnel and other hosts with no env.
let seenOrigin = "", tunnelOrigin = "";
const publicUrl = () => config.publicUrl || tunnelOrigin || seenOrigin;
const URI_TAG = "v" + VERSION.replace(/\./g, "");
const WIDGET = "ui://estampes/number-line-v031.html";
const LEGACY_WIDGET = "ui://estampes/number-line.html";
const VISUAL_URI = "ui://estampes/visual-surface-" + URI_TAG + ".html";
const EVIDENCE_URI = "ui://estampes/visual-evidence-" + URI_TAG + ".html";
// Older URIs stay resolvable for saved ChatGPT conversations. They serve the
// current HTML on purpose: the host caches templates by URI, so a stale URI
// must still get a working widget, not a 404.
const LEGACY_VISUAL_URIS = ["v040","v041","v042","v043","v046","v047","v048","v050","v051","v052","v053","v054","v055","v056","v057","v058","v059","v060","v070","v071","v080"]
  .map(tag => "ui://estampes/visual-surface-" + tag + ".html")
  .filter(uri => uri !== VISUAL_URI);
const LEGACY_EVIDENCE_URIS = ["v045","v047","v048","v050","v051","v052","v053","v054","v055","v056","v057","v058","v059","v060","v070","v071","v080"]
  .map(tag => "ui://estampes/visual-evidence-" + tag + ".html")
  .filter(uri => uri !== EVIDENCE_URI);
const loadWidget = (file) =>
  readFileSync(join(ROOT, "public", file), "utf8").replaceAll("__ESTAMPES_VERSION__", VERSION);
const html = loadWidget("number-line.html");
const evidenceHtml = loadWidget("visual-evidence.html");
const visualHtml = loadWidget("visual-surface.html");
const SceneSchema = z.enum(["landscape", "shapes", "formula"]);
const Point01 = z.number().finite().min(0).max(1);

const PolylinePointsSchema = z.array(z.object({ x: Point01, y: Point01 }))
  .min(2).max(MAX_POLYLINE_POINTS);
const checkGeometry = (a, ctx) => {
  if (a.type === "polyline") {
    if (!a.points) ctx.addIssue({ code: "custom", message: "Polyline requires points" });
    return;
  }
  if (a.x === undefined || a.y === undefined) ctx.addIssue({ code: "custom", message: "x/y are required" });
  if (a.type !== "point" && (a.x2 === undefined || a.y2 === undefined)) {
    ctx.addIssue({ code: "custom", message: "Rect/arrow require x2/y2" });
  }
};

// Guaranteed geometry for renderer + user validation.
const VisualAnnotationSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(MARK_TYPES),
  x: Point01.optional(), y: Point01.optional(),
  x2: Point01.optional(), y2: Point01.optional(),
  points: PolylinePointsSchema.optional(),
  smooth: z.boolean().optional(),
  closed: z.boolean().optional(),
  label: z.string().max(64).optional(),
  note: z.string().max(200).optional().describe("Assistant's finding about this mark, shown beside it (e.g. the text, name or value you read there)"),
  status: z.enum(MARK_STATUSES).optional().describe("inspected = you looked at the pixels (process_image); uncertain = not confirmed"),
  role: z.enum(["focus", "context"]).optional(),
  color: z.enum(MARK_COLORS).optional(),
  size: z.enum(MARK_SIZES).optional(),
  pen: z.enum(MARK_PENS).optional(),
  author: z.enum(["user", "assistant"]).optional(),
  grounding: z.enum(["scene-anchor", "unverified", "replayed-unverified", "user-pointer"]).optional(),
  layer: z.string().max(12).optional(),
  side: z.enum(["left", "right"]).optional().describe("Paired view only: which image the mark is on"),
}).superRefine(checkGeometry);
const VisualAnnotationsSchema = z.array(VisualAnnotationSchema).max(30);

// Evidence the assistant gives for a claim (a note or a link). It is always
// recorded as the model's own observation; only a tool's or the user's
// evidence can make a claim verified.
const EvidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS.filter((k) => k !== "tool-result")).describe("text = words/numbers read there; position = where it sits relative to other things; shape = outline, size, colour; context = what surrounds it"),
  side: z.enum(["left", "right"]).optional().describe("Paired view: the image this evidence is on (default left)"),
  region: z.array(z.number().min(0).max(1)).length(4).optional().describe("[x, y, x2, y2] normalized to the FULL image (not coordinateFrame) where the clue is, so the user can zoom in and check it"),
  says: z.string().min(1).max(160).describe("What you see there, e.g. 'silkscreen reads IC502'"),
}).strict();
const ClaimFields = {
  confidence: z.enum(CONFIDENCE).optional().describe("Your own belief in the note or link. It only orders the user's review; it never makes a claim verified"),
  evidence: z.array(EvidenceSchema).max(6).optional().describe("Where on which image the claim is supported and what you see there; empty list clears"),
  ambiguities: z.array(z.string().max(120)).max(4).optional().describe("What is still unresolved, e.g. 'part number unreadable'"),
};

// Model-facing annotations use coordinates ONLY. Legacy semantic anchors
// are retained in scene-catalog.js for isolated geometry unit tests, but
// never exposed as an object-position catalog to the model.
// Model coordinates may be crop pixels when coordinateFrame is given; they
// are converted and then checked against 0..1 of the full image.
const ModelCoord = z.number().finite().min(0).max(100000);
const ModelAnnotationSchema = z.object({
  id: z.string().min(1).max(64).describe("Stable id; re-using an id edits that mark"),
  type: z.enum(MARK_TYPES),
  x: ModelCoord.optional(), y: ModelCoord.optional(),
  x2: ModelCoord.optional(), y2: ModelCoord.optional(),
  points: z.array(z.object({ x: ModelCoord, y: ModelCoord })).min(2).max(MAX_POLYLINE_POINTS).optional().describe("polyline only: ordered vertices, e.g. along a road, a wire, a crack, an outline or a freehand sketch"),
  smooth: z.boolean().optional().describe("polyline only: draw a smooth curve through the points (freehand look)"),
  closed: z.boolean().optional().describe("polyline only: join the last point to the first, e.g. to circle a part"),
  label: z.string().max(64).optional(),
  note: z.string().max(200).optional().describe("Your finding about this mark, shown beside it, e.g. a label, a reading or what the thing is"),
  status: z.enum(MARK_STATUSES).optional().describe("inspected only if you actually looked at these pixels (e.g. via process_image); otherwise uncertain or omit"),
  color: z.enum(MARK_COLORS).optional().describe("Default gold. Use different colours to tell several traces or groups apart"),
  size: z.enum(MARK_SIZES).optional().describe("Line thickness; default medium"),
  pen: z.enum(MARK_PENS).optional().describe("highlighter = wide translucent stroke that keeps the picture visible; use it to shade an area rather than draw a precise line"),
  author: z.literal("assistant").optional(),
  side: z.enum(["left", "right"]).optional().describe("Paired view only: the image this mark is on (default left); coordinates are normalized to that image"),
  ...ClaimFields,
}).strict().superRefine(checkGeometry);
const ModelAnnotationsSchema=z.array(ModelAnnotationSchema).max(12);
const LinkSchema = z.object({
  id: z.string().min(1).max(64).describe("Stable link id; re-using it edits the link"),
  left: z.string().min(1).max(64).describe("Id of the mark on the LEFT image"),
  right: z.string().min(1).max(64).describe("Id of the mark on the RIGHT image"),
  label: z.string().max(64).optional().describe("What both marks are, e.g. a part, a street, a room or a person's name"),
  note: z.string().max(200).optional().describe("Why they match, e.g. same shape, same position relative to a neighbour, same text"),
  confidence: z.enum(LINK_CONFIDENCE).optional().describe("How sure you are they are the same thing. Every unverified link goes to the user's review; confidence only orders it"),
  evidence: ClaimFields.evidence, ambiguities: ClaimFields.ambiguities,
}).strict();
const FindingSchema = z.object({
  id: z.string().min(1).max(64),
  note: z.string().max(200).optional().describe("Empty string clears the note"),
  status: z.enum(MARK_STATUSES).optional(),
  ...ClaimFields,
}).strict();

// M0.5 real-image schemas, shared by the image tools and present_visual.
// ChatGPT file param shape: only download_url and file_id are guaranteed.
const ChatFileSchema = z.object({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
}).strict();

async function readMarksFile(entry, file) {
  const data = parseMarksFile(await downloadImage(file.download_url), { width: entry.width, height: entry.height });
  if (data.width > 0 && data.height > 0 && Math.abs(data.width / data.height - entry.width / entry.height) > 0.01) {
    throw new Error("These marks were drawn on a " + data.width + "x" + data.height + " image; attach that image too");
  }
  const marks = data.marks.map((m) => {
    const parsed = VisualAnnotationSchema.safeParse(m);
    if (!parsed.success) throw new Error("Invalid mark in marks file: " + (m?.id ?? "?"));
    return { ...parsed.data, author: m.author === "user" ? "user" : "assistant" };
  });
  const layers = data.layers.filter((l) => /^L\d{1,6}$/.test(l?.id) && ["user", "assistant"].includes(l.author))
    .map((l) => ({ id: l.id, author: l.author, name: String(l.name ?? "").slice(0, 40) }));
  return { marks, options: { layers, replayUser: replayUserAnnotation, resolve: resolveCoordinateAnnotation } };
}

async function loadImageInput({ image, imageUrl }) {
  const bytes = await downloadImage(image ? image.download_url : imageUrl);
  return intakeImage(bytes, { source: image ? "chat-file" : "url", fileName: image?.file_name ?? null });
}
const RegionSchema = z.object({
  x: Point01, y: Point01, x2: Point01, y2: Point01,
}).describe("Normalized source-image box (top-left origin). Omit for the whole image.");
const ImageIdSchema = z.string().regex(/^img:[0-9a-f]{16}$/).describe("imageId returned by load_image");
const DerivedViewIdSchema = z.string().regex(/^dv:[0-9a-f]{16}$/).describe("derivedViewId returned by process_image");
// A coordinateFrame naming a derived view becomes that view's exact
// derived -> normalized matrix; the older region form passes through.
function resolveFrame(frame, left, right) {
  if (!frame?.derivedViewId) return frame;
  const entry = (frame.side ?? "left") === "right" ? right : left;
  const record = entry && findView(entry, frame.derivedViewId);
  if (!record) throw new Error("coordinateFrame.derivedViewId " + frame.derivedViewId + " is not a processed view of the " + (frame.side ?? "left") + " image; call process_image on that image first");
  return { ...frameFromView(record, frame.units), ...(frame.side ? { side: frame.side } : {}) };
}
const SamplingSchema = z.object({
  mode: z.enum(SAMPLING_MODES).default("preview").describe("preview (default, the old behaviour: resize to the output size first, then process), working (process the cached working copy at its own resolution), native (process pixels cut from the original file, beyond the 4096 px working copy; best for small text and fine lines)"),
  allowUpscale: z.boolean().optional().describe("working/native: enlarge small crops to the output size AFTER processing (interpolated, no new detail). Default false"),
  maxPixels: z.number().int().min(10000).max(200_000_000).optional().describe("Analysis budget for the crop; larger crops are reduced and the result says so"),
  alpha: z.enum(["flatten", "flatten-black", "keep"]).optional().describe("Transparent sources: flatten on white (default), on black, or keep alpha (native only)"),
}).describe("Resolution the operations run at (analysis resolution), separate from the delivered size");
const OutputSpecSchema = z.object({
  format: z.enum(OUTPUT_FORMATS).default("auto").describe("auto (PNG for grey results, else JPEG), png or webp (lossless; use for small text, line art and evidence), jpeg"),
  maxLongSide: z.number().int().min(64).max(MAX_DELIVERY_SIDE).optional().describe("Delivered long side in px (default 1600)"),
  quality: z.number().int().min(40).max(100).optional().describe("JPEG quality (default 88)"),
}).describe("Delivery size and codec of the returned image");
const OpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("grayscale") }),
  z.object({ op: z.literal("normalize") }).describe("Stretch contrast to the full range"),
  z.object({ op: z.literal("clahe"), tile: z.number().int().min(8).max(256).optional(),
    maxSlope: z.number().min(1).max(10).optional() }).describe("Local adaptive contrast; good for blurry scans, glare, dark or low-contrast photos"),
  z.object({ op: z.literal("contrast"), factor: z.number().min(0.2).max(4).optional() }),
  z.object({ op: z.literal("brightness"), factor: z.number().min(0.2).max(4).optional() }),
  z.object({ op: z.literal("sharpen"), sigma: z.number().min(0.3).max(5).optional() }),
  z.object({ op: z.literal("denoise"), size: z.union([z.literal(3), z.literal(5), z.literal(7)]).optional() }).describe("Median filter"),
  z.object({ op: z.literal("threshold"), method: z.enum(["adaptive", "otsu", "fixed"]).optional(),
    value: z.number().int().min(0).max(255).optional(),
    blockSize: z.number().int().min(3).max(201).optional(),
    offset: z.number().min(-50).max(50).optional() }).describe("Black/white; adaptive suits handwriting, book pages and uneven light"),
  z.object({ op: z.literal("invert") }),
  z.object({ op: z.literal("edges") }).describe("Sobel edge magnitude; good for traces and line art"),
]);

// What the widget needs to explain the verification image to the user.
const CheckSummarySchema = z.object({
  layout: z.enum(["side-by-side", "stacked"]),
  region: RegionSchema,
  numbers: z.array(z.object({ n: z.number().int(), id: z.string(), label: z.string().optional() })),
});
const checkSummary = ({ layout, region, numbers }) => ({ layout, region, numbers });

// What the model reads about the canvas: ids, kinds and rounded boxes, no
// polyline vertices. Full geometry goes to the widget in _meta only, so a
// long session does not re-send every point on every call.
const r3 = (v) => Math.round(v * 1000) / 1000;
// What the model reads about a claim: its state, its own confidence, how
// much evidence of each kind of observer, and what is unresolved.
function claimSummary(c) {
  const n = evidenceCount(c);
  return {
    verification: verificationOf(c), ...(c.confidence ? { confidence: c.confidence } : {}),
    evidence: { model: n.model, tool: n.tool, user: n.user },
    ...(c.ambiguities?.length ? { ambiguities: c.ambiguities } : {}),
    ...(c.reviewReason ? { userReason: c.reviewReason } : {}), ...(c.previouslyRejected ? { previouslyRejected: true } : {}),
  };
}
function compactMark(m) {
  return {
    id: m.id, type: m.type, author: m.author, ...(m.side ? { side: m.side } : {}), ...(m.layer ? { layer: m.layer } : {}), ...(m.label ? { label: m.label } : {}),
    box: m.type === "point" ? [r3(m.x), r3(m.y)] : [r3(m.x), r3(m.y), r3(m.x2), r3(m.y2)],
    ...(m.type === "polyline" ? { vertices: m.points.length } : {}),
    ...(m.note ? { note: m.note, claim: claimSummary(m) } : {}), ...(m.status ? { status: m.status } : {}), ...(m.edited ? { editedByUser: true } : {}),
    ...(m.color ? { color: m.color } : {}), ...(m.size ? { size: m.size } : {}), ...(m.pen ? { pen: m.pen } : {}),
  };
}
const LayerSchema = z.object({ id: z.string(), author: z.enum(["user", "assistant"]), name: z.string(), count: z.number().int(),
  locked: z.boolean().optional(), opacity: z.number().optional(), side: z.enum(["left", "right"]).optional() });
const compactLink = (l) => ({ id: l.id, left: l.left, right: l.right, ...(l.label ? { label: l.label } : {}),
  ...(l.note ? { note: l.note } : {}), confidence: l.confidence, ...(l.review ? { review: l.review } : {}), claim: claimSummary(l) });
// The widget also gets each piece of evidence, to show where it is.
const widgetLink = (l) => ({ ...compactLink(l), evidence: l.evidence ?? [], ambiguities: l.ambiguities ?? [],
  verification: verificationOf(l), ...(l.reviewReason ? { reviewReason: l.reviewReason } : {}), ...(l.previouslyRejected ? { previouslyRejected: l.previouslyRejected } : {}) });
const STATE_TEXT = {
  "user-confirmed": "USER CONFIRMED", "user-rejected": "USER REJECTED (do not rely on it)",
  "independently-verified": "VERIFIED by a tool", unverified: "UNVERIFIED",
};
const claimTag = (c) => {
  const n = evidenceCount(c), state = verificationOf(c);
  return c.confidence + ", evidence model " + n.model + " tool " + n.tool + ", " + STATE_TEXT[state] +
    (c.reviewReason ? " because " + JSON.stringify(c.reviewReason) : "") + (c.previouslyRejected ? ", re-proposed after a rejection" : "") +
    (c.ambiguities?.length ? "; unresolved: " + c.ambiguities.join("; ") : "");
};
// Claims refused this call, and what the user rejected before.
const refusedText = (refused) => refused.length
  ? ". REFUSED (the user rejected the same claim at the same place before; it was not stored): " + refused.map((r) =>
    r.kind + " " + r.id + (r.rejection.reason ? " (user's reason: " + r.rejection.reason + ")" : "")).join("; ") +
    ". Re-propose only with NEW evidence (a different kind of clue or another image), or drop it."
  : "";
const rejectionsText = (entries) => {
  const list = entries.flatMap((e) => e.rejections ?? []);
  return list.length ? ". The user REJECTED these claims (do not repeat them without new evidence): " + list.slice(-12).map(rejectionText).join("; ") : "";
};
// One line per link so the model can reason from its own earlier matches
// without looking at the images again.
const linkTable = (links, marksById) => links.map((l) => {
  const name = (id) => id + (marksById.get(id)?.label ? " " + JSON.stringify(marksById.get(id).label) : "");
  return l.id + (l.label ? " " + JSON.stringify(l.label) : "") + ": left " + name(l.left) + " <-> right " + name(l.right) +
    " [" + claimTag(l) + "]" +
    (l.note ? " — " + l.note : "");
}).join("\n");
const layerText = (layers) => layers.map((l) => (l.side ? l.side + ":" : "") + l.id + " " + JSON.stringify(l.name) + " (" + l.author + ", " + l.count +
  (l.locked ? ", LOCKED by the user: do not edit or remove its marks" : "") + ")").join("; ");
// Changes the user made by hand in the canvas since GPT's last call.
const EDIT_TEXT = {
  "rename-layer": (e) => "renamed layer " + e.layer + " " + JSON.stringify(e.from) + " to " + JSON.stringify(e.to),
  "lock-layer": (e) => "locked layer " + e.layer, "unlock-layer": (e) => "unlocked layer " + e.layer,
  "reorder-layers": (e) => "reordered layers (bottom to top) " + e.order.join(", "),
  "remove-mark": (e) => "deleted " + (e.author === "user" ? "their" : "YOUR") + " mark " + e.id + (e.label ? " " + JSON.stringify(e.label) : ""),
  "move-mark": (e) => "moved/reshaped their mark " + e.id + (e.label ? " " + JSON.stringify(e.label) : "") + " (your earlier notes on it may no longer fit)",
  "restyle-mark": (e) => "restyled or relabelled their mark " + e.id + (e.label ? " " + JSON.stringify(e.label) : ""),
};
const userEditsText = (edits) => edits.length
  ? ". USER EDITS since your last look (trust these over your memory): " + edits.map((e) => (e.side ? e.side + " image: " : "") + (EDIT_TEXT[e.kind]?.(e) ?? e.kind)).join("; ")
  : "";
// With an access key the links are signed, so an image hash alone is not
// enough to download a picture.
const exportLink = (hex, file) => publicUrl() + "/export/" + hex + "/" + file + (ACCESS_KEY ? "?sig=" + exportSignature(ACCESS_KEY, hex, file) : "");
const exportLinks = (imageId) => publicUrl() ? {
  image: exportLink(imageId.slice(4), "image.jpg"),
  marks: exportLink(imageId.slice(4), "marks.svg"),
} : undefined;

// Render logs show what each call costs: text the model reads, images the
// model sees, and bytes only the widget gets.
function logSizes(tool, result, { appOnly = false } = {}) {
  const images = (result.content ?? []).filter((b) => b.type === "image");
  const text = JSON.stringify((result.content ?? []).filter((b) => b.type !== "image")).length +
    JSON.stringify(result.structuredContent ?? {}).length;
  log("info", "[size] " + tool + (appOnly ? " appOnly(widget-called)=" : " modelText=") + text + "B modelImages=" + images.length + "x" +
    images.reduce((n, b) => n + b.data.length, 0) + "B widgetOnly=" + JSON.stringify(result._meta ?? {}).length + "B");
  return result;
}

// Both images of a paired view with their marks tagged by side.
const pairMarks = (left, right) => [
  ...canvasMarks(left).map((m) => ({ ...m, side: "left" })),
  ...canvasMarks(right).map((m) => ({ ...m, side: "right" })),
];
const pairLayers = (left, right) => [
  ...canvasLayers(left).map((l) => ({ ...l, side: "left" })),
  ...canvasLayers(right).map((l) => ({ ...l, side: "right" })),
];
const pixelsBlock = (out) => ({ type: "image", data: out.data.toString("base64"), mimeType: out.mimeType });

async function presentPair({ left, right, annotations, findings, remove, reset, layer, coordinateFrame, priorUserAnnotations, links, removeLinks, verify }) {
  const refused = [];
  const changed = applyPairChanges(left, right, {
    annotations, findings, remove, reset, layer, frame: coordinateFrame, links, removeLinks, refused,
    priorUser: priorUserAnnotations.map((m, i) => {
      try { return { ...replayUserAnnotation(m), side: m.side ?? "left" }; }
      catch (error) { throw new Error("present_visual priorUserAnnotations[" + i + "] (mark " + JSON.stringify(m.id) + "): " + error.message); }
    }),
    resolve: resolveCoordinateAnnotation,
  });
  const history = { tool: "present_visual", changed, removed: remove, ...(links.length || removeLinks.length ? { note: "links " + links.map((l) => l.id).concat(removeLinks.map((id) => "-" + id)).join(",") } : {}) };
  const edits = [...takeUserEdits(left).map((e) => ({ ...e, side: "left" })), ...takeUserEdits(right).map((e) => ({ ...e, side: "right" }))];
  await Promise.all([saveCanvas(left, history), saveCanvas(right, history)]);
  const marks = pairMarks(left, right), byId = new Map(marks.map((m) => [m.id, m]));
  const linkList = pairLinks(left, right), layers = pairLayers(left, right);
  const sides = { left, right }, checks = [], ink = [];
  for (const side of ["left", "right"]) {
    const entry = sides[side], own = canvasMarks(entry);
    const drawn = changed.filter((id) => annotations.some((a) => a.id === id && (a.side ?? "left") === side));
    if (verify && drawn.length) checks.push({ side, check: await renderVerification(entry, own, drawn) });
    ink.push(...inkReport(own.filter((m) => drawn.includes(m.id)), entry).map((i) => ({ ...i, side })));
  }
  const pending = linkList.filter(needsReview);
  const [shownLeft, shownRight] = [await displayImage(left), await displayImage(right)];
  const text = "Paired view: LEFT " + left.imageId + " (" + left.width + "x" + left.height + " px), RIGHT " + right.imageId +
    " (" + right.width + "x" + right.height + " px), side by side, not overlaid. Coordinates are normalized to each mark's own image. " +
    marks.length + " marks (side, id, rounded box): " + JSON.stringify(marks.map(compactMark)) +
    (layers.length ? ". Layers: " + layerText(layers) : "") + userEditsText(edits) +
    ". LINKS (" + linkList.length + ", your record of which left and right marks are the same thing):\n" + (linkTable(linkList, byId) || "(none yet)") +
    (pending.length ? "\n" + pending.length + " link(s) are UNVERIFIED and wait for the user's review in the canvas. Your confidence does not verify them: treat them as candidates, not facts, until the user confirms them." : "") +
    refusedText(refused) + rejectionsText([left, right]) +
    (changed.length ? "\nChanged this call: " + changed.join(", ") : "") +
    (ink.length ? ". Ink in image px: " + ink.map((i) => i.side + ":" + i.id + " " + i.pen + "/" + i.size + " " + i.px + "px" + (i.warn ? " WARNING " + i.warn : "")).join("; ") : "") +
    checks.map(({ side, check }) => ". VERIFICATION image for the " + side.toUpperCase() + " image follows: crop " + JSON.stringify(check.region) + ", " +
      (check.layout === "side-by-side" ? "left half" : "top") + " = original pixels, other half = with marks numbered " +
      check.numbers.map((n) => n.n + "=" + n.id).join(", ") + "; check each mark sits on its target and fix it (same id) if not").join("");
  return logSizes("present_visual", {
    content: [{ type: "text", text }, ...checks.map(({ check }) => pixelsBlock(check))],
    structuredContent: {
      kind: "estampes.visual_surface", protocol: VISUAL_PROTOCOL, imageId: left.imageId, width: left.width, height: left.height, views: [],
      pair: { imageId: right.imageId, width: right.width, height: right.height, ...(exportLinks(right.imageId) ? { exports: exportLinks(right.imageId) } : {}) },
      marks: marks.map(compactMark), layers, links: linkList.map(compactLink), coordinateSystem: "normalized-top-left",
      ...(exportLinks(left.imageId) ? { exports: exportLinks(left.imageId) } : {}),
    },
    _meta: {
      "estampes/links": linkList.map(widgetLink),
      "estampes/image": { mimeType: shownLeft.mimeType, data: shownLeft.data.toString("base64"), width: shownLeft.width, height: shownLeft.height },
      "estampes/pairImage": { mimeType: shownRight.mimeType, data: shownRight.data.toString("base64"), width: shownRight.width, height: shownRight.height },
      "estampes/views": [],
      "estampes/annotations": marks,
    },
  });
}

function makeServer() {
  const server = new McpServer({ name: "estampes", version: VERSION });

  registerAppResource(
    server,
    "Estampes number line",
    WIDGET,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [{ uri: WIDGET, mimeType: RESOURCE_MIME_TYPE, text: html }],
    })
  );

  // Keep the old address resolvable for preexisting conversations.
  // Newly discovered tools point only to the versioned WIDGET URI.
  registerAppResource(
    server,
    "Estampes number line (legacy)",
    LEGACY_WIDGET,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [{ uri: LEGACY_WIDGET, mimeType: RESOURCE_MIME_TYPE, text: html }],
    })
  );

  registerAppTool(
    server,
    "show_number_line",
    {
      title: "Show interactive number line",
      description:
        "Display an interactive number line from -4 to 4 in ChatGPT, with a mark at the specified integer.",
      inputSchema: z.object({
        target: z.number().int().min(-4).max(4).describe("Tick to highlight"),
      }),
      outputSchema: z.object({
        kind: z.literal("estampes.number_line"),
        target: z.number(),
        x: z.number(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: WIDGET } },
    },
    async ({ target }) => ({
      content: [{
        type: "text",
        text: "Estampes number line: AI pointed to " + target + ".",
      }],
      structuredContent: {
        kind: "estampes.number_line",
        target,
        x: valueToX(target),
      },
    })
  );


  // Called from the embedded widget, not from the model.
  // Stateless on purpose for M0: validate and echo the selected value.
  registerAppTool(
    server,
    "record_number_line_selection",
    {
      title: "Validate number-line selection",
      description:
        "Validate a number picked by the user in the Estampes number-line UI, and return its normalized coordinate.",
      inputSchema: z.object({
        value: z.number().int().min(-4).max(4),
      }),
      outputSchema: z.object({
        kind: z.literal("estampes.user_selection"),
        value: z.number().int().min(-4).max(4),
        x: z.number(),
        y: z.number(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      // App-only actions must not advertise a widget of their own to ChatGPT.
      // The UI is rendered exclusively by show_number_line.
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ value }) => ({
      content: [{
        type: "text",
        text: "Estampes selection validated: " + value +
          " (normalized x=" + valueToX(value) + ").",
      }],
      structuredContent: {
        kind: "estampes.user_selection",
        value,
        x: valueToX(value),
        y: 0.5,
      },
    })
  );


  // M0.4: an overlay engine for several built-in sample scenes.
  // Does not claim to access images already rendered by ChatGPT search.
  registerAppResource(
    server,
    "Estampes visual surface",
    VISUAL_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [{ uri: VISUAL_URI, mimeType: RESOURCE_MIME_TYPE, text: visualHtml }],
    })
  );

  for (const uri of LEGACY_VISUAL_URIS) {
    registerAppResource(
      server,
      "Estampes visual surface (legacy " + uri.match(/v\d+/)[0] + ")",
      uri,
      { mimeType: RESOURCE_MIME_TYPE },
      async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: visualHtml }] })
    );
  }

  const ViewSchema = z.object({
    label: z.string().min(1).max(24).describe("Short tab name, e.g. 增強對比 or 二值化"),
    ops: z.array(OpSchema).max(8).default([]),
    region: RegionSchema.optional(),
    sampling: SamplingSchema.optional().describe("As in process_image; native shows real source pixels in the tab"),
  });

  registerAppTool(
    server,
    "present_visual",
    {
      title: "Present a shared visual canvas",
      description:
        "CANONICAL shared visual canvas the user sees in chat. Users will not name tools: when they ask to show, point out, circle, box, trace or draw on a photo, call this yourself. " +
        "Whenever YOU ask the user to point at, circle or mark something, call this in the same turn so they have a canvas to draw on (imageId re-opens it with every mark); never ask without one. Also call it when the user asks for the canvas/drawing board again. Do not call it for text-only follow-ups. " +
        "Pass the attached file as `image` (or `imageUrl`) to load and show it in ONE call, or imageId from an earlier Estampes call; `scene` is only for bundled SVG demos. " +
        "Marks PERSIST per photo with stable ids: the user's submitted marks and your earlier marks are kept automatically. `annotations` adds marks or edits one by re-using its id; `remove` deletes ids; `reset` clears all; `findings` attaches note/status to any mark, including the user's (never redraw a user's mark). Ids starting 'user-' and bare labels like 'YOU 3' belong to the user's marks; your own labels may refer to them, e.g. 'YOU 3 → C105'. " +
        "Marks are grouped in LAYERS the user can show, hide, rename, reorder, fade or LOCK: never change or remove marks in a locked layer (findings are still allowed). The user can also move, restyle or delete marks by hand; results list these USER EDITS once, so trust them over your memory. get_visual_state returns the whole canvas as JSON when you need to recall it without redrawing. Each user submission and each of your calls that adds marks becomes one layer. Give `layer` a short name for what this call draws (e.g. '第一輪', '第二次檢查'); re-using a name of one of your layers adds to it, which keeps related marks together over a long session. " +
        "Put your answer ON the mark: `note` (e.g. the text or value you read) and `status:'inspected'` only after you looked at those pixels. " +
        "If you read positions off a process_image output, pass `coordinateFrame` = {derivedViewId} of that output and its pixel coordinates; Estampes converts them exactly. For overlay_grid use its cellCenters, or coordinateFrame {region (plus width/height for pixels)}. " +
        "The result includes a VERIFICATION image: the same crop of the real photo without and with your marks (numbered). Check that the marks sit on the right pixels before telling the user it is done; fix with the same id if not. " +
        "The widget opens on the ORIGINAL image; your marks are GOLD and the user's marks BLUE, and the user can draw marks and send them back. " +
        "Choose color, size and pen YOURSELF; never ask the user. pen = precise points, outlines and paths; highlighter = translucent band to cover an area or follow a feature without hiding it. Sizes fine < thin < medium (default) < thick: a line must be narrower than the thing it follows (a fine trace, a pen stroke, a crack), thick only for large regions. " +
        "The result lists each changed mark's ink width in image pixels with warnings, and the verification image draws ink at its real width: if ink hides its target or is too faint, redraw the same id with another size or pen. " +
        "Mark types: point, rect, arrow (head = target) and polyline (`points`, up to 128 ordered vertices; `smooth` for a freehand curve, `closed` to circle something) for paths such as traces, wires, roads, outlines, handwriting strokes or loose circles; follow only what is visible in zoomed process_image output, and say where a path is hidden. " +
        "`marksFile`: an Estampes marks SVG the user exported earlier and attached again; its marks are restored onto this image. The result has download links (`exports`) for the image and a layered marks SVG; give them when the user wants to save or export. " +
        "PAIRED VIEW: to compare two DIFFERENT images side by side (a schematic and a board photo, a map and an aerial photo, a drawing and the object), pass the second as `pairImage`/`pairImageUrl`/`pairImageId`: it shows on the RIGHT, the first image on the LEFT. The images are never overlaid. Each annotation takes `side` (left|right, default left) with coordinates normalized to that image; ids are unique across both. `links` records that a left mark and a right mark are the same thing (same part, net, pin, building...), with your `confidence`. Every result lists all links as a table: use it to remember and reason about earlier matches, and trust USER CONFIRMED / USER REJECTED over your own guess. " +
        "CLAIMS AND EVIDENCE: a note on a mark and a link are claims. Give `evidence` for them: each item says what you see (`says`), what kind of clue it is, and the `region` (full-image 0..1, `side` in a paired view) where the user can zoom in to check it; list what is unresolved in `ambiguities`. Your evidence is recorded as your own observation: a claim stays UNVERIFIED until the user confirms it in the canvas or a tool's evidence backs it, whatever your confidence, so call such claims candidates, not facts. A claim the user REJECTED is remembered for that place even if its marks are deleted; repeating it without new evidence is refused. " +
        "Optional `views` (real images only, max 3) add extra tabs with processed versions (e.g. clahe+sharpen, threshold, a zoomed region) that the user can switch to; only add them when they help the user see something. " +
        "Coordinates are normalized to the full image, top-left origin. For small or ambiguous targets, zoom with process_image or overlay_grid (imageId from this call's result) before marking; coordinates alone are not evidence of recognition. " +
        "Do NOT also call present_visual_evidence for the same task.",
      inputSchema: z.object({
        image: ChatFileSchema.optional().describe("Image file from the conversation; loads and shows it in one call"),
        imageUrl: z.string().url().max(2048).optional().describe("Public https URL of an image"),
        imageId: ImageIdSchema.optional(),
        scene: SceneSchema.optional().describe("Bundled demo scene; use only when there is no real image"),
        marksFile: ChatFileSchema.optional().describe("Estampes marks SVG (exported earlier) attached by the user; restores its marks"),
        annotations: ModelAnnotationsSchema.default([]),
        views: z.array(ViewSchema).max(3).default([]).describe("Optional processed views shown as extra tabs; the original stays the default view"),
        priorUserAnnotations: z.array(VisualAnnotationSchema).max(18).default([]).describe(
          "Rarely needed for photos (marks persist). Only marks the user actually drew; replayed provenance is not authenticated."
        ),
        findings: z.array(FindingSchema).max(30).default([]).describe("Attach your note/status to existing marks by id, e.g. the user's box"),
        remove: z.array(z.string().max(64)).max(30).default([]).describe("Ids of marks to delete"),
        reset: z.boolean().default(false).describe("Start from an empty canvas for this photo (both images and their links in a paired view)"),
        pairImage: ChatFileSchema.optional().describe("Second image file shown on the RIGHT for a paired view"),
        pairImageUrl: z.string().url().max(2048).optional().describe("Public https URL of the right-hand image"),
        pairImageId: ImageIdSchema.optional().describe("imageId of the right-hand image"),
        links: z.array(LinkSchema).max(30).default([]).describe("Paired view: left mark <-> right mark correspondences"),
        removeLinks: z.array(z.string().max(64)).max(30).default([]).describe("Paired view: link ids to delete"),
        layer: z.string().trim().min(1).max(40).optional().describe("Name of the layer for this call's new marks; an existing name of yours adds to that layer, and edited marks move into it"),
        coordinateFrame: z.object({
          derivedViewId: DerivedViewIdSchema.optional().describe("The process_image result you read the coordinates from; exact for any crop or zoom"),
          units: z.enum(["pixels", "normalized"]).optional().describe("With derivedViewId: pixels of that output (default) or 0..1 of it"),
          region: RegionSchema.optional(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          side: z.enum(["left", "right"]).optional().describe("Paired view: the image the region belongs to (default left)"),
        }).refine((f) => Boolean(f.derivedViewId) !== Boolean(f.region), { message: "coordinateFrame needs exactly one of derivedViewId or region" })
          .optional().describe("Coordinates in `annotations` (of that side) are in a processed output: give its derivedViewId, or (older form) its region with 0..1 coordinates or pixels of a width×height output of it"),
        verify: z.boolean().default(true).describe("Return the verification image of changed marks"),
      }),
      outputSchema: z.object({
        kind: z.literal("estampes.visual_surface"),
        protocol: z.literal(VISUAL_PROTOCOL).optional(),
        scene: SceneSchema.optional(),
        imageId: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        views: z.array(z.object({ label: z.string(), region: RegionSchema, derivedViewId: z.string().optional() })).optional(),
        annotations: VisualAnnotationsSchema.optional(),
        marks: z.array(z.record(z.string(), z.unknown())).optional(),
        layers: z.array(LayerSchema).optional(),
        check: CheckSummarySchema.optional(),
        exports: z.object({ image: z.string(), marks: z.string() }).optional(),
        pair: z.object({ imageId: z.string(), width: z.number(), height: z.number(),
          exports: z.object({ image: z.string(), marks: z.string() }).optional() }).optional(),
        links: z.array(z.record(z.string(), z.unknown())).optional(),
        coordinateSystem: z.literal("normalized-top-left"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: VISUAL_URI }, "openai/fileParams": ["image", "marksFile", "pairImage"] },
    },
    async ({ image, imageUrl, imageId, scene, marksFile, annotations, views, priorUserAnnotations, findings, remove, reset, layer, coordinateFrame, verify,
      pairImage, pairImageUrl, pairImageId, links, removeLinks }) => {
      try {
        if ([image, imageUrl, imageId, scene].filter(Boolean).length !== 1) {
          throw new Error("Provide exactly one of image, imageUrl, imageId or scene");
        }
        const paired = [pairImage, pairImageUrl, pairImageId].filter(Boolean).length;
        if (paired > 1) throw new Error("Provide at most one of pairImage, pairImageUrl or pairImageId");
        if (!paired && (links.length || removeLinks.length || annotations.some(a => a.side === "right") || coordinateFrame?.side === "right")) {
          throw new Error("links, removeLinks and side:'right' need a paired view (pairImage, pairImageUrl or pairImageId)");
        }
        if (paired && (scene || views.length || marksFile)) throw new Error("A paired view needs two real images and does not take scene, views or marksFile");
        if (image || imageUrl) imageId = (await loadImageInput({ image, imageUrl })).imageId;
        if (paired) {
          if (pairImage || pairImageUrl) pairImageId = (await loadImageInput({ image: pairImage, imageUrl: pairImageUrl })).imageId;
          if (pairImageId === imageId) throw new Error("The paired image is the same as the left image; pass a different picture");
          const left = await ensureImage(imageId), right = await ensureImage(pairImageId);
          return await presentPair({ left, right, annotations, findings, remove, reset, layer,
            coordinateFrame: resolveFrame(coordinateFrame, left, right), priorUserAnnotations, links, removeLinks, verify });
        }
        if (scene && views.length) throw new Error("views are only available for real images (imageId)");
        if (scene) {
          if (coordinateFrame || findings.length || remove.length || marksFile) throw new Error("coordinateFrame, findings, remove and marksFile need a real photo");
          const resolved = [...annotations.map(a => resolveSceneAnnotation(scene, a)), ...priorUserAnnotations.map(replayUserAnnotation)];
          return {
            content: [{
              type:"text",
              text:"Estampes scene="+scene+"; geometry/provenance annotations="+JSON.stringify(resolved)+
                ". No semantic object lookup was performed. These coordinates are geometry only, NOT evidence the model visually located an object. " +
                "For image-content questions call inspect_visual to see pixels. " +
                "Previously user-drawn marks retain author=user."
            }],
            structuredContent:{
              kind:"estampes.visual_surface",scene,annotations:resolved,
              coordinateSystem:"normalized-top-left",
            },
          };
        }
        const entry = await ensureImage(imageId);
        coordinateFrame = resolveFrame(coordinateFrame, entry, null);
        // A marks file and this call's changes land together or not at all.
        const parsedFile = marksFile ? await readMarksFile(entry, marksFile) : null;
        const restore = snapshotCanvas(entry);
        let imported = [], changed;
        const refused = [];
        try {
          if (parsedFile) imported = importMarks(entry, parsedFile.marks, parsedFile.options);
          changed = applyCanvasChanges(entry, {
            annotations, findings, remove, reset, layer, frame: coordinateFrame, refused,
            priorUser: priorUserAnnotations.map((m, i) => {
              try { return replayUserAnnotation(m); } catch (error) { throw new Error("present_visual priorUserAnnotations[" + i + "] (mark " + JSON.stringify(m.id) + "): " + error.message); }
            }),
            resolve: resolveCoordinateAnnotation,
          });
        } catch (error) { restore(); throw error; }
        const edits = takeUserEdits(entry);
        if (imported.length || changed.length || remove.length || reset || edits.length) {
          await saveCanvas(entry, { tool: "present_visual", changed: [...imported, ...changed], removed: remove, ...(reset ? { note: "reset" } : {}) });
        }
        const resolved = canvasMarks(entry), layers = canvasLayers(entry);
        const drawn = changed.filter(id => annotations.some(a => a.id === id));
        const check = verify && drawn.length ? await renderVerification(entry, resolved, drawn) : null;
        const ink = inkReport(resolved.filter(m => drawn.includes(m.id)), entry);
        const exports = exportLinks(imageId);
        const shown = await displayImage(entry);
        const rendered = [];
        for (const view of views) {
          const { out: full, record } = await deliverView(entry, { region: view.region, ops: view.ops, sampling: view.sampling });
          const out = await compactForDisplay(full);
          rendered.push({ label: view.label, mimeType: out.mimeType, data: out.data.toString("base64"), region: out.region, derivedViewId: record.derivedViewId });
        }
        // Kept so the widget can fetch them again if the host drops this
        // result's _meta (see load_visual_canvas).
        entry.lastViews = rendered;
        if (check) entry.lastCheck = check;
        return logSizes("present_visual", {
          content: [{
            type: "text",
            text: "Showing " + imageId + " (" + entry.width + "x" + entry.height + " px) to the user (original by default" +
              (rendered.length ? "; extra tabs: " + rendered.map(v => v.label).join(", ") : "") + "). Canvas now has " +
              resolved.length + " marks (ids persist; edit by re-using an id; boxes rounded): " + JSON.stringify(resolved.map(compactMark)) +
              (layers.length ? ". Layers (the user can hide, rename, reorder, fade or lock any): " + layerText(layers) : "") + userEditsText(edits) +
              (imported.length ? ". Restored from marks file: " + imported.join(", ") : "") +
              (changed.length ? ". Changed this call: " + changed.join(", ") : "") +
              (resolved.some(m => m.note && needsReview(m)) ? ". Notes marked claim.verification unverified are your own claims: only the user (in the canvas) or a tool's evidence verifies them" : "") +
              refusedText(refused) + rejectionsText([entry]) +
              (ink.length ? ". Ink in image px: " + ink.map(i => i.id + " " + i.pen + "/" + i.size + " " + i.px + "px" + (i.warn ? " WARNING " + i.warn : "")).join("; ") : "") +
              (check ? ". The next image is a VERIFICATION crop of region " + JSON.stringify(check.region) + ", " +
                (check.layout === "side-by-side" ? "left" : "top") + " = original pixels, " +
                (check.layout === "side-by-side" ? "right" : "bottom") + " = with marks numbered " +
                check.numbers.map(n => n.n + "=" + n.id).join(", ") +
                ". Compare them: say whether each mark really sits on its target; if not, fix it (same id) before claiming it is done. The user can open the same image in the canvas tab 「GPT 驗收圖」." : ""),
          }, ...(check ? [imageBlock(check)] : [])],
          structuredContent: {
            kind: "estampes.visual_surface", protocol: VISUAL_PROTOCOL, imageId, width: entry.width, height: entry.height,
            views: rendered.map(({ label, region, derivedViewId }) => ({ label, region, derivedViewId })),
            marks: resolved.map(compactMark), layers, coordinateSystem: "normalized-top-left",
            ...(check ? { check: checkSummary(check) } : {}),
            ...(exports ? { exports } : {}),
          },
          // Pixels go to the widget only; the model already has them from load_image.
          _meta: {
            "estampes/image": { mimeType: shown.mimeType, data: shown.data.toString("base64"), width: shown.width, height: shown.height },
            "estampes/views": rendered,
            "estampes/annotations": resolved,
          },
        });
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] };
      }
    }
  );

  // Private tool for the canvas widget: re-sends a photo's pixels, marks,
  // last processed views and last verification image. The widget calls it
  // when a present_visual result arrives without pixels (the host can drop
  // large results) or when the user opens the verification tab.
  registerAppTool(
    server,
    "load_visual_canvas",
    {
      title: "Load visual canvas",
      description: "Reload a photo canvas for the Estampes widget.",
      inputSchema: z.object({
        imageId: ImageIdSchema,
        part: z.enum(["canvas", "check"]).default("canvas"),
        pairImageId: ImageIdSchema.optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ imageId, part, pairImageId }) => {
      try {
        const entry = await ensureImage(imageId);
        if (pairImageId && part === "canvas") {
          const right = await ensureImage(pairImageId), shown = await displayImage(right), own = await displayImage(entry);
          return logSizes("load_visual_canvas", {
            content: [{ type: "text", text: "Paired canvas data for " + imageId + " + " + pairImageId + " sent to the widget." }],
            structuredContent: {
              kind: "estampes.visual_canvas", imageId, part, width: entry.width, height: entry.height,
              image: { mimeType: own.mimeType, data: own.data.toString("base64") },
              pair: { imageId: pairImageId, width: right.width, height: right.height, image: { mimeType: shown.mimeType, data: shown.data.toString("base64") },
                ...(exportLinks(pairImageId) ? { exports: exportLinks(pairImageId) } : {}) },
              annotations: pairMarks(entry, right), layers: pairLayers(entry, right), links: pairLinks(entry, right).map(widgetLink), views: [],
              ...(exportLinks(imageId) ? { exports: exportLinks(imageId) } : {}),
            },
          }, { appOnly: true });
        }
        const check = entry.lastCheck;
        const pixels = (out) => ({ mimeType: out.mimeType, data: Buffer.isBuffer(out.data) ? out.data.toString("base64") : out.data });
        // App-only: the model never sees this result, so pixels may sit in
        // structuredContent, which every host passes to the widget.
        const body = part === "check"
          ? { check: check ? { ...checkSummary(check), image: pixels(check) } : null }
          : {
              width: entry.width, height: entry.height, annotations: canvasMarks(entry), layers: canvasLayers(entry),
              image: pixels(await displayImage(entry)),
              views: (entry.lastViews ?? []).map(v => ({ label: v.label, region: v.region, ...pixels(v) })),
              ...(check ? { check: checkSummary(check) } : {}),
            };
        return logSizes("load_visual_canvas", {
          content: [{ type: "text", text: "Canvas data for " + imageId + " sent to the widget." }],
          structuredContent: { kind: "estampes.visual_canvas", imageId, part, ...body, ...(exportLinks(imageId) ? { exports: exportLinks(imageId) } : {}) },
        }, { appOnly: true });
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] };
      }
    }
  );

  // The whole canvas as one estampes.visual/1 document: images, layers,
  // marks with provenance, links and (with storage) the change history. No
  // widget and nothing ChatGPT-specific, so any MCP client can read it.
  server.registerTool(
    "get_visual_state",
    {
      title: "Read the visual canvas state",
      description: "Return everything on an Estampes canvas as one estampes.visual/2 JSON document: images, layers (order, lock, opacity), marks (geometry normalized to their own image, style, label, note/status, who made them and how), links between a paired left and right image, the confidence, evidence and verification state of every note and link, the claims the user rejected, and optionally the recent change history. Read-only. Use it to recall what is on a canvas without redrawing it, or to hand the canvas to another tool.",
      inputSchema: z.object({
        imageId: ImageIdSchema,
        pairImageId: ImageIdSchema.optional().describe("Right-hand image of a paired view"),
        history: z.number().int().min(0).max(200).default(0).describe("How many recent changes to include (needs server storage)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ imageId, pairImageId, history }) => {
      try {
        const left = await ensureImage(imageId), right = pairImageId ? await ensureImage(pairImageId) : null;
        const doc = canvasDocument(left, right, history ? { history: await readHistory(imageId, history) } : {});
        return {
          content: [{ type: "text", text: VISUAL_PROTOCOL + ": " + doc.marks.length + " marks, " + doc.layers.length + " layers, " + doc.links.length + " links. " + JSON.stringify(doc) }],
          structuredContent: doc,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] };
      }
    }
  );

  // Private tool for the canvas widget: a sharper tile of the photo while
  // the user zooms. App-only, like load_visual_canvas.
  registerAppTool(
    server,
    "load_visual_region",
    {
      title: "Load photo detail",
      description: "Return a higher-resolution tile of a photo region for the Estampes widget.",
      inputSchema: z.object({
        imageId: ImageIdSchema,
        region: RegionSchema,
        maxSide: z.number().int().min(256).max(2048).default(1600),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ imageId, region, maxSide }) => {
      try {
        const tile = await regionTile(await ensureImage(imageId), region, maxSide);
        return logSizes("load_visual_region", {
          content: [{ type: "text", text: "Detail tile for " + imageId + " sent to the widget." }],
          structuredContent: { kind: "estampes.visual_tile", imageId, region: tile.region,
            width: tile.width, height: tile.height, mimeType: tile.mimeType, data: tile.data.toString("base64") },
        }, { appOnly: true });
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] };
      }
    }
  );

  // Private tool, not a widget: returns validated user marks.
  registerAppTool(
    server,
    "validate_visual_annotations",
    {
      title:"Validate user visual annotations",
      description:"Validate the user's 2D normalized image annotations.",
      inputSchema:z.object({
        scene:SceneSchema.optional(),
        imageId:ImageIdSchema.optional(),
        pairImageId:ImageIdSchema.optional(),
        annotations:VisualAnnotationsSchema,
        intent:z.enum(INTENTS).default("free-annotate"),
        note:z.string().max(500).default(""),
        replyQuote:z.string().max(300).default(""),
      }),
      outputSchema:z.object({
        kind:z.literal("estampes.validated_annotations"),
        scene:SceneSchema.optional(),
        imageId:z.string().optional(),
        count:z.number().int(),
        annotations:VisualAnnotationsSchema,
        layer:z.object({id:z.string(),name:z.string()}).optional(),
        pairLayer:z.object({id:z.string(),name:z.string()}).optional(),
        event:z.record(z.string(),z.unknown()),
        chatMessage:z.string(),
      }),
      annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
      _meta:{ui:{visibility:["app"]}},
    },
    async ({scene,imageId,pairImageId,annotations,intent,note,replyQuote})=>{
      // Validation is geometric only; no image classification or host
      // conversation access is claimed. The user supplies the intent/quote.
      try {
        if(!imageId===!scene) throw new Error("Provide exactly one of imageId or scene");
        let image;
        let entry;
        if(imageId){entry=await ensureImage(imageId);image={imageId,width:entry.width,height:entry.height};}
        if(pairImageId&&!entry) throw new Error("pairImageId needs imageId");
        const right=pairImageId?await ensureImage(pairImageId):null;
        if(!right&&annotations.some(a=>a.side==="right")) throw new Error("side:'right' needs pairImageId");
        const checked=annotations.map(a=>({...a,author:"user",grounding:"user-pointer"}));
        const pairImage=right?{imageId:pairImageId,width:right.width,height:right.height}:undefined;
        const event=buildAnnotationEvent({scene,image,pairImage,annotations:checked,intent,note,replyQuote});
        const chatMessage=formatAnnotationChatMessage(event);
        let layer=null,pairLayer=null;
        if(right){
          // Paired view: each mark belongs to its own image.
          const sideOf=a=>a.side==="right"?"right":"left";
          layer=storeUserMarks(entry,checked.filter(a=>sideOf(a)==="left").map(({side,...a})=>a));
          pairLayer=storeUserMarks(right,checked.filter(a=>sideOf(a)==="right").map(({side,...a})=>a));
        // Submitted marks join the photo's canvas so GPT need not replay them.
        }else if(entry)layer=storeUserMarks(entry,checked);
        const ids=checked.map(a=>a.id);
        if(entry)await saveCanvas(entry,{tool:"validate_visual_annotations",author:"user",changed:ids,note:intent});
        if(right)await saveCanvas(right,{tool:"validate_visual_annotations",author:"user",changed:ids,note:intent});
        return {
          content:[{type:"text",text:"Validated "+checked.length+" user-authored annotations; explicit interaction intent="+intent+" (geometry only)."}],
          structuredContent:{
            kind:"estampes.validated_annotations",...(scene?{scene}:{imageId}),
            count:checked.length,annotations:checked,event,chatMessage,
            ...(layer?{layer:{id:layer.id,name:layer.name}}:{}),
            ...(pairLayer?{pairLayer:{id:pairLayer.id,name:pairLayer.name}}:{}),
          },
        };
      } catch(error) {
        return {isError:true,content:[{type:"text",text:String(error?.message||error)}]};
      }
    }
  );


  // Private tool for the canvas widget: the user confirms or rejects one of
  // GPT's links in a paired view. The verdict is stored with the link, so
  // GPT's next link table shows it.
  registerAppTool(
    server,
    "review_visual_link",
    {
      title: "Review a link between paired images",
      description: "Record the user's verdict on a link in an Estampes paired view.",
      inputSchema: z.object({
        imageId: ImageIdSchema,
        pairImageId: ImageIdSchema,
        linkId: z.string().min(1).max(64),
        review: z.enum([...LINK_REVIEW, "unreviewed"]),
        reason: z.string().max(200).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ imageId, pairImageId, linkId, review, reason }) => {
      try {
        const left = await ensureImage(imageId);
        const link = reviewLink(left, await ensureImage(pairImageId), linkId, review, reason);
        await saveCanvas(left, { tool: "review_visual_link", author: "user", changed: [linkId], note: review });
        return {
          content: [{ type: "text", text: "Link " + linkId + " marked " + review + " by the user." }],
          structuredContent: { kind: "estampes.link_review", imageId, pairImageId, link: widgetLink(link) },
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] };
      }
    }
  );

  // Private tool for the canvas widget: the user confirms or rejects GPT's
  // note on one mark (what GPT says is there). A rejection is remembered
  // for that place, so GPT cannot simply say it again.
  registerAppTool(
    server,
    "review_visual_finding",
    {
      title: "Review a note on a mark",
      description: "Record the user's verdict on the assistant's note about one mark in an Estampes canvas.",
      inputSchema: z.object({
        imageId: ImageIdSchema.describe("The image the mark is on (the right image's id for a mark on the right of a paired view)"),
        markId: z.string().min(1).max(64),
        review: z.enum([...LINK_REVIEW, "unreviewed"]),
        reason: z.string().max(200).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ imageId, markId, review, reason }) => {
      try {
        const entry = await ensureImage(imageId);
        const mark = reviewFinding(entry, markId, review, reason);
        await saveCanvas(entry, { tool: "review_visual_finding", author: "user", changed: [markId], note: review });
        return {
          content: [{ type: "text", text: "Note on " + markId + " marked " + review + " by the user." }],
          structuredContent: { kind: "estampes.finding_review", imageId, mark },
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] };
      }
    }
  );

  // Private tool for the canvas widget: the user's own edits. Layers can be
  // renamed, reordered, locked and faded; the user's marks from any earlier
  // turn can be moved, restyled or relabelled; any unlocked mark can be
  // deleted. GPT is told about these edits on its next present_visual call.
  const EditMarkSchema = z.object({
    id: z.string().min(1).max(64), side: z.enum(["left", "right"]).optional(),
    x: Point01.optional(), y: Point01.optional(), x2: Point01.optional(), y2: Point01.optional(),
    points: PolylinePointsSchema.optional(), smooth: z.boolean().optional(), closed: z.boolean().optional(),
    label: z.string().max(64).optional(), color: z.enum(MARK_COLORS).optional(), size: z.enum(MARK_SIZES).optional(), pen: z.enum(MARK_PENS).optional(),
  }).strict();
  const LayerIds = z.array(z.string().regex(/^L\d{1,6}$/)).max(200);
  registerAppTool(
    server,
    "edit_visual_canvas",
    {
      title: "Edit the visual canvas",
      description: "Apply the user's own layer and mark edits from the Estampes canvas.",
      inputSchema: z.object({
        imageId: ImageIdSchema,
        pairImageId: ImageIdSchema.optional(),
        layers: z.array(z.object({
          id: z.string().regex(/^L\d{1,6}$/), side: z.enum(["left", "right"]).optional(),
          name: z.string().max(LAYER_NAME_MAX).optional(), locked: z.boolean().optional(), opacity: z.number().min(0).max(1).optional(),
        }).strict()).max(60).default([]),
        order: z.object({ left: LayerIds.optional(), right: LayerIds.optional() }).strict().optional().describe("Layer ids bottom to top"),
        marks: z.array(EditMarkSchema).max(30).default([]),
        remove: z.array(z.object({ id: z.string().min(1).max(64), side: z.enum(["left", "right"]).optional() }).strict()).max(30).default([]),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ imageId, pairImageId, layers, order, marks, remove }) => {
      try {
        const left = await ensureImage(imageId), right = pairImageId ? await ensureImage(pairImageId) : null;
        if (!right && [...layers, ...marks, ...remove].some((x) => x.side === "right")) throw new Error("side:'right' needs pairImageId");
        if (!right && order?.right) throw new Error("order.right needs pairImageId");
        const resolveUser = (m) => {
          const { side: _s, ...rest } = m;
          return replayUserAnnotation(VisualAnnotationSchema.parse(rest));
        };
        const pick = (side) => ({
          layers: layers.filter((l) => (l.side ?? "left") === side).map(({ side: _s, ...l }) => l),
          order: order?.[side],
          marks: marks.filter((m) => (m.side ?? "left") === side),
          remove: remove.filter((m) => (m.side ?? "left") === side).map((m) => m.id),
          resolveUser,
        });
        const undoLeft = snapshotCanvas(left), leftEdits = [...(left.userEdits ?? [])];
        const edits = editCanvas(left, pick("left"));
        let rightEdits = [];
        if (right) {
          try { rightEdits = editCanvas(right, pick("right")); }
          catch (error) { undoLeft(); left.userEdits = leftEdits; throw error; }
        }
        const history = { tool: "edit_visual_canvas", author: "user" };
        await saveCanvas(left, { ...history, changed: edits.map((e) => e.id ?? e.layer ?? e.kind) });
        if (right) await saveCanvas(right, { ...history, changed: rightEdits.map((e) => e.id ?? e.layer ?? e.kind) });
        const all = right ? pairMarks(left, right) : canvasMarks(left);
        return {
          content: [{ type: "text", text: "Applied " + (edits.length + rightEdits.length) + " user edit(s) to " + imageId + (right ? " + " + pairImageId : "") + "." }],
          structuredContent: {
            kind: "estampes.canvas_edit", imageId, ...(right ? { pairImageId } : {}),
            edits: [...edits.map((e) => ({ ...e, side: "left" })), ...rightEdits.map((e) => ({ ...e, side: "right" }))],
            annotations: all, layers: right ? pairLayers(left, right) : canvasLayers(left),
            ...(right ? { links: pairLinks(left, right).map(compactLink) } : {}),
          },
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] };
      }
    }
  );

  // Image analysis and user-facing UI have separate contracts. This resource
  // is retained only for explicit standalone viewer compatibility.
  registerAppResource(
    server,
    "Estampes visual evidence preview",
    EVIDENCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents:[{uri:EVIDENCE_URI,mimeType:RESOURCE_MIME_TYPE,text:evidenceHtml}]
    })
  );

  for (const uri of LEGACY_EVIDENCE_URIS) {
    registerAppResource(
      server,
      "Estampes visual evidence (legacy " + uri.match(/v\d+/)[0] + ")",
      uri,
      { mimeType: RESOURCE_MIME_TYPE },
      async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: evidenceHtml }] })
    );
  }

  // Model pixel-inspection tool: image blocks are for GPT, no UI attached.
  // Returns real PNG image bytes in the MCP content array, not object names.
  // Some hosts do not forward these blocks to their vision model.
  server.registerTool(
    "inspect_visual",
    {
      title:"Inspect actual source pixels and annotated region",
      description:
        "Retrieve PIXEL IMAGES for a user-marked location on an Estampes demo SVG. Call this when asked what a marked object is, rather than inferring objects from coordinates or scene names. Pass imageId='demo:'+scene, revision='svg-v1', and focus={type:'point'|'rect'|'arrow',x,y[,x2,y2]} copied from the user's Estampes annotation; for arrows the crop centres on the head x2/y2; when the user's arrow shows a direction rather than a target, pass a rect covering the whole arrow instead. Returns original PNG, full PNG with focus overlay, and locally cropped magnified PNG. These are image content blocks plus geometry metadata; if your host does not expose image pixels to vision, explicitly state that and do not guess the object's identity. This M0.4.3 tool supports ONLY bundled SVG demo images, not arbitrary user uploads or ChatGPT image search.",
      inputSchema:z.object({
        scene:SceneSchema,
        imageId:z.string().min(1).max(80),
        revision:z.literal("svg-v1"),
        focus:z.object({
          type:z.enum(["point","rect","arrow"]),
          x:Point01,y:Point01,
          x2:Point01.optional(),y2:Point01.optional(),
        }).superRefine((a,ctx)=>{
          if(a.type!=="point"&&(a.x2===undefined||a.y2===undefined)){
            ctx.addIssue({code:"custom",message:"Rect and arrow require x2/y2"});
          }
        }),
        padding:z.number().finite().min(0.02).max(0.2).default(0.08),
      }),
      outputSchema:z.object({
        kind:z.literal("estampes.visual_evidence"),
        imageId:z.string(),
        revision:z.string(),
        source:z.object({kind:z.literal("svg"),logicalSize:z.object({
          width:z.number(),height:z.number(),unit:z.literal("svg-user-unit"),
        })}),
        rendered:z.object({width:z.number(),height:z.number(),mimeType:z.literal("image/png")}),
        coordinateSystem:z.literal("normalized-top-left"),
        focus:z.object({
          type:z.string(),x:z.number(),y:z.number(),
          x2:z.number().optional(),y2:z.number().optional(),
        }),
        crop:z.object({left:z.number(),top:z.number(),width:z.number(),
          height:z.number(),origin:z.string(),target:z.string()}),
        evidenceCount:z.literal(3),
        modelVisionStatus:z.literal("host-dependent-unverified"),
      }),
      annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    },
    async ({scene,imageId,revision,focus,padding})=>{
      try {
        const evidence=await createVisualEvidence({scene,imageId,revision,focus,padding});
        const {images,...metadata}=evidence;
        return {
          content:[
            {type:"text",text:"Estampes visual evidence for "+imageId+" / "+revision+
              ". The NEXT THREE MCP blocks contain real PNG pixels: (1) original whole image, (2) whole image with NEUTRAL inspection-focus overlay (not an authored annotation), (3) enlarged raw crop with no overlay. "+
              "Focus metadata: "+JSON.stringify({focus:evidence.focus,crop:evidence.crop})+
              ". Please identify the marked object ONLY if you can actually perceive the image content. Do not infer the answer from sceneId or coordinates alone. "+
              "If your ChatGPT host hides image blocks from the model, say you could not inspect the pixels."},
            {type:"image",data:images.original.toString("base64"),mimeType:"image/png"},
            {type:"image",data:images.marked.toString("base64"),mimeType:"image/png"},
            {type:"image",data:images.crop.toString("base64"),mimeType:"image/png"},
          ],
          structuredContent:{
            kind:"estampes.visual_evidence",
            imageId,revision,source:metadata.source,rendered:metadata.rendered,
            coordinateSystem:metadata.coordinateSystem,focus:metadata.focus,
            crop:metadata.crop,evidenceCount:3,
            modelVisionStatus:"host-dependent-unverified",
          },
        };
      } catch(error) {
        return {isError:true,content:[{type:"text",text:"Estampes image processing failed: "+String(error?.message||error)}]};
      }
    }
  );


  // This UI tool is separate from inspect_visual, which provides MCP image
  // blocks to the model but must not be expected to create a host widget.
  registerAppTool(
    server,
    "present_visual_evidence",
    {
      title:"Show Estampes visual evidence",
      description:
        "LEGACY standalone PNG evidence viewer, retained for older conversations and explicit requests for the separate 3-PNG view. Do NOT call after present_visual in the same visual task: present_visual now already includes annotation, original image and zoom in one shared canvas. For general new ChatGPT visual exchanges prefer inspect_visual (model pixels) followed by present_visual (one UI). This tool performs no object recognition.",
      inputSchema:z.object({
        scene:SceneSchema,
        imageId:z.string().min(1).max(80),
        revision:z.literal("svg-v1"),
        focus:z.object({
          type:z.enum(["point","rect","arrow"]),x:Point01,y:Point01,
          x2:Point01.optional(),y2:Point01.optional()
        }).superRefine((a,ctx)=>{
          if(a.type!=="point"&&(a.x2===undefined||a.y2===undefined))
            ctx.addIssue({code:"custom",message:"Rect/arrow require x2/y2"});
        }),
        padding:z.number().finite().min(0.02).max(0.2).default(0.08),
      }),
      outputSchema:z.object({
        kind:z.literal("estampes.visual_evidence_view"),
        imageId:z.string(),revision:z.string(),
        focus:z.object({
          type:z.string(),x:z.number(),y:z.number(),
          x2:z.number().optional(),y2:z.number().optional()
        }),
        crop:z.object({
          left:z.number(),top:z.number(),width:z.number(),height:z.number(),
          origin:z.string(),target:z.string()
        }),
        rendered:z.object({width:z.number(),height:z.number(),mimeType:z.literal("image/png")}),
      }),
      annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
      _meta:{ui:{resourceUri:EVIDENCE_URI},"openai/outputTemplate":EVIDENCE_URI},
    },
    async ({scene,imageId,revision,focus,padding})=>{
      try{
        const e=await createVisualEvidence({scene,imageId,revision,focus,padding});
        return {
          content:[{type:"text",text:"Estampes image viewer: actual PNGs are available to the inline widget. Object identification is not performed by Estampes."}],
          structuredContent:{
            kind:"estampes.visual_evidence_view",imageId,revision,
            focus:e.focus,crop:e.crop,rendered:e.rendered,
          },
          // Widget-only payload. structuredContent is also read by the model,
          // so ~100 KB of base64 there would only burn its context window.
          _meta:{
            "estampes/images":{
              original:e.images.original.toString("base64"),
              marked:e.images.marked.toString("base64"),
              crop:e.images.crop.toString("base64")
            }
          }
        };
      }catch(e){
        return {isError:true,content:[{type:"text",text:"Image viewer error: "+String(e?.message||e)}]};
      }
    }
  );

  // ---- M0.5 real-image preprocessing -------------------------------------
  // Images come from ChatGPT's native file handling (openai/fileParams) or a
  // public URL; there is no Estampes upload UI. Outputs are image blocks for
  // the model plus coordinates normalized to the full oriented source image.
  const imageBlock = (out) => ({ type: "image", data: out.data.toString("base64"), mimeType: out.mimeType });
  const fail = (error) => ({ isError: true, content: [{ type: "text", text: "Estampes: " + String(error?.message || error) }] });

  server.registerTool(
    "load_image",
    {
      title: "Load a real image for Estampes",
      description:
        "Load a photo, scan or picture so Estampes can preprocess it (enhance, zoom, grid). To simply SHOW the user a photo with marks, call present_visual with the image directly instead; it loads it too. Pass `image` for a file the user attached or photographed in this ChatGPT conversation, OR `imageUrl` for a public https image you found. Returns an imageId plus a preview image. Use the imageId with process_image (enhance, threshold, edges, zoom into a region) and overlay_grid (labelled grid for precise locating). Estampes never identifies content; you do, from the returned pixels.",
      inputSchema: z.object({
        image: ChatFileSchema.optional().describe("Image file from the conversation"),
        imageUrl: z.string().url().max(2048).optional().describe("Public https URL of an image"),
      }),
      outputSchema: z.object({
        kind: z.literal("estampes.image"),
        imageId: z.string(),
        width: z.number(), height: z.number(),
        original: z.object({ format: z.string().optional(), width: z.number().optional(), height: z.number().optional() }),
        source: z.enum(["chat-file", "url"]),
        coordinateSystem: z.literal("normalized-top-left"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { "openai/fileParams": ["image"] },
    },
    async ({ image, imageUrl }) => {
      try {
        if (!image === !imageUrl) throw new Error("Provide exactly one of image or imageUrl");
        const entry = await loadImageInput({ image, imageUrl });
        const preview = await previewImage(entry);
        return {
          content: [
            { type: "text", text: "Loaded " + entry.imageId + " (" + entry.width + "x" + entry.height +
              " after orientation). The next block is a preview. Coordinates for every Estampes tool are normalized to this full image, top-left origin." },
            imageBlock(preview),
          ],
          structuredContent: {
            kind: "estampes.image", imageId: entry.imageId, width: entry.width, height: entry.height,
            original: entry.original, source: entry.source, coordinateSystem: "normalized-top-left",
          },
        };
      } catch (error) { return fail(error); }
    }
  );

  // One renderer for process_image and get_derived_view: remembers the
  // recipe (and stores it with the image) so the view can be rebuilt by id.
  async function deliverView(entry, spec) {
    const out = await renderView(entry, spec);
    const record = rememberView(entry, out.record);
    await saveDerived(entry);
    return { out, record };
  }
  const viewText = (imageId, out, record, ops) => {
    const ev = record.evidence;
    return "Processed " + imageId + " region " + JSON.stringify(out.region) +
      " with " + (ops.map(o => o.op).join(" > ") || "no ops") + " (analysis at " + record.analysis.space + " resolution, " +
      record.analysis.width + "x" + record.analysis.height + " px; " + ev.sourcePixelsPerOutputPixel + " source px per output px). " +
      "derivedViewId " + record.derivedViewId + ". The next block is the result, " + out.width + "x" + out.height + " px" +
      (ev.warnings.length ? ". Caveats: " + ev.warnings.join("; ") : "") +
      ". To mark something you see in it, call present_visual with coordinateFrame {derivedViewId: " + JSON.stringify(record.derivedViewId) +
      "} and pixel coordinates from this image (older form: {region: " + JSON.stringify(out.region) + ", width: " + out.width + ", height: " + out.height + "}).";
  };
  // What the model gets about a view: everything except the step list.
  const viewSummary = (record) => {
    const { coordinateMapping: { steps, ...mapping }, ...rest } = record;
    return { ...rest, coordinateMapping: { ...mapping, steps: steps.map((st) => st.kind) } };
  };
  const DerivedViewSchema = z.record(z.string(), z.unknown());

  server.registerTool(
    "process_image",
    {
      title: "Preprocess an image region",
      description:
        "Return a processed view of a loaded image to help you read or locate details. Optionally crop to `region`, then apply `ops` in order, e.g. [{op:'clahe'},{op:'sharpen'}] for blurry scans or dark boards, [{op:'grayscale'},{op:'threshold',method:'adaptive'}] for handwriting and book pages, [{op:'edges'}] for thin lines and outlines. " +
        "`sampling.mode` picks the resolution the ops run at: preview (default; old behaviour, the crop is resized to the output first and zoomed up to 8x by interpolation), working (the cached working copy at its own pixels), native (pixels cut from the original file; use it for small text, fine traces and anything you must not guess, before trying interpolation). " +
        "`output` picks the delivered size and codec (png/webp are lossless). Every result has a derivedViewId, a coordinate mapping back to the image and caveats (interpolated, lossy, thresholded, enhanced): enhanced pixels are not new evidence, so check the original. Output is for your analysis; the user sees the original unless you choose to show this.",
      inputSchema: z.object({
        imageId: ImageIdSchema,
        region: RegionSchema.optional(),
        ops: z.array(OpSchema).max(8).default([]),
        sampling: SamplingSchema.optional(),
        output: OutputSpecSchema.optional(),
      }),
      outputSchema: z.object({
        kind: z.literal("estampes.processed_image"),
        imageId: z.string(),
        region: z.object({ x: z.number(), y: z.number(), x2: z.number(), y2: z.number() }),
        ops: z.array(z.record(z.string(), z.unknown())),
        output: z.object({ width: z.number(), height: z.number(), mimeType: z.string(), scale: z.number() }),
        derivedViewId: z.string().optional(),
        derivedView: DerivedViewSchema.optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ imageId, region, ops, sampling, output }) => {
      try {
        const { out, record } = await deliverView(await ensureImage(imageId), { region, ops, sampling, output });
        return {
          content: [{ type: "text", text: viewText(imageId, out, record, ops) }, imageBlock(out)],
          structuredContent: {
            kind: "estampes.processed_image", imageId, region: out.region, ops,
            output: { width: out.width, height: out.height, mimeType: out.mimeType, scale: out.scale },
            derivedViewId: record.derivedViewId, derivedView: viewSummary(record),
          },
        };
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "get_derived_view",
    {
      title: "Re-render a processed view",
      description: "Render a processed view again from its derivedViewId (its recipe is kept with the image, also across restarts with storage), optionally at another delivered size or codec. Use it to look at an earlier result again or to get a lossless copy, instead of rebuilding the recipe. `includeImage:false` returns only the record (recipe, coordinate mapping, caveats).",
      inputSchema: z.object({
        imageId: ImageIdSchema,
        derivedViewId: DerivedViewIdSchema,
        output: OutputSpecSchema.optional().describe("Different delivered size or codec (gives a new derivedViewId)"),
        includeImage: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ imageId, derivedViewId, output, includeImage }) => {
      try {
        const entry = await ensureImage(imageId);
        const saved = findView(entry, derivedViewId);
        if (!saved) throw new Error("No processed view " + derivedViewId + " for " + imageId + "; recipes are kept for the last " + config.derivedViewsPerImage + " views of an image");
        if (!includeImage) {
          return { content: [{ type: "text", text: VIEW_API + " record " + JSON.stringify(viewSummary(saved)) }], structuredContent: { kind: "estampes.derived_view", derivedView: saved } };
        }
        const { recipe } = saved;
        const { out, record } = await deliverView(entry, { ...recipe, output: output ? { ...recipe.output, ...output } : recipe.output });
        const reproduced = !output && record.derivedViewId === derivedViewId;
        return {
          content: [{ type: "text", text: (output ? "" : reproduced ? "Re-rendered from its recipe. " : "WARNING: the recipe now gives a different id (" + record.derivedViewId + "), so an operator changed since it was made. ") +
            viewText(imageId, out, record, recipe.ops) }, imageBlock(out)],
          structuredContent: { kind: "estampes.derived_view", derivedViewId: record.derivedViewId, reproduced, derivedView: viewSummary(record) },
        };
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "inspect_image",
    {
      title: "Describe an image source",
      description: "Report what Estampes knows about a loaded image without returning pixels: source file format, size before and after EXIF orientation, colour space, bit depth, alpha, ICC profile, density, the SHA-256 source asset id, the working copy's size, the coordinate spaces and the matrices between them, and the processed views made so far. Use it to decide whether native-resolution processing can show more than the working copy.",
      inputSchema: z.object({ imageId: ImageIdSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ imageId }) => {
      try {
        const entry = await ensureImage(imageId);
        const src = entry.sourceInfo ?? { width: entry.width, height: entry.height };
        const info = {
          kind: "estampes.image_source", apiVersion: VIEW_API, imageId, sourceAssetId: entry.sourceAssetId ?? null,
          source: { ...src, origin: entry.source, fileName: entry.fileName ?? null },
          working: { width: entry.width, height: entry.height, colorSpace: "srgb", alpha: "flattened on white", scaleFromSource: Number((entry.width / src.width).toFixed(6)) },
          ...(entry.page ? { page: entry.page } : {}),
          spaces: {
            normalized: "0..1 of the oriented source, top-left origin; every mark and region uses it",
            source: { width: src.width, height: src.height, normalizedToSource: roundMatrix(scaleMatrix(src.width, src.height)) },
            working: { width: entry.width, height: entry.height, normalizedToWorking: roundMatrix(scaleMatrix(entry.width, entry.height)) },
          },
          nativeDetailAvailable: src.width > entry.width,
          derivedViews: [...(entry.derivedViews?.values() ?? [])].slice(-20).map((v) => ({ derivedViewId: v.derivedViewId, ops: v.recipe.ops.map((o) => o.op), region: v.recipe.region, sampling: v.recipe.sampling.mode })),
        };
        return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "overlay_grid",
    {
      title: "Overlay a labelled grid",
      description:
        "Draw a labelled grid (rows A,B,C..., columns 1,2,3...) over a loaded image or a region of it, so you can name where something is ('it is in C7') instead of guessing decimals. structuredContent.cellCenters gives each cell's centre in source coordinates; use those values as present_visual x/y. For finer positioning call again with region set to the chosen cell or neighbourhood.",
      inputSchema: z.object({
        imageId: ImageIdSchema,
        region: RegionSchema.optional(),
        rows: z.number().int().min(2).max(12).default(8),
        cols: z.number().int().min(2).max(12).default(8),
      }),
      outputSchema: z.object({
        kind: z.literal("estampes.grid"),
        imageId: z.string(),
        region: z.object({ x: z.number(), y: z.number(), x2: z.number(), y2: z.number() }),
        rows: z.number(), cols: z.number(),
        cellCenters: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ imageId, region, rows, cols }) => {
      try {
        const out = await overlayGrid(await ensureImage(imageId), { region, rows, cols });
        const cellCenters = {};
        for (let r = 0; r < rows; r++) for (let c = 1; c <= cols; c++) {
          const label = rowLabel(r) + c;
          const p = cellCenter(label, { rows, cols, region: out.region });
          cellCenters[label] = { x: Number(p.x.toFixed(4)), y: Number(p.y.toFixed(4)) };
        }
        return {
          content: [
            { type: "text", text: "Grid " + rows + "x" + cols + " over " + imageId + " region " + JSON.stringify(out.region) +
              ". Rows are letters from the top, columns numbers from the left. The next block is the gridded image." },
            imageBlock(out),
          ],
          structuredContent: { kind: "estampes.grid", imageId, region: out.region, rows, cols, cellCenters },
        };
      } catch (error) { return fail(error); }
    }
  );

  return server;
}

// SDK 2.x handles 2026-07-28 server/discover and legacy initialize on the same
// endpoint. No request-body listeners: they would consume the stream before the
// MCP transport can parse it.
const mcpHandler = toNodeHandler(createMcpHandler(makeServer));

const port = config.port;

// Shared secret. When there is one, /mcp and /api require it as "?key=..."
// in the connector URL (ChatGPT's "No authentication" mode can still carry
// it) or as "Authorization: Bearer ...". It comes from ESTAMPES_ACCESS_KEY,
// or, with ESTAMPES_REQUIRE_KEY=1 (Docker), from the storage folder, where
// it is generated on first start. Set before the server listens.
let ACCESS_KEY = "";
// "*" by default so browser tools such as MCP Inspector keep working; ChatGPT
// calls /mcp server-to-server and does not need CORS at all.
const CORS_ORIGINS = config.corsOrigins;
const RATE_LIMIT = config.rateLimitPerMin;
const hits = new Map();

function corsOrigin(req) {
  if (CORS_ORIGINS.includes("*")) return "*";
  const origin = req.headers.origin;
  return origin && CORS_ORIGINS.includes(origin) ? origin : null;
}

function authorized(req, url) {
  if (!ACCESS_KEY) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
  return sameSecret(url.searchParams.get("key"), ACCESS_KEY) || sameSecret(bearer, ACCESS_KEY);
}

// Fixed one-minute window per client IP (see clientIp for when
// X-Forwarded-For counts). In-memory is enough for a single instance.
function rateLimited(req) {
  if (!(RATE_LIMIT > 0)) return false;
  const ip = clientIp(req, config.trustProxy);
  const now = Date.now();
  let entry = hits.get(ip);
  if (!entry || now - entry.start >= 60000) {
    entry = { start: now, count: 0 };
    hits.set(ip, entry);
    if (hits.size > 10000) {
      for (const [key, value] of hits) if (now - value.start >= 60000) hits.delete(key);
    }
  }
  return ++entry.count > RATE_LIMIT;
}
const httpServer = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/version" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({
      name: "Estampes",
      version: BUILD_VERSION,
      uiResourceUri: WIDGET,
      selectionTool: "record_number_line_selection",
      visualResourceUri: VISUAL_URI,
      visualTool: "present_visual",
      visualGroundingMode: "coordinates-only-no-object-anchors",
      visualValidationTool: "validate_visual_annotations",
      annotationProtocol: "0.2-draft",
      visualInputTool: "inspect_visual",
      visualDisplayTool: "present_visual",
      legacyVisualDisplayTool: "present_visual_evidence",
      visualCanvasModes: ["annotated","original","zoom"],
      visualCanvasPresentation: "single-shared-ui",
      visualEvidenceResourceUri: EVIDENCE_URI,
      visualEvidencePresentation: "explicit-render-tool",
      visualInputFormat: "mcp-image-content-png",
      visualModelVisibility: "host-dependent-unverified",
      accessKeyRequired: Boolean(ACCESS_KEY),
      imageTools: ["load_image", "process_image", "overlay_grid", "inspect_image", "get_derived_view"],
      imageApi: VIEW_API,
      imageInput: ["openai-file-param", "https-url"],
      visualProtocol: VISUAL_PROTOCOL,
      stateTool: "get_visual_state",
      stateApi: "/api/v1/canvas/{hash}",
      storage: config.storageDir ? "disk" : "memory",
    }));
    return;
  }

  // Downloads for the canvas: the working image (EXIF-oriented, long side
  // <= 4096, the frame every coordinate refers to) and a layered marks SVG.
  // No access key: the id is a content hash, unguessable without the image.
  const exportMatch = /^\/export\/([0-9a-f]{16})\/(image\.jpg|marks\.svg)$/.exec(url.pathname);
  if (exportMatch && req.method === "GET") {
    const imageId = "img:" + exportMatch[1];
    const svg = exportMatch[2] === "marks.svg";
    if (!exportAllowed(ACCESS_KEY, exportMatch[1], exportMatch[2], url.searchParams.get("sig"))) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("This download link is not signed for this server. Ask for the canvas again to get a fresh link.");
      return;
    }
    ensureImage(imageId).then((entry) => {
      Promise.resolve(svg ? Buffer.from(exportMarksSvg(entry, canvasMarks(entry), canvasLayers(entry))) : entrySharp(entry).jpeg({ quality: 92 }).toBuffer())
      .then((body) => {
        res.writeHead(200, {
          "content-type": svg ? "image/svg+xml; charset=utf-8" : "image/jpeg",
          "content-disposition": "attachment; filename=\"estampes-" + exportMatch[1] + (svg ? "-marks.svg" : ".jpg") + "\"",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
          "cache-control": "no-store",
        });
        res.end(body);
      })
      .catch((error) => { res.writeHead(500); res.end(String(error?.message || error)); });
    }, () => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Image expired from this server" + (config.storageDir ? "" : " (memory only)") + ". Show it again in ChatGPT, then export.");
    });
    return;
  }

  // The canvas as an estampes.visual/1 document for other tools and
  // scripts: /api/v1/canvas/<hash>[?pair=<hash>][&history=N]. Uses the
  // access key when one is set.
  const apiMatch = /^\/api\/v1\/canvas\/([0-9a-f]{16})$/.exec(url.pathname);
  if (apiMatch && req.method === "GET") {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    if (!authorized(req, url)) { json(401, { error: "Missing or invalid Estampes access key" }); return; }
    const pairHex = url.searchParams.get("pair"), history = Math.min(200, Math.max(0, Number(url.searchParams.get("history")) || 0));
    if (pairHex && !/^[0-9a-f]{16}$/.test(pairHex)) { json(400, { error: "pair must be a 16-character image hash" }); return; }
    Promise.all([ensureImage("img:" + apiMatch[1]), pairHex ? ensureImage("img:" + pairHex) : null])
      .then(async ([left, right]) => json(200, canvasDocument(left, right, history ? { history: await readHistory(left.imageId, history) } : {})))
      .catch((error) => json(404, { error: String(error?.message || error) }));
    return;
  }

  // For Docker/compose health checks and uptime monitors: 200 while the
  // server answers and, when storage is on, the storage folder is writable.
  if (url.pathname === "/healthz" && req.method === "GET") {
    storageHealth().then((storage) => {
      const ok = !storage.enabled || storage.writable;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok, version: BUILD_VERSION, uptimeSeconds: Math.round(process.uptime()), storage }));
    });
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Estampes MCP M0 (SDK 2.x)");
    return;
  }

  if (url.pathname === "/mcp" && req.method === "OPTIONS") {
    const origin = corsOrigin(req);
    res.writeHead(204, origin ? {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers":
        "content-type, accept, authorization, mcp-session-id, mcp-protocol-version",
      "access-control-expose-headers": "Mcp-Session-Id",
      ...(origin === "*" ? {} : { vary: "Origin" }),
    } : {});
    res.end();
    return;
  }

  if (url.pathname === "/mcp" && ["GET", "POST", "DELETE"].includes(req.method)) {
    const origin = corsOrigin(req);
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-expose-headers", "Mcp-Session-Id");
      if (origin !== "*") res.setHeader("vary", "Origin");
    }
    if (!authorized(req, url)) {
      res.writeHead(401, { "content-type": "text/plain", "www-authenticate": "Bearer" });
      res.end("Missing or invalid Estampes access key");
      return;
    }
    if (rateLimited(req)) {
      res.writeHead(429, { "content-type": "text/plain", "retry-after": "60" });
      res.end("Too many requests");
      return;
    }
    if (!config.publicUrl && req.headers.host) {
      // Forwarded headers only from a trusted proxy.
      const fwd = (name) => config.trustProxy > 0 ? String(req.headers[name] ?? "").split(",")[0].trim() : "";
      const proto = fwd("x-forwarded-proto") || "http";
      const host = fwd("x-forwarded-host") || String(req.headers.host).trim();
      if (/^[a-z0-9.:[\]-]+$/i.test(host) && /^https?$/.test(proto)) seenOrigin = proto + "://" + host;
    }
    const start = Date.now();
    res.once("finish", () => {
      log("info", "[mcp] " + req.method + " status=" + res.statusCode + " ms=" + (Date.now() - start));
    });
    Promise.resolve(mcpHandler(req, res)).catch((error) => {
      log("error", "[mcp] handler error", { error: String(error?.stack || error) });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal MCP error");
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// Checked at most every 30 s so a health probe never hammers the disk.
let lastHealth = null;
async function storageHealth() {
  if (lastHealth && Date.now() - lastHealth.at < 30000) return lastHealth.value;
  let value;
  try { value = { ...(await checkStorage()), writable: true }; }
  catch (error) { value = { enabled: true, writable: false, error: String(error?.message || error) }; }
  if (!config.storageDir) value = { enabled: false };
  lastHealth = { at: Date.now(), value };
  return value;
}

for (const warning of configWarnings()) log("warn", "[config] " + warning);
const storage = await storageHealth();
const keyInfo = await resolveAccessKey({ configured: config.accessKey, require: config.requireKey, allowOpen: config.allowOpen,
  storageDir: storage.enabled && storage.writable ? config.storageDir : "" });
ACCESS_KEY = keyInfo.key;
// The key is printed once, when it is made; afterwards only where it lives.
if (keyInfo.source === "generated" || keyInfo.source === "memory") {
  log("warn", "[auth] generated an access key. Connect ChatGPT to https://<your host>/mcp?key=" + keyInfo.key +
    (keyInfo.path ? " (saved in " + keyInfo.path + "; read it again with: docker compose exec estampes cat " + keyInfo.path + ")" : " (not saved: no storage; it changes on restart)"));
} else if (keyInfo.source === "file") {
  log("info", "[auth] access key loaded from " + keyInfo.path + " (docker compose exec estampes cat " + keyInfo.path + ")");
} else if (keyInfo.source === "open") {
  log(config.requireKey ? "warn" : "info", "[auth] no access key: anyone who can reach /mcp can use this server" +
    (config.requireKey ? " (ESTAMPES_ALLOW_OPEN=1)" : ""));
}
if (storage.enabled && !storage.writable) log("error", "[storage] not writable; marks will only live in memory", { dir: config.storageDir, error: storage.error });
if (storage.enabled) {
  sweepStorage().catch(() => {});
  setInterval(() => sweepStorage().catch(() => {}), 6 * 3600 * 1000).unref();
}

// The quick tunnel's address, once cloudflared has one. The owner's own log
// is where the full connector URL (with the key) is meant to be read.
if (config.tunnelMetrics) {
  watchQuickTunnel(config.tunnelMetrics, (origin) => {
    tunnelOrigin = origin;
    log("warn", "[tunnel] public address " + origin + ". ChatGPT connector URL: " + origin + "/mcp" + (ACCESS_KEY ? "?key=" + ACCESS_KEY : "") +
      " (temporary: it changes when the tunnel restarts)");
  });
}

httpServer.listen(port, config.host, () => {
  log("info", "Estampes " + VERSION + " MCP server at http://localhost:" + port + "/mcp", {
    storage: config.storageDir || "memory-only", accessKey: ACCESS_KEY ? "required (" + keyInfo.source + ")" : "off", trustProxy: config.trustProxy,
    maxImageMB: config.maxImageBytes / 1048576, publicUrl: config.publicUrl || "from-request",
  });
});

// docker stop / Heroku dyno restart send SIGTERM: finish pending writes first.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    log("info", "[shutdown] " + signal);
    httpServer.close();
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref();
    flushStorage().finally(() => process.exit(0));
  });
}
