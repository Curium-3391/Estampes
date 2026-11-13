// detect_features on processed views (issue #115) and the regions engine
// (issue #117): the engine reads the view's pixels, and what it finds lands
// on the original image without offset.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { registerImage, clearImages, imageIdOf } from "../src/image-store.js";
import { runEngine } from "../src/image/engines.js";
import { renderView, rememberView, frameFromView, viewAnalysis } from "../src/image/view.js";
import { apply } from "../src/image/transform.js";
import { calibrate } from "../src/image/measure.js";

beforeEach(() => clearImages());
const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();
// 600x400, white. Two black squares 4 px apart (one object with a hairline
// crack), a faint grey square that Otsu on the whole image misses, and a
// black square far to the right.
const board = () => png(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" shape-rendering="crispEdges"><rect width="600" height="400" fill="#fff"/>
<rect x="100" y="100" width="40" height="60" fill="#000"/><rect x="144" y="100" width="40" height="60" fill="#000"/>
<rect x="300" y="240" width="50" height="50" fill="#d8d8d8"/>
<rect x="480" y="60" width="30" height="30" fill="#000"/></svg>`);
// Discs for the regions engine: two overlapping, one alone, one cut by the frame.
const discs = () => png(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#fff"/>
<circle cx="100" cy="120" r="40" fill="#000"/><circle cx="160" cy="120" r="40" fill="#000"/>
<circle cx="300" cy="80" r="25" fill="#000"/><circle cx="395" cy="200" r="30" fill="#000"/></svg>`);
const view = async (entry, spec) => rememberView(entry, (await renderView(entry, spec)).record);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg ?? "") + " " + a + " vs " + b);

test("an engine given a derivedViewId reads the processed pixels, not the source", async () => {
  const entry = await registerImage(await board(), { source: "url" });
  // Source pixels: the cracked object is two components.
  const raw = await runEngine(entry, "components", { params: { minArea: 100 } });
  assert.equal(raw.detections.length, 3);
  assert.equal(raw.derivedViewId, undefined);
  // Closing the crack (a dilation of the dark side) makes it one.
  const closed = await view(entry, { sampling: { mode: "working" }, ops: [{ op: "grayscale" }, { op: "morphology", operation: "open", radius: 3 }] });
  const res = await runEngine(entry, "components", { derivedViewId: closed.derivedViewId, params: { minArea: 100 } });
  assert.equal(res.status, "ok");
  assert.equal(res.detections.length, 2);
  const joined = res.detections[0];
  assert.deepEqual([joined.x * 600, joined.y * 400, joined.x2 * 600, joined.y2 * 400].map(Math.round), [100, 100, 184, 160]);
  // The result says what it read.
  assert.equal(res.derivedViewId, closed.derivedViewId);
  assert.equal(res.view.reproduced, true);
  assert.deepEqual(res.view.ops.map((o) => o.op), ["grayscale", "morphology"]);
  assert.equal(res.view.versions.ops.morphology, closed.versions.ops.morphology);
  assert.equal(res.sourceAssetId, entry.sourceAssetId);
  assert.equal(res.analysis.space, "view");
  assert.match(res.warnings.join(" | "), /detected on the processed pixels of dv:[0-9a-f]{16} \(grayscale > morphology\), not on the source pixels/);
  // A stretched view finds the faint square the source-pixel run does not.
  assert.equal(raw.detections.some((d) => Math.abs(d.x * 600 - 300) < 3), false);
  const faint = await view(entry, { region: { x: 0.4, y: 0.5, x2: 0.7, y2: 0.85 }, sampling: { mode: "working" }, ops: [{ op: "grayscale" }, { op: "threshold", method: "otsu" }] });
  const found = await runEngine(entry, "components", { derivedViewId: faint.derivedViewId });
  assert.equal(found.detections.length, 1);
  assert.deepEqual([found.detections[0].x * 600, found.detections[0].y * 400, found.detections[0].x2 * 600, found.detections[0].y2 * 400].map(Math.round), [300, 240, 350, 290]);
  // Same call, same answer.
  assert.deepEqual(await runEngine(entry, "components", { derivedViewId: faint.derivedViewId }), found);
});

test("wrong, unknown and stale views are refused; region and sampling cannot be combined with a view", async () => {
  const entry = await registerImage(await board(), { source: "url" });
  const other = await registerImage(await discs(), { source: "url" });
  const v = await view(entry, { sampling: { mode: "working" }, ops: [{ op: "grayscale" }] });
  await assert.rejects(runEngine(other, "components", { derivedViewId: v.derivedViewId }), /is not a processed view of img:/);
  await assert.rejects(runEngine(entry, "components", { derivedViewId: "dv:0000000000000000" }), /is not a processed view/);
  await assert.rejects(runEngine(entry, "components", { derivedViewId: v.derivedViewId, region: { x: 0, y: 0, x2: 0.5, y2: 0.5 } }), /do not pass region or sampling/);
  await assert.rejects(runEngine(entry, "components", { derivedViewId: v.derivedViewId, sampling: { mode: "native" } }), /do not pass region or sampling/);
  // A record whose recipe no longer gives its id (an operator changed, or the
  // record was edited) is stale: refuse rather than analyse other pixels.
  other.derivedViews = new Map([[v.derivedViewId, { ...v, imageId: other.imageId, sourceAssetId: other.sourceAssetId }]]);
  await assert.rejects(runEngine(other, "components", { derivedViewId: v.derivedViewId }), /is stale: its recipe now gives dv:/);
  entry.derivedViews.set(v.derivedViewId, { ...v, recipe: { ...v.recipe, ops: [{ op: "invert" }] } });
  await assert.rejects(runEngine(entry, "components", { derivedViewId: v.derivedViewId }), /is stale/);
  // A record copied from another image is not this image's view.
  await assert.rejects(viewAnalysis(other, v), /belongs to img:/);
  // No mapping back to the image: nowhere to put the detections.
  entry.derivedViews.set(v.derivedViewId, { ...v, coordinateMapping: { ...v.coordinateMapping, derivedToNormalized: null } });
  await assert.rejects(runEngine(entry, "components", { derivedViewId: v.derivedViewId }), /no invertible mapping/);
});

test("view detections carry view pixels and image coordinates that agree through the view's own matrix", async () => {
  const entry = await registerImage(await board(), { source: "url" });
  // A crop delivered at half size: view pixels are delivered pixels.
  const v = await view(entry, { region: { x: 0.7, y: 0.05, x2: 0.95, y2: 0.35 }, sampling: { mode: "working" }, ops: [{ op: "grayscale" }], output: { format: "png", maxLongSide: 75 } });
  assert.deepEqual(v.pixelDimensions, { width: 75, height: 60 });
  const res = await runEngine(entry, "components", { derivedViewId: v.derivedViewId });
  assert.deepEqual([res.analysis.width, res.analysis.height], [150, 120]);
  const d = res.detections[0];
  assert.deepEqual([d.x * 600, d.y * 400, d.x2 * 600, d.y2 * 400].map(Math.round), [480, 60, 510, 90]);
  assert.deepEqual(d.view, { x: 30, y: 20, x2: 45, y2: 35, centroid: { x: 37.25, y: 27.25 } });
  // The frame present_visual would use for {derivedViewId} gives the same place.
  const { matrix } = frameFromView(v);
  const p = apply(matrix, d.view.x, d.view.y), q = apply(matrix, d.view.centroid.x, d.view.centroid.y);
  near(p.x, d.x, 1e-5); near(p.y, d.y, 1e-5); near(q.x, d.centroid.x, 1e-5); near(q.y, d.centroid.y, 1e-5);
  assert.equal(d.mark.type, "rect");
  assert.equal(d.attributes.widthPx, 30); // analysis pixels, one per source pixel here
  assert.equal(res.analysis.sourcePixelsPerAnalysisPixel, 1);
});

test("rotated and perspective views put detections back on the image without offset", async () => {
  const entry = await registerImage(await board(), { source: "url" });
  // Quarter turn: boxes stay boxes.
  const quarter = await view(entry, { sampling: { mode: "working" }, geometry: [{ op: "rotate", degrees: 90 }], ops: [{ op: "grayscale" }] });
  const q = await runEngine(entry, "components", { derivedViewId: quarter.derivedViewId, params: { minArea: 500 } });
  const small = q.detections.find((d) => d.attributes.areaPx === 900);
  assert.deepEqual([small.x * 600, small.y * 400, small.x2 * 600, small.y2 * 400].map(Math.round), [480, 60, 510, 90]);
  assert.equal(small.mark.type, "rect");
  assert.equal(small.polygon, undefined);
  assert.equal(q.view.axisAligned, true);
  // 30 degrees: a box in the view is a tilted quadrilateral on the image.
  const tilted = await view(entry, { sampling: { mode: "working" }, geometry: [{ op: "rotate", degrees: 30 }], ops: [{ op: "grayscale" }] });
  const t = await runEngine(entry, "blobs", { derivedViewId: tilted.derivedViewId, params: { polarity: "dark", minArea: 400 } });
  const c = await runEngine(entry, "components", { derivedViewId: tilted.derivedViewId, params: { minArea: 500 } });
  assert.equal(c.view.axisAligned, false);
  assert.match(c.warnings.join(" | "), /rotated or warped: boxes are given on the image as four-corner polygons/);
  const sq = c.detections.find((d) => Math.abs(d.attributes.areaPx - 900) < 60);
  near(sq.centroid.x * 600, 495, 0.75, "centroid x"); near(sq.centroid.y * 400, 75, 0.75, "centroid y");
  assert.equal(sq.polygon.length, 4);
  assert.equal(sq.mark.type, "polyline");
  assert.equal(sq.mark.closed, true);
  // The quadrilateral contains the square, and x/y/x2/y2 bound the quadrilateral.
  assert.ok(sq.x * 600 < 480 && sq.x2 * 600 > 510 && sq.y * 400 < 60 && sq.y2 * 400 > 90);
  assert.deepEqual([sq.x, sq.x2], [Math.min(...sq.polygon.map((p) => p.x)), Math.max(...sq.polygon.map((p) => p.x))]);
  // Detections in the rotation's fill (the frame corners turn dark-on-light there) are flagged, not marked.
  assert.ok(t.detections.length >= 1);
  for (const d of [...c.detections, ...t.detections]) assert.equal(Boolean(d.outsideSource), d.mark === undefined);
  // Perspective: rectify the lone square's neighbourhood from a skewed quadrilateral.
  const corners = [{ x: 0.74, y: 0.08 }, { x: 0.92, y: 0.1 }, { x: 0.9, y: 0.32 }, { x: 0.72, y: 0.28 }];
  const warped = await view(entry, { sampling: { mode: "working" }, geometry: [{ op: "perspective", corners, width: 200, height: 200 }], ops: [{ op: "grayscale" }] });
  const w = await runEngine(entry, "components", { derivedViewId: warped.derivedViewId, params: { minArea: 200 } });
  assert.equal(w.view.mapping, "homography");
  assert.equal(w.analysis.sourcePixelsPerAnalysisPixel, null);
  assert.match(w.warnings.join(" | "), /perspective warp/);
  assert.equal(w.detections.length, 1);
  near(w.detections[0].centroid.x * 600, 495, 1, "warped centroid x"); near(w.detections[0].centroid.y * 400, 75, 1, "warped centroid y");
  // The four mapped corners of the view-space box enclose the true square.
  const poly = w.detections[0].polygon;
  assert.ok(Math.min(...poly.map((p) => p.x)) * 600 < 481 && Math.max(...poly.map((p) => p.x)) * 600 > 509);
});

test("regions splits touching discs, measures them, flags what is inferred and what is cut off", async () => {
  const entry = await registerImage(await discs(), { source: "url" });
  const res = await runEngine(entry, "regions", {});
  assert.equal(res.status, "ok");
  assert.equal(res.kind, "segment");
  assert.equal(res.quality.regions, 4);
  assert.equal(res.quality.components, 3);
  assert.equal(res.quality.splitRegions, 2);
  assert.equal(res.quality.touchingBorder, 1);
  assert.equal(res.quality.calibration, null);
  const lone = res.detections.find((d) => Math.abs(d.centroid.x * 400 - 300) < 2);
  near(lone.attributes.areaPx, Math.PI * 625, 25, "area");
  near(lone.attributes.equivalentDiameterPx, 50, 0.6, "diameter");
  near(lone.attributes.perimeterPx, 2 * Math.PI * 25, 3, "perimeter");
  near(lone.attributes.inscribedRadiusPx, 25, 1, "inscribed radius");
  assert.ok(lone.attributes.circularity > 0.95 && lone.attributes.eccentricity < 0.15);
  assert.equal(lone.attributes.splitFrom, undefined);
  assert.equal(lone.attributes.touchesBorder, false);
  assert.equal(lone.verification, "unverified");
  // Its outline is a closed polyline around the disc, within the vertex budget.
  assert.equal(lone.mark.type, "polyline");
  assert.equal(lone.mark.closed, true);
  assert.ok(lone.mark.points.length >= 8 && lone.mark.points.length <= 16);
  for (const p of lone.mark.points) near(Math.hypot(p.x * 400 - 300, p.y * 240 - 80), 25, 2.5, "outline radius");
  // The pair: two regions cut at x = 130, both saying they come from one blob.
  const pair = res.detections.filter((d) => d.attributes.splitFrom);
  assert.equal(pair.length, 2);
  assert.equal(pair[0].attributes.splitFrom, pair[1].attributes.splitFrom);
  assert.deepEqual(pair.map((d) => d.attributes.splitParts), [2, 2]);
  assert.ok(pair.every((d) => d.attributes.weakestSplit > 0.12 && d.attributes.weakestSplit < 0.5));
  const [left, right] = pair.sort((a, b) => a.centroid.x - b.centroid.x);
  near(left.x2 * 400, 130, 2.5, "cut"); near(right.x * 400, 130, 2.5, "cut");
  assert.match(res.warnings.join(" | "), /2 regions come from splitting touching blobs by shape; no boundary was seen/);
  // The disc cut by the frame is kept and flagged, or dropped on request.
  assert.equal(res.detections.filter((d) => d.attributes.touchesBorder).length, 1);
  assert.match(res.warnings.join(" | "), /1 regions touch the frame/);
  const inner = await runEngine(entry, "regions", { params: { excludeBorder: true } });
  assert.equal(inner.quality.regions, 3);
  // Without splitting the pair is one region; without contours marks are boxes.
  const whole = await runEngine(entry, "regions", { params: { split: false, contours: false } });
  assert.equal(whole.quality.regions, 3);
  assert.equal(whole.quality.split, null);
  assert.ok(whole.detections.every((d) => d.mark.type === "rect" && d.attributes.splitFrom === undefined));
  // maxCount limits what is returned; the summary still covers every region.
  const top = await runEngine(entry, "regions", { params: { maxCount: 2 } });
  assert.deepEqual([top.detections.length, top.quality.regions, top.quality.returned], [2, 4, 2]);
  assert.match(top.warnings.join(" | "), /4 regions; the largest 2 returned/);
  // Nothing to segment is an empty result, not an error; repeat runs agree.
  const blank = await registerImage(await png(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#fff"/></svg>`), { source: "url" });
  const none = await runEngine(blank, "regions", { params: { method: "fixed", value: 100 } });
  assert.deepEqual([none.status, none.detections.length, none.quality.regions], ["ok", 0, 0]);
  assert.deepEqual(await runEngine(entry, "regions", {}), res);
});

test("regions report real units only with a calibration for the space they ran in", async () => {
  const entry = await registerImage(await discs(), { source: "url" });
  // 100 source px = 50 um, on the source image.
  entry.calibrations = new Map([["image", calibrate({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], length: 50, unit: "um", sigmaPx: 1 })]]);
  const res = await runEngine(entry, "regions", {});
  const lone = res.detections.find((d) => Math.abs(d.centroid.x * 400 - 300) < 2);
  assert.equal(lone.attributes.unit, "um");
  near(lone.attributes.equivalentDiameter, 25, 0.3, "diameter um");
  near(lone.attributes.area, Math.PI * 12.5 * 12.5, 8, "area um2");
  assert.equal(res.quality.calibration.unit, "um");
  near(res.quality.calibration.unitsPerAnalysisPixel, 0.5, 1e-9);
  assert.ok(res.quality.calibration.relativeUncertainty > 0);
  // A view has its own measurement space: the image's scale is not borrowed.
  const v = await view(entry, { sampling: { mode: "working" }, ops: [{ op: "grayscale" }], output: { format: "png", maxLongSide: 200 } });
  const onView = await runEngine(entry, "regions", { derivedViewId: v.derivedViewId });
  assert.equal(onView.quality.calibration, null);
  assert.equal(onView.detections[0].attributes.unit, undefined);
  // Calibrated in the view (delivered at half size: 50 view px = 50 um).
  entry.calibrations.set(v.derivedViewId, calibrate({ points: [{ x: 0, y: 0 }, { x: 50, y: 0 }], length: 50, unit: "um", sigmaPx: 1 }));
  const scaled = await runEngine(entry, "regions", { derivedViewId: v.derivedViewId });
  near(scaled.quality.calibration.unitsPerAnalysisPixel, 0.5, 1e-9);
  const loneV = scaled.detections.find((d) => Math.abs(d.centroid.x * 400 - 300) < 2);
  near(loneV.attributes.equivalentDiameter, 25, 0.3, "view diameter um");
  // Outlines come back on the image; view pixels keep the box and centroid only.
  for (const p of loneV.mark.points) near(Math.hypot(p.x * 400 - 300, p.y * 240 - 80), 25, 2.5, "view outline radius");
  near(loneV.view.centroid.x, 150, 0.5); near(loneV.view.centroid.y, 40, 0.5);
  assert.equal(loneV.view.points, undefined);
});

test("MCP: detect_features runs on a process_image result and refuses a view of another image", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "estampes-engview-"));
  const ids = [];
  for (const bytes of [await board(), await discs()]) {
    const id = imageIdOf(bytes); ids.push(id);
    mkdirSync(join(dir, "images", id.slice(4)), { recursive: true });
    writeFileSync(join(dir, "images", id.slice(4), "source"), bytes);
  }
  const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const port = s.address().port; await new Promise((r) => s.close(r));
  const handle = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), ESTAMPES_STORAGE_DIR: dir, ESTAMPES_ACCESS_KEY: "", ESTAMPES_ALLOW_OPEN: "1" }, stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const client = new Client({ name: "engview-test", version: "0" }, { versionNegotiation: { mode: "auto" } });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/")).ok) break; } catch {} await sleep(100); }
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const [boardId, discsId] = ids;
    const processed = await client.callTool({ name: "process_image", arguments: { imageId: boardId, sampling: { mode: "working" }, ops: [{ op: "grayscale" }, { op: "morphology", operation: "open", radius: 3 }] } });
    assert.equal(processed.isError, undefined, processed.content?.[0]?.text);
    const dv = processed.structuredContent.derivedViewId;
    const raw = await client.callTool({ name: "detect_features", arguments: { imageId: boardId, engine: "components", params: { minArea: 100 } } });
    const onView = await client.callTool({ name: "detect_features", arguments: { imageId: boardId, engine: "components", derivedViewId: dv, params: { minArea: 100 } } });
    assert.equal(onView.isError, undefined, onView.content?.[0]?.text);
    assert.equal(raw.structuredContent.detections.length, 3);
    assert.equal(onView.structuredContent.detections.length, 2);
    assert.equal(onView.structuredContent.derivedViewId, dv);
    assert.match(onView.content[0].text, /on processed view dv:/);
    assert.match(raw.content[0].text, /on source pixels/);
    // The view's mark goes straight onto the canvas of the original.
    const shown = await client.callTool({ name: "present_visual", arguments: { imageId: boardId, annotations: [{ id: "joined", ...onView.structuredContent.detections[0].mark, label: "one object" }] } });
    assert.equal(shown.isError, undefined, shown.content?.[0]?.text);
    const wrong = await client.callTool({ name: "detect_features", arguments: { imageId: discsId, engine: "components", derivedViewId: dv } });
    assert.equal(wrong.isError, true);
    assert.match(wrong.content[0].text, /is not a processed view of img:/);
    const both = await client.callTool({ name: "detect_features", arguments: { imageId: boardId, engine: "components", derivedViewId: dv, sampling: { mode: "native" } } });
    assert.equal(both.isError, true);
    const regions = await client.callTool({ name: "detect_features", arguments: { imageId: discsId, engine: "regions" } });
    assert.equal(regions.isError, undefined, regions.content?.[0]?.text);
    assert.equal(regions.structuredContent.quality.regions, 4);
    assert.match(regions.content[0].text, /Summary: \{"regions":4/);
  } finally { await client.close().catch(() => {}); handle.kill(); }
});
