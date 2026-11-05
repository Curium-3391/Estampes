# Independent native A/B adjudication

Read the committed [protocol](../../docs/rfc/unified-visual-architecture/evidence/pr1d-native-performance-ab/PROTOCOL.md) first. This finite driver requires the exact two detached worktrees and independent Node 22.23.4 npm ci dependencies. It refuses root, a non-ext4 mount, insufficient headroom, uncommitted harness changes, reused case names and reused regression harness directories.

From this evidence checkout, as `estampes`:

```sh
python3 scripts/pr1d-native-ab/run.py
```

No production files or original assertions are edited. The benchmark adapts the original investigation sequence to the native durable profile and records extra read-only receipts outside transaction timing. Its original direct recovery runs before the cold client and publishes an epoch; the two timings are distinct. `/proc` CPU has 10 ms tick resolution on this host. RSS polling is sampled, worker HWM is kernel cumulative per process. Plain latency has no diagnostic preload. Separate profiles use the unchanged original investigation hooks. All runs and failures remain in the new evidence directory; scratch Stores remain private and never transfer between variants.

The disposable native regression adapter reproduces the existing native profile, Document persistence and ACK literal substitutions with new source/transformed hashes because the sealed old adapter rejects the later opt-in fixture hook. It does not edit old manifests. Historical groups execute their original native files directly against the exact candidate source.
