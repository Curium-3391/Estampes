// Layout schemas (zod) for the server, on top of the pure rules in
// geometry.js. Every layout that is stored or sent back has passed
// LayoutSchema, so a client cannot persist a malformed arrangement.
import { z } from "zod";
import { MAX_PANELS, PANEL_ID, applyOp } from "./geometry.js";
export * from "./geometry.js";

const Num = z.number().finite();
export const RectSchema = z.object({ x: Num.min(0).max(1), y: Num.min(0).max(1), w: Num.min(0.05).max(1), h: Num.min(0.05).max(1) }).strict();
const PlacementSchema = z.object({
  rect: RectSchema, z: z.number().int().min(0).max(100000),
  mode: z.enum(["docked", "floating", "minimized", "maximized"]).default("docked"),
  dock: z.enum(["left", "right", "top", "bottom", "free"]).default("free"),
}).strict();
export const LayoutSchema = z.object({
  placements: z.record(z.string().regex(PANEL_ID), PlacementSchema).refine((o) => Object.keys(o).length <= MAX_PANELS, "too many panels"),
  // Mobile: one panel at a time, the rest in a tab strip, in this order.
  order: z.array(z.string().regex(PANEL_ID)).max(MAX_PANELS),
  active: z.string().regex(PANEL_ID).nullable(),
  sheet: z.enum(["collapsed", "half", "full"]).default("half"),
}).strict();
export const LayoutsSchema = z.object({ desktop: LayoutSchema, tablet: LayoutSchema, mobile: LayoutSchema }).strict();


export function applyLayoutOp(layout, op, panelIds) {
  return LayoutSchema.parse(applyOp(layout, op, panelIds));
}
