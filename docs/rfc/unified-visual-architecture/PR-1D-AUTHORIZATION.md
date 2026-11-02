# PR-1D — Limited implementation authorization

Status: **EXPLICIT MAINTAINER AUTHORIZATION FOR ISOLATED PR-1D ONLY**.

The latest user-supplied “Phase 1 / PR-1D Implementation Authorization” supersedes earlier pending-PR-1D statements for this scope. Exact source SHA256 and the fixed code/test allowlist are recorded in [authorization](evidence/pr1d-authorization.json). This is an instruction record, not an inferred architecture approval.

Required base is `58f7789414130085543560147df87e85a62123ea` on `codex/pr1c-native-ext4-acceptance`. Both native acceptance commits descend from original PR-1C `5549f10586dc17e0a802c42dd6c37ebaa70ad80a`; the initially clean checkout was branched to `feat/unified-visual-architecture-pr1d`. Main remains the original `7fb9b73442401fc32a7034888deaf49303e582a6`; no rebase was performed.

Allowed: isolated retention/pins, lossless history, compaction, G1/G2 GC, Ledger retention, quota/reservations, maintenance, document-store backup/restore, disposable fault tests, evidence and documentation. All Root publication remains inside the existing single-writer coordinator. Existing public tools and stores stay unchanged.

Excluded: PR-1B, Authority Cutover, production activation, legacy `saveCanvas` changes, MCP registration, Host authentication, Graph/CAS/Workbench integration, user-data migration, release, push and merge. Existing tests, the original 95 source/config hashes, and historical PR-1A/PR-1C/native evidence must remain unchanged.

The user explicitly requires **IMPLEMENTATION BLOCKED** when a required safety condition cannot be proven. Historical WSL2 ext4 results do not certify new PR-1D code or power-loss durability. End at the PR-1D gate after committing; do not continue into PR-1B.
