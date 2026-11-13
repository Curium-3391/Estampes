// Ink: the one place that says how a mark's colour, pen and size become
// widths. mark-render.js (server drawings), the RenderPlan and the SVG
// adapter all take these numbers from here.
export const INK_COLORS = Object.freeze({ gold: "#E4AE57", blue: "#579DF6", red: "#F2545B", green: "#3DDC84", yellow: "#FFD23F",
  magenta: "#E36BF0", cyan: "#3FD0E0", white: "#FFFFFF", black: "#111111" });
export const INK_SIZES = Object.freeze({ fine: 0.3, thin: 0.6, medium: 1, thick: 1.8 });
// The canvas is 1000 units wide (K = 1000/640), so a width in units becomes
// source pixels via entry.width / 1000.
export const K = 1000 / 640;

export function inkUnits(m) {
  const hl = m.pen === "highlighter", size = INK_SIZES[m.size] ?? 1;
  const stroke = (hl ? 14 : 3) * K * size;
  return {
    stroke,
    // Pen polylines get a dark outline 1.7x the line under the colour.
    total: stroke * (m.type === "polyline" && !hl ? 1.7 : 1),
    dot: m.type === "point" ? 2 * (hl ? 18 : 8) * K * size : 0,
  };
}
