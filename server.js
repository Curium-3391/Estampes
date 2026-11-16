import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
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
import { GESTURE_VERDICTS, gestureGroups, recordGestureDecision } from "./src/gesture-groups.js";
import { createVisualEvidence } from "./src/visual-input.js";
import {
  applyCanvasChanges, canvasMarks, canvasLayers, snapshotCanvas, storeUserMarks, importMarks, shownLinks,
  applyPairChanges, pairLinks, reviewLink, reviewFinding, applyWorkspaceChanges, workspaceLinks, reviewWorkspaceLink, LINK_CONFIDENCE, LINK_REVIEW, editCanvas, takeUserEdits, LAYER_NAME_MAX,
  undoCanvasEdit, redoCanvasEdit, canvasHistory,
} from "./src/canvas-state.js";
import { CONFIDENCE, EVIDENCE_KINDS, evidenceCount, verificationOf, needsReview, rejectionText } from "./src/assessment.js";
import { renderVerification, inkReport } from "./src/mark-render.js";
import { exportMarksSvg, parseMarksFile } from "./src/marks-file.js";
import { downloadImage, entrySharp, MAX_DOWNLOAD_BYTES } from "./src/image-store.js";
import { exportBundle, importBundle } from "./src/bundle.js";
import { config, configWarnings, log } from "./src/config.js";
import { VISUAL_PROTOCOL, canvasDocument } from "./src/protocol.js";
import { watchQuickTunnel } from "./src/tunnel.js";
import { resolveAccessKey, sameSecret, clientIp, exportSignature, exportAllowed } from "./src/security.js";
import {
  WORKSPACE_PROTOCOL, MAX_ITEMS, getWorkspace, ensureSet, createWorkspace, editWorkspace, previewTransfer, commitTransfer, undoChange, resolveRef, workspaceDocument, workspaceItems,
} from "./src/workspace.js";
import { readSource, intakeImage as intakeImageFile, ensureImage as ensureImageFile, saveCanvas as saveCanvasFile, saveDerived, saveDocument, loadDocument, checkStorage, flushStorage, sweepStorage, readHistory, useRecords, useCanvasStore } from "./src/storage.js";
import { renderView, analysisFor, rememberView, findView, frameFromView, SAMPLING_MODES, OUTPUT_FORMATS, VIEW_API, MAX_DELIVERY_SIDE } from "./src/image/view.js";
import { scale as scaleMatrix, roundMatrix, apply as applyMatrix } from "./src/image/transform.js";
import { registerPair, compareView, MODELS as REGISTER_MODELS } from "./src/image/register.js";
import { measureQuality, clippingMap } from "./src/image/quality.js";
import { runEngine, listEngines } from "./src/image/engines.js";
import { pdfAvailable, renderPdfPage, pdfInfo, isPdf, MAX_DPI } from "./src/image/pdf.js";
import { calibrate, measure, toSpacePixels, spaceToNormalized, defaultSigma, UNITS } from "./src/image/measure.js";
import {
  overlayGrid, previewImage, cellCenter, rowLabel, displayImage, widgetImage, compactForDisplay, regionTile,
} from "./src/image-ops.js";
import { createUvaService } from "./src/uva/service.js";
import { createCanvasStore } from "./src/uva/canvas-store.js";

// With the UVA store on, src/storage.js reads and writes canvases, images and
// workspaces through it (src/uva/canvas-store.js, src/uva/record-store.js), so
// every module that loads or saves a canvas reaches the store the same way.
// A canvas save is acknowledged only once its record is durable.
let canvasStore = null;
const saveCanvas = (entry, meta) => saveCanvasFile(entry, meta);
const ensureImage = (imageId) => ensureImageFile(imageId);
const intakeImage = (bytes, options) => intakeImageFile(bytes, options);
// Workspaces, panel surfaces and calculator notebooks live in the UVA store
// when it is on (src/uva/record-store.js): their modules read and write
// through it, and write no files of their own.
let recordStore = null;
import { registerUvaTools } from "./src/uva/mcp-tools.js";
import { createRecordStore } from "./src/uva/record-store.js";
import { createModuleHost } from "./src/modules/index.js";
import { resolveAdminKey } from "./src/modules/admin.js";
import sharp from "sharp";
import { fitResult } from "./src/result-budget.js";
import { createHash, randomBytes } from "node:crypto";
import { createOAuth, readBody } from "./src/oauth.js";
import { registerModuleTools } from "./src/modules/mcp-tools.js";
import { registerTextTools } from "./src/visual/text-tools.js";
import { registerLayerTools } from "./src/visual/layer-tools.js";
import { renderCanvas, canvasReadRequest, canvasRevision } from "./src/scene/canvas-render.js";
import { createRevisionTracker, classifyChange, MAX_POLLED_DOCUMENTS } from "./src/visual/document-revisions.js";
import { composeCanvas } from "./src/scene/compose.js";
import { createBlankCanvas } from "./src/scene/blank-canvas.js";
import { createCasClient } from "./src/cas/client.js";
import { createNotebooks } from "./src/cas/notebooks.js";
import { createSurfaceStore } from "./src/surface/store.js";
import { createSurfaceService } from "./src/surface/service.js";
import { inlineWorkbench } from "./src/surface/widget-source.js";
import { collectBundleExtras, installBundleExtras } from "./src/surface/bundle-extras.js";
import { autoRefresh } from "./src/surface/refresh.js";
import { registerSurfaceTools } from "./src/surface/mcp-tools.js";
import { configure as configureCas, casStatus, notebookStore } from "./src/builtin-modules/cas/index.js";
import { widgetObjects, renderedObjects, compactObject } from "./src/scene/scene-ops.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
// package.json is the single source of truth for the release version.
// Widget HTML uses __ESTAMPES_VERSION__ and versioned ui:// URIs derive from
// it, so a release bump only touches package.json.
// The last few bundles built, so a link still downloads if the workspace later fails to rebuild.
const bundleCache = { map: new Map(), set(k, v) { this.map.delete(k); this.map.set(k, v); if (this.map.size > 4) this.map.delete(this.map.keys().next().value); }, get(k) { return this.map.get(k); } };
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
const VISUAL_BASE_URI = "ui://estampes/visual-surface-" + URI_TAG + ".html";
const EVIDENCE_URI = "ui://estampes/visual-evidence-" + URI_TAG + ".html";
// Older URIs stay resolvable for saved ChatGPT conversations. They serve the
// current HTML on purpose: the host caches templates by URI, so a stale URI
// must still get a working widget, not a 404.
const LEGACY_VISUAL_URIS = ["v040","v041","v042","v043","v046","v047","v048","v050","v051","v052","v053","v054","v055","v056","v057","v058","v059","v060","v070","v071","v080","v090","v0100","v0101","v0110","v0120","v0130","v0140","v0150","v0160","v0170","v0180","v0190","v0191","v0192","v0193","v0194","v0195","v0196","v0197","v0198"]
  .map(tag => "ui://estampes/visual-surface-" + tag + ".html")
  .filter(uri => uri !== VISUAL_BASE_URI);
const LEGACY_EVIDENCE_URIS = ["v045","v047","v048","v050","v051","v052","v053","v054","v055","v056","v057","v058","v059","v060","v070","v071","v080","v090","v0100","v0101","v0110","v0120","v0130","v0140","v0150","v0160","v0170","v0180","v0190","v0191","v0192","v0193","v0194","v0195","v0196","v0197","v0198"]
  .map(tag => "ui://estampes/visual-evidence-" + tag + ".html")
  .filter(uri => uri !== EVIDENCE_URI);
const loadWidget = (file) =>
  inlineWorkbench(readFileSync(join(ROOT, "public", file), "utf8").replaceAll("__ESTAMPES_VERSION__", VERSION));
const STORE_URI = "ui://estampes/module-store-" + URI_TAG + ".html";
const html = loadWidget("number-line.html");
const storeHtml = loadWidget("module-store.html");
const evidenceHtml = loadWidget("visual-evidence.html");
const visualHtml = loadWidget("visual-surface.html");
// The host caches templates by URI, so a widget fix shipped without a version
// bump would never reach ChatGPT. The canvas URI therefore also carries a hash
// of the HTML actually served (which depends on config, e.g. the UVA Beta).
// The plain versioned URI stays registered for conversations that saved it.
const VISUAL_URI = "ui://estampes/visual-surface-" + URI_TAG + "-" + createHash("sha256").update(visualHtml).digest("hex").slice(0, 12) + ".html";
LEGACY_VISUAL_URIS.push(VISUAL_BASE_URI);
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

const WorkspaceItemId = z.string().regex(/^wi-\d{1,4}$/);
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
  note: z.string().max(200).optional().describe("Note attached to this mark, shown beside it (e.g. the text, name or value you read there)"),
  status: z.enum(MARK_STATUSES).optional().describe("inspected = you looked at the pixels (process_image); uncertain = not confirmed"),
  role: z.enum(["focus", "context"]).optional(),
  color: z.enum(MARK_COLORS).optional(),
  size: z.enum(MARK_SIZES).optional(),
  pen: z.enum(MARK_PENS).optional(),
  author: z.enum(["user", "assistant"]).optional(),
  grounding: z.enum(["scene-anchor", "unverified", "replayed-unverified", "user-pointer"]).optional(),
  layer: z.string().max(12).optional(),
  side: z.enum(["left", "right"]).optional().describe("Paired view only: which image the mark is on"),
  // Drawing facts the widget records for the user's strokes (gesture grouping).
  strokeOrder: z.number().int().min(1).max(1e6).optional(),
  relativeStartMs: z.number().int().min(0).max(36e5).optional(),
  relativeEndMs: z.number().int().min(0).max(36e5).optional(),
  pointerType: z.enum(["mouse", "pen", "touch"]).optional(),
  item: WorkspaceItemId.optional().describe("Workspace only: which item the mark is on"),
}).superRefine(checkGeometry);
const GestureDecisionSchema = z.object({
  memberIds: z.array(z.string().min(1).max(64)).min(2).max(8),
  verdict: z.enum(GESTURE_VERDICTS),
}).strict();
const VisualAnnotationsSchema = z.array(VisualAnnotationSchema).max(30);

// Evidence the assistant gives for a claim (a note or a link). It is always
// recorded as the model's own observation; only a tool's or the user's
// evidence can make a claim verified.
const EvidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS.filter((k) => k !== "tool-result")).describe("text = words/numbers read there; position = where it sits relative to other things; shape = outline, size, colour; context = what surrounds it"),
  side: z.enum(["left", "right"]).optional().describe("Paired view: the image this evidence is on (default left)"),
  item: WorkspaceItemId.optional().describe("Workspace: the item this evidence is on (default the claim's own item)"),
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
  item: WorkspaceItemId.optional().describe("Workspace only: the item (image) this mark is on (default the first); coordinates are normalized to that image"),
  ifMatch: z.string().regex(/^[0-9a-f]{12}$/).optional().describe("The mark's etag from your last read (get_visual_state / get_workspace_state / a previous result). If the mark changed since then (another conversation or the user edited it), the whole call is refused with CONFLICT instead of overwriting; read again and retry. Recommended whenever you edit an existing mark."),
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
// A link inside a workspace: a mark on one item and a mark on another.
const WorkspaceLinkSchema = z.object({
  id: z.string().min(1).max(64).describe("Stable link id; re-using it (with the same two items) edits the link"),
  fromItem: WorkspaceItemId, from: z.string().min(1).max(64).describe("Mark id on fromItem"),
  toItem: WorkspaceItemId, to: z.string().min(1).max(64).describe("Mark id on toItem"),
  label: LinkSchema.shape.label, note: LinkSchema.shape.note, confidence: LinkSchema.shape.confidence,
  evidence: ClaimFields.evidence, ambiguities: ClaimFields.ambiguities,
}).strict();
const FindingSchema = z.object({
  id: z.string().min(1).max(64),
  item: WorkspaceItemId.optional().describe("Workspace: the item the mark is on, when the id is used on several"),
  note: z.string().max(200).optional().describe("Empty string clears the note"),
  status: z.enum(MARK_STATUSES).optional(),
  ifMatch: z.string().regex(/^[0-9a-f]{12}$/).optional().describe("The mark's etag from your last read (get_visual_state / get_workspace_state / a previous result). If the mark changed since then (another conversation or the user edited it), the whole call is refused with CONFLICT instead of overwriting; read again and retry. Recommended whenever you edit an existing mark."),
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
const documentRevisions = createRevisionTracker();
const ImageIdSchema = z.string().regex(/^img:[0-9a-f]{16}$/).describe("imageId returned by load_image");
const DerivedViewIdSchema = z.string().regex(/^dv:[0-9a-f]{16}$/).describe("derivedViewId returned by process_image");
// A coordinateFrame naming a derived view becomes that view's exact
// derived -> normalized matrix; the older region form passes through.
function resolveFrame(frame, left, right) {
  if (!frame?.derivedViewId) return frame;
  const entry = (frame.side ?? "left") === "right" ? right : left;
  const record = entry && findView(entry, frame.derivedViewId);
  if (!record) throw new Error("coordinateFrame.derivedViewId " + frame.derivedViewId + " is not a processed view of the " + (frame.side ?? "left") + " image; call process_image on that image first");
  return { ...frameFromView(record, frame.units, frame.width && frame.height ? { width: frame.width, height: frame.height } : null), ...(frame.side ? { side: frame.side } : {}) };
}
// Registrations stay in memory (bounded) across requests: each MCP request
// builds its own server object, so this lives at module level. The same
// inputs rebuild the same id and result, so a lost one is one call away.
const registrations = new Map();
function remember(reg) {
  registrations.delete(reg.registrationId);
  registrations.set(reg.registrationId, reg);
  while (registrations.size > 50) registrations.delete(registrations.keys().next().value);
  return reg;
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
  z.object({ op: z.literal("gamma"), gamma: z.number().min(0.2).max(5).optional() }).describe("Exposure-like curve; above 1 lifts shadows without blowing highlights"),
  z.object({ op: z.literal("levels"), low: z.number().min(0).max(49).optional(), high: z.number().min(51).max(100).optional(),
    black: z.number().int().min(0).max(254).optional(), white: z.number().int().min(1).max(255).optional() }).describe("Percentile stretch (low/high percent) or fixed black/white points; robust to a few hot pixels"),
  z.object({ op: z.literal("white_balance"), method: z.enum(["gray_world", "white_patch"]).optional(), percentile: z.number().min(50).max(100).optional() }).describe("Neutralize a colour cast from lighting"),
  z.object({ op: z.literal("channel"), channel: z.enum(["red", "green", "blue", "hue", "saturation", "value", "lab_l", "lab_a", "lab_b"]) }).describe("One colour channel as grey; to separate silkscreen, copper, rust, ink colours"),
  z.object({ op: z.literal("flat_field"), radius: z.number().min(2).max(500).optional() }).describe("Remove uneven illumination (vignetting, shadows across a page)"),
  z.object({ op: z.literal("morphology"), operation: z.enum(["erode", "dilate", "open", "close"]), radius: z.number().int().min(1).max(20).optional(),
    shape: z.enum(["square", "disk"]).optional() }).describe("Clean or join binary strokes; radius is in analysis pixels (see sourcePixelsPerOutputPixel)"),
  z.object({ op: z.literal("canny"), sigma: z.number().min(0).max(5).optional(), low: z.number().min(0.01).max(1).optional(), high: z.number().min(0.01).max(1).optional() }).describe("Thin single-pixel edges with hysteresis; thresholds are fractions of the strongest gradient in the crop"),
]);
const Pt01 = z.object({ x: z.number().finite(), y: z.number().finite() });
const GeometrySchema = z.array(z.discriminatedUnion("op", [
  z.object({ op: z.literal("rotate"), degrees: z.number().min(-360).max(360), fill: z.enum(["white", "black"]).optional() }).describe("Rotate clockwise; multiples of 90 are lossless"),
  z.object({ op: z.literal("flip"), axis: z.enum(["horizontal", "vertical"]).optional() }).describe("Mirror (e.g. the back of a board)"),
  z.object({ op: z.literal("pad"), px: z.number().int().min(1).max(500), fill: z.enum(["white", "black"]).optional() }),
  z.object({ op: z.literal("deskew"), maxAngle: z.number().min(1).max(45).optional(), minConfidence: z.number().min(0).max(1).optional(), fill: z.enum(["white", "black"]).optional() }).describe("Straighten text lines or ruled lines; leaves the image alone when no clear direction is found"),
  z.object({ op: z.literal("perspective"), corners: z.array(Pt01).length(4).describe("Four corners as 0..1 of the FULL image: top-left, top-right, bottom-right, bottom-left of the flat surface"),
    width: z.number().int().min(2).max(8000).optional(), height: z.number().int().min(2).max(8000).optional(), aspect: z.number().positive().optional().describe("width/height of the real surface, if known"),
    fill: z.enum(["white", "black"]).optional() }).describe("Rectify a tilted flat surface (page, board, screen) to a top-down view"),
  z.object({ op: z.literal("mask"), polygon: z.array(Pt01).min(3).max(64).describe("0..1 of the FULL image"), fill: z.enum(["white", "black"]).optional() }).describe("Keep only the inside of a polygon so background does not disturb the result"),
])).max(6);

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
  module: z.string().optional(), visible: z.boolean().optional(), locked: z.boolean().optional(), opacity: z.number().optional(), side: z.string().regex(/^(left|right|wi-\d{1,4})$/).optional() });
const compactLink = (l) => ({ id: l.id, left: l.left, right: l.right, ...(l.label ? { label: l.label } : {}),
  ...(l.note ? { note: l.note } : {}), confidence: l.confidence, ...(l.review ? { review: l.review } : {}), claim: claimSummary(l) });
// The widget also gets each piece of evidence, to show where it is.
const widgetLink = (l) => ({ ...compactLink(l), evidence: l.evidence ?? [], ambiguities: l.ambiguities ?? [],
  verification: verificationOf(l), ...(l.reviewReason ? { reviewReason: l.reviewReason } : {}), ...(l.previouslyRejected ? { previouslyRejected: l.previouslyRejected } : {}) });
const STATE_TEXT = {
  "user-confirmed": "USER CONFIRMED", "user-rejected": "USER REJECTED (do not rely on it)",
  "independently-verified": "VERIFIED by a tool", unverified: "UNVERIFIED",
  "stale-confirmation": "STALE CONFIRMATION (an end was moved after the user confirmed; do not rely on it until they confirm again)",
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
  "edit-note": (e) => "edited the note on their mark " + e.id,
  "restyle-mark": (e) => "restyled or relabelled their mark " + e.id + (e.label ? " " + JSON.stringify(e.label) : ""),
  "undo-edit": (e) => "undid their last change to mark " + e.id + " (" + e.steps.join("+") + "); it is back as it was before",
  "redo-edit": (e) => "redid their change to mark " + e.id + " (" + e.steps.join("+") + ")",
  "edit-object": (e) => "edited object " + e.id + (e.props ? " to " + JSON.stringify(e.props) : ""),
  "remove-object": (e) => "deleted object " + e.id,
};
// Scene objects added by modules (function plots, axes, shapes).
const objectsText = (entry) => {
  const list = renderedObjects(entry);
  return list.length ? ". Scene objects (from modules; change them with execute_module): " + JSON.stringify(list.map(compactObject)) : "";
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
// Widget pixels per tool result (see widgetImage): a whole result must stay
// under the strictest host's cap (claude.ai, about 150,000 characters).
// Canvas uploads in progress (upload_visual_image), by uploadId.
const uploads = new Map();
const INLINE_IMAGE_CHARS = 80_000;
const INLINE_TOTAL_CHARS = 90_000;
const metaImage = (img) => ({ mimeType: img.mimeType, data: img.data, width: img.width, height: img.height, ...(img.full ? {} : { preview: true }) });

// Image layers (add_image_layer, a promoted base image, a copied canvas) keep
// their full PNG inline in the scene, up to 8 MB. Inside a tool result that
// alone breaks the host cap, so every result is rewritten on its way out:
// a widget object's image primitive carries a small preview (full: false,
// ref) and the widget fetches the full PNG with load_visual_pixels {object};
// a model-facing document lists the layer without its pixels (render_canvas
// shows them). Nothing stored changes.
const OBJECT_PREVIEW_CHARS = 16_000;
// A scan, not a regular expression: a regex over megabytes of base64
// overflows V8's stack.
const B64 = new Uint8Array(128);
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") B64[c.charCodeAt(0)] = 1;
function omitLongPngs(text) {
  const head = "data:image/png;base64,";
  let out = "", from = 0;
  for (let at = text.indexOf(head); at >= 0; at = text.indexOf(head, from)) {
    let end = at + head.length;
    while (end < text.length && B64[text.charCodeAt(end)] === 1) end++;
    if (end - at < 2000) { out += text.slice(from, end); from = end; continue; }
    out += text.slice(from, at) + "[image layer PNG omitted: " + (end - at) + " characters; render_canvas shows it]";
    from = end;
  }
  return from ? out + text.slice(from) : text;
}
const objectPreviews = new Map();
const pngRef = (href) => createHash("sha256").update(href).digest("hex").slice(0, 16);
async function objectPreview(href, ref, maxChars) {
  const key = ref + ":" + maxChars;
  if (!objectPreviews.has(key)) {
    objectPreviews.set(key, (async () => {
      const source = Buffer.from(href.slice(href.indexOf(",") + 1), "base64");
      for (const side of [640, 480, 360, 256, 180, 120, 80]) {
        const data = await sharp(source).resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
          .webp({ quality: side > 300 ? 60 : 50, alphaQuality: 80 }).toBuffer();
        const uri = "data:image/webp;base64," + data.toString("base64");
        if (uri.length <= maxChars) return uri;
      }
      return "";
    })().catch(() => ""));
    if (objectPreviews.size > 64) objectPreviews.delete(objectPreviews.keys().next().value);
  }
  return objectPreviews.get(key);
}
async function budgetObjectPixels(result) {
  if (!result || typeof result !== "object") return result;
  const long = new Map();
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 40) return;
    if (Array.isArray(node)) { for (const v of node) visit(v, depth + 1); return; }
    if (node.k === "image" && typeof node.href === "string" && node.href.length > 2000 && node.href.startsWith("data:image/png;base64,")) long.set(node.href, null);
    for (const v of Object.values(node)) visit(v, depth + 1);
  };
  visit(result.structuredContent); visit(result._meta);
  const share = long.size ? Math.floor(OBJECT_PREVIEW_CHARS / long.size) : 0;
  for (const href of long.keys()) {
    const ref = pngRef(href);
    long.set(href, { ref, preview: href.length <= share ? href : await objectPreview(href, ref, share) });
  }
  const rewrite = (node, objectId = null, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 40) return node;
    if (Array.isArray(node)) return node.map((v) => rewrite(v, objectId, depth + 1));
    if (node.k === "image" && long.has(node.href)) {
      const { ref, preview } = long.get(node.href);
      return preview === node.href ? node : { ...node, href: preview, full: false, ref, ...(objectId ? { object: objectId } : {}) };
    }
    // A stored-form image object (get_visual_state, get_workspace_state).
    if (node.type === "image" && node.props && typeof node.props.png === "string" && node.props.png.length > 2000) {
      const { png, ...props } = node.props;
      return { ...node, props: { ...props, pixels: { omitted: true, characters: png.length, ref: pngRef(png), read: "render_canvas" } } };
    }
    const id = typeof node.id === "string" && /^o\d{1,6}$/.test(node.id) && Array.isArray(node.primitives) ? node.id : objectId;
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = rewrite(v, id, depth + 1);
    return out;
  };
  const content = Array.isArray(result.content) ? result.content.map((part) => part?.type === "text" && typeof part.text === "string" && part.text.length > 2000
    ? { ...part, text: omitLongPngs(part.text) } : part) : result.content;
  return { ...result, content,
    ...(result.structuredContent ? { structuredContent: rewrite(result.structuredContent) } : {}),
    ...(result._meta ? { _meta: rewrite(result._meta) } : {}) };
}
// The full PNG of one public image object, for the widget (load_visual_pixels).
function objectPng(entry, objectId) {
  const o = entry.objects?.get(objectId);
  if (!o || o.type !== "image" || o.visibility !== "public" || typeof o.props?.png !== "string") throw new Error("No image layer " + objectId + " on " + entry.imageId);
  return o.props.png.slice(o.props.png.indexOf(",") + 1);
}
// Processed views ride along only while the result stays under budget; the
// rest are listed without pixels and fetched by the widget.
function budgetViews(views, used) {
  return views.map((v, index) => {
    const size = v.data?.length ?? 0;
    if (used + size <= INLINE_TOTAL_CHARS) { used += size; return v; }
    return { label: v.label, region: v.region, derivedViewId: v.derivedViewId, index, deferred: true };
  });
}
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
  const linkList = shownLinks(left, right), layers = pairLayers(left, right);
  const sides = { left, right }, checks = [], ink = [];
  for (const side of ["left", "right"]) {
    const entry = sides[side], own = canvasMarks(entry);
    const drawn = changed.filter((id) => annotations.some((a) => a.id === id && (a.side ?? "left") === side));
    if (verify && drawn.length) checks.push({ side, check: await renderVerification(entry, own, drawn) });
    ink.push(...inkReport(own.filter((m) => drawn.includes(m.id)), entry).map((i) => ({ ...i, side })));
  }
  const pending = linkList.filter(needsReview);
  const [shownLeft, shownRight] = [await widgetImage(left, INLINE_IMAGE_CHARS / 2), await widgetImage(right, INLINE_IMAGE_CHARS / 2)];
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
      "estampes/image": metaImage(shownLeft),
      "estampes/pairImage": metaImage(shownRight),
      "estampes/views": [],
      "estampes/annotations": marks,
    },
  });
}

// ---- Workspace view: N images, each with its own marks --------------------
// The widget gets every item's placement; pixels go in _meta when they are
// small enough, else the widget fetches each image with load_visual_canvas.
const wsMarks = (items) => items.flatMap(({ id, entry }) => canvasMarks(entry).map((m) => ({ ...m, side: id })));
const wsLayers = (items) => items.flatMap(({ id, entry }) => canvasLayers(entry).map((l) => ({ ...l, side: id })));
const wsItemInfo = ({ item, entry }) => ({ id: item.id, imageId: entry.imageId, set: item.set, width: entry.width, height: entry.height,
  placement: item.placement, ...(item.label ? { label: item.label } : {}), ...(entry.setId ? { copy: true } : {}) });
const wsLinkTable = (links, items) => links.map((l) => {
  const label = (item, id) => { const m = items.find((x) => x.id === item) && canvasMarks(items.find((x) => x.id === item).entry).find((x) => x.id === id); return item + ":" + id + (m?.label ? " " + JSON.stringify(m.label) : ""); };
  return l.id + (l.label ? " " + JSON.stringify(l.label) : "") + ": " + label(l.fromItem, l.from) + " <-> " + label(l.toItem, l.to) + " [" + claimTag(l) + "]" + (l.note ? " — " + l.note : "");
}).join("\n");
const wsWidgetLink = (l) => ({ ...widgetLink({ ...l, left: l.from, right: l.to }), fromItem: l.fromItem, toItem: l.toItem });
async function wsPixels(items) {
  const out = [];
  const each = Math.floor(INLINE_IMAGE_CHARS / Math.max(1, items.length));
  // Below ~8,000 characters a preview is too coarse to help; the widget
  // fetches every image itself instead.
  if (each < 8000) return [];
  for (const { id, entry } of items) {
    const shown = await widgetImage(entry, each);
    out.push({ id, objects:widgetObjects(entry),baseAsObject:!!entry.baseAsObject, ...metaImage(shown) });
  }
  return out;
}

async function presentWorkspace(workspaceId, { annotations, findings, remove, reset, layer, coordinateFrame, links, removeLinks, verify }) {
  const { doc } = await resolveRef(workspaceId);
  const items = await workspaceItems(doc);
  if (!items.length) throw new Error("Workspace " + workspaceId + " has no images; add some with edit_workspace");
  if (links.some((l) => l.left !== undefined)) throw new Error("In a workspace a link is { id, fromItem, from, toItem, to }");
  if (annotations.some((a) => a.side) || coordinateFrame?.side) throw new Error("In a workspace use `item` (wi-…), not `side`");
  // A processed view of one of the items becomes that view's exact matrix.
  if (coordinateFrame?.derivedViewId) {
    const target = items.find((it) => it.id === (coordinateFrame.item ?? items[0].id));
    if (!target) throw new Error("coordinateFrame.item " + coordinateFrame.item + " is not an item of " + workspaceId);
    const record = findView(target.entry, coordinateFrame.derivedViewId);
    if (!record) throw new Error("coordinateFrame.derivedViewId " + coordinateFrame.derivedViewId + " is not a processed view of " + target.id + "; call process_image on that image first");
    coordinateFrame = { ...frameFromView(record, coordinateFrame.units, coordinateFrame.width && coordinateFrame.height ? { width: coordinateFrame.width, height: coordinateFrame.height } : null), item: target.id };
  }
  const refused = [];
  // remove entries may be "wi-2:g1" to name the item.
  const removeList = remove.map((r) => { const m = /^(wi-\d{1,4}):(.+)$/.exec(r); return m && items.some((it) => it.id === m[1]) ? { item: m[1], id: m[2] } : r; });
  const changed = applyWorkspaceChanges(items, {
    annotations, findings, remove: removeList, reset, layer, frame: coordinateFrame, links, removeLinks, resolve: resolveCoordinateAnnotation, refused,
  });
  const touched = new Set(changed.map((c) => c.item));
  if (reset || remove.length || links.length || removeLinks.length) items.forEach((it) => touched.add(it.id));
  const history = { tool: "present_visual", changed: changed.map((c) => c.id), removed: remove, note: "workspace " + workspaceId };
  const edits = items.flatMap(({ id, entry }) => takeUserEdits(entry).map((e) => ({ ...e, side: id })));
  await Promise.all(items.filter((it) => touched.has(it.id) || edits.some((e) => e.side === it.id)).map((it) => saveCanvas(it.entry, history)));
  const marks = wsMarks(items), layerList = wsLayers(items), linkList = workspaceLinks(items);
  const checks = [], ink = [];
  for (const { id, entry } of items) {
    const drawn = changed.filter((c) => c.item === id && annotations.some((a) => a.id === c.id && (a.item ?? items[0].id) === id)).map((c) => c.id);
    if (!drawn.length) continue;
    const own = canvasMarks(entry);
    if (verify) checks.push({ item: id, check: await renderVerification(entry, own, drawn) });
    ink.push(...inkReport(own.filter((m) => drawn.includes(m.id)), entry).map((i) => ({ ...i, item: id })));
  }
  const pending = linkList.filter(needsReview);
  const info = items.map(wsItemInfo);
  const text = "Workspace " + workspaceId + " " + JSON.stringify(doc.name) + " revision " + doc.revision + ": " + items.length + " images side by side, never overlaid: " +
    info.map((i) => i.id + " = " + i.imageId + (i.copy ? " (a copy of its canvas)" : "") + " " + i.width + "x" + i.height + (i.label ? " " + JSON.stringify(i.label) : "")).join("; ") +
    ". Each mark belongs to one item (`item`, here as side) and its coordinates are normalized to THAT image. " + marks.length + " marks: " + JSON.stringify(marks.map(compactMark)) +
    (layerList.length ? ". Layers: " + layerText(layerList) : "") + userEditsText(edits) +
    ". LINKS (" + linkList.length + "):\n" + (wsLinkTable(linkList, items) || "(none yet)") +
    (pending.length ? "\n" + pending.length + " link(s) are UNVERIFIED and wait for the user's review in the canvas; treat them as candidates." : "") +
    refusedText(refused) + rejectionsText(items.map((it) => it.entry)) +
    (changed.length ? "\nChanged this call: " + changed.map((c) => c.item + ":" + c.id).join(", ") : "") +
    (ink.length ? ". Ink in image px: " + ink.map((i) => i.item + ":" + i.id + " " + i.pen + "/" + i.size + " " + i.px + "px" + (i.warn ? " WARNING " + i.warn : "")).join("; ") : "") +
    checks.map(({ item, check }) => ". VERIFICATION image for item " + item + " follows: crop " + JSON.stringify(check.region) + ", " +
      (check.layout === "side-by-side" ? "left half" : "top") + " = original pixels, other half = with marks numbered " +
      check.numbers.map((n) => n.n + "=" + n.id).join(", ") + "; check each mark sits on its target and fix it (same id and item) if not").join("");
  const first = items[0].entry;
  return logSizes("present_visual", {
    content: [{ type: "text", text }, ...checks.map(({ check }) => pixelsBlock(check))],
    structuredContent: {
      kind: "estampes.visual_surface", protocol: VISUAL_PROTOCOL, imageId: first.imageId, width: first.width, height: first.height, views: [],
      workspace: { id: workspaceId, name: doc.name, revision: doc.revision, items: info },
      marks: marks.map(compactMark), layers: layerList, links: linkList.map((l) => ({ ...compactLink({ ...l, left: l.from, right: l.to }), fromItem: l.fromItem, toItem: l.toItem })),
      coordinateSystem: "normalized-top-left",
    },
    _meta: { "estampes/links": linkList.map(wsWidgetLink), "estampes/items": await wsPixels(items), "estampes/views": [], "estampes/annotations": marks },
  });
}

function makeServer() {
  const server = new McpServer({ name: "estampes", version: VERSION });
  // Every tool result goes through the host size cap (src/result-budget.js).
  const register = server.registerTool.bind(server);
  server.registerTool = (name, cfg, handler) => register(name, cfg, async (...args) =>
    fitResult(await budgetObjectPixels(await handler(...args)), config.maxResultChars));

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
        "Display an interactive number line from -4 to 4 in the chat, with a mark at the specified integer.",
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
    geometry: GeometrySchema.optional(),
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
        "WORKSPACE: for THREE OR MORE images, or to combine canvases, use create_workspace / merge_workspaces and then pass `workspaceId` here: every image keeps its own marks; each annotation, finding and evidence names its `item` (wi-1, wi-2…, default the first) with coordinates normalized to that image, links are { id, fromItem, from, toItem, to }, and remove entries may be 'wi-2:markId'. Never stitch images into one picture to show them together. " +
        "Optional `views` (real images only, max 3) add extra tabs with processed versions (e.g. clahe+sharpen, threshold, a zoomed region) that the user can switch to; only add them when they help the user see something. " +
        "Coordinates are normalized to the full image, top-left origin. For small or ambiguous targets, zoom with process_image or overlay_grid (imageId from this call's result) before marking; coordinates alone are not evidence of recognition. " +
        "Do NOT also call present_visual_evidence for the same task.",
      inputSchema: z.object({
        image: ChatFileSchema.optional().describe("Image file from the conversation; loads and shows it in one call"),
        imageUrl: z.string().url().max(2048).optional().describe("Public https URL of an image"),
        imageId: ImageIdSchema.optional(),
        upload: z.boolean().optional().describe("Open an empty canvas where the user picks or photographs an image on their device. Use it when the user wants to show you a picture but no image file reaches this tool (no `image` parameter in this app, or the attachment is not passed to tools)."),
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
        workspaceId: z.string().regex(/^ws:[0-9a-f]{16}$/).optional().describe("Show a WORKSPACE (several images, see create_workspace); annotations, findings and links then name their `item`"),
        links: z.array(z.union([LinkSchema, WorkspaceLinkSchema])).max(30).default([]).describe("Paired view: { id, left, right }; workspace: { id, fromItem, from, toItem, to }"),
        removeLinks: z.array(z.string().max(64)).max(30).default([]).describe("Link ids to delete"),
        layer: z.string().trim().min(1).max(40).optional().describe("Name of the layer for this call's new marks; an existing name of yours adds to that layer, and edited marks move into it"),
        coordinateFrame: z.object({
          derivedViewId: DerivedViewIdSchema.optional().describe("The process_image result you read the coordinates from; exact for any crop or zoom"),
          units: z.enum(["pixels", "normalized"]).optional().describe("With derivedViewId: pixels of that output (default) or 0..1 of it"),
          region: RegionSchema.optional(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          side: z.enum(["left", "right"]).optional().describe("Paired view: the image the region belongs to (default left)"),
          item: WorkspaceItemId.optional().describe("Workspace: the item the region belongs to (default the first)"),
        }).refine((f) => Boolean(f.derivedViewId) !== Boolean(f.region), { message: "coordinateFrame needs exactly one of derivedViewId or region" })
          .optional().describe("Coordinates in `annotations` (of that side) are in a processed output: give its derivedViewId, or (older form) its region with 0..1 coordinates or pixels of a width×height output of it"),
        verify: z.boolean().default(true).describe("Return the verification image of changed marks"),
        dryRun: z.boolean().default(false).describe("Single canvas only: check this call without saving it. Every refusal (locked layer, stale ifMatch, invalid mark) is reported exactly as in a real call; if nothing is refused, the result lists what WOULD change and the canvas stays as it is. Safe for tests and for asking 'may I edit this?'."),
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
        workspace: z.object({ id: z.string(), name: z.string(), revision: z.number(), items: z.array(z.record(z.string(), z.unknown())) }).optional(),
        links: z.array(z.record(z.string(), z.unknown())).optional(),
        awaitingUpload: z.boolean().optional(),
        coordinateSystem: z.literal("normalized-top-left"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: VISUAL_URI }, "openai/fileParams": ["image", "marksFile", "pairImage"] },
    },
    async ({ image, imageUrl, imageId, scene, marksFile, annotations, views, priorUserAnnotations, findings, remove, reset, layer, coordinateFrame, verify,
      pairImage, pairImageUrl, pairImageId, links, removeLinks, workspaceId, upload, dryRun }) => {
      try {
        if (dryRun && (workspaceId || upload || pairImage || pairImageUrl || pairImageId || scene)) {
          throw new Error("dryRun works on one image's canvas (imageId, image or imageUrl), not on a workspace, a paired view, a scene or an upload canvas");
        }
        if (upload) {
          if ([image, imageUrl, imageId, scene, workspaceId, pairImage, pairImageUrl, pairImageId, marksFile].some(Boolean) || annotations.length) {
            throw new Error("upload opens an empty canvas; it takes no image, scene, workspace or marks");
          }
          return {
            content: [{ type: "text", text: "Opened an empty Estampes canvas with a 選擇圖片／拍照 (pick or photograph an image) button. " +
              "When the user adds a picture, the canvas reports its imageId in the conversation; then use that imageId with present_visual, inspect_image or process_image. Nothing is loaded yet." }],
            structuredContent: { kind: "estampes.visual_surface", awaitingUpload: true, coordinateSystem: "normalized-top-left" },
          };
        }
        if ([image, imageUrl, imageId, scene, workspaceId].filter(Boolean).length !== 1) {
          throw new Error("Provide exactly one of image, imageUrl, imageId, workspaceId or scene (or upload: true)");
        }
        if (workspaceId) {
          if (pairImage || pairImageUrl || pairImageId || views.length || marksFile || priorUserAnnotations.length) {
            throw new Error("A workspace view does not take pairImage, views, marksFile or priorUserAnnotations (add images with edit_workspace)");
          }
          return await presentWorkspace(workspaceId, { annotations, findings, remove, reset, layer, coordinateFrame, links, removeLinks, verify });
        }
        if (links.some((l) => l.fromItem !== undefined) || annotations.some((a) => a.item) || findings.some((f) => f.item) || coordinateFrame?.item) {
          throw new Error("item, fromItem and toItem are for a workspace view (workspaceId)");
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
        // dryRun: everything above was checked for real; undo it and report.
        const preview = dryRun ? { changed: [...changed], imported: [...imported] } : null;
        if (dryRun) { restore(); changed = []; imported = []; }
        const edits = dryRun ? [] : takeUserEdits(entry);
        if (!dryRun && (imported.length || changed.length || remove.length || reset || edits.length)) {
          await saveCanvas(entry, { tool: "present_visual", changed: [...imported, ...changed], removed: remove, ...(reset ? { note: "reset" } : {}) });
        }
        const resolved = canvasMarks(entry), layers = canvasLayers(entry);
        const drawn = changed.filter(id => annotations.some(a => a.id === id));
        const check = verify && drawn.length ? await renderVerification(entry, resolved, drawn) : null;
        const ink = inkReport(resolved.filter(m => drawn.includes(m.id)), entry);
        const exports = exportLinks(imageId);
        const shown = await widgetImage(entry, INLINE_IMAGE_CHARS);
        const rendered = [];
        for (const view of views) {
          const { out: full, record } = await deliverView(entry, { region: view.region, ops: view.ops, geometry: view.geometry, sampling: view.sampling });
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
            text: (preview ? "DRY RUN: nothing was saved and the canvas is unchanged. This call would " +
              (preview.changed.length || preview.imported.length || remove.length || reset ? "change: " + JSON.stringify({ marks: preview.changed, removed: remove, reset, restoredFromFile: preview.imported }) : "change nothing") +
              " and no rule refused it. " : "") +
              "Showing " + imageId + " (" + entry.width + "x" + entry.height + " px) to the user (original by default" +
              (rendered.length ? "; extra tabs: " + rendered.map(v => v.label).join(", ") : "") + "). Canvas now has " +
              resolved.length + " marks (ids persist; edit by re-using an id; boxes rounded): " + JSON.stringify(resolved.map(compactMark)) +
              (layers.length ? ". Layers (the user can hide, rename, reorder, fade or lock any): " + layerText(layers) : "") + objectsText(entry) + userEditsText(edits) +
              (imported.length ? ". Restored from marks file: " + imported.join(", ") : "") +
              (changed.length ? ". Changed this call: " + changed.join(", ") : "") +
              (resolved.some(m => m.note && needsReview(m)) ? ". Notes marked claim.verification unverified are your own claims: only the user (in the canvas) or a tool's evidence verifies them" : "") +
              refusedText(refused) + rejectionsText([entry]) +
              (ink.length ? ". Ink in image px: " + ink.map(i => i.id + " " + i.pen + "/" + i.size + " " + i.px + "px" + (i.warn ? " WARNING " + i.warn : "")).join("; ") : "") +
              (check ? ". The next image is a VERIFICATION crop of region " + JSON.stringify(check.region) + ", " +
                (check.layout === "side-by-side" ? "left" : "top") + " = original pixels, " +
                (check.layout === "side-by-side" ? "right" : "bottom") + " = with marks numbered " +
                check.numbers.map(n => n.n + "=" + n.id).join(", ") +
                ". Compare them: say whether each mark really sits on its target; if not, fix it (same id) before claiming it is done. The user can open the same image in the canvas tab 「AI 驗收圖」." : ""),
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
            "estampes/image": metaImage(shown),
            "estampes/views": budgetViews(rendered, shown.data.length),
            "estampes/annotations": resolved,
            "estampes/baseAsObject": !!entry.baseAsObject, "estampes/objects": widgetObjects(entry), "estampes/canRestoreObjects": !!entry.deletedObjectBatches?.length,
          },
        });
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] };
      }
    }
  );

  // Private tool for the canvas widget: the full display image (or one
  // processed view) as base64 in slices, for hosts that cap result size.
  // A result that carried a preview (preview: true) or a deferred view is
  // completed with this, one slice per call.
  const PIXEL_SLICE = 90_000;
  registerAppTool(
    server,
    "load_visual_pixels",
    {
      title: "Load canvas pixels",
      description: "Fetch the Estampes canvas photo or a processed view in slices, for the widget.",
      inputSchema: z.object({
        imageId: ImageIdSchema, setId: z.string().regex(/^c[0-9a-f]{12}$/).optional(),
        view: z.number().int().min(0).max(2).optional().describe("Index of a processed view; omit for the photo"),
        object: z.string().regex(/^o\d{1,6}$/).optional().describe("An image layer's object id: its full PNG"),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ imageId, setId, view, object, offset }) => {
      try {
        const entry = await ensureSet(imageId + (setId ? "#" + setId : ""));
        let source;
        if (object != null) {
          if (view != null) throw new Error("Pass view or object, not both");
          source = { mimeType: "image/png", data: objectPng(entry, object) };
        } else if (view == null) {
          const shown = await displayImage(entry);
          source = { mimeType: shown.mimeType, width: shown.width, height: shown.height, data: shown.data.toString("base64") };
        } else {
          const v = entry.lastViews?.[view];
          if (!v) throw new Error("No processed view " + view + " on " + imageId);
          source = { mimeType: v.mimeType, label: v.label, region: v.region, data: Buffer.isBuffer(v.data) ? v.data.toString("base64") : v.data };
        }
        const { data, ...info } = source;
        if (offset > data.length) throw new Error("offset is past the end");
        const slice = data.slice(offset, offset + PIXEL_SLICE);
        return {
          content: [{ type: "text", text: "Pixels for " + imageId + " sent to the widget." }],
          structuredContent: { kind: "estampes.visual_pixels", imageId, ...(view == null ? {} : { view }), ...(object == null ? {} : { object }), ...info,
            total: data.length, offset, data: slice, done: offset + slice.length >= data.length },
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] };
      }
    }
  );

  // Private tool for the canvas widget: an image the user picked or
  // photographed in the canvas itself, sent as base64 in slices (hosts limit
  // message sizes). The last slice loads it and returns its canvas.
  registerAppTool(
    server,
    "upload_visual_image",
    {
      title: "Upload an image to the canvas",
      description: "Receive an image the user picked in the Estampes canvas, in base64 slices.",
      inputSchema: z.object({
        uploadId: z.string().regex(/^up[0-9a-f]{16}$/).optional().describe("From the first slice's result; omit on the first slice"),
        fileName: z.string().max(120).optional(),
        total: z.number().int().min(1).max(Math.ceil(MAX_DOWNLOAD_BYTES * 4 / 3) + 4),
        offset: z.number().int().min(0),
        data: z.string().max(400_000).regex(/^[A-Za-z0-9+/=]*$/),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ uploadId, fileName, total, offset, data }) => {
      try {
        const nowMs = Date.now();
        for (const [id, u] of uploads) if (nowMs - u.touched > 10 * 60 * 1000) uploads.delete(id);
        let u;
        if (!uploadId) {
          if (offset !== 0) throw new Error("The first slice starts at offset 0");
          if (uploads.size >= 16) throw new Error("Too many uploads in progress; try again in a few minutes");
          uploadId = "up" + randomBytes(8).toString("hex");
          u = { total, parts: [], received: 0, fileName: fileName ?? null, touched: nowMs };
          uploads.set(uploadId, u);
        } else {
          u = uploads.get(uploadId);
          if (!u) throw new Error("This upload expired; pick the image again");
          if (u.total !== total || offset !== u.received) throw new Error("Slice out of order: expected offset " + u.received);
        }
        if (offset + data.length > total) throw new Error("Slice runs past the declared size");
        u.parts.push(data); u.received += data.length; u.touched = nowMs;
        if (u.received < total) {
          return { content: [{ type: "text", text: "Received " + u.received + "/" + total }],
            structuredContent: { kind: "estampes.upload_progress", uploadId, received: u.received, total } };
        }
        uploads.delete(uploadId);
        const bytes = Buffer.from(u.parts.join(""), "base64");
        if (!bytes.length || bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("The image must be 1 byte to " + Math.round(MAX_DOWNLOAD_BYTES / 1048576) + " MB");
        const entry = await intakeImage(bytes, { source: "upload", fileName: u.fileName });
        const payload = await canvasPayload(entry);
        log("info", "[upload] " + entry.imageId + " " + bytes.length + "B from the canvas");
        return logSizes("upload_visual_image", {
          content: [{ type: "text", text: "Loaded " + entry.imageId + " (" + entry.width + "x" + entry.height + ") from the canvas." }],
          structuredContent: { ...payload.structuredContent, uploaded: { imageId: entry.imageId, fileName: u.fileName } },
          _meta: payload._meta,
        }, { appOnly: true });
      } catch (error) {
        if (uploadId) uploads.delete(uploadId);
        return { isError: true, content: [{ type: "text", text: "Estampes: " + String(error?.message || error) }] };
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
        imageId: ImageIdSchema, setId:z.string().regex(/^c[0-9a-f]{12}$/).optional(),
        part: z.enum(["canvas", "check", "image"]).default("canvas"),
        pairImageId: ImageIdSchema.optional(),
        workspaceId: z.string().regex(/^ws:[0-9a-f]{16}$/).optional().describe("Reload a whole workspace (imageId = its first image)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ imageId, setId, part, pairImageId, workspaceId }) => {
      try {
        if (workspaceId && part === "canvas") {
          const { doc } = await resolveRef(workspaceId);
          const items = await workspaceItems(doc);
          return logSizes("load_visual_canvas", {
            content: [{ type: "text", text: "Workspace data for " + workspaceId + " sent to the widget." }],
            structuredContent: {
              kind: "estampes.visual_canvas", imageId: items[0]?.entry.imageId ?? imageId, part, workspaceId,
              workspace: { id: workspaceId, name: doc.name, revision: doc.revision, items: items.map(wsItemInfo) },
              annotations: wsMarks(items), layers: wsLayers(items), links: workspaceLinks(items).map(wsWidgetLink), views: [],
            },
          }, { appOnly: true });
        }
        const entry = await ensureSet(imageId+(setId?"#"+setId:""));
        if (part === "image") {
          const shown = await widgetImage(entry, INLINE_IMAGE_CHARS);
          return logSizes("load_visual_canvas", {
            content: [{ type: "text", text: "Image " + imageId + " sent to the widget." }],
            structuredContent: { kind: "estampes.visual_canvas", imageId, part, width: entry.width, height: entry.height,
              objects:widgetObjects(entry),baseAsObject:!!entry.baseAsObject, image: metaImage(shown) },
          }, { appOnly: true });
        }
        if (pairImageId && part === "canvas") {
          const right = await ensureImage(pairImageId), shown = await widgetImage(right, INLINE_IMAGE_CHARS / 2), own = await widgetImage(entry, INLINE_IMAGE_CHARS / 2);
          return logSizes("load_visual_canvas", {
            content: [{ type: "text", text: "Paired canvas data for " + imageId + " + " + pairImageId + " sent to the widget." }],
            structuredContent: {
              kind: "estampes.visual_canvas", imageId, part, width: entry.width, height: entry.height,
              image: metaImage(own),
              pair: { imageId: pairImageId, width: right.width, height: right.height, image: metaImage(shown),
                ...(exportLinks(pairImageId) ? { exports: exportLinks(pairImageId) } : {}) },
              annotations: pairMarks(entry, right), layers: pairLayers(entry, right), links: shownLinks(entry, right).map(widgetLink), views: [],
              gestureGroups: [...gestureGroups(canvasMarks(entry), entry, entry.gestureDecisions),
                ...gestureGroups(canvasMarks(right), right, right.gestureDecisions).map((g) => ({ ...g, side: "right" }))],
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
              gestureGroups: gestureGroups(canvasMarks(entry), entry, entry.gestureDecisions),
              objects: widgetObjects(entry),baseAsObject:!!entry.baseAsObject,
              ...(await (async () => {
                const shown = await widgetImage(entry, INLINE_IMAGE_CHARS);
                return { image: metaImage(shown), views: budgetViews((entry.lastViews ?? []).map(v => ({ label: v.label, region: v.region, ...pixels(v) })), shown.data.length) };
              })()),
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

  // Private poll tool for the canvas widget (UVA Phase 3, OD-04 option A):
  // one call asks about up to 12 documents and answers each with unchanged, a
  // snapshot, or a gap (more than one revision behind, or the server restarted).
  // Snapshots carry marks, layers and objects but no pixels; pixels stay on
  // load_visual_canvas, which the widget calls only when it has none.
  registerAppTool(
    server,
    "documents_get_changes",
    {
      title: "Poll canvas documents for changes",
      description: "Ask which of up to 12 canvas documents changed since the revision the widget last saw.",
      inputSchema: z.object({
        documents: z.array(z.object({
          documentId: z.string().regex(/^(img:[0-9a-f]{16}(#c[0-9a-f]{12})?|ws:[0-9a-f]{16})$/),
          sinceRevision: z.object({ epoch: z.string().max(40), counter: z.number().int().min(0), hash: z.string().max(80) }).optional(),
        })).min(1).max(MAX_POLLED_DOCUMENTS),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ documents }) => {
      const results = [];
      for (const { documentId, sinceRevision } of documents) {
        try {
          let hash, body;
          if (documentId.startsWith("ws:")) {
            const { doc } = await resolveRef(documentId);
            const items = await workspaceItems(doc);
            hash = "ws:" + createHash("sha256").update(JSON.stringify([doc.revision, items.map(({ id, entry }) => [id, canvasRevision(entry)])])).digest("hex").slice(0, 24);
            body = () => ({ workspace: { id: documentId, name: doc.name, revision: doc.revision, items: items.map(wsItemInfo) },
              annotations: wsMarks(items), layers: wsLayers(items), links: workspaceLinks(items).map(wsWidgetLink) });
          } else {
            const entry = await ensureSet(documentId);
            hash = canvasRevision(entry);
            body = () => ({ width: entry.width, height: entry.height, annotations: canvasMarks(entry), layers: canvasLayers(entry),
              gestureGroups: gestureGroups(canvasMarks(entry), entry, entry.gestureDecisions), objects: widgetObjects(entry), baseAsObject: !!entry.baseAsObject });
          }
          const revision = documentRevisions.observe(documentId, hash);
          const status = classifyChange(sinceRevision, revision);
          results.push({ documentId, status, revision, ...(status === "unchanged" ? {} : { snapshot: body() }) });
        } catch (error) {
          results.push({ documentId, status: "missing", error: String(error?.message || error).slice(0, 200) });
        }
      }
      return logSizes("documents_get_changes", {
        content: [{ type: "text", text: "Checked " + documents.length + " canvas document(s) for the widget." }],
        structuredContent: { kind: "estampes.documents_changes", epoch: documentRevisions.epoch, documents: results },
      }, { appOnly: true });
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

  // ---- Workspaces: several images, merge, split, move, copy, link ----------
  // See src/workspace.js. These tools change which canvases a workspace
  // shows; marks are drawn with present_visual as before.
  const WorkspaceRef = z.string().trim().min(4).max(80)
    .describe("ws:<id> for a workspace; an imageId for a single canvas; imageId+pairImageId (joined with +) for a paired view");
  const CanvasKey = z.string().regex(/^img:[0-9a-f]{16}(#c[0-9a-f]{8,16})?$/).describe("An image's own canvas (its imageId) or a copy (imageId#c<hex>)");
  const IdempotencyKey = z.string().trim().min(1).max(80).optional()
    .describe("Any unique string for this change; repeating a call with the same key (e.g. after a timeout) returns the first result instead of applying it twice");
  const itemsText = (doc, check) => doc.items.map((it) => {
    const c = check.items.find((x) => x.id === it.id) ?? {};
    return it.id + " " + it.asset + (it.set !== it.asset ? " (copy " + it.set.split("#")[1] + ")" : "") + (it.label ? " " + JSON.stringify(it.label) : "") +
      ": " + (c.ok === false ? "UNAVAILABLE" : c.marks + " marks (" + c.userMarks + " the user's), " + c.layers + " layers");
  }).join("; ");
  const wsText = (head, r) => head + " " + r.workspace.id + " " + JSON.stringify(r.workspace.name) + " revision " + r.workspace.revision + ": " +
    r.check.totals.items + " images, " + r.check.totals.marks + " marks, " + r.check.totals.layerInstances + " layers, " + r.check.totals.links + " links. Items: " +
    itemsText(r.workspace, r.check) + (r.check.problems.length ? ". PROBLEMS: " + r.check.problems.join("; ") : "") +
    (r.skipped?.length ? ". Skipped: " + r.skipped.map((x) => (x.item ?? x.set) + " (" + x.reason + ")").join("; ") : "") +
    (r.undoToken ? ". undoToken " + r.undoToken : "") + (r.repeated ? ". (Same idempotency key as an earlier call: nothing was applied again.)" : "") +
    ". Show it with present_visual {workspaceId}.";
  const wsStructured = (r) => ({ kind: "estampes.workspace_change", protocol: WORKSPACE_PROTOCOL, workspaceId: r.workspace.id, revision: r.workspace.revision,
    items: r.workspace.items, check: r.check, ...(r.undoToken ? { undoToken: r.undoToken } : {}), ...(r.skipped ? { skipped: r.skipped } : {}),
    ...(r.repeated ? { repeated: true } : {}) });
  const ImageList = {
    images: z.array(ChatFileSchema).max(MAX_ITEMS).default([]).describe("Image files from the conversation, in order"),
    imageUrls: z.array(z.string().url().max(2048)).max(MAX_ITEMS).default([]).describe("Public https image URLs"),
    canvases: z.array(CanvasKey).max(MAX_ITEMS).default([]).describe("Images already in Estampes (imageId), or copies of canvases; their marks come along (linked)"),
    labels: z.array(z.string().max(40)).max(MAX_ITEMS).default([]).describe("Optional short names, in the order images, imageUrls, canvases"),
  };
  const loadList = async ({ images, imageUrls, canvases, labels }) => {
    const keys = [];
    for (const image of images) keys.push((await loadImageInput({ image })).imageId);
    for (const imageUrl of imageUrls) keys.push((await loadImageInput({ imageUrl })).imageId);
    keys.push(...canvases);
    return keys.map((set, i) => ({ set, ...(labels[i] ? { label: labels[i] } : {}) }));
  };

  server.registerTool(
    "create_workspace",
    {
      title: "Create a workspace with several images",
      description: "Create an Estampes WORKSPACE: any number of images (up to " + MAX_ITEMS + ") in one canvas, each keeping its own marks, layers and coordinates. Use it when the user wants three or more images together, or wants to combine canvases. Images can be new files, URLs, or images already in Estampes (`canvases`: their existing marks come along and stay editable; edits show in both places). `from` adds every image of existing workspaces or canvases (imageId, or imageId+pairImageId for a paired view). Never combine images by stitching them into one picture: that loses the marks. Show the result with present_visual {workspaceId}.",
      inputSchema: z.object({
        name: z.string().max(60).optional(),
        ...ImageList,
        from: z.array(WorkspaceRef).max(8).default([]).describe("Workspaces or canvases whose images (with their marks) to include, linked"),
        idempotencyKey: IdempotencyKey,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { "openai/fileParams": ["images"] },
    },
    async ({ name, images, imageUrls, canvases, labels, from, idempotencyKey }) => {
      try {
        const items = [];
        for (const ref of from) for (const it of (await resolveRef(ref)).doc.items) items.push({ set: it.set, label: it.label });
        items.push(...await loadList({ images, imageUrls, canvases, labels }));
        const r = await createWorkspace({ name, items, key: idempotencyKey });
        return { content: [{ type: "text", text: wsText("Created workspace", r) }], structuredContent: wsStructured(r) };
      } catch (error) { return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] }; }
    }
  );

  server.registerTool(
    "edit_workspace",
    {
      title: "Add, remove or arrange workspace images",
      description: "Change which images an Estampes workspace shows and where. `add` images (files, URLs or existing canvases, with their marks); `remove` item ids to DETACH them from this workspace only (the image and its marks are kept, also in other workspaces and in its own canvas); `arrange` moves, resizes, rotates (0/90/180/270) or renames items, which never changes the marks' own coordinates; `order` sets the item order; `autoLayout` re-flows them. Pass `expectedRevision` (from the last result) so a change made meanwhile is not overwritten. Returns an undoToken.",
      inputSchema: z.object({
        workspaceId: z.string().regex(/^ws:[0-9a-f]{16}$/),
        name: z.string().max(60).optional(),
        ...ImageList,
        remove: z.array(z.string().regex(/^wi-\d{1,4}$/)).max(MAX_ITEMS).default([]).describe("Item ids to detach (never deletes images or marks)"),
        arrange: z.array(z.object({
          item: z.string().regex(/^wi-\d{1,4}$/),
          x: z.number().finite().min(-100000).max(100000).optional(), y: z.number().finite().min(-100000).max(100000).optional(),
          width: z.number().finite().min(50).max(20000).optional().describe("Workspace units; items are 1000 wide by default"),
          rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
          label: z.string().max(40).optional().describe("Empty string clears"),
        }).strict()).max(MAX_ITEMS).default([]),
        order: z.array(z.string().regex(/^wi-\d{1,4}$/)).max(MAX_ITEMS).optional().describe("Every item id once, in the new order"),
        autoLayout: z.boolean().default(false),
        expectedRevision: z.number().int().min(0).optional(),
        idempotencyKey: IdempotencyKey,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { "openai/fileParams": ["images"] },
    },
    async ({ workspaceId, name, images, imageUrls, canvases, labels, remove, arrange, order, autoLayout, expectedRevision, idempotencyKey }) => {
      try {
        const add = await loadList({ images, imageUrls, canvases, labels });
        const r = await editWorkspace(workspaceId, { add, remove, arrange, order, name, autoLayout, expectedRevision, key: idempotencyKey });
        return { content: [{ type: "text", text: wsText("Updated workspace", r) }], structuredContent: wsStructured(r) };
      } catch (error) { return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] }; }
    }
  );

  const TransferFields = {
    items: z.array(z.string().max(40)).max(MAX_ITEMS).optional().describe("Which images of the source (item ids like wi-2, or imageIds); default all"),
    mode: z.enum(["link", "copy"]).default("link").describe("link (default) = the same marks, edits show in both places; copy = independent copies of the marks that remember their source"),
    removeFromSource: z.boolean().default(false).describe("true = MOVE: also remove the items from the source workspace (never deletes images or marks). Not for a single or paired canvas"),
    commit: z.boolean().default(false).describe("false (default) = only PREVIEW what would happen; true = apply. Pass previewId from the preview to apply exactly that"),
    previewId: z.string().max(40).optional(),
    idempotencyKey: IdempotencyKey,
  };
  const planText = (plan) => "mode " + plan.mode + (plan.removeFromSource ? " + move" : "") + "; from " + plan.source.ref + " into " +
    (plan.target.ref === "new" ? "a NEW workspace" : plan.target.ref + (plan.target.createsWorkspace ? " (a canvas: a NEW workspace is created that shows it plus these; the canvas itself stays as it is)" : "")) +
    ". Adds " + plan.add.length + " image(s): " + plan.add.map((a) => a.item + " " + a.asset + " " + a.marks + " marks (" + a.userMarks + " the user's), " + a.layers + " layers").join("; ") +
    (plan.skipped.length ? ". Skipped " + plan.skipped.map((x) => x.item + " (" + x.reason + ")").join("; ") : "") +
    ". Result: " + plan.result.items + " images, " + plan.result.marks + " marks (" + plan.result.userMarks + " the user's), " + plan.result.layerInstances + " layers; links carried " + plan.links.carried +
    (plan.links.leftBehind ? ", left behind " + plan.links.leftBehind : "") + ". " + plan.sharedEditing + "." +
    (plan.warnings.length ? " WARNINGS: " + plan.warnings.join("; ") : "");
  async function transfer(args, { commit, previewId, idempotencyKey }) {
    if (!commit) {
      const { previewId: id, plan } = await previewTransfer(args);
      return {
        content: [{ type: "text", text: "PREVIEW (nothing changed yet): " + planText(plan) + ". To apply, call again with commit:true and previewId " + JSON.stringify(id) +
          ". If the user already asked for exactly this and nothing is surprising (no warnings, no move), you may apply it right away; ask first when it moves items, copies or the counts look wrong." }],
        structuredContent: { kind: "estampes.workspace_preview", protocol: WORKSPACE_PROTOCOL, previewId: id, plan },
      };
    }
    const r = await commitTransfer(previewId ? { previewId, key: idempotencyKey } : { ...args, key: idempotencyKey });
    const verdict = r.repeated ? "" : r.verified ? " VERIFIED: the workspace holds exactly what the preview said." :
      " NOT VERIFIED: " + (r.mismatch ? "these totals differ from the plan: " + r.mismatch.join(", ") : r.check.problems.join("; ")) + ". Tell the user; do not claim the merge is complete.";
    return {
      content: [{ type: "text", text: wsText(r.created ? "Created workspace" : "Updated workspace", r) + verdict +
        (r.itemMap?.length ? " Item ids: " + r.itemMap.map((m) => m.from + "→" + m.to).join(", ") + "." : "") }],
      structuredContent: { ...wsStructured(r), kind: "estampes.workspace_change", created: !!r.created, verified: !!r.verified, ...(r.itemMap ? { itemMap: r.itemMap } : {}) },
    };
  }

  server.registerTool(
    "merge_workspaces",
    {
      title: "Merge canvases or workspaces",
      description: "Bring the images of one canvas or workspace, WITH their marks, layers and links, into another, so they are edited together (for example the user's paired view B into canvas A = one workspace with three images). Nothing is flattened and nothing is deleted: by default the source stays as it is and the marks are LINKED (the same marks, edits show in both places); mode copy makes independent copies; removeFromSource moves. Call it first WITHOUT commit to get a PREVIEW (counts of images, marks, layers, links and what is shared), then with commit:true and the previewId. Merging the same thing twice adds nothing. Returns an undoToken.",
      inputSchema: z.object({
        target: WorkspaceRef.describe("Where the images go: a workspace, or a canvas (then a new workspace is created that shows the canvas's images first)"),
        source: WorkspaceRef.describe("Where they come from"),
        ...TransferFields,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ target, source, items, mode, removeFromSource, commit, previewId, idempotencyKey }) => {
      try { return await transfer({ source, target, items, mode, removeFromSource }, { commit, previewId, idempotencyKey }); }
      catch (error) { return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] }; }
    }
  );

  server.registerTool(
    "split_workspace",
    {
      title: "Split images out into a new workspace",
      description: "Put some images of a workspace or canvas, WITH their marks, into a NEW workspace. By default the source keeps them and the marks are linked (shared); mode copy makes independent copies; removeFromSource takes them out of the source workspace (a move). Preview first (no commit), then commit:true with the previewId. Returns an undoToken.",
      inputSchema: z.object({
        source: WorkspaceRef,
        name: z.string().max(60).optional().describe("Name of the new workspace"),
        ...TransferFields,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ source, name, items, mode, removeFromSource, commit, previewId, idempotencyKey }) => {
      try { return await transfer({ source, target: "new", items, mode, removeFromSource, name }, { commit, previewId, idempotencyKey }); }
      catch (error) { return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] }; }
    }
  );

  server.registerTool(
    "undo_workspace_change",
    {
      title: "Undo a workspace change",
      description: "Undo one create/edit/merge/split/move by the undoToken it returned. Every workspace it touched goes back to how it was; a workspace it created is removed (its images and marks are kept). Refused if one of them changed again since: undo the later change first. Marks drawn with present_visual are not affected.",
      inputSchema: z.object({ workspaceId: z.string().regex(/^ws:[0-9a-f]{16}$/), undoToken: z.string().regex(/^u-[0-9a-f]{12}$/) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspaceId, undoToken }) => {
      try {
        const r = await undoChange(workspaceId, undoToken);
        return {
          content: [{ type: "text", text: "Undid " + r.kind + " " + undoToken + ": " + r.workspaces.map((w) => w.id + (w.archived ? " removed" : " now revision " + w.revision)).join(", ") + "." }],
          structuredContent: { kind: "estampes.workspace_undo", ...r },
        };
      } catch (error) { return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] }; }
    }
  );

  server.registerTool(
    "export_workspace_bundle",
    {
      title: "Export a workspace as a .estampes bundle",
      description: "Make a portable .estampes file of a workspace (or a canvas / paired view, which becomes a workspace first): every image, and every canvas's marks, layers, claims and links as editable DATA (nothing is flattened). The user can open it on another Estampes server with import_workspace_bundle. Returns a download link and the manifest. It contains no access key, link or chat content. Set fileNames:false to leave original file names out.",
      inputSchema: z.object({ workspace: WorkspaceRef, fileNames: z.boolean().default(true) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspace, fileNames }) => {
      try {
        let ref = workspace;
        if (!/^ws:/.test(ref)) {
          const made = await createWorkspace({ items: (await resolveRef(ref)).doc.items.map((it) => ({ set: it.set, label: it.label })) });
          ref = made.workspace.id;
        }
        const first = (await resolveRef(ref)).doc.items[0];
        const extras = await collectBundleExtras({ surfaceStore, notebooks: notebookStore(), keys: [workspace, ref, first?.set?.split("#")[0]] });
        const built = await exportBundle(ref, { version: VERSION, fileNames, extras });
        bundleCache.set(ref.slice(3), built);
        const link = publicUrl() + "/export/ws/" + ref.slice(3) + "/workspace.estampes" + (ACCESS_KEY ? "?sig=" + exportSignature(ACCESS_KEY, ref.slice(3), "workspace.estampes") : "");
        return {
          content: [{ type: "text", text: "Bundle " + built.fileName + " (" + Math.round(built.buffer.length / 1024) + " KiB): " + built.manifest.workspace.items + " image(s), " + built.manifest.workspace.marks + " mark(s). Download: " + link +
            (built.warnings.length ? "\nNotes: " + built.warnings.join(" ") : "") }],
          structuredContent: { kind: "estampes.workspace_bundle", workspaceId: ref, fileName: built.fileName, bytes: built.buffer.length, downloadUrl: link, manifest: built.manifest, warnings: built.warnings },
        };
      } catch (error) { return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] }; }
    }
  );

  server.registerTool(
    "import_workspace_bundle",
    {
      title: "Import a .estampes bundle",
      description: "Open a .estampes bundle (attached file or public https URL) as a new workspace. Hashes, format, paths and every mark are checked first; nothing is overwritten: a canvas that already has different marks gets an independent copy (collision copy) or, if identical, is reused (collision reuse). Importing the same bundle again returns the same workspace. Returns the workspace, what each canvas became, warnings, and a read-back verification against the bundle's own totals. Show it with present_visual {workspaceId}.",
      inputSchema: z.object({
        file: ChatFileSchema.optional().describe("The attached .estampes file"),
        bundleUrl: z.string().url().optional().describe("Public https URL of a .estampes file"),
        name: z.string().max(60).optional(),
        collision: z.enum(["reuse", "copy"]).default("reuse"),
        allowPartial: z.boolean().default(false).describe("Default false: a bundle with invalid marks or totals that disagree with its manifest is refused and nothing is created. true imports the valid part and reports what was dropped."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { "openai/fileParams": ["file"] },
    },
    async ({ file, bundleUrl, name, collision, allowPartial }) => {
      try {
        if (Boolean(file) === Boolean(bundleUrl)) throw new Error("Give exactly one of file or bundleUrl");
        const bytes = await downloadImage(file ? file.download_url : bundleUrl, { maxBytes: 256 * 1024 * 1024, accept: "application/octet-stream,application/zip,*/*" });
        const r = await importBundle(bytes, { name, collision, allowPartial });
        const installed = r.repeated ? null : await installBundleExtras({ surfaceStore, notebooks: notebookStore(), workspaceId: r.workspace?.id, extras: r.extras });
        if (installed?.notes.length) r.warnings = [...(r.warnings ?? []), ...installed.notes];
        return {
          content: [{ type: "text", text: (r.repeated ? "Already imported: " : "Imported ") + (r.workspace?.id ?? "") + " (" + (r.check?.totals?.items ?? "?") + " image(s), " + (r.check?.totals?.marks ?? "?") + " mark(s))." +
            (r.verified === false ? " Verification differs from the bundle: " + JSON.stringify({ mismatch: r.mismatch, unsupported: r.unsupported }) : "") +
            (r.warnings?.length ? "\nNotes: " + r.warnings.join(" ") : "") }],
          structuredContent: { ...wsStructured(r), kind: "estampes.workspace_import", summary: r.summary, warnings: r.warnings, verified: r.verified, repeated: !!r.repeated, ...(installed ? { surface: installed.surface, notebooks: installed.notebooks } : {}) },
        };
      } catch (error) { return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] }; }
    }
  );

  server.registerTool(
    "get_workspace_state",
    {
      title: "Read a workspace",
      description: "Return an Estampes workspace as one " + WORKSPACE_PROTOCOL + " JSON document: its items (which image, which canvas, placement), the images, every canvas's layers and marks (geometry normalized to its own image, author, note, claim state, where a copy came from), links between items, rejected claims, the recent undo tokens and a CHECK of the totals. A single canvas (imageId) or a paired view (imageId+pairImageId) is returned in the same shape. Read-only.",
      inputSchema: z.object({ workspace: WorkspaceRef, history: z.number().int().min(0).max(200).default(0) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspace, history }) => {
      try {
        const doc = await workspaceDocument((await resolveRef(workspace)).doc, { history });
        const t = doc.check.totals;
        return {
          content: [{ type: "text", text: WORKSPACE_PROTOCOL + ": " + t.items + " images, " + t.marks + " marks, " + t.layerInstances + " layers, " + t.links + " links" +
            (doc.check.problems.length ? ", PROBLEMS: " + doc.check.problems.join("; ") : "") + ". " + JSON.stringify(doc) }],
          structuredContent: doc,
        };
      } catch (error) { return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] }; }
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
        let tile = await regionTile(await ensureImage(imageId), region, maxSide);
        // Same result-size cap as the canvas photo: shrink until it fits.
        for (let side = Math.max(tile.width, tile.height); tile.data.length * 4 / 3 > INLINE_TOTAL_CHARS && side > 320; ) {
          side = Math.round(side * 0.8);
          const { data, info } = await sharp(tile.data).resize({ width: side, height: side, fit: "inside" }).jpeg({ quality: 72 }).toBuffer({ resolveWithObject: true });
          tile = { ...tile, data, mimeType: "image/jpeg", width: info.width, height: info.height };
        }
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
        workspaceId:z.string().regex(/^ws:[0-9a-f]{16}$/).optional(),
        hiddenLayers:z.array(z.object({id:z.string().regex(/^L\d+$/),side:z.string().max(64).optional()})).max(200).default([]),
        annotations:VisualAnnotationsSchema,
        intent:z.enum(INTENTS).default("free-annotate"),
        note:z.string().max(500).default(""),
        replyQuote:z.string().max(300).default(""),
        gestureDecisions:z.array(GestureDecisionSchema).max(30).default([]).describe("The user's verdicts on stroke groups not yet stored (e.g. on the demo scenes)"),
      }),
      outputSchema:z.object({
        kind:z.literal("estampes.validated_annotations"),
        scene:SceneSchema.optional(),
        imageId:z.string().optional(),
        count:z.number().int(),
        annotations:VisualAnnotationsSchema,
        layer:z.object({id:z.string(),name:z.string()}).optional(),
        pairLayer:z.object({id:z.string(),name:z.string()}).optional(),
        itemLayers:z.array(z.object({item:z.string(),id:z.string(),name:z.string()})).optional(),
        event:z.record(z.string(),z.unknown()),
        chatMessage:z.string(),
      }),
      annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
      _meta:{ui:{visibility:["app"]}},
    },
    async ({scene,imageId,pairImageId,workspaceId,annotations,intent,note,replyQuote,gestureDecisions,hiddenLayers})=>{
      // Validation is geometric only; no image classification or host
      // conversation access is claimed. The user supplies the intent/quote.
      try {
        if(workspaceId){
          // Workspace view: each mark joins the canvas of its own item.
          const {doc}=await resolveRef(workspaceId),items=await workspaceItems(doc);
          if(!items.length)throw new Error("This workspace has no images");
          const itemOf=a=>items.find(it=>it.id===a.item)??items[0];
          const checked=annotations.map(({side:_s,...a})=>({...a,item:itemOf(a).id,author:"user",grounding:"user-pointer"}));
          const workspace={id:workspaceId,items:items.map(it=>({id:it.id,imageId:it.entry.imageId,width:it.entry.width,height:it.entry.height,label:it.item.label}))};
          const first=items[0].entry;
          const decisions=[...items.flatMap(it=>it.entry.gestureDecisions??[]),...gestureDecisions];
          const event=buildAnnotationEvent({image:{imageId:first.imageId,width:first.width,height:first.height},workspace,annotations:checked,intent,note,replyQuote,gestureDecisions:decisions});
          const itemLayers=[];
          event.canvasReads=[];
          for(const it of items){
            const own=checked.filter(a=>a.item===it.id).map(({item:_i,...a})=>a);
            if(!own.length){event.canvasReads.push({item:it.id,request:canvasReadRequest(it.entry,hiddenLayers.filter(l=>l.side===it.id).map(l=>l.id))});continue;}
            const layer=storeUserMarks(it.entry,own);
            event.canvasReads.push({item:it.id,request:canvasReadRequest(it.entry,hiddenLayers.filter(l=>l.side===it.id).map(l=>l.id))});
            if(layer)itemLayers.push({item:it.id,id:layer.id,name:layer.name});
            await saveCanvas(it.entry,{tool:"validate_visual_annotations",author:"user",changed:own.map(a=>a.id),note:intent});
          }
          return {
            content:[{type:"text",text:"Validated "+checked.length+" user-authored annotations in workspace "+workspaceId+"; explicit interaction intent="+intent+" (geometry only)."}],
            structuredContent:{kind:"estampes.validated_annotations",imageId:first.imageId,count:checked.length,annotations:checked,event,chatMessage:formatAnnotationChatMessage(event),itemLayers},
          };
        }
        if(!imageId===!scene) throw new Error("Provide exactly one of imageId or scene");
        let image;
        let entry;
        if(imageId){entry=await ensureImage(imageId);image={imageId,width:entry.width,height:entry.height};}
        if(pairImageId&&!entry) throw new Error("pairImageId needs imageId");
        const right=pairImageId?await ensureImage(pairImageId):null;
        if(!right&&annotations.some(a=>a.side==="right")) throw new Error("side:'right' needs pairImageId");
        const checked=annotations.map(a=>({...a,author:"user",grounding:"user-pointer"}));
        const pairImage=right?{imageId:pairImageId,width:right.width,height:right.height}:undefined;
        // Stored verdicts first; the widget's own (newer) ones override them.
        const decisions=[...(entry?.gestureDecisions??[]),...(right?.gestureDecisions??[]),...gestureDecisions];
        const event=buildAnnotationEvent({scene,image,pairImage,annotations:checked,intent,note,replyQuote,gestureDecisions:decisions});

        let layer=null,pairLayer=null;
        if(right){
          // Paired view: each mark belongs to its own image.
          const sideOf=a=>a.side==="right"?"right":"left";
          layer=storeUserMarks(entry,checked.filter(a=>sideOf(a)==="left").map(({side,...a})=>a));
          pairLayer=storeUserMarks(right,checked.filter(a=>sideOf(a)==="right").map(({side,...a})=>a));
        // Submitted marks join the photo's canvas so GPT need not replay them.
        }else if(entry)layer=storeUserMarks(entry,checked);
        if(entry)event.canvasReads=[{side:"left",request:canvasReadRequest(entry,hiddenLayers.filter(l=>!l.side||l.side==="left").map(l=>l.id))},
          ...(right?[{side:"right",request:canvasReadRequest(right,hiddenLayers.filter(l=>l.side==="right").map(l=>l.id))}]:[])];
        if(entry)event.image.sourceKind=entry.source==="blank"?"blank":entry.page?"pdf-page":"image";
        const chatMessage=formatAnnotationChatMessage(event);
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
        pairImageId: ImageIdSchema.optional(),
        workspaceId: z.string().regex(/^ws:[0-9a-f]{16}$/).optional(),
        fromItem: WorkspaceItemId.optional(), toItem: WorkspaceItemId.optional(),
        linkId: z.string().min(1).max(64),
        review: z.enum([...LINK_REVIEW, "unreviewed"]),
        reason: z.string().max(200).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ imageId, pairImageId, workspaceId, fromItem, toItem, linkId, review, reason }) => {
      try {
        if (workspaceId) {
          const items = await workspaceItems((await resolveRef(workspaceId)).doc);
          const { owner, link } = reviewWorkspaceLink(items, { fromItem, toItem, id: linkId }, review, reason);
          await saveCanvas(owner.entry, { tool: "review_visual_link", author: "user", changed: [linkId], note: review });
          const shown = workspaceLinks(items).find((l) => l.id === linkId && [l.fromItem, l.toItem].includes(fromItem) && [l.fromItem, l.toItem].includes(toItem));
          return {
            content: [{ type: "text", text: "Link " + linkId + " marked " + review + " by the user." }],
            structuredContent: { kind: "estampes.link_review", imageId, workspaceId, link: wsWidgetLink(shown ?? { ...link, fromItem, toItem, from: link.left, to: link.right }) },
          };
        }
        if (!pairImageId) throw new Error("pairImageId or workspaceId is required");
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
        workspaceId: z.string().regex(/^ws:[0-9a-f]{16}$/).optional(), item: WorkspaceItemId.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ imageId, markId, review, reason, workspaceId, item }) => {
      try {
        let entry;
        if (workspaceId) {
          const items = await workspaceItems((await resolveRef(workspaceId)).doc);
          entry = items.find((it) => it.id === item)?.entry;
          if (!entry) throw new Error("No item " + item + " in " + workspaceId);
        } else entry = await ensureImage(imageId);
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

  // Private tool for the canvas widget: the user says whether some strokes
  // are one gesture (confirming or rejecting a candidate, or grouping marks
  // by hand). Only the verdict is stored; the strokes are untouched.
  registerAppTool(
    server,
    "review_gesture_group",
    {
      title: "Review a gesture group",
      description: "Record the user's verdict on whether some of their strokes in an Estampes canvas form one gesture.",
      inputSchema: z.object({
        imageId: ImageIdSchema.describe("The image the strokes are on (the right image's id for the right of a paired view)"),
        memberIds: z.array(z.string().min(1).max(64)).min(2).max(8),
        verdict: z.enum([...GESTURE_VERDICTS, "unreviewed"]),
        workspaceId: z.string().regex(/^ws:[0-9a-f]{16}$/).optional().describe("Workspace view: the strokes are on the canvas of this workspace's `item`"),
        item: WorkspaceItemId.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ imageId, memberIds, verdict, workspaceId, item }) => {
      try {
        let entry;
        if (workspaceId) {
          entry = (await workspaceItems((await resolveRef(workspaceId)).doc)).find((it) => it.id === item)?.entry;
          if (!entry) throw new Error("No item " + item + " in " + workspaceId);
        } else entry = await ensureImage(imageId);
        recordGestureDecision(entry, memberIds, verdict);
        await saveCanvas(entry, { tool: "review_gesture_group", author: "user", changed: memberIds, note: verdict });
        return {
          content: [{ type: "text", text: "Strokes " + memberIds.join(", ") + " marked " + verdict + " as one gesture by the user." }],
          structuredContent: { kind: "estampes.gesture_review", imageId, memberIds, verdict,
            gestureGroups: gestureGroups(canvasMarks(entry), entry, entry.gestureDecisions) },
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
    id: z.string().min(1).max(64), side: z.enum(["left", "right"]).optional(), item: WorkspaceItemId.optional(),
    x: Point01.optional(), y: Point01.optional(), x2: Point01.optional(), y2: Point01.optional(),
    points: PolylinePointsSchema.optional(), smooth: z.boolean().optional(), closed: z.boolean().optional(),
    label: z.string().max(64).optional(), note: z.string().max(200).optional(), color: z.enum(MARK_COLORS).optional(), size: z.enum(MARK_SIZES).optional(), pen: z.enum(MARK_PENS).optional(),
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
        workspaceId: z.string().regex(/^ws:[0-9a-f]{16}$/).optional().describe("Edits in a workspace view: entries name their `item`"),
        layers: z.array(z.object({
          id: z.string().regex(/^L\d{1,6}$/), side: z.enum(["left", "right"]).optional(), item: WorkspaceItemId.optional(),
          name: z.string().max(LAYER_NAME_MAX).optional(), locked: z.boolean().optional(), visible: z.boolean().optional(), opacity: z.number().min(0).max(1).optional(),
        }).strict()).max(60).default([]),
        order: z.record(z.string().regex(/^(left|right|wi-\d{1,4})$/), LayerIds).optional().describe("Layer ids bottom to top, per image (left/right, or workspace item id)"),
        marks: z.array(EditMarkSchema).max(30).default([]),
        remove: z.array(z.object({ id: z.string().min(1).max(64), side: z.enum(["left", "right"]).optional(), item: WorkspaceItemId.optional() }).strict()).max(30).default([]),
        history: z.object({ action: z.enum(["undo", "redo"]), side: z.enum(["left", "right"]).optional(), item: WorkspaceItemId.optional() }).strict().optional()
          .describe("Undo or redo the user's last mark edit on one image (move, resize, restyle, relabel, delete). Cannot be combined with other edits."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ imageId, pairImageId, workspaceId, layers, order, marks, remove, history: step }) => {
      try {
        if (step && (layers.length || order || marks.length || remove.length)) throw new Error("history cannot be combined with other edits");
        const stepOf = (entry) => (step.action === "undo" ? undoCanvasEdit : redoCanvasEdit)(entry);
        const stateOf = (entries) => Object.fromEntries(entries.map(([key, entry]) => [key, canvasHistory(entry)]));
        const resolveUser = (m) => {
          const { side: _s, item: _i, ...rest } = m;
          return replayUserAnnotation(VisualAnnotationSchema.parse(rest));
        };
        if (workspaceId) {
          // Workspace: the same edits, per item, all or nothing.
          const items = await workspaceItems((await resolveRef(workspaceId)).doc);
          const known = new Set(items.map((it) => it.id));
          if (step) {
            if (step.item && !known.has(step.item)) throw new Error("No item " + step.item + " in " + workspaceId);
            const it = items.find((x) => x.id === (step.item ?? items[0].id));
            const edit = stepOf(it.entry);
            await saveCanvas(it.entry, { tool: "edit_visual_canvas", author: "user", changed: [edit.id] });
            return {
              content: [{ type: "text", text: (step.action === "undo" ? "Undid" : "Redid") + " the last edit of mark " + edit.id + " on item " + it.id + "." }],
              structuredContent: { kind: "estampes.canvas_edit", imageId, workspaceId, edits: [{ ...edit, side: it.id }], annotations: wsMarks(items), layers: wsLayers(items),
                links: workspaceLinks(items).map(wsWidgetLink), history: stateOf(items.map((x) => [x.id, x.entry])) },
            };
          }
          for (const x of [...layers, ...marks, ...remove]) if (x.item && !known.has(x.item)) throw new Error("No item " + x.item + " in " + workspaceId);
          for (const key of Object.keys(order ?? {})) if (!known.has(key)) throw new Error("order: no item " + key + " in " + workspaceId);
          const first = items[0].id, of = (x) => x.item ?? first;
          const undo = [], all = [];
          try {
            for (const it of items) {
              const pick = {
                layers: layers.filter((l) => of(l) === it.id).map(({ side: _s, item: _i, ...l }) => l), order: order?.[it.id],
                marks: marks.filter((m) => of(m) === it.id), remove: remove.filter((m) => of(m) === it.id).map((m) => m.id), resolveUser,
              };
              if (!pick.layers.length && !pick.order && !pick.marks.length && !pick.remove.length) continue;
              const restore = snapshotCanvas(it.entry), savedEdits = [...(it.entry.userEdits ?? [])];
              undo.push(() => { restore(); it.entry.userEdits = savedEdits; });
              all.push({ it, edits: editCanvas(it.entry, pick) });
            }
          } catch (error) { undo.forEach((u) => u()); throw error; }
          for (const { it, edits } of all) await saveCanvas(it.entry, { tool: "edit_visual_canvas", author: "user", changed: edits.map((e) => e.id ?? e.layer ?? e.kind) });
          const edits = all.flatMap(({ it, edits }) => edits.map((e) => ({ ...e, side: it.id })));
          return {
            content: [{ type: "text", text: "Applied " + edits.length + " user edit(s) in workspace " + workspaceId + "." }],
            structuredContent: { kind: "estampes.canvas_edit", imageId, workspaceId, edits, annotations: wsMarks(items), layers: wsLayers(items), links: workspaceLinks(items).map(wsWidgetLink),
              history: stateOf(items.map((x) => [x.id, x.entry])) },
          };
        }
        const left = await ensureImage(imageId), right = pairImageId ? await ensureImage(pairImageId) : null;
        if (!right && [...layers, ...marks, ...remove].some((x) => x.side === "right")) throw new Error("side:'right' needs pairImageId");
        if (!right && order?.right) throw new Error("order.right needs pairImageId");
        if (step) {
          if (step.side === "right" && !right) throw new Error("side:'right' needs pairImageId");
          const entry = step.side === "right" ? right : left, edit = stepOf(entry), side = step.side ?? "left";
          await saveCanvas(entry, { tool: "edit_visual_canvas", author: "user", changed: [edit.id] });
          const all = right ? pairMarks(left, right) : canvasMarks(left);
          return {
            content: [{ type: "text", text: (step.action === "undo" ? "Undid" : "Redid") + " the last edit of mark " + edit.id + " on " + (side === "right" ? pairImageId : imageId) + "." }],
            structuredContent: { kind: "estampes.canvas_edit", imageId, ...(right ? { pairImageId } : {}), edits: [{ ...edit, side }], annotations: all,
              layers: right ? pairLayers(left, right) : canvasLayers(left), ...(right ? { links: shownLinks(left, right).map(widgetLink) } : {}),
              history: stateOf(right ? [["left", left], ["right", right]] : [["left", left]]) },
          };
        }
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
            ...(right ? { links: shownLinks(left, right).map(widgetLink) } : {}),
            history: stateOf(right ? [["left", left], ["right", right]] : [["left", left]]),
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
        "Retrieve PIXEL IMAGES for a user-marked location on an Estampes demo SVG. Call this when asked what a marked object is, rather than inferring objects from coordinates or scene names. Pass imageId='demo:'+scene, revision='svg-v1', and focus={type:'point'|'rect'|'arrow',x,y[,x2,y2]} copied from the user's Estampes annotation; for arrows the crop centres on the head x2/y2; when the user's arrow shows a direction rather than a target, pass a rect covering the whole arrow instead. Returns original PNG, full PNG with focus overlay, and locally cropped magnified PNG. These are image content blocks plus geometry metadata; if your host does not expose image pixels to vision, explicitly state that and do not guess the object's identity. This M0.4.3 tool supports ONLY bundled SVG demo images, not arbitrary user uploads or web image search.",
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
              "If your host hides image blocks from the model, say you could not inspect the pixels."},
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
        "LEGACY standalone PNG evidence viewer, retained for older conversations and explicit requests for the separate 3-PNG view. Do NOT call after present_visual in the same visual task: present_visual now already includes annotation, original image and zoom in one shared canvas. For general new visual exchanges prefer inspect_visual (model pixels) followed by present_visual (one UI). This tool performs no object recognition.",
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
        "Load a photo, scan or picture so Estampes can preprocess it (enhance, zoom, grid). To simply SHOW the user a photo with marks, call present_visual with the image directly instead; it loads it too. Pass `image` for a file the user attached or photographed in this conversation (hosts that pass attachments to tools), OR `imageUrl` for a public https image you found. If neither is possible (the host does not pass attachments), call present_visual with upload: true so the user picks or photographs the image in the canvas. Returns an imageId plus a preview image. Use the imageId with process_image (enhance, threshold, edges, zoom into a region) and overlay_grid (labelled grid for precise locating). Estampes never identifies content; you do, from the returned pixels.",
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
      "} and pixel coordinates from this image. If the host result budget resizes it, include width and height from the delivered image in coordinateFrame (older form: {region: " + JSON.stringify(out.region) + ", width: " + out.width + ", height: " + out.height + "}).";
  };
  // What the model gets about a view: everything except the step list.
  const viewSummary = (record) => {
    const { coordinateMapping: { steps, ...mapping }, ...rest } = record;
    return { ...rest, coordinateMapping: { ...mapping, steps: steps.map((st) => st.kind) } };
  };
  const DerivedViewSchema = z.record(z.string(), z.unknown());

  server.registerTool("add_image_layer",{
    title:"Add an independent image/canvas layer",
    description:"Promote the base image into an editable layer, optionally copy another canvas and its public objects/marks as independent layers. PNG transparency is preserved. Source is never modified. sourceSet can identify a workspace copy. region positions the copied content in destination normalized coordinates.",
    inputSchema:z.object({imageId:ImageIdSchema,sourceImageId:ImageIdSchema.optional(),sourceSet:z.string().regex(/^c[0-9a-f]{12}$/).optional(),region:RegionSchema.optional()}),
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async({imageId,sourceImageId,sourceSet,region})=>{
    try{
      if(sourceSet&&!sourceImageId)throw Error("sourceSet requires sourceImageId");
      const entry=await ensureImage(imageId),source=sourceImageId?await ensureSet(sourceImageId+(sourceSet?"#"+sourceSet:"")):null;
      const result=await composeCanvas(entry,source,region);
      await saveCanvas(entry,{tool:"add_image_layer",author:"user",changed:result.created});
      return {content:[{type:"text",text:"Independent layers ready."}],structuredContent:{kind:"estampes.composed_canvas",imageId,objects:widgetObjects(entry),layers:canvasLayers(entry),annotations:canvasMarks(entry),baseAsObject:!!entry.baseAsObject}};
    }catch(error){return fail(error);}
  });

  server.registerTool("render_canvas", {
    title: "Read visible canvas pixels",
    description: "Render the base image, public scene objects and saved marks, including Graph and handwriting. Use for whiteboards and mixed scenes; process_image reads only source pixels. Pass the submission's canvasReads request (expectedRevision and hiddenLayers) to preserve its state and visibility; STALE_CANVAS means that old state is unavailable. Mark labels default to none; formula and axis text stay visible. Returns a pixel-to-canvas mapping. Does not run modules or include scratch. Shared layer visibility is respected; hiddenLayers can additionally hide layers for this render. Workspace copies require setId from canvasReads.",
    inputSchema: z.object({ imageId: ImageIdSchema, setId: z.string().regex(/^c[0-9a-f]{12}$/).optional(),
      region: RegionSchema.optional(), maxSide: z.number().int().min(64).max(4096).default(1600),
      format: z.enum(["png", "webp"]).default("png"), labels: z.enum(["none", "all"]).default("none"),
      hiddenLayers: z.array(z.string().regex(/^L\d+$/)).max(200).default([]),
      expectedRevision: z.string().regex(/^cv:[0-9a-f]{24}$/).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ imageId, setId, ...options }) => {
    try {
      const entry = await ensureSet(imageId + (setId ? "#" + setId : ""));
      const out = await renderCanvas(entry, options);
      return { content: [{ type: "text", text: "Visible canvas composite; " + out.metadata.revision }, imageBlock(out)], structuredContent: out.metadata };
    } catch (error) {
      return { ...fail(error), structuredContent: { kind: "estampes.canvas_render_error", code: error.code ?? "INVALID_RENDER", ...(error.revision ? { revision: error.revision } : {}) } };
    }
  });

  server.registerTool(
    "process_image",
    {
      title: "Preprocess an image region",
      description:
        "Read only the source image, excluding scene objects and all annotations. For handwriting or Graph on the canvas use render_canvas. Return a processed view of a loaded image to help you read or locate details. Optionally crop to `region`, then apply `ops` in order, e.g. [{op:'clahe'},{op:'sharpen'}] for blurry scans or dark boards, [{op:'grayscale'},{op:'threshold',method:'adaptive'}] for handwriting and book pages, [{op:'edges'}] for thin lines and outlines. " +
        "`sampling.mode` picks the resolution the ops run at: preview (default; old behaviour, the crop is resized to the output first and zoomed up to 8x by interpolation), working (the cached working copy at its own pixels), native (pixels cut from the original file; use it for small text, fine traces and anything you must not guess, before trying interpolation). " +
        "`output` picks the delivered size and codec (png/webp are lossless). Every result has a derivedViewId, a coordinate mapping back to the image and caveats (interpolated, lossy, thresholded, enhanced): enhanced pixels are not new evidence, so check the original. Output is for your analysis; the user sees the original unless you choose to show this.",
      inputSchema: z.object({
        imageId: ImageIdSchema,
        region: RegionSchema.optional(),
        ops: z.array(OpSchema).max(8).default([]),
        geometry: GeometrySchema.optional().describe("Geometry steps applied first (rotate, flip, pad, deskew, perspective, mask); marks read off the result still map back through its derivedViewId"),
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
        delivery: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ imageId, region, ops, geometry, sampling, output }) => {
      try {
        const { out, record } = await deliverView(await ensureImage(imageId), { region, ops, geometry, sampling, output });
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

  // ---- Registration, comparison, quality and measurement (P1) ----------
  const RegIdSchema = z.string().regex(/^reg:[0-9a-f]{16}$/);
  const NormPoint = z.object({ x: Point01, y: Point01 });
  const regSummary = ({ inlierPairs, landmarkResiduals, ...rest }) => ({ ...rest, ...(landmarkResiduals ? { landmarkResiduals } : {}) });

  server.registerTool(
    "register_images",
    {
      title: "Align one image to another",
      description:
        "Estimate how image B maps onto image A (a transform in normalized coordinates, both directions) and report how good it is. `method: auto` matches corner features (needs texture shared by both photos: the same board, page or scene); `method: landmarks` fits a transform from 2-4+ point pairs you or the user identified (`landmarks: [{a:{x,y}, b:{x,y}}]`, normalized to each image); use it when auto fails or the two images are different kinds (a schematic and a photo are NOT alignable by pixels). `mirror: true` aligns a flipped copy of B (front vs back of a board). Result: status ok/failed with reasons, inliers, inlier ratio, median and P95 error in pixels, error at held-out points, conditioning, coverage and residuals per area of A; the returned `registrationId` feeds compare_images. `status: ok` means a transform was fitted and passed its checks; `alignmentConfidence` (high, medium, low, unverified) with `confidenceReasons` says how far to trust it across the whole image: four landmarks always fit a homography exactly (unverified), and points clustered in one area leave the rest extrapolated. A homography is exact only for flat subjects. Optional `mapPoints` maps points of A onto B (or B onto A with `direction: 'b-to-a'`). The alignment is a measurement aid; it creates no marks and does not say what anything is.",
      inputSchema: z.object({
        imageId: ImageIdSchema.describe("Image A (the reference)"),
        otherImageId: ImageIdSchema.describe("Image B (the one to align onto A)"),
        method: z.enum(["auto", "landmarks"]).default("auto"),
        landmarks: z.array(z.object({ a: NormPoint, b: NormPoint })).max(40).default([]),
        model: z.enum(REGISTER_MODELS).default("homography").describe("similarity (2+ points), affine (3+), homography (4+, flat subjects)"),
        mirror: z.boolean().default(false),
        mapPoints: z.array(NormPoint).max(50).optional(),
        direction: z.enum(["a-to-b", "b-to-a"]).default("a-to-b"),
        includeMatches: z.boolean().default(true).describe("Return an image with the matched points drawn"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ imageId, otherImageId, method, landmarks, model, mirror, mapPoints, direction, includeMatches }) => {
      try {
        if (imageId === otherImageId) throw new Error("Pass two different images");
        if (method === "landmarks" && !landmarks.length) throw new Error("method landmarks needs landmarks");
        const a = await ensureImage(imageId), b = await ensureImage(otherImageId);
        const reg = remember(await registerPair(a, b, { method, landmarks, model, mirror }));
        const mapped = reg.status === "ok" && mapPoints
          ? mapPoints.map((p) => { const m = direction === "a-to-b" ? reg.normalizedAtoB : reg.normalizedBtoA; const q = applyMatrix(m, p.x, p.y); return { from: p, to: { x: Number(q.x.toFixed(5)), y: Number(q.y.toFixed(5)) }, inside: q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1 }; })
          : undefined;
        const content = [{ type: "text", text: "Registration " + reg.registrationId + " " + reg.status.toUpperCase() + " (" + model + (mirror ? ", mirrored" : "") + "): " +
          (reg.quality ? reg.quality.inliers + "/" + reg.quality.correspondences + " inliers, median " + reg.quality.medianErrorPx + " px, P95 " + reg.quality.p95ErrorPx + " px, coverage " + Math.round(reg.quality.coverage * 100) + "%. " : "") +
          (reg.quality?.heldOut ? "Held-out points (" + reg.quality.heldOut.scheme + "): median " + reg.quality.heldOut.medianErrorPx + " px, P95 " + reg.quality.heldOut.p95ErrorPx + " px. " : "") +
          (reg.status === "ok" ? "Alignment confidence: " + reg.alignmentConfidence + (reg.confidenceReasons?.length ? " (" + reg.confidenceReasons.join("; ") + ")" : "") + ". OK means a transform was fitted and passed its checks, not that the whole image is verified. " : "") +
          (reg.reasons?.length ? "Why not: " + reg.reasons.join("; ") + ". " : "") + (reg.notes.length ? "Note: " + reg.notes.join("; ") + ". " : "") +
          "Details in structuredContent; use compare_images to look at the alignment." }];
        if (includeMatches && reg.status === "ok" && method === "auto") content.push(imageBlock(await compareView(a, b, reg, { mode: "matches" })));
        return { content, structuredContent: { kind: "estampes.registration", ...regSummary(reg), ...(mapped ? { mappedPoints: mapped } : {}) } };
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "compare_images",
    {
      title: "Compare two aligned images",
      description: "Show image B warped onto image A using a registration: `overlay` (50% blend), `difference` (absolute grey difference), `checkerboard` (alternating tiles to check edges line up) or `matches`. Also returns overlap, mean difference, PSNR and SSIM over the area both images cover; lighting changes lower them without any misalignment, so read differences as 'look here', not as proof. Areas of A with no pixels from B are dimmed.",
      inputSchema: z.object({
        registrationId: RegIdSchema,
        mode: z.enum(["overlay", "difference", "checkerboard", "matches"]).default("overlay"),
        maxSide: z.number().int().min(256).max(1600).default(1024),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ registrationId, mode, maxSide }) => {
      try {
        const reg = registrations.get(registrationId);
        if (!reg) throw new Error("Unknown registrationId " + registrationId + "; call register_images again (the same inputs give the same id)");
        if (reg.status !== "ok") throw new Error("That registration failed (" + (reg.reasons ?? []).join("; ") + "); nothing to compare");
        const a = await ensureImage(reg.a), b = await ensureImage(reg.b);
        const out = await compareView(a, b, reg, { mode, side: maxSide });
        return {
          content: [{ type: "text", text: "Comparison " + mode + " of " + reg.b + " onto " + reg.a + " in A's frame, " + out.width + "x" + out.height + " px" +
            (out.metrics ? ". Overlap " + Math.round((out.metrics.overlap ?? 0) * 100) + "%, mean difference " + out.metrics.meanAbsDiff + ", SSIM " + out.metrics.ssim + ", PSNR " + out.metrics.psnr : "") + "." }, imageBlock(out)],
          structuredContent: { kind: "estampes.comparison", registrationId, mode, a: reg.a, b: reg.b, width: out.width, height: out.height, metrics: out.metrics },
        };
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "assess_image",
    {
      title: "Measure image quality",
      description: "Measure what limits reading an image or a region before choosing filters: sharpness (Laplacian variance), noise sigma, contrast and dynamic range, clipped highlights and crushed shadows per channel, colour cast, a luminance histogram and the dominant line tilt, with plain advice. Values depend on the analysis resolution (stated), so compare only crops measured at the same scale. `clippingMap: true` also returns an image with clipped highlights red and crushed shadows blue.",
      inputSchema: z.object({
        imageId: ImageIdSchema,
        region: RegionSchema.optional(),
        sampling: SamplingSchema.optional(),
        clippingMap: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ imageId, region, sampling, clippingMap: wantMap }) => {
      try {
        const entry = await ensureImage(imageId);
        // Measured on the analysis pixels, before any delivery resize.
        const { analysisPixels } = await analysisFor(entry, { region, sampling: { mode: "working", ...sampling } });
        const q = await measureQuality(analysisPixels.img);
        const info = { kind: "estampes.image_quality", imageId, region: analysisPixels.region, analysis: { space: analysisPixels.space, width: analysisPixels.img.width, height: analysisPixels.img.height, sourcePixelsPerAnalysisPixel: analysisPixels.srcPerPx }, ...q };
        const content = [{ type: "text", text: "Quality of " + imageId + " region " + JSON.stringify(analysisPixels.region) + " at " + analysisPixels.space + " resolution (" + info.analysis.width + "x" + info.analysis.height + "): sharpness " + q.metrics.sharpness.laplacianVariance + ", noise " + q.metrics.noise.sigma + ", dynamic range " + q.metrics.contrast.dynamicRange + ". " + (q.advice.length ? "Advice: " + q.advice.join("; ") + "." : "Nothing stands out.") }];
        if (wantMap) content.push(imageBlock(await clippingMap(analysisPixels.img)));
        return { content, structuredContent: info };
      } catch (error) { return fail(error); }
    }
  );

  const scaleKey = (derivedViewId) => derivedViewId ?? "image";
  const spaceOf = (entry, derivedViewId) => {
    if (!derivedViewId) return { kind: "image" };
    const record = findView(entry, derivedViewId);
    if (!record) throw new Error("Unknown derivedViewId " + derivedViewId + " for " + entry.imageId);
    return { kind: "view", record };
  };
  const SpaceArgs = {
    derivedViewId: DerivedViewIdSchema.optional().describe("Measure in this processed view's pixels (best: a perspective-rectified view of a flat surface, where distances are uniform). Omit for source-image pixels"),
    units: z.enum(["normalized", "pixels"]).default("normalized").describe("normalized = 0..1 of the image (or of the view); pixels = pixels of the view, or oriented source pixels without derivedViewId"),
  };
  const perspectiveWarning = (space) => space.kind === "image" ? "measured in image pixels: on a tilted photo distances are not uniform; rectify with process_image geometry perspective and measure in that view for flat surfaces" : null;

  server.registerTool(
    "calibrate_scale",
    {
      title: "Set a real-world scale",
      description: "Tell Estampes that the distance between two points is a known length (a ruler, a connector pitch, a printed dimension), so measure_image can report real units. The scale belongs to one measurement space: the source image, or one processed view (pass its derivedViewId). Stored with the image. Only valid for a flat surface at the same distance as the reference.",
      inputSchema: z.object({
        imageId: ImageIdSchema, ...SpaceArgs,
        points: z.array(NormPoint.extend({ x: z.number().finite(), y: z.number().finite() })).length(2),
        length: z.number().positive(), unit: z.enum(UNITS.filter((u) => u !== "px")),
        lengthUncertainty: z.number().min(0).optional().describe("Uncertainty of the stated length, same unit"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ imageId, derivedViewId, units, points, length, unit, lengthUncertainty }) => {
      try {
        const entry = await ensureImage(imageId), space = spaceOf(entry, derivedViewId);
        const px = toSpacePixels(entry, space, points, units);
        const cal = calibrate({ points: px, length, unit, sigmaPx: defaultSigma(entry, space), lengthUncertainty });
        (entry.calibrations ??= new Map()).set(scaleKey(derivedViewId), cal);
        await saveDerived(entry);
        return { content: [{ type: "text", text: "Scale set for " + (derivedViewId ?? "the source image") + ": " + length + " " + unit + " = " + cal.referencePx.toFixed(1) + " px (" + cal.unitsPerPixel.toPrecision(5) + " " + unit + "/px, ±" + (cal.relativeUncertainty * 100).toFixed(2) + "%)." + (perspectiveWarning(space) ? " Caution: " + perspectiveWarning(space) + "." : "") }],
          structuredContent: { kind: "estampes.scale", imageId, derivedViewId: derivedViewId ?? null, ...cal } };
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "measure_image",
    {
      title: "Measure distance, path, area or angle",
      description: "Measure between points you read off an image or processed view: `distance` (2 points), `path` (polyline length), `area` (polygon) or `angle` (3 points: end, vertex, end). Without a calibrate_scale in the same space the answer is in pixels; real units are never guessed. Every value has an uncertainty from point precision (about one working pixel) and the scale. The result is a measurement, not a mark: draw it with present_visual if the user should see it.",
      inputSchema: z.object({
        imageId: ImageIdSchema, ...SpaceArgs,
        kind: z.enum(["distance", "path", "area", "angle"]),
        points: z.array(z.object({ x: z.number().finite(), y: z.number().finite() })).min(2).max(128),
        pointPrecisionPx: z.number().min(0.1).max(50).optional().describe("Your estimate of how well you placed the points, in pixels of the measurement space"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ imageId, derivedViewId, units, kind, points, pointPrecisionPx }) => {
      try {
        const entry = await ensureImage(imageId), space = spaceOf(entry, derivedViewId);
        const px = toSpacePixels(entry, space, points, units);
        const calibration = entry.calibrations?.get(scaleKey(derivedViewId)) ?? null;
        const m = measure(kind, px, { calibration, sigmaPx: pointPrecisionPx ?? defaultSigma(entry, space) });
        const warnings = [];
        if (!calibration) warnings.push("no scale calibrated for this space; value is in pixels");
        const w = perspectiveWarning(space); if (w && calibration) warnings.push(w);
        return {
          content: [{ type: "text", text: kind + ": " + m.value + " ±" + m.uncertainty + " " + m.unit + (warnings.length ? ". " + warnings.join("; ") : "") + "." }],
          structuredContent: { kind: "estampes.measurement", imageId, derivedViewId: derivedViewId ?? null, ...m, calibrated: Boolean(calibration), points: spaceToNormalized(entry, space, px).map((p) => ({ x: Number(p.x.toFixed(5)), y: Number(p.y.toFixed(5)) })), warnings },
        };
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "render_pdf_page",
    {
      title: "Render a PDF page as an image",
      description:
        "Render one PHYSICAL page of a PDF at a chosen DPI so it can be shown, processed and annotated like any image (the result is an imageId; use it with process_image, present_visual, ...). Pass the PDF as `pdf` (file from the conversation) or `pdfUrl`, or `documentSha256` of one given earlier (kept when the server has storage). `pageIndex` is 0-based physical position (the fifth page is 4); printed page numbers can differ, so the result lists `pageLabel` when the PDF defines it. Omit pageIndex to get only the page count and labels. `text: true` also returns the embedded text layer with boxes (normalized to the page image) so you can read text without OCR; scanned pages have none. The image covers the page's visible box with rotation applied, so normalized coordinates are the same at every DPI. Needs the optional PDF support to be installed on the server.",
      inputSchema: z.object({
        pdf: ChatFileSchema.optional().describe("PDF file from the conversation"),
        pdfUrl: z.string().url().max(2048).optional().describe("Public https URL of a PDF"),
        documentSha256: z.string().regex(/^[0-9a-f]{64}$/).optional().describe("A PDF given to this server before"),
        pageIndex: z.number().int().min(0).max(4999).optional().describe("0-based physical page; omit for document info only"),
        dpi: z.number().int().min(36).max(MAX_DPI).default(150),
        text: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: { "openai/fileParams": ["pdf"] },
    },
    async ({ pdf, pdfUrl, documentSha256, pageIndex, dpi, text }) => {
      try {
        if ([pdf, pdfUrl, documentSha256].filter(Boolean).length !== 1) throw new Error("Provide exactly one of pdf, pdfUrl or documentSha256");
        const avail = await pdfAvailable();
        if (!avail.ok) throw new Error(avail.reason + ". Ask the server owner to enable it (docs/IMAGE-PIPELINE.md#pdf-pages)");
        let bytes;
        if (documentSha256) {
          bytes = await loadDocument(documentSha256);
          if (!bytes) throw new Error("No stored PDF " + documentSha256 + (config.storageDir ? "" : " (the server has no storage)") + "; send the file again");
        } else bytes = await downloadImage(pdf ? pdf.download_url : pdfUrl);
        if (!isPdf(bytes)) throw new Error("That file is not a PDF");
        if (pageIndex === undefined) {
          const info = await pdfInfo(bytes);
          await saveDocument(bytes, info.documentSha256);
          return { content: [{ type: "text", text: "PDF " + info.documentSha256.slice(0, 12) + ": " + info.pageCount + " pages (physical, 0-based index). Call again with pageIndex." }],
            structuredContent: { kind: "estampes.pdf_info", ...info } };
        }
        const { png, info, boxes } = await renderPdfPage(bytes, { pageIndex, dpi, text });
        await saveDocument(bytes, info.documentSha256);
        const entry = await intakeImage(png, { source: "pdf-page", fileName: "page-" + (pageIndex + 1) + ".png", page: info });
        const shown = boxes ? boxes.slice(0, 400) : null;
        return {
          content: [
            { type: "text", text: "Rendered physical page " + (pageIndex + 1) + " of " + info.pageCount + (info.pageLabel ? " (printed label " + JSON.stringify(info.pageLabel) + ")" : "") + " at " + dpi + " dpi as " + entry.imageId + " (" + entry.width + "x" + entry.height + "). " +
              (boxes ? (boxes.length ? boxes.length + " text boxes" + (boxes.length > 400 ? " (first 400 returned)" : "") + " in structuredContent.textBoxes; positions are approximate for rotated text. " : "No text layer on this page (scanned?); read it from the image. ") : "") +
              "Marks use normalized coordinates, identical at any dpi. The next block is the page." },
            imageBlock(await previewImage(entry)),
          ],
          structuredContent: { kind: "estampes.pdf_page", imageId: entry.imageId, sourceAssetId: entry.sourceAssetId, width: entry.width, height: entry.height, page: info,
            ...(shown ? { textBoxes: shown, textBoxesTruncated: boxes.length > shown.length } : {}) },
        };
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    "detect_features",
    {
      title: "Detect structure with an analysis engine",
      description:
        "Run an analysis engine on an image or region and get structured detections in normalized image coordinates: `components` (connected dark/light regions as boxes), `regions` (closed regions such as grains, cells, particles or pads, with touching blobs split by shape; outline, area, perimeter, equivalent diameter, axes, circularity per region), `blobs` (point-like sources: stars, solder joints, particles, with centroid, flux and FWHM), `lines` (straight segments), `circles` (rings, holes, dials), `ocr` (words with boxes; optional install). Each detection has geometry, attributes and, where meaningful, a confidence, plus a ready `mark` you can pass to present_visual once you have checked it against the image. Detections are candidates: they say where pixels have a shape, not what the thing is (two lines are not a verified wire; recognised text is not a verified part number; a region count is not a verified count of objects). Nothing is drawn on the canvas. Call with `engine` omitted to list engines and whether each is available. Results state the analysis resolution; use sampling native for small features. " +
        "To detect on processed pixels (after threshold, CLAHE, denoise, morphology, a perspective fix...), pass `derivedViewId` from process_image: the engine then reads that view's pixels, not the source, and each detection carries both image coordinates and `view` pixel coordinates. Without it the engine always reads source pixels, whatever was processed before.",
      inputSchema: z.object({
        imageId: ImageIdSchema.optional(),
        engine: z.enum(["components", "regions", "blobs", "lines", "circles", "ocr"]).optional(),
        derivedViewId: DerivedViewIdSchema.optional().describe("Run on the pixels of this processed view of imageId instead of the source pixels. Do not combine with region or sampling: the view has its own"),
        region: RegionSchema.optional(),
        sampling: SamplingSchema.optional(),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}).describe("Engine parameters, see the engine list"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ imageId, engine, derivedViewId, region, sampling, params }) => {
      try {
        if (!engine) {
          const engines = await listEngines();
          return { content: [{ type: "text", text: "Engines: " + engines.map((e) => e.id + (e.ok ? "" : " (unavailable)")).join(", ") + ". " + JSON.stringify(engines) }],
            structuredContent: { kind: "estampes.engines", engines } };
        }
        if (!imageId) throw new Error("imageId is required with engine");
        const res = await runEngine(await ensureImage(imageId), engine, { region, sampling, params, derivedViewId });
        const n = res.detections.length;
        const text = engine + " " + res.status + (res.reasons?.length ? " (" + res.reasons.join("; ") + ")" : "") + ": " + n + " detection" + (n === 1 ? "" : "s") +
          (derivedViewId ? " on processed view " + derivedViewId : " on source pixels") +
          (res.analysis ? " at " + res.analysis.space + " resolution " + res.analysis.width + "x" + res.analysis.height : "") +
          (res.quality ? ". Summary: " + JSON.stringify(res.quality) : "") +
          (res.warnings?.length ? ". Notes: " + res.warnings.join("; ") : "") + ". Candidates only; check them against the image before marking. " +
          JSON.stringify(res.detections.slice(0, 12)) + (n > 12 ? " ... (all in structuredContent)" : "");
        return { content: [{ type: "text", text }], structuredContent: { kind: "estampes.detections", ...res } };
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

  // ---- Modules and the Store (src/modules) --------------------------------
  registerLayerTools(server, { ensureSet, saveCanvas });
  registerTextTools(server, { ensureSet, saveCanvas });
  registerModuleTools(server, {
    host: moduleHost, storeUri: STORE_URI, storeHtml, visualUri: VISUAL_URI, canvasPayload, logSizes,
    ensureImage, saveCanvas, canvasLayers,
    // The model changed a calculator notebook that has auto-refresh on: redraw its linked plots, like the panel does for the user.
    afterRun: async ({ module, capability, params, run }) => {
      if (module !== "org.estampes.cas") return null;
      const r = await autoRefresh({ host: moduleHost, notebooks: notebookStore(), capability, notebookId: params.notebook ?? run.data?.notebookId });
      return r ? "Auto-refresh: recomputed " + r.recomputed.length + " cell(s), redrew " + r.updated.length + " Graph plot(s)" + (r.failed.length ? ", " + r.failed.length + " could not be updated (" + r.failed.map((f) => f.reason).slice(0, 2).join("; ") + ")" : "") + (r.remaining ? ", " + r.remaining + " cell(s) still stale" : "") + "." : null;
    },
  });
  registerSurfaceTools(server, { service: surfaceService, host: moduleHost, notebooks: notebookStore, casClient: () => casClientInstance, ensureImage, visualUri: VISUAL_URI, canvasPayload });

  registerUvaTools(server, { service: uvaService, visualUri: VISUAL_URI, maxResultChars: config.maxResultChars, exportLink: (id) => publicUrl() + "/export/uva/" + id + ".zip" + (ACCESS_KEY ? "?sig=" + exportSignature(ACCESS_KEY, id, "uva.zip") : "") });
  return server;
}

// What the canvas widget needs to show one image's canvas (the same shape
// present_visual returns), for tools that change a canvas without drawing
// marks themselves, such as execute_module.
async function canvasPayload(entry) {
  const shown = await widgetImage(entry, INLINE_IMAGE_CHARS), marks = canvasMarks(entry), exports = exportLinks(entry.imageId);
  return {
    structuredContent: {
      kind: "estampes.visual_surface", protocol: VISUAL_PROTOCOL, imageId: entry.imageId, width: entry.width, height: entry.height,
      views: [], marks: marks.map(compactMark), layers: canvasLayers(entry), coordinateSystem: "normalized-top-left", ...(exports ? { exports } : {}),
    },
    _meta: {
      "estampes/image": metaImage(shown),
      "estampes/views": [], "estampes/annotations": marks, "estampes/baseAsObject": !!entry.baseAsObject, "estampes/objects": widgetObjects(entry), "estampes/canRestoreObjects": !!entry.deletedObjectBatches?.length,
    },
  };
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
// Created at startup, once storage is checked (see below).
let moduleHost = null, surfaceService = null, uvaService = null;
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
  return sameSecret(url.searchParams.get("key"), ACCESS_KEY) || sameSecret(bearer, ACCESS_KEY) || oauth.validAccessToken(bearer);
}

// OAuth sign-in for hosts that prefer it over a key in the URL (see src/oauth.js).
const oauth = createOAuth({ getKey: () => ACCESS_KEY,
  fetchClientDocument: async (clientUrl) => JSON.parse((await downloadImage(clientUrl, { maxBytes: 64 * 1024, accept: "application/json" })).toString("utf8")) });

// The origin clients reach this server on, for OAuth metadata.
function requestOrigin(req) {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, "");
  const fwd = (name) => config.trustProxy > 0 ? String(req.headers[name] ?? "").split(",")[0].trim() : "";
  const forwardedProto = fwd("x-forwarded-proto");
  const forwardedHost = fwd("x-forwarded-host");
  if (forwardedProto === "https" && /^[a-z0-9.:[\]-]+$/i.test(forwardedHost)) {
    return "https://" + forwardedHost;
  }
  // A quick tunnel terminates TLS outside the container. Never downgrade
  // a known public HTTPS origin to an internal HTTP forwarded Host.
  if (tunnelOrigin) return tunnelOrigin.replace(/\/+$/, "");
  if (forwardedProto === "http" && /^[a-z0-9.:[\]-]+$/i.test(forwardedHost)) {
    return "http://" + forwardedHost;
  }
  const host = String(req.headers.host ?? "").trim();
  if (/^[a-z0-9.:[\]-]+$/i.test(host)) return "http://" + host;
  return seenOrigin;
}

async function handleOAuth(req, res, url) {
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "access-control-allow-origin": "*", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  const html = (status, body) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
    res.end(body);
  };
  const redirect = (location) => { res.writeHead(302, { location, "cache-control": "no-store" }); res.end(); };
  const origin = requestOrigin(req);
  const path = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization, mcp-protocol-version" });
    res.end();
    return;
  }
  if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
    json(200, oauth.resourceMetadata(origin)); return;
  }
  if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")) {
    json(200, oauth.serverMetadata(origin)); return;
  }
  if (rateLimited(req)) { json(429, { error: "slow_down", error_description: "Too many requests" }); return; }
  try {
    if (path === "/oauth/register" && req.method === "POST") {
      const out = oauth.register(await readBody(req));
      json(out.status, out.body);
      return;
    }
    if (path === "/oauth/authorize" && (req.method === "GET" || req.method === "POST")) {
      const params = req.method === "GET" ? Object.fromEntries(url.searchParams) : await readBody(req);
      const out = await (req.method === "GET" ? oauth.checkAuthorize(params) : oauth.approve(params));
      if (out.redirect) {
        if (req.method === "POST") log("info", "[oauth] sign-in " + (out.redirect.includes("code=") ? "approved" : "not approved"));
        redirect(out.redirect);
      } else if (out.html) html(out.status, out.html);
      else if (out.client) html(200, oauth.consentPage(params, { client: out.client }));
      else html(400, "<!doctype html><meta charset=utf-8><title>Estampes</title><p>" + out.page.replace(/[<>&]/g, "") + "</p>");
      return;
    }
    if (path === "/oauth/token" && req.method === "POST") {
      const out = oauth.token(await readBody(req));
      json(out.status, out.body);
      return;
    }
  } catch (error) {
    json(error?.status ?? 400, { error: "invalid_request", error_description: String(error?.message || error) });
    return;
  }
  json(404, { error: "not_found" });
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
      imageTools: ["load_image", "process_image", "overlay_grid", "inspect_image", "get_derived_view", "register_images", "compare_images", "assess_image", "calibrate_scale", "measure_image", "render_pdf_page", "detect_features"],
      imageApi: VIEW_API,
      imageInput: ["openai-file-param", "https-url"],
      visualProtocol: VISUAL_PROTOCOL,
      stateTool: "get_visual_state",
      stateApi: "/api/v1/canvas/{hash}",
      workspaceProtocol: WORKSPACE_PROTOCOL,
      workspaceApi: "/api/v1/workspaces/{hash}",
      workspaceTools: ["create_workspace", "edit_workspace", "merge_workspaces", "split_workspace", "undo_workspace_change", "get_workspace_state", "export_workspace_bundle", "import_workspace_bundle"],
      storage: config.storageDir ? "disk" : "memory",
    }));
    return;
  }

  // Saved logical exports remain downloadable with Beta disabled. No writer
  // is opened and no experimental data are migrated by this read-only path.
  const uvaExport = /^\/export\/uva\/([0-9a-f]{64})\.zip$/.exec(url.pathname);
  if (uvaExport && req.method === "GET") {
    if (!exportAllowed(ACCESS_KEY, uvaExport[1], "uva.zip", url.searchParams.get("sig"))) { res.writeHead(403); res.end("Invalid export signature"); return; }
    import("./src/uva/exports.js").then(m => m.readSavedExport(config.uvaBetaDir, uvaExport[1])).then(bytes => {
      res.writeHead(200, { "content-type": "application/zip", "content-disposition": 'attachment; filename="workspace.uva.zip"', "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(bytes);
    }, error => { res.writeHead(404); res.end("Saved export unavailable: " + error.message); });
    return;
  }

  // A workspace as a .estampes bundle, signed like the other exports.
  const bundleMatch = /^\/export\/ws\/([0-9a-f]{16})\/workspace\.estampes$/.exec(url.pathname);
  if (bundleMatch && req.method === "GET") {
    if (!exportAllowed(ACCESS_KEY, bundleMatch[1], "workspace.estampes", url.searchParams.get("sig"))) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("This download link is not signed for this server. Ask for the bundle again to get a fresh link.");
      return;
    }
    const send = (built) => {
      res.writeHead(200, {
        "content-type": "application/zip", "content-length": built.buffer.length,
        "content-disposition": "attachment; filename=\"" + built.fileName + "\"",
        "x-content-type-options": "nosniff", "cache-control": "no-store",
      });
      res.end(built.buffer);
    };
    // The file the tool described; after a restart it is built again from the stored workspace.
    const cached = bundleCache.get(bundleMatch[1]);
    if (cached) { send(cached); return; }
    exportBundle("ws:" + bundleMatch[1], { version: VERSION }).then(send, (error) => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Workspace not found on this server: " + String(error?.message || error));
    });
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
      res.end("Image expired from this server" + (config.storageDir ? "" : " (memory only)") + ". Show it again in the chat, then export.");
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

  // A workspace as an estampes.workspace/1 document: /api/v1/workspaces/<hex>.
  const wsMatch = /^\/api\/v1\/workspaces\/([0-9a-f]{16})$/.exec(url.pathname);
  if (wsMatch && req.method === "GET") {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    if (!authorized(req, url)) { json(401, { error: "Missing or invalid Estampes access key" }); return; }
    const history = Math.min(200, Math.max(0, Number(url.searchParams.get("history")) || 0));
    resolveRef("ws:" + wsMatch[1]).then(async ({ doc }) => json(200, await workspaceDocument(doc, { history })))
      .catch((error) => json(404, { error: String(error?.message || error) }));
    return;
  }

  // For Docker/compose health checks and uptime monitors: 200 while the
  // server answers and, when storage is on, the storage folder is writable.
  if (url.pathname === "/healthz" && req.method === "GET") {
    Promise.all([storageHealth(), casStatus()]).then(([storage, cas]) => {
      const ok = !storage.enabled || storage.writable;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok, version: BUILD_VERSION, uptimeSeconds: Math.round(process.uptime()), storage,
        // A stopped calculator degrades only the calculator; everything else keeps working.
        cas: cas.available ? { available: true, engine: cas.engine } : { available: false, reason: cas.reason } }));
    });
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Estampes MCP M0 (SDK 2.x)");
    return;
  }

  // OAuth only exists when the server has an access key to protect.
  if (ACCESS_KEY && (url.pathname.startsWith("/.well-known/oauth-") || url.pathname === "/.well-known/openid-configuration" || url.pathname.startsWith("/oauth/"))) {
    handleOAuth(req, res, url).catch((error) => {
      log("error", "[oauth] " + String(error?.stack || error));
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
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
      res.writeHead(401, { "content-type": "text/plain",
        "www-authenticate": 'Bearer resource_metadata="' + requestOrigin(req) + '/.well-known/oauth-protected-resource"' });
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
const modulesDir = storage.enabled && storage.writable ? config.storageDir : "";
const adminInfo = await resolveAdminKey({ storageDir: modulesDir, configured: config.adminKey });
if (adminInfo.source === "generated") log("warn", "[modules] made an administrator key for approving module installs, saved in " + adminInfo.path + ". It never goes in the chat; approve a plan with: node scripts/estampes-module.js approve <planId>");
const casClientInstance = createCasClient({ socketPath: config.casSocket });
configureCas({ client: casClientInstance, notebooks: createNotebooks({ dir: modulesDir ? join(config.storageDir, "cas", "notebooks") : "", records: () => recordStore }) });
const surfaceStore = createSurfaceStore({ dir: modulesDir ? join(config.storageDir, "surfaces") : "", records: () => recordStore });
moduleHost = await createModuleHost({
  storageDir: modulesDir, coreVersion: VERSION, adminKey: adminInfo.key, allowUnsigned: config.moduleAllowUnsigned,
  canvases: { ensure: ensureImage, create: createBlankCanvas, save: saveCanvas }, readSource,
});
surfaceService = createSurfaceService({ store: surfaceStore, registry: moduleHost.registry, notebooks: notebookStore() });
// A UVA store that cannot start (for example a history too long to open within
// the engine's startup limit) must never keep the whole server down: the legacy
// canvas does not depend on it.
const startUva = (options) => createUvaService(options).catch((error) => {
  log("error", "[uva] could not start; continuing without UVA. The canvas is unaffected. Export the workspaces from a copy, or start a new ESTAMPES_UVA_BETA_DIR.", { code: error.code, error: error.message });
  return createUvaService({ enabled: false });
});
// The canvas store is the default: with storage on disk, canvases, workspaces,
// surfaces and notebooks are committed to UVA. Memory-only servers have no
// store to commit to and keep everything in memory, as before.
const wantCanvasStore = config.canvasStore === "uva" && !!modulesDir;
if (config.canvasStore === "uva" && !modulesDir) log("info", "[canvas-store] no writable ESTAMPES_STORAGE_DIR: nothing is committed to UVA");
uvaService = await startUva({ mirrorMaxCommits: config.uvaMirrorMaxCommits, enabled: wantCanvasStore,
  canvasStore: wantCanvasStore, assetCapBytes: config.uvaAssetMaxMb * 1024 * 1024, directory: config.uvaBetaDir, profile: config.uvaBetaProfile, legacyDirectory: config.storageDir, moduleHost,
});
if (uvaService.enabled && config.uvaBetaProfile === "linux-process-crash-test") log("info", "[uva] store profile linux-process-crash-test: the same fsync barriers as linux-local-durable, which also checks for a local ext4/XFS mount (docs/UVA-POWERLOSS.md)", { directory: config.uvaBetaDir });
if (uvaService.enabled && uvaService.canvasStore) {
  canvasStore = await createCanvasStore({ service: uvaService, storageDir: config.storageDir, idleMs: config.uvaMirrorIdleSec * 1000, log })
    .catch((error) => { log("error", "[canvas-store] could not start; canvases stay in legacy storage", { error: String(error?.message || error) }); return null; });
  if (canvasStore) recordStore = await createRecordStore({ service: uvaService, storageDir: config.storageDir, idleMs: config.uvaMirrorIdleSec * 1000, log })
    .catch((error) => { log("error", "[record-store] could not start; workspaces, surfaces and notebooks stay in legacy storage", { error: String(error?.message || error) }); return null; });
  // Both stores or neither: canvases and the workspaces naming them stay together.
  if (canvasStore && recordStore) { useCanvasStore(canvasStore); useRecords(recordStore); }
  else if (canvasStore) { await canvasStore.close(); canvasStore = null; }
  if (canvasStore) log("info", "[canvas-store] canvases, images, workspaces, surfaces and notebooks live only in UVA; no legacy file is written (scripts/uva-to-legacy.mjs writes them back out)", { directory: config.uvaBetaDir, recovering: canvasStore.recovered.length + recordStore.recovered.length });
}
// Once the store holds data, the legacy files no longer have it: running on
// them would show stale canvases and write edits the store never sees. A
// store that held nothing yet (e.g. a host without flock) may fall back.
if (wantCanvasStore && !canvasStore) {
  const used = [join(config.storageDir, "uva-pending"), join(config.uvaBetaDir, "init.json"), join(config.uvaBetaDir, "estampes-pr1c-beta")].filter((p) => existsSync(p));
  if (used.length) {
    log("error", "[canvas-store] the UVA store holds this server's canvases and workspaces but could not open; stopping instead of running on stale legacy files. Fix the cause logged above, or stop, run node scripts/uva-to-legacy.mjs <storage dir> and set ESTAMPES_CANVAS_STORE=legacy.", { found: used });
    process.exit(1);
  }
  log("warn", "[canvas-store] the UVA store could not open and holds nothing yet; using the legacy files (ESTAMPES_CANVAS_STORE=legacy silences this)");
}
// The key is printed once, when it is made; afterwards only where it lives.
if (keyInfo.source === "generated" || keyInfo.source === "memory") {
  log("warn", "[auth] generated an access key. Connector URL: https://<your host>/mcp?key=" + keyInfo.key +
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
    log("warn", "[tunnel] public address " + origin + ". Connector URL: " + origin + "/mcp" + (ACCESS_KEY ? "?key=" + ACCESS_KEY : "") +
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
    flushStorage().then(() => recordStore?.close()).then(() => canvasStore?.close()).catch(() => {}).then(() => uvaService?.close()).finally(() => process.exit(0));
  });
}
