# Estampes

**A shared visual language for humans and AI.**

Estampes is an experimental, open-source project exploring a simple idea: humans and AI should be able to **point at the same image** while talking, without leaving their conversation.

Inspired by Claude Debussy's *Estampes* (1903).

> **Status:** M0 proof of concept. ChatGPT has successfully rendered the inline number-line widget (model → UI). The M0.3 user → server → ChatGPT round trip is implemented but **still awaiting host verification**.

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

## Development roadmap

- [ ] **M0 — ChatGPT plugin number-line PoC:** The inline widget and model-directed marker work. M0.3 adds an app-scoped selection tool, user-to-chat message attempt, and round-trip smoke tests; host confirmation and resizing checks remain.
- [ ] **M1 — Formula and simple-image grounding:** Test precise pointing at terms in formulas and easily identifiable objects in images, with validation and uncertainty.
- [ ] **M2 — Persistent bidirectional context:** Stable annotation IDs, user corrections, and multi-turn updates.
- [ ] **M3 — Host-native image integration research:** Investigate supported Plugin Extensions/file viewers for closer integration with existing ChatGPT images, without assuming direct access to host-rendered search images.
- [ ] **M4 — Complex real-world imagery and evaluation:** Progress to diagrams and PCBs only after simpler cases work; measure accuracy, clarification turns, and task completion.

**Integration requirement:** Estampes is a ChatGPT-native plugin experience, not a standalone website or chatbot. Use an MCP server + MCP Apps UI inside the conversation for M0; evaluate ChatGPT Plugin Extensions for deeper native integrations.

See [Vision](docs/VISION.md), [Architecture](docs/ARCHITECTURE.md), [Annotation protocol draft](docs/PROTOCOL.md), and [M0.3 testing guide](docs/M0-TESTING.md).

## Integration caveat

Current client/plugin APIs may not expose images already displayed by the chat host, nor permit adding layers directly over native image components. In-chat custom UI is a possible intermediate step; transparent access to host-rendered images is a longer-term goal, **not** a capability we assume exists.

## Contributing

Ideas, technical feedback, reproducible test cases, and accessibility suggestions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

A license has not yet been selected and committed. Until then, please do not assume redistribution rights for the source code.
