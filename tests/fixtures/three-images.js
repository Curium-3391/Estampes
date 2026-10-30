// The 2026-10-30 multi-canvas report as a fixture: canvas A (one image,
// 25 marks in 5 layers, 3 of them the user's) and paired canvas B (two
// images with 2 marks each in 2 layers each, one of them the user's).
// Merged, the expected workspace is 3 images, 29 marks, 9 layer instances.
import sharp from "sharp";
import { applyCanvasChanges, applyPairChanges, storeUserMarks } from "../../src/canvas-state.js";
import { resolveCoordinateAnnotation as resolve } from "../../src/scene-catalog.js";

const png = (w, h, colour) => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer();
const box = (id, i, extra = {}) => ({ id, type: "rect", x: 0.02 + (i % 10) * 0.09, y: 0.1 + Math.floor(i / 10) * 0.3, x2: 0.08 + (i % 10) * 0.09, y2: 0.3 + Math.floor(i / 10) * 0.3, ...extra });

export async function threeImageFixture(intake) {
  const a = await intake(await png(1536, 432, "#fafafa"), { source: "chat-file", fileName: "opamp.jpg" });
  const b1 = await intake(await png(1152, 1536, "#264"), { source: "chat-file", fileName: "pcb.jpg" });
  const b2 = await intake(await png(1323, 1871, "#fff"), { source: "chat-file", fileName: "page05.png" });
  // A: 12 + 7 GPT marks, 1 user arrow, 3 GPT corrections, 2 user curves.
  applyCanvasChanges(a, { annotations: Array.from({ length: 12 }, (_, i) => box("op-" + i, i)), layer: "運算放大器電路標註", resolve });
  applyCanvasChanges(a, { annotations: Array.from({ length: 7 }, (_, i) => box("x3-" + i, i + 12)), layer: "三倍放大實例", resolve });
  storeUserMarks(a, [{ id: "user-a1", type: "arrow", x: 0.1, y: 0.9, x2: 0.2, y2: 0.8, label: "YOU 1" }]);
  applyCanvasChanges(a, { annotations: Array.from({ length: 3 }, (_, i) => box("fix-" + i, i, { note: "電流方向" })), layer: "電流方向糾正", resolve });
  storeUserMarks(a, [
    { id: "user-a2", type: "polyline", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.1 }], smooth: true, label: "YOU 2" },
    { id: "user-a3", type: "polyline", points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }], label: "YOU 3" },
  ]);
  // B: a source mark on each side, then the user's circle (left) and point (right).
  applyPairChanges(b1, b2, { annotations: [box("pcb-source", 0), { ...box("pdf-p5-source", 1), side: "right" }], layer: "來源識別", resolve });
  storeUserMarks(b1, [{ id: "user-1r8w-2", type: "polyline", closed: true, label: "YOU 2",
    points: [{ x: 0.42436, y: 0.39543 }, { x: 0.69654, y: 0.39543 }, { x: 0.69654, y: 0.57668 }, { x: 0.42436, y: 0.57668 }] }]);
  storeUserMarks(b2, [{ id: "user-1r8w-1", type: "point", x: 0.3831, y: 0.47816, label: "YOU 1" }]);
  return { a, b1, b2 };
}
