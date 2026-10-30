# Estampes visual protocol 1 (`estampes.visual/1`)

> Superseded by [version 2](PROTOCOL-V2.md), which adds confidence, evidence, verification and rejections. Version 1 documents are still accepted as marks files.

One JSON document describes everything on an Estampes canvas. It does not depend on ChatGPT, on MCP Apps widgets or on any subject (photos, scans, maps, drawings, schematics, handwriting all use the same fields). The document comes from:

- the MCP tool `get_visual_state` (`imageId`, optional `pairImageId`, optional `history` count), readable by any MCP client;
- `GET /api/v1/canvas/<hash>[?pair=<hash>][&history=N]` (uses the access key when one is set);
- the storage folder (`canvas.json` holds the same data in the server's own shape).

Attaching a document back as `marksFile` restores the marks of the image with the same aspect ratio.

## Document

```json
{
  "protocol": "estampes.visual/1",
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
      "finding": { "note": "text read there", "status": "inspected" },
      "provenance": { "author": "assistant", "grounding": "unverified" } }
  ],
  "links": [
    { "id": "k1", "from": { "image": "img:3d2d…", "mark": "g1" }, "to": { "image": "img:9a0c…", "mark": "p4" },
      "label": "same thing", "note": "why", "confidence": "low", "review": "confirmed", "author": "assistant" }
  ],
  "history": [ { "at": "2026-10-29T19:31:13.661Z", "tool": "present_visual", "author": "assistant", "changed": ["g1"], "marks": 3 } ]
}
```

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
| `arrow` | `x, y` tail → `x2, y2` head (the target) |
| `polyline` | `points` (2–128 ordered vertices), optional `smooth` (curve through the points), `closed` (loop), and `bbox [x, y, x2, y2]` |

- `style`: `color` (gold, blue, red, green, yellow, magenta, cyan, white, black), `size` (fine, thin, medium, thick), `pen` (pen, highlighter). Absent = author default.
- `finding`: the assistant's `note` on a mark and `status` (`inspected` = it says it looked at those pixels, `uncertain`). A finding can sit on anyone's mark.
- `provenance.author`: `user` or `assistant`. `provenance.grounding`: how the position was obtained:
  - `user-pointer` — the user drew it on the canvas;
  - `unverified` — coordinates from a model, not proof that the model recognised anything;
  - `replayed-unverified` — re-sent without proof of who drew it;
  - `scene-anchor` — a known landmark of a bundled demo scene.
- `provenance.editedByUser`: the user moved or reshaped the mark after it was first sent.

## Layers

Each user submission and each assistant call that adds marks is one layer. `order` counts from the bottom (0) up, per image. `locked` layers may not be moved, restyled or deleted by anyone (findings still allowed). `opacity` (0.1–1) only changes how the layer is drawn. Hiding a layer is a viewer preference and is not part of the document.

## Links

A link says that one mark on the left image and one on the right image are the same thing. `confidence` is the assistant's (`high`, `medium`, `low`); `review` is the user's verdict (`confirmed`, `rejected`) and outranks the confidence. A link is dropped when either of its marks is deleted.

## Rules a consumer can rely on

1. The server validates every mark it stores; an assistant cannot create or overwrite a mark with `author: user`.
2. A failed change leaves the canvas exactly as it was (all or nothing).
3. Ids are stable: re-using an id edits that mark; ids are unique across the two images of a pair.
4. Nothing in the document names a host; host-specific transport (ChatGPT file params, widget `_meta`) stays outside it.
