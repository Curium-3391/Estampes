# Estampes visual protocol 2 (`estampes.visual/2`)

One JSON document describes everything on an Estampes canvas. It does not depend on ChatGPT, on MCP Apps widgets or on any subject (photos, scans, maps, drawings, schematics, handwriting all use the same fields). The document comes from:

- the MCP tool `get_visual_state` (`imageId`, optional `pairImageId`, optional `history` count), readable by any MCP client;
- `GET /api/v1/canvas/<hash>[?pair=<hash>][&history=N]` (uses the access key when one is set);
- the storage folder (`canvas.json` holds the same data in the server's own shape).

Attaching a document back as `marksFile` restores the marks of the image with the same aspect ratio.

## Document

```json
{
  "protocol": "estampes.visual/2",
  "coordinateSystem": "normalized-top-left",
  "images": [
    { "id": "img:3d2d3118d6fabe52", "role": "left", "width": 3000, "height": 2000,
      "source": "chat-file", "fileName": "board.jpg", "original": { "format": "jpeg", "width": 6000, "height": 4000 } }
  ],
  "layers": [
    { "id": "L1", "image": "img:3d2d…", "author": "assistant", "name": "第一輪", "order": 0, "count": 3, "locked": true, "opacity": 0.5 }
  ],
  "marks": [
    { "id": "g1", "image": "img:3d2d…", "type": "rect", "geometry": { "x": 0.1, "y": 0.2, "x2": 0.3, "y2": 0.4 },
      "label": "A", "layer": "L1", "style": { "color": "red", "size": "thin", "pen": "pen" },
      "finding": { "note": "R12", "status": "inspected", "confidence": "high",
        "evidence": [ { "id": "e1", "kind": "text", "observer": "model", "image": "img:3d2d…", "region": [0.1, 0.2, 0.3, 0.25], "says": "silkscreen reads R12" } ],
        "ambiguities": ["value band unreadable"], "verification": { "state": "unverified" } },
      "provenance": { "author": "assistant", "grounding": "unverified" } }
  ],
  "links": [
    { "id": "k1", "from": { "image": "img:3d2d…", "mark": "g1" }, "to": { "image": "img:9a0c…", "mark": "p4" },
      "label": "same thing", "note": "why", "confidence": "low", "evidence": [ … ], "verification": { "state": "user-confirmed" },
      "review": "confirmed", "author": "assistant" }
  ],
  "rejections": [
    { "id": "r1", "kind": "link", "at": "2026-10-30T02:40:00Z", "ref": "link:img:9a0c…:k2",
      "from": { "image": "img:3d2d…", "region": [0.1, 0.3, 0.16, 0.36], "text": "IC501" },
      "to": { "image": "img:9a0c…", "region": [0.55, 0.4, 0.6, 0.45], "text": "U1" },
      "reason": "board number not visible", "evidenceSeen": ["model:text:img:3d2d…"] }
  ],
  "history": [ { "at": "2026-10-29T19:31:13.661Z", "tool": "present_visual", "author": "assistant", "changed": ["g1"], "marks": 3 } ]
}
```

A layer the server named by default also carries optional `nameKey` and `nameParams` (a catalog key under `name.` and its parameters). `name` is always present and is the name of record; a reader that does not know the key shows `name`. Renaming a layer removes both fields.

Fields that do not apply are left out (no `null`s).

## Images

- `id` is `img:` + the first 16 hex digits of the SHA-256 of the file as received. The same file always has the same id, on any server.
- `width`/`height` are the **working copy**: EXIF orientation applied, long side capped (default 4096). All coordinates refer to this orientation; because they are normalized, the cap does not change their meaning.
- `role` is `single` for one image, `left`/`right` for a paired view (two different images side by side, never overlaid).

## Coordinates

Every coordinate is a number from 0 to 1 relative to the mark's **own** image, origin top-left, x to the right, y down. A paired view does not share a coordinate space between its images.

## Marks

| `type` | `geometry` |
| --- | --- |
| `point` | `x, y` |
| `rect` | `x, y, x2, y2` (two opposite corners) |
| `arrow` | `x, y` tail → `x2, y2` head. The type is geometry only: whether the head is a target or the arrow shows a direction is up to the author (see [TOOLS](TOOLS.md#what-your-marks-mean)). |
| `polyline` | `points` (2–128 ordered vertices), optional `smooth` (curve through the points), `closed` (loop), and `bbox [x, y, x2, y2]` |

- `style`: `color` (gold, blue, red, green, yellow, magenta, cyan, white, black), `size` (fine, thin, medium, thick), `pen` (pen, highlighter). Absent = author default.
- `finding`: the assistant's `note` on a mark and `status` (`inspected` = it says it looked at those pixels, `uncertain`). A finding can sit on anyone's mark. A note is a **claim** and carries the claim fields below.
- `provenance.author`: `user` or `assistant`. `provenance.grounding`: how the position was obtained:
  - `user-pointer` — the user drew it on the canvas;
  - `unverified` — coordinates from a model, not proof that the model recognised anything;
  - `replayed-unverified` — re-sent without proof of who drew it;
  - `scene-anchor` — a known landmark of a bundled demo scene.
- `provenance.editedByUser`: the user moved or reshaped the mark after it was first sent.
- `stroke` (user marks drawn on the canvas, optional): `order` within the submission, `relativeStartMs` / `relativeEndMs` from the first stroke of that submission (no clock time), `pointerType` (`mouse`, `pen`, `touch`).

## Gesture groups

`gestureGroups` lists sets of user marks that may form one gesture, such as a freehand arrow drawn as a shaft plus a head. They are hypotheses about the marks, never part of them: no mark is merged, retyped or edited.

- `id`, `image`, `memberIds` (2–8 marks on that image).
- `proposedMeaning`: `direction-arrow`, `connected-path` (pieces joined end to end) or `unknown`. With `direction-arrow`, `arrow` gives the `shaft` mark, the `tip` and the `direction` (`heading`, `angleDeg`).
- `provenance`: `system-inferred` (Estampes, from where strokes meet in image pixels and how quickly they followed each other) or `user-created`.
- `confirmation`: `unconfirmed`, `user-confirmed` or `user-rejected`. Only the user sets the last two.
- `evidence`: `near-coincident-junction`, `endpoint-touches-stroke`, `arrowhead-like-geometry`, `drawn-in-quick-succession`.

Groups are recomputed from the current marks, so a group disappears when one of its marks is deleted. Strokes that only cross in their middles are not grouped. Only the user's verdicts are stored (`gestureDecisions` in `canvas.json`).

## Layers

Each user submission and each assistant call that adds marks is one layer. `order` counts from the bottom (0) up, per image. `locked` layers may not be moved, restyled or deleted by anyone (findings still allowed). `opacity` (0.1–1) only changes how the layer is drawn. Hiding a layer is a viewer preference and is not part of the document.

## Links

A link says that one mark on the left image and one on the right image are the same thing. It is a **claim** and carries the claim fields below. `review` (`confirmed`, `rejected`) is kept from version 1 and says the same as `verification.state`. A link is dropped when either of its marks is deleted; a rejection of it is not (see Rejections).

## Claims: confidence, evidence, verification

A note on a mark and a link are claims. Three fields describe how far a claim can be trusted, and they never stand in for one another:

| Field | Values | Written by | Meaning |
| --- | --- | --- | --- |
| `confidence` | `high`, `medium`, `low` | the proposer (assistant or tool) | Its own belief. It only orders the review queue; it never verifies anything. |
| `evidence` | list, up to 6 | the proposer; each item says who observed it | What supports the claim and where it can be checked. |
| `verification.state` | `unverified`, `user-confirmed`, `user-rejected`, `independently-verified` | the user and the server only | Whether the claim may be relied on. `reason` is the user's reason for a rejection. |

`ambiguities` lists what is still unresolved (up to 4 short strings). `previouslyRejected` (`at`, `reason`) marks a claim the user rejected before at the same place and that came back with new evidence.

Each evidence item:

- `kind`: `text` (words or numbers read there), `position` (where it sits relative to other things), `shape` (outline, size, colour), `context` (what surrounds it), `tool-result`, `other`.
- `observer`: `model` (an assistant says it saw this), `tool` (a deterministic tool produced it), `user`. The server sets it: an assistant's evidence is always `model`.
- `image` and `region` (`[x, y, x2, y2]`, normalized to the full image named), so a viewer can zoom to the clue. Optional when the clue has no place.
- `says`: what is there, in a short sentence.

Verification rules:

1. A claim is `unverified` until the user confirms or rejects it, whatever its confidence or however much model evidence it has.
2. `independently-verified` needs at least one `tool` evidence item. The server decides it; nobody can write it.
3. Changing a note's wording, or re-pointing a link to other marks, is a new claim: its old evidence and verdict do not carry over.

## Rejections

A claim the user rejected is remembered in `rejections`, apart from the mark or link it was about, so deleting or redrawing the marks does not erase it.

- `kind`: `link` or `note`. `from` (and `to` for a link): the image, the region of the mark at the time, and its text (label or note).
- `evidenceSeen`: the evidence the rejected claim had, as `observer:kind:image`.
- `ref`: the claim it came from; confirming or withdrawing the verdict removes the rejection.

A new claim **repeats** a rejection when it is on the same images and each end's region overlaps the old one (intersection over union at least 0.5, or the new centre inside the old box); for notes the wording must also match (one contains the other, or half the words are shared, ignoring hedges such as "maybe" or 疑似). A repeat is refused, and reported to the proposer, unless it brings evidence of an `observer:kind:image` the rejected claim did not have; then it is stored with `previouslyRejected`. The rest of the same call is not affected.

## Rules a consumer can rely on

1. The server validates every mark it stores; an assistant cannot create or overwrite a mark with `author: user`, and cannot write `verification` or evidence with `observer` other than `model`.
2. A failed change leaves the canvas exactly as it was (all or nothing).
3. Ids are stable: re-using an id edits that mark; ids are unique across the two images of a pair.
4. Nothing in the document names a host; host-specific transport (ChatGPT file params, widget `_meta`) stays outside it.

## Changes from version 1

- Claims (notes and links) gained `confidence` (notes), `evidence`, `ambiguities`, `verification` and `previouslyRejected`.
- New top-level `rejections`.
- Optional `gestureGroups` and per-mark `stroke` (added later in version 2; readers that ignore them lose nothing).
- Readers of version 1 documents keep working: every version 1 field is still there. Estampes still accepts version 1 documents as marks files.
