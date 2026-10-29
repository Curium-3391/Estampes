# Estampes Annotation / Context Protocol — v0.2 draft

**Status:** Experimental; M0.4.2 pilot. Not a stable public schema or universal image understanding system.

## Problem this protocol solves

A geometric gesture alone cannot say whether the user is asking for an explanation, answering a question, correcting the model, reporting an error, or comparing objects. Estampes therefore sends a **user-selected communicative intent**, optional plain-language note, and optional manually pasted prior utterance **together with** the same precise annotation geometry.

**Trust boundary:** an MCP Apps widget must not claim to know what was said earlier unless the host exposes a supported conversation-context API or the user explicitly supplies that text. The M0.4.2 widget does **not** read chat history. It sends an explicit `replyTo.quote` only when the user types it. `messageId` stays `null`.

## Envelope

```json
{
  "schemaVersion": "0.2-draft",
  "eventType": "annotation.submit",
  "image": {
    "id": "demo:landscape",
    "revision": "svg-v1",
    "kind": "svg",
    "intrinsicSize": {"width": 640, "height": 360, "unit": "svg-user-unit"},
    "rasterPixelSize": null,
    "pixelDensityDpi": null,
    "coordinateSystem": {
      "origin": "top-left", "unit": "normalized", "range": [0,1],
      "orientation": "unrotated"
    },
    "crop": null
  },
  "annotations": [
    {
      "id": "user-5",
      "author": "user",
      "type": "arrow",
      "geometry": {"x": 0.2045, "y": 0.5795, "x2": 0.7577, "y2": 0.5147},
      "arrowhead": "end",
      "label": "YOU 1",
      "grounding": "user-pointer"
    }
  ],
  "interaction": {
    "intent": "correct-assistant",
    "requestedAssistantAction": "reconsider-prior-identification",
    "userNote": "我指的是右邊的樹，不是後面的山。",
    "replyTo": {
      "messageId": null,
      "quote": "你剛剛標的是哪一座山？",
      "provenance": "user-entered"
    },
    "arrowMeaning": "arrowhead-is-target",
    "contextAvailability": "host-conversation-not-readable-by-widget"
  }
}
```

The quote and note above are **examples entered by a user**, not inferred from the current conversation.

## Interaction intents

| `intent` | Meaning | Recommended response |
| --- | --- | --- |
| `point-out` | Just referring to this location | Acknowledge the referent; use genuinely available conversation context |
| `ask-about-region` | Ask about a marked part | Explain that region, not the whole scene |
| `answer-question` | Answer a prior assistant question | Interpret the gesture as a reply, but do not invent the missing question |
| `correct-assistant` | Correct a mistaken identification | Compare the prior claim if actually known; otherwise ask what is being corrected |
| `compare` | Compare multiple marked objects | Compare the marked objects, not unrelated parts of the image |
| `report-issue` | Point out a problem | Investigate the indicated region and explain uncertainty |

M0.4.2 derives `requestedAssistantAction` from the explicit selected intent. M0.4.2 requires the user to select an intent before sending, and offers a free-text note and a separately entered quoted prior utterance. Blank optional fields stay `null`, not imaginary context.

## Coordinate and image identity rules

- Coordinates are normalized `[0,1]`, origin at the **source image's top-left**, independent of responsive CSS size.
- A `point` has `x,y`. A `rect` has `x,y,x2,y2` as diagonal corners. An `arrow` has `x,y` for the tail and `x2,y2` for the **arrowhead / target**.
- `image.id` and `image.revision` identify the image being annotated. A new image revision must not silently inherit annotations from another revision.
- The built-in examples are vector SVG with `viewBox=640×360`. These are **SVG coordinate units**, not a photographic resolution of 640×360 pixels.
- `rasterPixelSize` and `pixelDensityDpi` remain `null` for these vector demos. For future raster images, real pixel width/height should be reported; EXIF DPI is usually irrelevant to on-screen object targeting.
- Future crop/rotation/padding transforms must be explicit before annotations are mapped to source coordinates.
- `author:"user"` means the gesture was submitted by the UI's user path; it is not a cross-device cryptographic identity claim.
- `grounding:"user-pointer"` means **human input geometry was accepted**, not that a CV model correctly recognized the object.

## Conversation message template

The MCP server generates the actual user-visible chat message from this canonical event. Its structure is:

```text
我透過 Estampes 在同一張畫布上做了視覺指認。
這次的目的：<selected intent label>。
我的補充說明（使用者親自輸入）：<note, only when supplied>
我提供的前文引述（使用者自行填寫...）：<quote, only when supplied>
點代表位置；框代表範圍；箭頭的終點（箭頭尖端）才是我指的對象...
底圖為內建 SVG 示範場景...
以下為 Estampes 的結構化標註事件（schemaVersion=0.2-draft）：
<complete JSON envelope>
請優先回應我所選的意圖與補充說明...
```

If no quote was entered, the message **explicitly says that no exact quotation is attached**. The assistant should not hallucinate a previous question.

## M0.4.2 integration flow

1. User creates one or more marks with point / box / arrow gestures.
2. User **explicitly selects an intent** and may add a note or quote.
3. Embedded UI calls the app-only `validate_visual_annotations` tool with `scene`, `annotations`, `intent`, `note`, and `replyQuote`.
4. Server validates coordinates and generates `event` (canonical protocol v0.2) and `chatMessage` via `src/interaction-protocol.js`.
5. UI posts `chatMessage` to ChatGPT using `ui/message` and waits for the host's acceptance; only an actual new message/model response confirms end-to-end success.
6. If server validation fails, the UI attempts a plainly labeled **unverified fallback** with intent, note, image identity and raw coordinates; it does not pretend the canonical v0.2 event was validated.

## Future snapping / object detection extensions (not implemented)

Potential extension:

```json
{
  "selectionAssistance": {
    "mode": "edge-snap | object-box | segmentation | none",
    "proposedGeometry": null,
    "acceptedByUser": false,
    "modelId": null,
    "confidence": null
  }
}
```

Snapping must be **suggestive and reversible**, with source geometry preserved and a visual indication of what moved. Edge detection sees low-level contrast boundaries, while object detection/segmentation can propose semantic regions; neither guarantees correctness. A snapping proposal must never silently replace the user's deliberate position.

## Security, provenance and limits

- The MCP server is publicly hosted without auth. Do not submit sensitive images or private quoted conversation text during the PoC.
- Human-provided `userNote` and `replyTo.quote` are conversation input, not independently verified facts.
- This is not ChatGPT-native image access, persisted conversation linkage, authenticated author identity, image segmentation, or general-purpose VLM grounding.
- Server validates syntax and image-domain geometry. **It does not prove that a described object matches a coordinate.**
- Limit note to 500 characters, optional quote to 300 characters, and mark count to 30.
- Follow the existing [legacy v0.1 sketch](PROTOCOL.md) and [M0.4.1 geometry correction](M0-4-1.md) for historical decisions.
