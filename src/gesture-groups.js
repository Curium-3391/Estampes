// Candidate gesture groups: several user strokes that may form one gesture
// (a freehand arrow drawn as a shaft plus a head, a path drawn in pieces).
// Strokes are never merged, edited or retyped. Groups are a separate,
// revocable layer of hypotheses computed from geometry (and drawing time
// when the widget sent it), each tagged with who proposed it and whether
// the user confirmed it. Everything is measured in image pixels, so zoom,
// display size and device do not change the result.

export const GESTURE_MEANINGS = Object.freeze(["direction-arrow", "connected-path", "unknown"]);
export const GESTURE_VERDICTS = Object.freeze(["user-confirmed", "user-rejected"]);
const MAX_MEMBERS = 8;
const QUICK_MS = 1500;

export const groupKey = (ids) => [...new Set(ids)].sort().join("+");
const groupId = (key) => {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return "G" + (h >>> 0).toString(36);
};

const HEADINGS = ["right", "up-right", "up", "up-left", "left", "down-left", "down", "down-right"];
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v) => Math.hypot(v.x, v.y);
const dist = (a, b) => len(sub(a, b));

// Line-like strokes as pixel point lists. Points, boxes and closed loops
// have no free ends, so they never start a junction.
function strokeOf(m, w, h) {
  const pts = m.type === "polyline" && Array.isArray(m.points) ? m.points
    : m.type === "arrow" ? [{ x: m.x, y: m.y }, { x: m.x2, y: m.y2 }] : null;
  if (!pts || pts.length < 2) return null;
  const px = pts.map((p) => ({ x: p.x * w, y: p.y * h }));
  let length = 0;
  for (let i = 1; i < px.length; i++) length += dist(px[i], px[i - 1]);
  return { mark: m, pts: px, length, ends: m.closed ? [] : [px[0], px[px.length - 1]] };
}

function nearestOnPath(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], ab = sub(pts[i], a), t2 = ab.x * ab.x + ab.y * ab.y;
    const t = t2 ? Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / t2)) : 0;
    best = Math.min(best, dist(p, { x: a.x + t * ab.x, y: a.y + t * ab.y }));
  }
  return best;
}

// How two strokes touch: end to end, or an end of one on the other's body.
// Strokes that only cross in their middles do not count.
function junction(a, b, tol) {
  for (const e of a.ends) for (const f of b.ends) if (dist(e, f) <= tol) return { kind: "near-coincident-junction", at: e };
  for (const [s, t] of [[a, b], [b, a]]) {
    for (const e of s.ends) if (nearestOnPath(e, t.pts) <= tol) return { kind: "endpoint-touches-stroke", at: e };
  }
  return null;
}

function quick(a, b) {
  const [s, t] = [a.mark, b.mark].sort((m, n) => (m.relativeStartMs ?? 0) - (n.relativeStartMs ?? 0));
  if (![s.relativeEndMs, t.relativeStartMs].every(Number.isFinite)) return false;
  return t.relativeStartMs - s.relativeEndMs <= QUICK_MS;
}

// Travel direction into an end of a stroke, from a point ~20% of the
// stroke's length back, so a wobble at the tip does not decide it.
function directionInto(s, atEnd) {
  const pts = atEnd ? s.pts : [...s.pts].reverse(), tip = pts[pts.length - 1];
  let back = pts[0], walked = 0;
  for (let i = pts.length - 1; i > 0; i--) {
    walked += dist(pts[i], pts[i - 1]);
    back = pts[i - 1];
    if (walked >= s.length * 0.2) break;
  }
  const v = sub(tip, back), n = len(v) || 1;
  return { tip, dir: { x: v.x / n, y: v.y / n } };
}

// An arrowhead: a short stroke at the shaft's end that lies behind the tip
// and spreads sideways (one V stroke, or one wing per stroke).
function arrowheadOf(group, tol) {
  for (const shaft of group) {
    for (const atEnd of [true, false]) {
      if (!shaft.ends.length) continue;
      const { tip, dir } = directionInto(shaft, atEnd);
      const wings = group.filter((w) => w !== shaft && w.length <= shaft.length * 0.6 && nearestOnPath(tip, w.pts) <= tol * 1.5);
      if (!wings.length || wings.length + 1 !== group.length) continue;
      const ok = wings.every((w) => {
        const rel = w.pts.map((p) => sub(p, tip));
        const behind = rel.filter((v) => v.x * dir.x + v.y * dir.y <= tol * 0.5).length / rel.length;
        const side = Math.max(...rel.map((v) => Math.abs(v.x * dir.y - v.y * dir.x)));
        return behind >= 0.8 && side >= Math.max(tol * 0.5, w.length * 0.15);
      });
      if (!ok) continue;
      const angle = (Math.atan2(-dir.y, dir.x) * 180 / Math.PI + 360) % 360;
      return { shaft: shaft.mark.id, tip, direction: { heading: HEADINGS[Math.round(angle / 45) % 8], angleDeg: Math.round(angle) } };
    }
  }
  return null;
}

function describe(members, tol, w, h) {
  const head = arrowheadOf(members, tol);
  if (head) return {
    proposedMeaning: "direction-arrow", evidence: ["arrowhead-like-geometry"],
    arrow: { shaft: head.shaft, tip: { x: r4(head.tip.x / w), y: r4(head.tip.y / h) }, direction: { ...head.direction, provenance: "computed-from-geometry" } },
  };
  return { proposedMeaning: "unknown", evidence: [] };
}

// marks: one image's marks (normalized). decisions: the user's verdicts,
// [{memberIds, verdict}]. Returns every candidate the geometry suggests,
// each with the user's verdict when there is one, plus groups the user
// made by hand. Groups whose members are gone simply disappear.
export function gestureGroups(marks, { width, height }, decisions = []) {
  const w = width || 1, h = height || 1, tol = Math.max(4, Math.hypot(w, h) * 0.012);
  const strokes = marks.filter((m) => m.author !== "assistant").map((m) => strokeOf(m, w, h)).filter(Boolean);
  const byId = new Map(strokes.map((s) => [s.mark.id, s]));
  const parent = new Map(strokes.map((s) => [s, s]));
  const root = (s) => parent.get(s) === s ? s : root(parent.get(s));
  const evidence = new Map();
  for (let i = 0; i < strokes.length; i++) for (let j = i + 1; j < strokes.length; j++) {
    const a = strokes[i], b = strokes[j], touch = junction(a, b, tol);
    if (!touch) continue;
    parent.set(root(a), root(b));
    for (const s of [a, b]) {
      const set = evidence.get(s) ?? new Set();
      set.add(touch.kind);
      if (quick(a, b)) set.add("drawn-in-quick-succession");
      evidence.set(s, set);
    }
  }
  const components = new Map();
  for (const s of strokes) {
    const r = root(s);
    components.set(r, [...(components.get(r) ?? []), s]);
  }
  const verdicts = new Map(decisions.filter((d) => d && GESTURE_VERDICTS.includes(d.verdict) && Array.isArray(d.memberIds))
    .map((d) => [groupKey(d.memberIds), d]));
  const out = [], seen = new Set();
  const emit = (members, provenance, extraEvidence = []) => {
    const ids = members.map((s) => s.mark.id), key = groupKey(ids);
    if (seen.has(key)) return;
    seen.add(key);
    const shape = describe(members, tol, w, h);
    if (shape.proposedMeaning === "unknown" && members.every((s) => evidence.get(s)?.has("near-coincident-junction"))) shape.proposedMeaning = "connected-path";
    const d = verdicts.get(key);
    out.push({
      id: groupId(key), memberIds: [...ids].sort(), proposedMeaning: shape.proposedMeaning, provenance,
      confirmation: d?.verdict ?? (provenance === "user-created" ? "user-confirmed" : "unconfirmed"),
      evidence: [...new Set([...extraEvidence, ...shape.evidence])],
      ...(shape.arrow ? { arrow: shape.arrow } : {}),
    });
  };
  for (const members of components.values()) {
    if (members.length < 2 || members.length > MAX_MEMBERS) continue;
    emit(members, "system-inferred", [...new Set(members.flatMap((s) => [...(evidence.get(s) ?? [])]))]);
  }
  // Groups the user made by hand, from any marks (not only line strokes).
  const all = new Map(marks.map((m) => [m.id, m]));
  for (const [key, d] of verdicts) {
    if (seen.has(key) || d.verdict !== "user-confirmed") continue;
    const ids = key.split("+");
    if (ids.length < 2 || ids.length > MAX_MEMBERS || !ids.every((id) => all.has(id))) continue;
    const members = ids.map((id) => byId.get(id) ?? { mark: all.get(id), pts: [], length: 0, ends: [] });
    emit(members, "user-created");
  }
  return out;
}

// One verdict per member set; "unreviewed" withdraws it.
export function recordGestureDecision(entry, memberIds, verdict) {
  const key = groupKey(memberIds);
  const rest = (entry.gestureDecisions ?? []).filter((d) => groupKey(d.memberIds) !== key);
  entry.gestureDecisions = GESTURE_VERDICTS.includes(verdict)
    ? [...rest, { memberIds: key.split("+"), verdict, at: new Date().toISOString() }] : rest;
  return entry.gestureDecisions;
}
