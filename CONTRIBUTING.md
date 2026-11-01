# Contributing to Estampes

Estampes is a self-hosted, pre-1.0 project (see `package.json` for the version). The core canvas, image tools, workspaces, modules and the calculator exist and are covered by automated tests (`npm test`, the calculator's Python tests, and a browser test against a fake host). Real-host testing in ChatGPT is limited and recorded per feature in the docs and the [changelog](CHANGELOG.md); a passing automated test is not a live ChatGPT result. Formats and tool schemas can still change between 0.x releases. Feedback, small prototypes, and reproducible visual-grounding test cases are especially welcome.

## Useful contributions

- Examples where text-only spatial explanation is frustrating
- Annotation data models and coordinate-transform edge cases
- Lightweight, accessible image overlay experiments
- Evaluation sets with known target locations
- Research on supported MCP Apps / ChatGPT integration APIs

## Getting started

- Set up, run the tests and find your way around the code: [Development guide](docs/DEVELOPMENT.md).
- Write a module: [Module quick start](docs/modules/QUICKSTART.md) and [Testing modules](docs/modules/TESTING.md).
- A good first change is a failing test for a bug you found, or a corrected document (run the commands in it).

## Before a large change

Please open an issue describing the user problem, proposed behavior, and verification plan before investing in a substantial implementation.

## Principles

Keep original images unchanged, state uncertainty clearly, avoid inventing client API capabilities, and prefer portable formats over vendor-specific assumptions.

## License

Estampes is licensed under the [Mozilla Public License 2.0](LICENSE). By submitting a contribution, you agree that it is licensed under the same terms.
