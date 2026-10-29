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
import { resolveSceneAnnotation, replayUserAnnotation } from "./src/scene-catalog.js";
import { INTENTS, buildAnnotationEvent, formatAnnotationChatMessage } from "./src/interaction-protocol.js";
import { createVisualEvidence } from "./src/visual-input.js";

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
const LEGACY_VISUAL_URIS = ["v040","v041","v042","v043","v046","v047"]
  .map(tag => "ui://estampes/visual-surface-" + tag + ".html")
  .filter(uri => uri !== VISUAL_URI);
const LEGACY_EVIDENCE_URIS = ["v045","v047"]
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

  registerAppTool(
    server,
    "present_visual",
    {
      title: "Present a shared visual canvas",
      description:
        "CANONICAL single shared visual canvas for annotation AND reviewing the same image: it contains three built-in views (annotated editable surface, pristine original, zoomed unmarked focus) in ONE ChatGPT widget. Do NOT also call present_visual_evidence for the same visual task; that is a legacy standalone viewer for explicit backwards-compatible use. For object localization, FIRST use inspect_visual to inspect actual image pixels, THEN choose x/y coordinates and call this present_visual once. For user-supplied coordinates, render directly. No semantic object dictionary or named target IDs; coordinates do not prove the model has recognized an object. Assistant marks are GOLD and user marks BLUE, preserving original authors. Only bundled SVG demo scenes are supported.",
      inputSchema: z.object({
        scene: SceneSchema,
        annotations: ModelAnnotationsSchema.default([]),
        priorUserAnnotations: z.array(VisualAnnotationSchema).max(18).default([]).describe(
          "Only marks the user actually drew and supplied earlier; replayed provenance is not authenticated."
        ),
      }),
      outputSchema: z.object({
        kind: z.literal("estampes.visual_surface"),
        scene: SceneSchema,
        annotations: VisualAnnotationsSchema,
        coordinateSystem: z.literal("normalized-top-left"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: VISUAL_URI } },
    },
    async ({ scene, annotations, priorUserAnnotations }) => {
      let resolved;
      try {
        const ai=annotations.map(a=>resolveSceneAnnotation(scene,a));
        const user=priorUserAnnotations.map(replayUserAnnotation);
        resolved=[...ai,...user];
      } catch(error) {
        return {isError:true,content:[{type:"text",text:String(error.message||error)}]};
      }
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
  );

  // Private tool, not a widget: returns validated user marks.
  registerAppTool(
    server,
    "validate_visual_annotations",
    {
      title:"Validate user visual annotations",
      description:"Validate the user's 2D normalized image annotations.",
      inputSchema:z.object({
        scene:SceneSchema,
        annotations:VisualAnnotationsSchema,
        intent:z.enum(INTENTS).default("point-out"),
        note:z.string().max(500).default(""),
        replyQuote:z.string().max(300).default(""),
      }),
      outputSchema:z.object({
        kind:z.literal("estampes.validated_annotations"),
        scene:SceneSchema,
        count:z.number().int(),
        annotations:VisualAnnotationsSchema,
        event:z.record(z.string(),z.unknown()),
        chatMessage:z.string(),
      }),
      annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
      _meta:{ui:{visibility:["app"]}},
    },
    async ({scene,annotations,intent,note,replyQuote})=>{
      // Validation is geometric only; no image classification or host
      // conversation access is claimed. The user supplies the intent/quote.
      const checked=annotations.map(a=>({...a,author:"user",grounding:"user-pointer"}));
      const event=buildAnnotationEvent({scene,annotations:checked,intent,note,replyQuote});
      const chatMessage=formatAnnotationChatMessage(event);
      return {
        content:[{type:"text",text:"Validated "+checked.length+" user-authored annotations; explicit interaction intent="+intent+" (geometry only)."}],
        structuredContent:{
          kind:"estampes.validated_annotations",scene,
          count:checked.length,annotations:checked,event,chatMessage,
        },
      };
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
