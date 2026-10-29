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

const WIDGET = "ui://estampes/number-line-v031.html";
const LEGACY_WIDGET = "ui://estampes/number-line.html";
const BUILD_VERSION = "m0.4.0";
const VISUAL_URI = "ui://estampes/visual-surface-v040.html";
const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "public/number-line.html"),
  "utf8"
);


const visualHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "public/visual-surface.html"),
  "utf8"
);
const SceneSchema = z.enum(["landscape", "shapes", "formula"]);
const Point01 = z.number().finite().min(0).max(1);
const VisualAnnotationSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["point", "rect", "arrow"]),
  x: Point01, y: Point01,
  x2: Point01.optional(), y2: Point01.optional(),
  label: z.string().max(64).optional(),
}).superRefine((annotation,ctx)=>{
  if(annotation.type!=="point" &&
     (annotation.x2===undefined || annotation.y2===undefined)){
    ctx.addIssue({code:"custom",message:"Rectangle and arrow require x2/y2"});
  }
});
const VisualAnnotationsSchema = z.array(VisualAnnotationSchema).max(30);

function makeServer() {
  const server = new McpServer({ name: "estampes", version: "0.4.0" });

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

  registerAppTool(
    server,
    "present_visual",
    {
      title: "Present a shared visual canvas",
      description:
        "Display a generic in-chat 2D canvas where the AI can mark points, rectangles, and arrows and the user can freely mark and send their own positions. Uses a built-in illustration: landscape (house/tree/sun/mountains), shapes (circle/square/triangle), or formula (E=mc²). All coordinates are normalized [0,1] from the image top-left. This does not import ChatGPT's searched images.",
      inputSchema: z.object({
        scene: SceneSchema,
        annotations: VisualAnnotationsSchema.max(12).default([]),
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
    async ({ scene, annotations }) => ({
      content: [{
        type:"text",
        text:"Estampes shared visual surface: "+scene+"; AI annotations: "+JSON.stringify(annotations)+
          ". The user can now click, drag a rectangle, or draw an arrow on this image and send coordinates back.",
      }],
      structuredContent:{
        kind:"estampes.visual_surface",scene,annotations,
        coordinateSystem:"normalized-top-left",
      },
    })
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
      }),
      outputSchema:z.object({
        kind:z.literal("estampes.validated_annotations"),
        scene:SceneSchema,
        count:z.number().int(),
        annotations:VisualAnnotationsSchema,
      }),
      annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
      _meta:{ui:{visibility:["app"]}},
    },
    async ({scene,annotations})=>({
      content:[{type:"text",text:"Validated "+annotations.length+" visual annotations on "+scene+"."}],
      structuredContent:{
        kind:"estampes.validated_annotations",scene,
        count:annotations.length,annotations,
      },
    })
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
