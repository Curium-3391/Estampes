// Messages the Visual Surface posts as the person (RFC docs/rfc/i18n class
// T2, decision D4). Each one is a short sentence in the person's language,
// then a block for the assistant that is English and the same in every
// language. Text the person typed (notes, reasons, labels) is passed through
// as typed. This file is inlined into the widget (see widget-source.js) and
// imported by tests; it has no imports, and `t` is passed in.
//
// `canvas` describes what is open: {kind:"workspace", id, items:[{id,imageId}]},
// {kind:"pair", left, right} or {kind:"single", imageId}.

const VERDICT_EN = {
  link: { confirmed: "confirmed, the same thing", rejected: "rejected, not the same thing", unreviewed: "withdrew their earlier verdict" },
  note: { confirmed: "confirmed your note is right", rejected: "rejected your note", unreviewed: "withdrew their earlier verdict" },
};
const GESTURE_EN = { "user-confirmed": "one gesture", "user-rejected": "not one gesture; read them separately", unreviewed: "withdrew their earlier verdict" };

export const canvasNameEn = (canvas) => canvas.kind === "workspace"
  ? "workspace " + canvas.id + ": " + canvas.items.map((it) => it.id + "=" + it.imageId).join(", ")
  : canvas.kind === "pair" ? canvas.left + " + right " + canvas.right : String(canvas.imageId ?? "");

// Which image a mark is on, for workspaces and pairs.
const sideEn = (canvas, side) => canvas.kind === "workspace" ? side + " " : canvas.kind === "pair" ? (side === "right" ? "right image " : "left image ") : "";
const q = (s) => JSON.stringify(String(s ?? ""));

// Gesture verdicts and reviewed claims. Each entry is plain data:
// gesture {kind:"gesture", side, labels, verdict, made}
// link    {kind:"link", label, verdict, reason, fromItem, toItem, left, right} (left/right are mark ids as shown)
// note    {kind:"note", side, label, note, verdict, reason}
export function reviewParts(list, canvas, t) {
  const gestures = list.filter((r) => r.kind === "gesture"), claims = list.filter((r) => r.kind !== "gesture");
  const sentences = [], blocks = [];
  if (gestures.length) {
    sentences.push(t("msg.gesture.summary", { count: gestures.length }));
    blocks.push(["--- Estampes stroke groups, for the assistant ---",
      "The person said which strokes belong to one gesture (the strokes themselves were not merged or changed):",
      ...gestures.map((r) => "- " + sideEn(canvas, r.side) + r.labels.join(" + ") + ": " +
        (r.made && r.verdict === "user-confirmed" ? "they grouped them into one gesture"
          : r.made && r.verdict === "unreviewed" ? "they split them apart; read them separately"
          : GESTURE_EN[r.verdict] ?? r.verdict)),
    ].join("\n"));
  }
  if (claims.length) {
    sentences.push(t("msg.review.summary", { count: claims.length }));
    blocks.push(["--- Estampes review, for the assistant ---",
      "The person reviewed your claims on the Estampes canvas (" + canvasNameEn(canvas) + "):",
      ...claims.map((r) => "- " + (r.kind === "link"
        ? "link " + r.label + (canvas.kind === "workspace" ? " (" + r.fromItem + " " + r.left + " <-> " + r.toItem + " " + r.right + ")" : " (left " + r.left + " <-> right " + r.right + ")")
        : sideEn(canvas, r.side) + "mark " + r.label + " note " + q(r.note)) +
        ": " + (VERDICT_EN[r.kind]?.[r.verdict] ?? r.verdict) +
        (r.verdict === "rejected" && r.reason ? "; their reason: " + q(r.reason) : "")),
      "Take the person's verdicts as final: do not rely on rejected claims or raise them again without new evidence; unconfirmed claims are only candidates.",
    ].join("\n"));
  }
  return { sentences, blocks };
}

const markName = (e) => e.id + (e.label ? " " + q(e.label) : "");
const EDIT_EN = {
  "rename-layer": (e) => "renamed layer " + e.layer + " from " + q(e.from) + " to " + q(e.to),
  "lock-layer": (e) => "locked layer " + e.layer + " (do not change or delete its marks)",
  "unlock-layer": (e) => "unlocked layer " + e.layer,
  "reorder-layers": (e) => "reordered the layers (bottom to top): " + (e.order ?? []).join(", "),
  "remove-mark": (e) => "deleted " + (e.author === "user" ? "their" : "your") + " mark " + markName(e),
  "move-mark": (e) => ({ move: "moved", resize: "resized", reshape: "reshaped" }[e.change] ?? "moved or reshaped") + " " +
    (e.author === "assistant" ? "your" : "their") + " mark " + markName(e) +
    (e.author === "assistant" ? " (they corrected its position; your note is kept, check that it still applies)" : " (your earlier note on it may no longer apply)"),
  "restyle-mark": (e) => "changed the style or label of their mark " + markName(e),
  "anchor-mark": (e) => (e.anchor === "document" ? "detached " : "attached ") + (e.author === "assistant" ? "your" : "their") + " mark " + markName(e) + (e.anchor === "world" ? " to the axes (it follows the data)" : e.anchor === "function-x" ? " to the curve " + e.plot + " (it follows the function)" : " from the axes (it stays on the page)"),
  "edit-text": (e) => "rewrote the text of your mark " + e.id +
    (e.before && e.after ? ": label " + q(e.before.label) + " -> " + q(e.after.label) + (e.before.note !== e.after.note ? ", note " + q(e.before.note) + " -> " + q(e.after.note) : "") : "") +
    " (their text is what counts)",
  "undo-edit": (e) => "undid the last change to mark " + e.id + " (" + (e.steps ?? []).join("+") + "); it is back as it was before",
  "redo-edit": (e) => "redid the change to mark " + e.id + " (" + (e.steps ?? []).join("+") + ")",
};

// Hand edits: layers renamed, locked or reordered, marks moved or deleted.
export function editParts(list, canvas, t) {
  if (!list.length) return { sentences: [], blocks: [] };
  return {
    sentences: [t("msg.edit.summary", { count: list.length })],
    blocks: [["--- Estampes edits, for the assistant ---",
      "The person changed the Estampes canvas by hand (" + canvasNameEn(canvas) + "):",
      ...list.map((e) => "- " + sideEn(canvas, e.side) + (EDIT_EN[e.kind]?.(e) ?? e.kind)),
      "Treat the canvas as it is now as current; read it again with present_visual (" +
        (canvas.kind === "workspace" ? "workspaceId=" + canvas.id : "imageId") + ") when needed.",
    ].join("\n")],
  };
}

// When the server could not validate a send, the widget still posts what the
// person meant, marked as unvalidated.
export function fallbackParts({ intent, note, replyQuote, canvas, scene, marks }, t) {
  const sentences = [t("msg.fallback.summary", { intent: t("msg.intent." + intent) })];
  if (note) sentences.push(t("msg.annotate.note", { note }));
  if (replyQuote) sentences.push(t("msg.annotate.quote", { quote: replyQuote }));
  const where = canvas.kind === "single" && !canvas.imageId
    ? "Base: built-in SVG demo scene id=demo:" + scene + " revision=svg-v1, viewBox 640x360."
    : "Canvas imageId=" + (canvas.kind === "workspace" ? canvas.items[0]?.imageId : canvas.kind === "pair" ? canvas.left : canvas.imageId) +
      "; use render_canvas for drawings and scene objects, process_image only for photo detail. This send was not saved, so a rendered image may lack the new strokes: do not claim you saw them." +
      (canvas.kind === "pair" ? " Right imageId=" + canvas.right + "; each mark's side says left or right image." : "") +
      (canvas.kind === "workspace" ? " This is workspace workspaceId=" + canvas.id + " (" + canvas.items.map((it) => it.id + "=" + it.imageId).join(", ") + "); each mark's item names its image." : "");
  const block = ["--- Estampes annotation (not validated), for the assistant ---",
    "The person annotated the Estampes canvas, but the server did not validate this send. Intent: " + intent + ".",
    replyQuote ? "The person typed a quote of the earlier turn (in the lines above)." : "No exact quote of an earlier turn was given: do not guess the previous question.",
    where,
    "Coordinates are 0..1 from the image's top-left corner.",
    intent === "point-out"
      ? "A point is a position, a box an extent, and an arrowhead (x2,y2) is what the person points at."
      : "A point is a position and a box an extent; an arrow keeps its direction from start (x,y) to tip (x2,y2), and whether it points at something or shows a direction or flow is for the person's note to say.",
    "Unvalidated marks: " + JSON.stringify(marks),
  ].join("\n");
  return { sentences, blocks: [block] };
}

// One message from several parts: all sentences, a blank line, all blocks.
export function joinUserVoice(...parts) {
  const sentences = parts.flatMap((p) => p.sentences), blocks = parts.flatMap((p) => p.blocks);
  return [sentences.join("\n"), ...blocks].filter(Boolean).join("\n\n");
}
