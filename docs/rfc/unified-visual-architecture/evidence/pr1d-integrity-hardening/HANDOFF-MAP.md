# Fresh-session handoff map

Authority: the uploaded integrity-hardening instruction and explicit push authorization; then the existing lifecycle/CommitRoot contracts. Old reports describe observations at their own commits and do not authorize production cutover.

| Path / functions | Proven or required invariant / evidence |
| --- | --- |
| `filesystem.js` / bytes, json, digest, atomic | Same FD supplies bytes and before/after identity; expected cryptographic identity comes from Locator/hashed metadata, never a later stat. Path must still select that object. Claim precedes temporary creation; file and directory barriers precede ACK. |
| `records.js` / loadSnapshot, VerificationCache | All six roots, every logical version, historical canonical bindings, resolver pairs, membership and Ledger agree. Proof metadata stays within 4 MiB; restart begins without proofs. A complete operation owns its observations and bounded verified-prefix working set. |
| `coordinator.js` / commit, publish, open | One serialized OS-leased writer. Candidate is verified before CURRENT; selected dependencies are checked before ACK. Published uncertainty fences the writer. Exact Ledger replay precedes OCC; it never reapplies content. |
| `temporary-attribution.js` / classifyTemporaryClaims | Original claim ID, owner, target, hash and length must match. A prepared Root is a candidate. Historical selection needs the exact original CURRENT or a matching selected proof already retained under CURRENT. Missing old evidence is not manufactured. |
| `gc.js` / plan, step, recoverQuarantine | Selected plan authorizes exact candidates. Validate old progress, presence, hash/length and live dependencies before durable unlink intent. Re-mark before unlink; fsync before completion. Missing without prior intent fails closed in warm and cold paths. |
| `journal.js`, `lease.js` | Durable intent/outcome agrees with membership and permanent request identity. Real flock contention exit 73 remains STORAGE_UNAVAILABLE; IPC EPIPE cannot acquire a second writer. |
| `archive.js`, `pages.js` | Full anchors, every delta transition and metadata page are hash-checked. Shared prefixes belong to one fixed Locator operation; eviction discards trust. Historical registries retain their own bindings. |
| `lifecycle.js`, `pins.js`, `backup.js` | Pins and backups protect physical dependencies; active reads quiesce before release. G2 keeps 24h grace and clock high-water. Backups use a fixed root and remain read-only on restore without continuation proof. |

OBSERVED red at exact baseline: the original cache-ACK race returned an ACK followed by cold corruption; forged prepared+claim was accepted after supersession; warm GC completed a missing quarantine candidate without prior intent. See `red-cache.log` and `red-storage.log`. Original evidence remains unchanged.

Must remain green: all persistence/fault/transaction/backup/pin/lease tests, strict Document schemas, historical binding isolation, 7-day exact ACK and permanent tombstones, original H-01/H-02 and Round 2 regressions, proposed contracts and nine examples, CAS, browser tests and architecture/source preservation checks.

Environment: Linux; checkout overlayfs, disposable stores tmpfs; Node 22 explicitly selected. Native ext4/XFS, device/VM power loss and production profile qualification are unavailable here. SIGKILL and injected I/O failures establish process-crash behavior only.

Authorization stops at isolated repairs, optimization, tests/evidence, commits and branch push. No PR-1B, production writer, migration, new Host/MCP route, main merge or release.
