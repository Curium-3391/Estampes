# Authority and bounded implementation

APPROVED: supplied PR-1D performance-remediation handoff and separate push
instruction. CURRENT implementation defines runtime behavior; strict schemas,
lifecycle/trust contracts define NORMATIVE invariants. OBSERVED measurements do
not authorize a format, authority, budget or deployment change. No architecture
redesign, cache enlargement, Unified Writer activation or PR-1B is permitted.

## A candidate

CURRENT bytes() performed a numeric lstat of the file, root-device comparison
and parent-directory checks, immediately followed by info() doing the same
ownership/link/device/ancestry validation with bigint metadata. The info result
is the pre-open physical identity used by the actual FD read protocol.

PROPOSED: use that one existing info result for pre-open size and identity.
No reusable directory/path trust is created; no observation spans two reads or
independent candidate/pre-rename/pre-ACK checks. The open still uses O_NOFOLLOW;
opened privateFile and max-byte checks still run; opened FD identity must match
pre-open info. After reading, FD metadata, byte count and a fresh info (including
ancestry and path ownership) must match. Hashing and observation conflict checks
are unchanged. Root ownership/device and parent checks still occur on both
sides of the read. The earliest duplicated check is not a separate publication
verification boundary. Mutable same-UID adversaries remain unsupported as in
the frozen trust model; deterministic visible substitutions must still reject.

Tests: controlled parent/symlink/inode/link/mode replacement between pre-open
info and open, bounded read/repeated ancestry checks, existing coherent read,
metadata collision, shared dependency invalidation, writer fence, cold reopen,
reader/backup and all existing final verification boundary assertions.

## B proposed lifetime

The generic JSON schema currently guards a value, then canonicalJson guards the
same value again before encoding and parsing a detached copy. The bounded
candidate calls the ORIGINAL canonicalJson inside one synchronous transform,
catching its DocumentValidationError into the same Zod custom issue. The outer
redundant guard is removed. No private encoder, skip-validation flag, identity
cache, retained bytes or cross-operation sharing is needed. canonicalJson and
assertJson remain byte-identical; every input still receives the same complete
guard before the exact same encode/parse round-trip. Both sync and async schema
entrypoints execute guard+encode in that same synchronous callback. Strict
Document schema, all byte/depth/node/numeric/Unicode/prototype/accessor checks,
and detached copy semantics remain. Canonical counters still count all encoding
work, and hash/encoding bytes should stay unchanged while guard calls decrease.
