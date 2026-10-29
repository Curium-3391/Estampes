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
import { landmarkIds, resolveSceneAnnotation, replayUserAnnotation } from "./src/scene-catalog.js";
import { INTENTS, buildAnnotationEvent, formatAnnotationChatMessage } from "./src/interaction-protocol.js";
import { createVisualEvidence } from "./src/visual-input.js";

const WIDGET = "ui://estampes/number-line-v031.html";
const LEGACY_WIDGET = "ui://estampes/number-line.html";
const BUILD_VERSION = "m0.4.3";
const VISUAL_URI = "ui://estampes/visual-surface-v042.html";
const VISUAL_PREVIOUS_URI = "ui://estampes/visual-surface-v041.html";
const VISUAL_LEGACY_URI = "ui://estampes/visual-surface-v040.html";
const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "public/number-line.html"),
  "utf8"
);


const visualHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "public/visual-surface.html"),
  "utf8"
);
const SceneSchema = z.enum(["landscape", "shapes", "formula"]);
const LandmarkSchema = z.enum(landmarkIds);
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
  targetId: LandmarkSchema.optional(),
}).superRefine((a,ctx)=>{
  if(a.type!=="point" && (a.x2===undefined || a.y2===undefined)) {
    ctx.addIssue({code:"custom",message:"Rectangle and arrow require x2/y2"});
  }
});
const VisualAnnotationsSchema = z.array(VisualAnnotationSchema).max(30);

// Model-proposed annotations may name an object by targetId and omit x/y.
// The server resolves targetId using a deterministic built-in SVG landmark
// catalog. Without targetId, coordinates are *not semantically verified*.
const ModelAnnotationSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["point", "rect", "arrow"]),
  targetId: LandmarkSchema.optional(),
  x: Point01.optional(), y: Point01.optional(),
  x2: Point01.optional(), y2: Point01.optional(),
  label: z.string().max(64).optional(),
  // AI mark input cannot explicitly claim to have been authored by a user.
  author: z.literal("assistant").optional(),
}).superRefine((a,ctx)=>{
  if(a.targetId && a.type==="arrow"){
    ctx.addIssue({code:"custom",message:"targetId is for points/rectangles only"});
  }
  if(!a.targetId && (a.x===undefined||a.y===undefined||
      (a.type!=="point"&&(a.x2===undefined||a.y2===undefined)))){
    ctx.addIssue({code:"custom",message:"Ungrounded marks require explicit coordinates"});
  }
});
const ModelAnnotationsSchema=z.array(ModelAnnotationSchema).max(12);

function makeServer() {
  const server = new McpServer({ name: "estampes", version: "0.4.3" });

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

  // Compatibility for conversations that cached the M0.4.0 resource URI.
  registerAppResource(
    server,
    "Estampes visual surface (legacy)",
    VISUAL_LEGACY_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [{ uri: VISUAL_LEGACY_URI, mimeType: RESOURCE_MIME_TYPE, text: visualHtml }],
    })
  );

  // UI URI cache compatibility for the immediately previous visual widget.
  registerAppResource(
    server,
    "Estampes visual surface v0.4.1 (legacy)",
    VISUAL_PREVIOUS_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [{ uri: VISUAL_PREVIOUS_URI, mimeType: RESOURCE_MIME_TYPE, text: visualHtml }],
    })
  );

  registerAppTool(
    server,
    "present_visual",
    {
      title: "Present a shared visual canvas",
      description:
        "Display an in-chat 2D surface over an embedded SVG test scene. For NAMED objects always use targetId (no guessed x/y): landscape ids sun, house, house-roof, tree, mountain-left, mountain-right; shapes ids circle, square, triangle; formula ids equation, equals-sign. Example: scene=landscape, annotations=[{id:'mountain', type:'point', targetId:'mountain-right', label:'山'}]. Server resolves anchors, never trusts model coordinates when targetId is set. Free coordinates without targetId are allowed but UNVERIFIED. To redraw previously user-drawn annotations, pass them in priorUserAnnotations; never copy them into annotations (reserved for new AI marks). This is an SVG sample, NOT native ChatGPT image-search access.",
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
          text:"Estampes scene="+scene+"; grounded/user-tagged annotations="+JSON.stringify(resolved)+
            ". A scene-anchor is deterministic SVG geometry; a free-coordinate annotation is NOT semantically grounded. " +
            "Previously human-drawn marks retain author=user. New user gestures can be sent from the widget."
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


  // Public model tool, separate from the ChatGPT embedded UI.
  // Returns real PNG image bytes in the MCP content array, not object names.
  // Some hosts do not forward these blocks to their vision model.
  registerAppTool(
    server,
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
              ". The NEXT THREE MCP blocks contain real PNG pixels: (1) original whole image, (2) whole image with BLUE annotation overlay, (3) enlarged raw crop with no overlay. "+
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

  return server;
}

// SDK 2.x handles 2026-07-28 server/discover and legacy initialize on the same
// endpoint. No request-body listeners: they would consume the stream before the
// MCP transport can parse it.
const mcpHandler = toNodeHandler(createMcpHandler(makeServer));

const port = Number(process.env.PORT ?? 8787);
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
      visualValidationTool: "validate_visual_annotations",
      annotationProtocol: "0.2-draft",
      visualInputTool: "inspect_visual",
      visualInputFormat: "mcp-image-content-png",
      visualModelVisibility: "host-dependent-unverified",
    }));
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Estampes MCP M0 (SDK 2.x)");
    return;
  }

  if (url.pathname === "/mcp" && req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers":
        "content-type, accept, mcp-session-id, mcp-protocol-version",
      "access-control-expose-headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (url.pathname === "/mcp" && ["GET", "POST", "DELETE"].includes(req.method)) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-expose-headers", "Mcp-Session-Id");
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
