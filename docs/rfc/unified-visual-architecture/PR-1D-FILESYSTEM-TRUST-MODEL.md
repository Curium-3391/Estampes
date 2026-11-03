# PR-1D filesystem trust model

2026-11-04 (Asia/Taipei). Scope: the isolated Linux persistence engine. This specifies reliability and a private UID trust domain; it does not activate a production writer or claim exclusion of hostile same-UID processes.

## Guarantees and actor boundary

| Category | Prevent / detect / enforcement | Acceptance evidence and exclusions |
| --- | --- | --- |
| A: cooperating clients, SIGKILL, partial writes, interrupted rename/fsync/GC/recovery, ENOSPC/EIO/EXDEV, missing/corrupt dependencies | Real lifetime flock serializes clients; sole CURRENT and hashed six-root closure preserve whole transactions; durable intent precedes unlink; cryptographic content checks reject known corruption and stale cache evidence; post-publication uncertainty fences without rollback or ACK. | Actual production-code process-crash/fault, schema, Ledger/history, pins/backup and state-transition tests. File/directory fsync calls remain real. Host power-loss is a separate gate. |
| B: another process with the writer UID, pathname/in-place mutation before/after validation/ACK, quarantine substitution, out-of-band metadata changes | Controlled changes visible at the final supported verification point are detected using content hashes and object identity. UID/mode/ancestry checks exclude ordinary other-UID access; they do NOT exclude processes sharing the writer UID. | Same-UID adversarial integrity is UNSUPPORTED in the current user-owned deployment. Adversarial tests are retained with markers and separate verdicts. No number of stat/hash checks makes the interval after the last check immutable. |
| C: administrator/root, compromised kernel, malicious hardware, host/VHDX flush loss, sudden power loss, filesystem rollback, replacement of CURRENT and its entire authority chain | No application-only guarantee. Deployment/storage controls and independent device/VM/power-loss tests are required. Hash consistency does not authenticate a completely replaced authority chain. | Not executed/certified here. No automatic old-CURRENT restoration, guessed authority, privilege escalation or data migration. |

The supported boundary treats **every process able to run with the writer UID, plus its executable/module/preload/configuration supply chain, as trusted**. This is a substantive restriction. A shared developer account executing untrusted code does not satisfy a hostile-writer isolation claim. Mode 0700, flock and owner-controlled chmod 0400 cannot enforce that claim against the same UID.

## Implemented private managed-tree policy

The implementation checks the effective process UID owns the store and managed directories/files; managed directories are owner-only, nonsymlink regular directories; files are nonsymlink regular files with one hard link and no group/other write bits. The existing 0700 disposable-root and same-device requirements remain. Readable file mode 0644 is compatible inside a 0700 tree, including the existing flock-created lock; it grants no traversal access through that tree. No existing file is silently chmodded/chowned to pass a check.

Directory ancestry must be nonsymlink, owned by the writer UID or root, and not writable by another UID. A root-owned sticky temporary ancestor such as /tmp is allowed: the kernel sticky rule protects this writer-owned child against other ordinary UIDs. It still does not exclude the writer UID or root. Critical reads/writes/deletes recheck managed parents and ownership. Startup inventories the tree before recovery mutation. Existing unsafe trees fail closed rather than being repaired in place.

Staging and quarantine stay under this same private tree and device. Normal POSIX rename retains inode identity while metadata timestamps may change. Persistent GC reservations identify device/inode plus exact content hash/length and authorized locations; terminal reservations do not own future objects recreated at a content-addressed source pathname. Hardlink aliases and ambiguous active reservations are rejected. The single-writer lease remains mandatory but is not an access-control mechanism.

Physical reservations are local to the original tree/device. A copied backup cannot inherit deletion authority over copied inodes. A restore-restricted copy verifies its complete logical snapshot and remains read-only before any physical GC recovery; missing unreachable GC garbage does not prevent reading that verified snapshot. It cannot resume maintenance or writing, and no candidate identities are rebound to authorize deletion in the copied tree.

The OS policy protects against ordinary different UIDs only when the host preserves these Unix DAC semantics and grants no bypassing ACL, capability, administrator or mount access. Runtime checks cannot certify arbitrary ACL/capability/host configuration or establish executable isolation. Those are explicit deployment prerequisites, not inferred from a successful probe.

## Cache and publication contract

Fingerprints are change-detection hints, never cryptographic identities. Reusable proofs carry raw-content SHA-256 and byte length as well as observed physical metadata. A fresh verification operation cryptographically revalidates unique reused dependencies. In-operation prefix/metadata sharing is provisional until the complete dependency set is rehashed at the integrity boundary. Eviction discards proof; restart starts empty. Existing 4 MiB proof, record/registry budgets and bounded prefix sharing remain.

A successful ACK certifies one selected transaction and exact Ledger identity after its required file/directory barriers and final content verification, assuming the stated writer-domain/storage preconditions. It does not certify that another process cannot corrupt storage after the last observation or after ACK delivery.

Candidate verification follows after-prepared. CURRENT publication performs a final verification after the current.before-rename test boundary. Before returning ACK, another verification follows the before-ack boundary. Detected pre-publication faults leave old CURRENT; detected post-publication faults preserve whichever CURRENT was selected, fence the writer and return RECOVERY_REQUIRED with no ACK. The committed Ledger is not erased to make a test expect an older root.

## Unlink contract and Linux limit

The selected hashed plan and preexisting durable unlink intent authorize a particular quarantine object/hash/length. After gc.before-unlink, the implementation rechecks that object's device/inode, content hash and length; known replacements are retained and maintenance fences. Live roots/pins/backups are re-marked before this operation, and directory fsync precedes terminal progress.

Linux unlink/unlinkat remove a directory entry by pathname. Node's supported filesystem API exposes no atomic "unlink this name only if it still has this inode and digest" operation. Holding an FD or adding stat calls does not turn unlink into such an operation. A non-cooperative writer can still replace or modify the entry after the last check. That residual belongs to unsupported category B; no portable conditional-unlink claim is made.

## Stronger deployment proposal — not activated

A separately reviewed Linux deployment could use a dedicated noninteractive writer UID, an administrator-owned non-writable parent and executable/module tree, a private writable data mount exposed only to that UID, no unrelated same-UID jobs, restricted process launch/preloads, and a permission-separated client interface. Different client UIDs could not directly write quarantine or immutable generations. ACLs, supplementary groups, capabilities, mount exposure and recovery/backup ownership would require explicit acceptance tests.

The current parent/worker run under the same user-owned account; converting them to such a service would change process launch, IPC, permissions, backup ownership and deployment compatibility. No dedicated account, daemon, privileged mount, chown, system-wide permission or active deployment change is made in this task. A hostile same-UID profile remains unimplemented; no caller-supplied attestation flag upgrades it into one.
