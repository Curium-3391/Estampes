## Summary

<!-- What problem does this solve? Link the issue or explain the motivation. -->

Related issue:

## Scope and risk

- [ ] Documentation / tests only
- [ ] Internal code / UI
- [ ] Public API, MCP tool, protocol, or module contract
- [ ] Persistence, UVA, import/export, or data migration
- [ ] Security, authentication, module permissions, network access, or CI
- [ ] Release / deployment / dependency change

Affected areas and compatibility or rollback implications:

## Verification

<!-- Record actual results, not what you intend to run. Do not call a check green if GitHub never assigned a runner. -->

- [ ] Targeted tests: 
- [ ] `npm test`:
- [ ] `npm run docs:check`:
- [ ] Python CAS tests, if affected:
- [ ] Real-host MCP Apps / ChatGPT / Claude check, if relevant:
- [ ] Not run / skipped (explain why):

## Security and data review

- [ ] No secrets, personal data, production files, or real credentials included
- [ ] External network and module permissions unchanged, or the change is documented and approved
- [ ] No silent data loss; data-format and rollback implications addressed
- [ ] Any public contract changes are documented and covered by tests

## AI assistance and human handoff

AI assistance (tool/model and what it changed, or "none"):

- [ ] I reviewed the resulting diff and understand the changes
- [ ] This PR is **not** an authorization for an AI agent to merge it, publish packages, or create release tags

<!-- Maintainer: manually review the diff and CI results before merging. -->
