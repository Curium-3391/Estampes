# Maintainer checklist before making Estampes public

This checklist is a **release gate**, not a declaration that the checks have passed. Keep the repository private until each critical item has evidence. See [Security](../SECURITY.md), [Releasing](RELEASE.md), and [Development](DEVELOPMENT.md).

## Privacy and repository history

- [ ] Run a trusted, maintained secret scanner against **all reachable Git history and tags** (not only the current working tree); investigate each finding. The repository includes a limited heuristic preflight in `scripts/audit-git-history.mjs` and a manually reusable workflow in `.github/workflows/prepublic-history-audit.yml`; these do **not** replace a mature scanner.
- [ ] Check historic commits and binary assets for credentials, private images, personal data, API URLs containing bearer keys, and accidentally committed `.env` or data files. Automated pattern scans cannot prove absence.
- [ ] Revoke and rotate any exposed credentials **before** publishing. Deleting a file from the tip of `main` does not remove it from history.
- [ ] Review Issues, PRs, Actions logs, Discussions, release assets, and historical artifacts for sensitive data. Repository visibility changes may expose more than source files.

## Licensing and third-party content

- [ ] Verify source-code ownership and compatibility with [MPL-2.0](../LICENSE), including all dependencies and contributed code.
- [ ] Audit screenshots, images, examples, documentation, fonts, binaries, and the WebAssembly example for distribution rights. Remove or replace anything without clear permission.
- [ ] Ensure README feature claims and live-host compatibility statements match tested behavior.

## Safety and contribution workflow

- [ ] Merge the reviewed AI governance PR; confirm `main` and `v*` rulesets remain active.
- [ ] Confirm the new always-run PR baseline check passes, then make the stable `baseline` job a required status check in branch rulesets. Do not require filtered/never-run checks.
- [ ] Give AI/bot integrations least-privilege write access; do not give them merge/admin/tag-release authority. `AGENTS.md` is guidance, not a security boundary.
- [ ] Confirm Issues, Discussions, Issue Forms, contribution policy, and support guidelines are usable.
- [ ] Enable and review Dependabot alerts and security updates where the repository plan supports them.
- [ ] Once public, enable **private vulnerability reporting** in repository security settings, review GitHub secret scanning alerts and push protection availability, and follow [SECURITY.md](../SECURITY.md).

## Release and user experience

- [ ] Run `npm test`, calculator tests, `npm run docs:check`, and `npm run release:check`; record what actually ran. Confirm any required CI checks are green.
- [ ] Run the Docker Compose smoke test, verify a backup/restore round trip, and check a clean install from the published instructions.
- [ ] Publish an intentional version tag and GitHub Release only after review; verify GHCR package visibility separately and test anonymous image pulls if advertised.
- [ ] Confirm the README, examples, and instructions for ChatGPT/Claude reflect the current API and tested capabilities.

The final decision to switch repository visibility and to ship a release belongs to the human maintainer.
