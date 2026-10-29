# Architecture (working proposal)

> This document describes a proposed system, not an implemented integration.

## Layers

1. **Host chat / vision model:** Understand user intent, select suitable imagery, reason about targets.
2. **Grounding adapter:** Convert intended targets to image-space locations; verify and carry uncertainty.
3. **Annotation protocol:** Transport image references and geometric objects across boundaries.
4. **Renderer:** Draw non-destructive vector overlays over the correct image revision.
5. **Interaction bridge:** Capture user gestures, preserve coordinates, and send the annotated reference back into the conversation.

## Candidate technology

- **MCP tools:** Provide stable operations for annotation validation, rendering, and state.
- **MCP Apps UI:** Candidate way to render interactive content inside supported hosts.
- **Skill/instructions:** Optional guide for when a model should annotate and how to verify targets.
- **Custom harness:** Not necessary for a first proof of concept.

MCP alone does **not** guarantee access to images shown by a host's built-in image search, nor modification of native image widgets. Treat host image access and UI embedding as separate capabilities to confirm.

## Data flow

```text
user question / image
        |
        v
chat model + image selection
        |
        v
target grounding + verification
        |
        v
annotation document (image ID + geometry)
        |
        v
overlay renderer <---- user draws / selects
        |                   |
        +---- shared context+
                 |
                 v
          next conversation turn
```

## Technical risks

- **Grounding precision:** Dense PCBs or similar-looking objects create false confidence.
- **Image identity:** The client may show a resized, cropped, or transformed rendition.
- **Host boundaries:** Third-party UI may not receive native image bytes or URLs.
- **Security/privacy:** External image URLs may be private, short-lived, or unsafe to fetch.
- **Continuity:** Annotation references need stable IDs across turns.
- **Accessibility:** Spatial references require equivalent text descriptions and keyboard support.

## MVP test

Start with a local, known image. Render an overlay from JSON, resize the view, and round-trip a human-drawn annotation into the same coordinate space. Add model-produced boxes only after the geometry pipeline is reliable.
