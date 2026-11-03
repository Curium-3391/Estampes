# PR-1D integrity hardening authorization

Source: the maintainer's uploaded “Estampes — PR-1D Integrity Hardening” instruction and the explicit chat instruction “完成後push”. Date: 2026-11-03, Asia/Taipei.

Approved: repair R2-H03, R2-H01 and R2-H02 in the isolated persistence engine; profile and improve cold recovery and large-document transient allocation; preserve old evidence and tests; add normal-discovery regressions; run supported verification; commit and push the independent branch.

Exact source: `a33fe411aac7fe763a9adf5b8d71bf4f77e5f3b0`, fetched from `codex/pr1d-native-reacceptance-round2`. Branch: `fix/unified-visual-architecture-pr1d-integrity-hardening`. Do not merge or rebase main.

The instruction explicitly permits a compatible durable publication-proof mechanism when historical selection cannot otherwise be established. The implementation records this proof only when the exact original CURRENT is selected, then retains it under the sole CURRENT retention root. An old classification without proof cannot be upgraded after supersession.

Not authorized: production activation, user data migration, new Host/MCP routes, PR-1B, deployment, merging or release. Native reacceptance, large-capacity qualification, revision-1000 checkpoint and hardware power-loss gates stay open unless separately demonstrated.
