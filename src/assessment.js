// Confidence, evidence and verification of a claim, kept apart.
// A claim is a note on a mark ("this is R12") or a link between two marks
// ("these are the same thing"). Confidence is the proposer's own belief and
// only orders the review queue. Evidence lists what supports the claim:
// where on which image, what kind of clue, and who observed it (model =
// the assistant says it saw it; tool = a deterministic tool; user). The
// verification state says whether the claim may be relied on, and the
// assistant can never set it: the user confirms or rejects, and the server
// calls a claim independently verified only when a tool's evidence backs it.
// Nothing here knows what is in the picture.

export const CONFIDENCE = ["high", "medium", "low"];
export const EVIDENCE_KINDS = ["text", "position", "shape", "context", "tool-result", "other"];
export const OBSERVERS = ["model", "tool", "user"];
export const VERIFICATION = ["unverified", "user-confirmed", "user-rejected", "independently-verified"];
export const MAX_EVIDENCE = 6, MAX_AMBIGUITIES = 4, MAX_REJECTIONS = 200;

const r4 = (v) => Math.round(v * 10000) / 10000;
const text = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";

// Evidence from a proposer. `observer` is forced by the caller (the
// assistant's evidence is always "model"), `images` maps a side to an image
// id (single view: only left). Regions are [x, y, x2, y2] normalized to the
// FULL image they name, whatever coordinateFrame the marks used.
export function cleanEvidence(list, { observer, images, where = "evidence" }) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new Error(where + " must be a list");
  return list.slice(0, MAX_EVIDENCE).map((e, i) => {
    const at = where + "[" + i + "]";
    const side = e?.side ?? "left";
    const image = images[side];
    if (!image) throw new Error(at + ": side " + JSON.stringify(side) + " is not an image in this view");
    const kind = EVIDENCE_KINDS.includes(e?.kind) ? e.kind : "other";
    const says = text(e?.says, 160);
    if (!says) throw new Error(at + ": say what this evidence shows");
    let region;
    if (e.region !== undefined) {
      const [x, y, x2, y2] = Array.isArray(e.region) ? e.region.map(Number) : [];
      if (![x, y, x2, y2].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) || x2 <= x || y2 <= y) {
        throw new Error(at + ": region must be [x, y, x2, y2] inside 0..1 of the full image, with x < x2 and y < y2");
      }
      region = [r4(x), r4(y), r4(x2), r4(y2)];
    }
    return { id: "e" + (i + 1), kind, observer, image, ...(region ? { region } : {}), says };
  });
}

export function cleanAmbiguities(list) {
  if (list === undefined) return undefined;
  return (Array.isArray(list) ? list : []).map((a) => text(a, 120)).filter(Boolean).slice(0, MAX_AMBIGUITIES);
}

// The assessment fields a proposer sent, ready to merge into a mark or link.
// Absent fields stay as they were; an empty list clears.
export function assessmentInput(raw, options) {
  const out = {};
  if (CONFIDENCE.includes(raw?.confidence)) out.confidence = raw.confidence;
  const evidence = cleanEvidence(raw?.evidence, options);
  if (evidence !== undefined) out.evidence = evidence;
  const ambiguities = cleanAmbiguities(raw?.ambiguities);
  if (ambiguities !== undefined) out.ambiguities = ambiguities;
  return out;
}

const hasTool = (claim) => (claim.evidence ?? []).some((e) => e.observer === "tool");

// review: the user's verdict (confirmed | rejected), stored on the claim.
export function verificationOf(claim) {
  // A confirmed link whose end moved since (see linkIsStale in canvas-state.js).
  if (claim.review === "confirmed") return claim.stale ? "stale-confirmation" : "user-confirmed";
  if (claim.review === "rejected") return "user-rejected";
  return hasTool(claim) ? "independently-verified" : "unverified";
}

export const needsReview = (claim) => verificationOf(claim) === "unverified";

export function evidenceCount(claim) {
  const n = { model: 0, tool: 0, user: 0 };
  for (const e of claim.evidence ?? []) n[e.observer] = (n[e.observer] ?? 0) + 1;
  return n;
}

// ---- Regions -------------------------------------------------------------
// A mark's area as [x, y, x2, y2]; a point gets a small box around it.
const POINT_HALF = 0.015;
export function markRegion(m) {
  if (m.type === "point") return [m.x - POINT_HALF, m.y - POINT_HALF, m.x + POINT_HALF, m.y + POINT_HALF].map(r4);
  if (m.type === "arrow") return [m.x2 - POINT_HALF, m.y2 - POINT_HALF, m.x2 + POINT_HALF, m.y2 + POINT_HALF].map(r4);
  return [Math.min(m.x, m.x2), Math.min(m.y, m.y2), Math.max(m.x, m.x2), Math.max(m.y, m.y2)].map(r4);
}

export function iou(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h, area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter);
}

// Same place: boxes overlap by half, or the new box's centre is in the old.
export const IOU_MATCH = 0.5;
export function sameRegion(next, old) {
  const cx = (next[0] + next[2]) / 2, cy = (next[1] + next[3]) / 2;
  return iou(next, old) >= IOU_MATCH || (cx >= old[0] && cx <= old[2] && cy >= old[1] && cy <= old[3]);
}

// ---- Rejections ------------------------------------------------------------
// A rejected claim is remembered apart from its mark or link, so deleting or
// redrawing the mark does not erase it. A later claim at the same place
// (same image, overlapping region, and for notes the same wording) is
// refused unless it brings evidence of a kind the rejected one did not have.
// Same words: one contains the other, or at least half of the shorter
// one's words appear in the other ("疑似 Rasalhague" ~ "Rasalhague（蛇夫座 α）").
// Hedges such as 疑似 or "maybe" do not count as words.
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "");
const HEDGES = /^(疑似|可能是|可能|應該是|應該|大概|也許|似乎|或許|maybe|probably|possibly|likely|perhaps)/;
const words = (s) => (String(s ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  .flatMap((w) => /[\p{Script=Han}]/u.test(w) ? w.match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu) : [w])
  .map((w) => w.replace(HEDGES, "")).filter((w) => w.length >= 2);
const sameWords = (a, b) => {
  const x = norm(a), y = norm(b);
  if (x.length < 2 || y.length < 2) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const [short, long] = [words(a), words(b)].sort((p, q) => p.length - q.length);
  if (!short.length) return false;
  const shared = short.filter((w) => long.some((v) => v.includes(w) || w.includes(v))).length;
  return shared / short.length >= 0.5;
};
export const evidenceKey = (e) => e.observer + ":" + e.kind + ":" + e.image;

export function rejectionOf(kind, claim, { from, to, reason, ref }) {
  return {
    id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind, at: new Date().toISOString(),
    ...(ref ? { ref } : {}), from, ...(to ? { to } : {}),
    ...(text(reason, 200) ? { reason: text(reason, 200) } : {}),
    evidenceSeen: [...new Set((claim.evidence ?? []).map(evidenceKey))],
  };
}

const endMatches = (end, old) => end && old && end.image === old.image && sameRegion(end.region, old.region);

// The rejection a new claim repeats, if any. Links: both ends at the same
// places. Notes: same place and the same words (either contains the other).
export function findRejection(rejections, kind, { from, to }) {
  return (rejections ?? []).find((r) => r.kind === kind && endMatches(from, r.from) &&
    (kind === "link" ? endMatches(to, r.to) : sameWords(from.text, r.from.text)));
}

export const bringsNewEvidence = (rejection, evidence) =>
  (evidence ?? []).some((e) => !rejection.evidenceSeen.includes(evidenceKey(e)));

export function addRejection(entry, rejection) {
  const list = (entry.rejections ??= []);
  list.push(rejection);
  if (list.length > MAX_REJECTIONS) list.splice(0, list.length - MAX_REJECTIONS);
  return rejection;
}

// The user withdrew or reversed a verdict: forget rejections made for that claim.
export function dropRejections(entry, ref) {
  if (entry.rejections) entry.rejections = entry.rejections.filter((r) => r.ref !== ref);
}

// One line per rejection for the assistant.
export const rejectionText = (r) => (r.kind === "link"
  ? "link " + JSON.stringify(r.from.text ?? "") + " <-> " + JSON.stringify(r.to?.text ?? "")
  : "note " + JSON.stringify(r.from.text ?? "")) +
  " at " + JSON.stringify(r.from.region) + (r.reason ? " (reason: " + r.reason + ")" : "");
