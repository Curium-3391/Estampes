# Estampes

**A shared visual language for humans and AI.**

Estampes is an experimental, open-source project exploring a simple idea: humans and AI should be able to **point at the same image** while talking, without leaving their conversation.

Inspired by Claude Debussy's *Estampes* (1903).

> **Status:** M0.3.2 number-line and M0.4 generic 2D visual annotation have both been observed working in ChatGPT (2026-10-29). **M0.4.5 visual evidence viewer was verified in ChatGPT on 2026-10-29. M0.4.7 is a new single-widget UI candidate (CI verified, live host testing pending)**: annotation/editing, original and local zoom now live in a single canvas; the separate PNG viewer is retained only for legacy/explicit use. `inspect_visual` remains a separate model-facing PNG tool; full model-vision visibility is not established by this viewer test. General-purpose image grounding and arbitrary image imports remain unsolved.

## The problem

Multimodal assistants can often discuss images, but a basic exchange about a specific component still involves screenshots, drawing circles in a separate editor, reuploading, and multiple rounds of "which one?" clarification.

Estampes aims to remove that friction.

## Desired experience

- **AI → human:** The assistant identifies and points to relevant objects using arrows, boxes, highlights, labels, or paths over an original image.
- **Human → AI:** The user draws or selects a region on the same image, then asks a question about it.
- **Shared context:** Both parties can refer to the same image and annotation IDs across turns.
- **Native-feeling interaction:** Annotation should happen inside the chat experience, not in a separate website or image editor.
- **Preserve the source:** Annotations are independent overlays, not destructive edits to the image.

## Design principles

1. **Conversation first.** Estampes is not another chatbot or a general-purpose whiteboard.
2. **Grounded, not guessed.** Uncertain locations must be distinguishable from confirmed ones.
3. **Source-preserving.** Keep image identity, dimensions, and annotation geometry explicit.
4. **Bidirectional by design.** Both human and assistant annotations matter.
5. **Portable.** Prefer model-agnostic annotation formats and lightweight integrations.
6. **Low-friction.** No extra app or context switch in the intended end-user workflow.

## Run your own server

```sh
git clone https://github.com/Curium-3391/Estampes.git
cd Estampes
cp .env.example .env
docker compose up -d
```

Runs on amd64 and arm64 (Raspberry Pi, NAS, mini PC); images, marks, layers, SVGs and history are kept in a Docker volume. Heroku (Deploy button) and Render (`render.yaml`) also work. See [Deployment](docs/DEPLOYMENT.md). Everything on a canvas can be read as one host-neutral JSON document; see [Visual protocol 2](docs/PROTOCOL-V2.md).

## Development roadmap

- [ ] **M0 — ChatGPT plugin number-line PoC:** The in-chat AI → widget → user → GPT round trip is **host-verified** (2026-10-29). Remaining: resizing, repeated interactions, and additional coordinate cases.
- [x] **M0.4 — Generic 2D visual surface:** In-chat point/rectangle and user-to-GPT transmission have been observed working on the landscape demo. This does **not** establish semantic accuracy or reliable author preservation.
- [ ] **M0.4.1 — Grounding and provenance correction:** Server resolves named demo objects from explicit scene landmarks; user marks have a separate replay channel and unverified AI coordinates are marked as such. Awaiting host verification.
- [ ] **M0.4.2 — Annotation/context protocol:** Explicit intent selector, optional user note and manually supplied quote, canonical v0.2 event and context-aware GPT message. Implemented; live host verification pending.
- [ ] **M0.4.3 — Visual Input Bridge:** `inspect_visual` returns real PNG pixels and source-coordinate metadata from demo artwork, separating Estampes geometry from GPT object interpretation. Live model vision visibility not yet verified.
- [x] **M0.4.5 — Inline visual evidence viewer:** Dedicated `present_visual_evidence` renderer shows three real PNG views (marked full image, pristine full image, enlarged pristine crop) inside ChatGPT. Confirmed by user screenshots on 2026-10-29 for `demo:landscape`, point `(0.82, 0.49)`. This validates the **human-visible render path**, not general model perception.
- [ ] **M0.4.6 — Evidence-first model annotation:** Removed object-name/scene-anchor lookup from the model-facing `present_visual` schema. AI must supply coordinates rather than ask the plugin for `house`/other labeled positions. CI checks this; blind image grounding is still unverified. See [M0.4.6 grounding evaluation](docs/M0-4-6.md).
- [ ] **M0.4.7 — Unified shared canvas:** Combined the original image, annotation editor and local zoom in one SVG surface; optional collapsed context, author-specific palette, no routine duplicate viewer. CI passed; ChatGPT one-widget acceptance pending. See [M0.4.7](docs/M0-4-7.md).
- [x] **M0.4.8 — Deployment hardening:** Optional access key, rate limit, CORS allowlist, committed lockfile, single version source, and widget-only image payload for the legacy viewer. Host-verified in ChatGPT on 2026-10-29, together with the M0.4.7 single-canvas flow. See [M0.4.8](docs/M0-4-8.md) and [Deployment](docs/DEPLOYMENT.md).
- [ ] **M0.5 — Real-image preprocessing:** `load_image` (ChatGPT file params or public https URL), `process_image` (CLAHE, sharpen, denoise, adaptive/Otsu threshold, edges, zoomed regions) and `overlay_grid` (labelled grid with source-coordinate cell centres). M0.5.1: `present_visual` shows the real photo (original by default, optional processed tabs) and takes the user's marks back. 0.5.3–0.5.5: polylines and freehand drawing, pens and highlighter, verification image, crop coordinates, persistent marks with notes, undo/redo, pixel reload. 0.5.7–0.5.9: zoom and pan in the canvas, layers you can show or hide. 0.6.0: paired view, two different images side by side with links between their marks that GPT records and the user reviews. 0.7.0: layers you can rename, reorder, fade and lock; select one mark to move, restyle or delete it, including marks from earlier turns; disk storage; Docker, Heroku; `estampes.visual/1` protocol. 0.8.0: every note and link GPT makes is a claim with its own confidence, evidence (where on which image, zoomable) and verification state; only the user or a tool verifies it, and a claim the user rejects is remembered so GPT cannot repeat it without new evidence (`estampes.visual/2`). Upload path and canvas verified live. See [M0.5](docs/M0-5.md).
- [ ] **M1 — Real-image grounding:** Support authorized image input and precise model grounding, without assuming access to ChatGPT native searched images.
- [ ] **M2 — Persistent bidirectional context:** Stable annotation IDs, user corrections, and multi-turn updates.
- [ ] **M3 — Host-native image integration research:** Investigate supported Plugin Extensions/file viewers for closer integration with existing ChatGPT images, without assuming direct access to host-rendered search images.
- [ ] **M4 — Complex real-world imagery and evaluation:** Progress to diagrams and PCBs only after simpler cases work; measure accuracy, clarification turns, and task completion.

**Integration requirement:** Estampes is a ChatGPT-native plugin experience, not a standalone website or chatbot. Use an MCP server + MCP Apps UI inside the conversation for M0; evaluate ChatGPT Plugin Extensions for deeper native integrations.

See [Vision](docs/VISION.md), [Architecture](docs/ARCHITECTURE.md), [Annotation protocol draft](docs/PROTOCOL.md), and [M0.3 testing guide](docs/M0-TESTING.md), and [M0.4 visual surface guide](docs/M0-4.md), [M0.4.1 grounding correction](docs/M0-4-1.md), [Protocol v0.2 draft](docs/PROTOCOL-V0.2.md), and [M0.4.2 testing](docs/M0-4-2.md), and [M0.4.3 visual input bridge](docs/M0-4-3.md).

## Integration caveat

Current client/plugin APIs may not expose images already displayed by the chat host, nor permit adding layers directly over native image components. In-chat custom UI is a possible intermediate step; transparent access to host-rendered images is a longer-term goal, **not** a capability we assume exists.

## Contributing

Ideas, technical feedback, reproducible test cases, and accessibility suggestions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

A license has not yet been selected and committed. Until then, please do not assume redistribution rights for the source code.
