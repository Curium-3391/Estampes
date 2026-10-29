import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
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
import { resolveSceneAnnotation, resolveCoordinateAnnotation, replayUserAnnotation } from "./src/scene-catalog.js";
import { INTENTS, buildAnnotationEvent, formatAnnotationChatMessage } from "./src/interaction-protocol.js";
import { createVisualEvidence } from "./src/visual-input.js";
import { downloadImage, registerImage, getImage } from "./src/image-store.js";
import {
  processImage, overlayGrid, previewImage, cellCenter, rowLabel, displayImage, compactForDisplay,
} from "./src/image-ops.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
// package.json is the single source of truth for the release version.
// Widget HTML uses __ESTAMPES_VERSION__ and versioned ui:// URIs derive from
// it, so a release bump only touches package.json.
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const BUILD_VERSION = "m" + VERSION;
const URI_TAG = "v" + VERSION.replace(/\./g, "");
const WIDGET = "ui://estampes/number-line-v031.html";
const LEGACY_WIDGET = "ui://estampes/number-line.html";
const VISUAL_URI = "ui://estampes/visual-surface-" + URI_TAG + ".html";
const EVIDENCE_URI = "ui://estampes/visual-evidence-" + URI_TAG + ".html";
// Older URIs stay resolvable for saved ChatGPT conversations. They serve the
// current HTML on purpose: the host caches templates by URI, so a stale URI
// must still get a working widget, not a 404.
const LEGACY_VISUAL_URIS = ["v040","v041","v042","v043","v046","v047","v048","v050"]
  .map(tag => "ui://estampes/visual-surface-" + tag + ".html")
  .filter(uri => uri !== VISUAL_URI);
const LEGACY_EVIDENCE_URIS = ["v045","v047","v048","v050"]
  .map(tag => "ui://estampes/visual-evidence-" + tag + ".html")
  .filter(uri => uri !== EVIDENCE_URI);
const loadWidget = (file) =>
  readFileSync(join(ROOT, "public", file), "utf8").replaceAll("__ESTAMPES_VERSION__", VERSION);
const html = loadWidget("number-line.html");
const evidenceHtml = loadWidget("visual-evidence.html");
const visualHtml = loadWidget("visual-surface.html");
const SceneSchema = z.enum(["landscape", "shapes", "formula"]);
const Point01 = z.number().finite().min(0).max(1);

// Guaranteed geometry for renderer + user validation.
const VisualAnnotationSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["point", "rect", "arrow"]),
  x: Point01, y: Point01,
  x2: Point01.optional(), y2: Point01.optional(),
  label: z.string().max(64).optional(),
  author: z.enum(["user", "assistant"]).optional(),
  grounding: z.enum(["scene-anchor", "unverified", "replayed-unverified", "user-pointer"]).optional(),
}).superRefine((a,ctx)=>{
  if(a.type!=="point" && (a.x2===undefined || a.y2===undefined)) {
    ctx.addIssue({code:"custom",message:"Rectangle and arrow require x2/y2"});
  }
});
const VisualAnnotationsSchema = z.array(VisualAnnotationSchema).max(30);

// Model-facing annotations use coordinates ONLY. Legacy semantic anchors
// are retained in scene-catalog.js for isolated geometry unit tests, but
// never exposed as an object-position catalog to the model.
const ModelAnnotationSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["point", "rect", "arrow"]),
  x: Point01, y: Point01,
  x2: Point01.optional(), y2: Point01.optional(),
  label: z.string().max(64).optional(),
  author: z.literal("assistant").optional(),
}).strict().superRefine((a,ctx)=>{
  if(a.type!=="point"&&(a.x2===undefined||a.y2===undefined)){
    ctx.addIssue({code:"custom",message:"Rect/arrow require x2/y2"});
  }
});
const ModelAnnotationsSchema=z.array(ModelAnnotationSchema).max(12);

// M0.5 real-image schemas, shared by the image tools and present_visual.
const RegionSchema = z.object({
  x: Point01, y: Point01, x2: Point01, y2: Point01,
}).describe("Normalized source-image box (top-left origin). Omit for the whole image.");
const ImageIdSchema = z.string().regex(/^img:[0-9a-f]{16}$/).describe("imageId returned by load_image");
const OpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("grayscale") }),
  z.object({ op: z.literal("normalize") }).describe("Stretch contrast to the full range"),
  z.object({ op: z.literal("clahe"), tile: z.number().int().min(8).max(256).optional(),
    maxSlope: z.number().min(1).max(10).optional() }).describe("Local adaptive contrast; good for blurry scans, glare, dark PCB photos"),
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
  });

  registerAppTool(
    server,
    "present_visual",
    {
      title: "Present a shared visual canvas",
      description:
        "CANONICAL shared visual canvas the user sees in chat. Pass imageId (from load_image) to show the user's REAL photo/scan, or scene for a bundled SVG demo. " +
        "The widget opens on the ORIGINAL image; your marks are GOLD and the user's marks BLUE, and the user can draw marks and send them back. " +
        "Optional `views` (imageId only, max 3) add extra tabs with processed versions (e.g. clahe+sharpen, threshold, a zoomed region) that the user can switch to; only add them when they help the user see something. " +
        "Coordinates are normalized to the full image, top-left origin. Locate things first with process_image/overlay_grid, then mark them; coordinates are not evidence of recognition. " +
        "Do NOT also call present_visual_evidence for the same task.",
      inputSchema: z.object({
        imageId: ImageIdSchema.optional(),
        scene: SceneSchema.optional().describe("Bundled demo scene; use only when there is no real image"),
        annotations: ModelAnnotationsSchema.default([]),
        views: z.array(ViewSchema).max(3).default([]).describe("Optional processed views shown as extra tabs; the original stays the default view"),
        priorUserAnnotations: z.array(VisualAnnotationSchema).max(18).default([]).describe(
          "Only marks the user actually drew and supplied earlier; replayed provenance is not authenticated."
        ),
      }),
      outputSchema: z.object({
        kind: z.literal("estampes.visual_surface"),
        scene: SceneSchema.optional(),
        imageId: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        views: z.array(z.object({ label: z.string(), region: RegionSchema })).optional(),
        annotations: VisualAnnotationsSchema,
        coordinateSystem: z.literal("normalized-top-left"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: VISUAL_URI } },
    },
    async ({ imageId, scene, annotations, views, priorUserAnnotations }) => {
      try {
        if (!imageId === !scene) throw new Error("Provide exactly one of imageId or scene");
        if (scene && views.length) throw new Error("views are only available for real images (imageId)");
        const ai = annotations.map(a => imageId ? resolveCoordinateAnnotation(a) : resolveSceneAnnotation(scene, a));
        const resolved = [...ai, ...priorUserAnnotations.map(replayUserAnnotation)];
        if (scene) {
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
        const entry = getImage(imageId);
        const shown = await displayImage(entry);
        const rendered = [];
        for (const view of views) {
          const out = await compactForDisplay(await processImage(entry, { region: view.region, ops: view.ops }));
          rendered.push({ label: view.label, mimeType: out.mimeType, data: out.data.toString("base64"), region: out.region });
        }
        return {
          content: [{
            type: "text",
            text: "Showing " + imageId + " to the user (original by default" +
              (rendered.length ? "; extra tabs: " + rendered.map(v => v.label).join(", ") : "") + ") with " +
              resolved.length + " marks: " + JSON.stringify(resolved) +
              ". Marks are geometry only; the user can draw and send marks back.",
          }],
          structuredContent: {
            kind: "estampes.visual_surface", imageId, width: entry.width, height: entry.height,
            views: rendered.map(({ label, region }) => ({ label, region })),
            annotations: resolved, coordinateSystem: "normalized-top-left",
          },
          // Pixels go to the widget only; the model already has them from load_image.
          _meta: {
            "estampes/image": { mimeType: shown.mimeType, data: shown.data.toString("base64"), width: shown.width, height: shown.height },
            "estampes/views": rendered,
          },
        };
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
        annotations:VisualAnnotationsSchema,
        intent:z.enum(INTENTS).default("point-out"),
        note:z.string().max(500).default(""),
        replyQuote:z.string().max(300).default(""),
      }),
      outputSchema:z.object({
        kind:z.literal("estampes.validated_annotations"),
        scene:SceneSchema.optional(),
        imageId:z.string().optional(),
        count:z.number().int(),
        annotations:VisualAnnotationsSchema,
        event:z.record(z.string(),z.unknown()),
        chatMessage:z.string(),
      }),
      annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
      _meta:{ui:{visibility:["app"]}},
    },
    async ({scene,imageId,annotations,intent,note,replyQuote})=>{
      // Validation is geometric only; no image classification or host
      // conversation access is claimed. The user supplies the intent/quote.
      try {
        if(!imageId===!scene) throw new Error("Provide exactly one of imageId or scene");
        let image;
        if(imageId){const entry=getImage(imageId);image={imageId,width:entry.width,height:entry.height};}
        const checked=annotations.map(a=>({...a,author:"user",grounding:"user-pointer"}));
        const event=buildAnnotationEvent({scene,image,annotations:checked,intent,note,replyQuote});
        const chatMessage=formatAnnotationChatMessage(event);
        return {
          content:[{type:"text",text:"Validated "+checked.length+" user-authored annotations; explicit interaction intent="+intent+" (geometry only)."}],
          structuredContent:{
            kind:"estampes.validated_annotations",...(scene?{scene}:{imageId}),
            count:checked.length,annotations:checked,event,chatMessage,
          },
        };
      } catch(error) {
        return {isError:true,content:[{type:"text",text:String(error?.message||error)}]};
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
        "Retrieve PIXEL IMAGES for a user-marked location on an Estampes demo SVG. Call this when asked what a marked object is, rather than inferring objects from coordinates or scene names. Pass imageId='demo:'+scene, revision='svg-v1', and focus={type:'point'|'rect'|'arrow',x,y[,x2,y2]} copied from the user's Estampes annotation; for arrows the head x2/y2 is the referent. Returns original PNG, full PNG with focus overlay, and locally cropped magnified PNG. These are image content blocks plus geometry metadata; if your host does not expose image pixels to vision, explicitly state that and do not guess the object's identity. This M0.4.3 tool supports ONLY bundled SVG demo images, not arbitrary user uploads or ChatGPT image search.",
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
        "Load a photo, scan or picture so Estampes can preprocess it. Pass `image` for a file the user attached or photographed in this ChatGPT conversation, OR `imageUrl` for a public https image you found. Returns an imageId plus a preview image. Use the imageId with process_image (enhance, threshold, edges, zoom into a region) and overlay_grid (labelled grid for precise locating). Estampes never identifies content; you do, from the returned pixels.",
      inputSchema: z.object({
        image: z.object({
          download_url: z.string(),
          file_id: z.string(),
          mime_type: z.string().optional(),
          file_name: z.string().optional(),
        }).strict().optional().describe("Image file from the conversation"),
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
        const bytes = await downloadImage(image ? image.download_url : imageUrl);
        const entry = await registerImage(bytes, {
          source: image ? "chat-file" : "url",
          fileName: image?.file_name ?? null,
        });
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

  server.registerTool(
    "process_image",
    {
      title: "Preprocess an image region",
      description:
        "Return a processed view of a loaded image to help you read or locate details. Optionally crop to `region` (zoomed up to 8x), then apply `ops` in order, e.g. [{op:'clahe'},{op:'sharpen'}] for blurry scans or dark boards, [{op:'grayscale'},{op:'threshold',method:'adaptive'}] for handwriting and book pages, [{op:'edges'}] for PCB traces. The result covers `region` in source coordinates: a point (u,v) in the output maps to x = region.x + u*(region.x2-region.x), y likewise. Output is for your analysis; the user sees the original unless you choose to show this.",
      inputSchema: z.object({
        imageId: ImageIdSchema,
        region: RegionSchema.optional(),
        ops: z.array(OpSchema).max(8).default([]),
      }),
      outputSchema: z.object({
        kind: z.literal("estampes.processed_image"),
        imageId: z.string(),
        region: z.object({ x: z.number(), y: z.number(), x2: z.number(), y2: z.number() }),
        ops: z.array(z.record(z.string(), z.unknown())),
        output: z.object({ width: z.number(), height: z.number(), mimeType: z.string(), scale: z.number() }),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ imageId, region, ops }) => {
      try {
        const out = await processImage(getImage(imageId), { region, ops });
        return {
          content: [
            { type: "text", text: "Processed " + imageId + " region " + JSON.stringify(out.region) +
              " with " + (ops.map(o => o.op).join(" > ") || "no ops") + ". The next block is the result." },
            imageBlock(out),
          ],
          structuredContent: {
            kind: "estampes.processed_image", imageId, region: out.region, ops,
            output: { width: out.width, height: out.height, mimeType: out.mimeType, scale: out.scale },
          },
        };
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
        const out = await overlayGrid(getImage(imageId), { region, rows, cols });
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

const port = Number(process.env.PORT ?? 8787);

// Optional shared secret. When ESTAMPES_ACCESS_KEY is set, /mcp requires it as
// "?key=..." in the connector URL (ChatGPT's "No authentication" mode can still
// carry it) or as "Authorization: Bearer ...". Unset keeps the open M0 setup.
const ACCESS_KEY = process.env.ESTAMPES_ACCESS_KEY ?? "";
// "*" by default so browser tools such as MCP Inspector keep working; ChatGPT
// calls /mcp server-to-server and does not need CORS at all.
const CORS_ORIGINS = (process.env.ESTAMPES_CORS_ORIGINS ?? "*").split(",").map(s => s.trim()).filter(Boolean);
const RATE_LIMIT = Number(process.env.ESTAMPES_RATE_LIMIT_PER_MIN ?? 120);
const hits = new Map();

function corsOrigin(req) {
  if (CORS_ORIGINS.includes("*")) return "*";
  const origin = req.headers.origin;
  return origin && CORS_ORIGINS.includes(origin) ? origin : null;
}

function sameSecret(given) {
  const a = Buffer.from(String(given ?? "")), b = Buffer.from(ACCESS_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req, url) {
  if (!ACCESS_KEY) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
  return sameSecret(url.searchParams.get("key")) || sameSecret(bearer);
}

// Fixed one-minute window per client IP; Render puts the client first in
// x-forwarded-for. In-memory is enough for a single free-tier instance.
function rateLimited(req) {
  if (!(RATE_LIMIT > 0)) return false;
  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() ||
    req.socket.remoteAddress || "unknown";
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
      imageTools: ["load_image", "process_image", "overlay_grid"],
      imageInput: ["openai-file-param", "https-url"],
    }));
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
    const start = Date.now();
    res.once("finish", () => {
      console.log("[mcp] " + req.method + " status=" + res.statusCode +
        " ms=" + (Date.now() - start));
    });
    Promise.resolve(mcpHandler(req, res)).catch((error) => {
      console.error("[mcp] handler error:", error);
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

httpServer.listen(port, "0.0.0.0", () => {
  console.log("Estampes MCP server at http://localhost:" + port + "/mcp");
});
