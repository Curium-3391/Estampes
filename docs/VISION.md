# Estampes — Product vision

## One sentence

Let humans and AI point, annotate, and reason together on the same image, directly inside a conversation.

## Origin

This idea comes from repeated friction during real-world technical discussions: locating components on PCBs, following circuits, finding controls on instruments, and having to explain visual locations with increasingly awkward text.

The goal is not to build another image editor. It is to make **"look here"** a first-class part of conversation.

## Primary user journeys

### Assistant points

1. The user asks about an object or region.
2. The assistant chooses an appropriate image or uses an image already shared when available.
3. It identifies the relevant target, checks its confidence, and produces annotations.
4. The user sees the **original image** with optional overlays and a linked explanation.

### User points back

1. The user taps or draws on an existing image.
2. Estampes preserves the mark as a coordinate-anchored annotation.
3. The next user turn includes the relevant image reference and annotation context.
4. The assistant interprets it and can revise or extend its own marks.

### Multi-turn collaboration

Annotations should be attributable, referenceable by ID, optionally hidden, and associated with conversation turns. Corrections must not silently rewrite the original source or erase history.

## Non-goals (initial releases)

- Building a standalone collaborative whiteboard
- Training a new vision foundation model
- Replacing existing image search or chat models
- Claiming pixel-level certainty when evidence is insufficient
- Requiring users to leave ChatGPT for ordinary pointing tasks

## Success metrics

- Fewer rounds of clarification for location-related questions
- Higher accuracy in identifying requested targets
- Reduced screenshot/edit/reupload steps
- Robust overlay placement under resize, zoom, and crop
- Natural discoverability without a separate annotation mode

## Long-term aspiration

Build a portable, open-source interaction primitive that could be adopted, integrated, or adapted by AI clients—including ChatGPT—if their host interfaces permit it.
