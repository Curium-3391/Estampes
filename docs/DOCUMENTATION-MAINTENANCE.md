# Documentation maintenance

How the documentation is kept true. The rule behind everything here: **`main` is the source of truth.** A document describes what the code on `main` does today, and says so plainly when something is planned, optional or not tested.

## Check before you push

```bash
npm run docs:check
```

It needs only Node: no server, Docker, CAS container, browser or `npm ci`. It prints one line per problem as `file:line: [check] reason` and exits 1 if there is any. Take it as a floor, not a review: it finds broken references, not wrong sentences.

| Check | What fails |
| --- | --- |
| `links` | A local link whose file is missing, or whose `#anchor` has no heading (GitHub's anchor rules, including `-1` suffixes for repeated headings). |
| `headings` | The same heading twice in one file (the changelog and `docs/history/` are exempt), or one document listed twice in the same index table or list. |
| `tools` | A registered MCP tool (`registerTool` / `registerAppTool` in `server.js` and `src/`) that `docs/TOOLS.md` does not mention; a snake_case name followed by an opening bracket, or in the first column of a TOOLS.md table that is not a registered tool. |
| `env` | An `ESTAMPES_*` name in a document that no code, compose file, workflow or example uses; a variable read in `src/config.js` that no document mentions. |
| `version` | `package.json`, `package-lock.json` and the newest released `CHANGELOG.md` heading disagree; a document pins `ghcr.io/.../estampes:X.Y.Z` to another version. |
| `stale` | A phrase from the list in `scripts/docs-allowlist.json` (statements that were wrong once). |
| `commands` | A fenced `bash`/`sh` example that does not parse (`bash -n`; blocks with `<placeholders>` or `...` are not parsed), `npm run` of a missing script, `node scripts/...` of a missing file, an `estampes-module.js` subcommand that does not exist. |

`docs/history/` records past milestones and is only link-checked. Everything else is checked.

The script reads `scripts/docs-allowlist.json` for three lists. Add to them sparingly and say why in the pull request:

- `nonTools`: a snake_case name written like a call that is not a tool.
- `envNames`: an `ESTAMPES_*` name a document may show although no code reads it literally (the module-secret example name is built by code).
- `stale`: `{ "pattern", "reason", "except": [files] }`. Add an entry when you correct a statement that was wrong, so it cannot return.

## What the check does not do

It does not run your commands (a few walk-throughs have their own verification: `scripts/verify-backup-restore.mjs` and `tests/module-authoring.test.js`), does not know whether a sentence is true, and does not know whether a feature was tested in a live ChatGPT. Those are for the author and the reviewer.

## When you change the code, change the document

| You changed | Update |
| --- | --- |
| A tool's name, inputs or result | `docs/TOOLS.md` (the check enforces the name), the tutorial or usage page that uses it |
| An environment variable | `docs/DEPLOYMENT.md` or the page for its area; `.env.example` and `compose.yaml` if operators set it |
| A data format or its version | `docs/PROTOCOL-V2.md` or `docs/WORKSPACES.md`, `docs/COMPATIBILITY.md`; follow `docs/RELEASE.md` |
| A module permission, capability field or the plan flow | `docs/MODULES.md`, `docs/modules/`, `SECURITY.md` |
| What is stored on disk | `docs/BACKUP-RESTORE.md` (and the script that verifies it) |
| A user-visible behaviour | `CHANGELOG.md` under *Unreleased*, in the same pull request |
| A new document | An index row in `README.md` and in `docs/zh-TW/README.md` |

## Writing rules

- **Label what a capability is**: *Implemented*, *Optional* (needs something installed), *Experimental*, *Planned* or *Unsupported*. Never describe a plan in the present tense.
- **Commands must be reproducible.** Run a command before you write it down. If you could not run it (for example the Docker steps in a sandbox without Docker), say so next to it. Never call something "tested" that you did not run.
- **Automated passes are not live host tests.** Say "tests pass in CI" for automated checks; say "tested in ChatGPT" only for a run in the real client, with the version and date.
- **Generic examples.** Features work for any image; the sample photo of a circuit board is only a test image.
- **English first.** The README and `docs/` are English; the Traditional Chinese guide is `docs/zh-TW/README.md`, with index rows for the English pages. A bug you find while documenting is a separate issue, not a silent doc workaround.

## In CI

Two places run `npm run docs:check`, so drift is caught from either side:

- The `baseline` job in `.github/workflows/pr-baseline.yml` runs it on every PR to `main` and on merge-queue entries. For docs-only PRs it needs no dependency install.
- Weekly, manual and release validation also run the checker through `.github/workflows/m0.yml`.

If Actions minutes ever become a problem, delete the docs workflow and keep running the command locally; the `node-tests` step costs a second.
