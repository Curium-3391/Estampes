// A canvas for a widget test: an uploaded image, or a Graph document (gph:)
// of the same size with axes and no curve. Tests that check the shared
// annotation tools run on both kinds (UVA Phase 4B-1).
import sharp from "sharp";

export const CANVAS_KINDS = ["image", "graph"];

export async function makeCanvas(s, kind, { width = 800, height = 600, background = "#ddd" } = {}) {
  if (kind === "graph") {
    await s.enable(["org.estampes.graph"]);
    // Axes only: no curve lies under the marks a test draws.
    const r = await s.call("execute_module", { module: "org.estampes.graph", capability: "set_axes", params: { xRange: [-10, 10], yRange: [-10, 10] }, newCanvas: { kind: "graph", width, height }, present: false });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    const id = (JSON.stringify(r.structuredContent).match(/gph:[0-9a-f]{16}/) ?? [])[0];
    if (!id) throw new Error("no Graph id in " + JSON.stringify(r.structuredContent).slice(0, 300));
    return id;
  }
  const data = (await sharp({ create: { width, height, channels: 3, background } }).png().toBuffer()).toString("base64");
  const r = await s.call("upload_visual_image", { total: data.length, offset: 0, data });
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return r.structuredContent.imageId;
}
