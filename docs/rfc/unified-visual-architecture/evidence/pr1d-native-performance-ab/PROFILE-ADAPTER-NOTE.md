# Separate profile adapter correction, before profile execution

Static inspection, before either optional profile run, found that the frozen
independent benchmark invokes its direct helper as `benchmark.mjs direct ROOT`.
The unchanged original profiling preload intentionally activates only when
`process.argv[2]` is the owned Store path. Consequently the new argument order
would skip the preload, and the later profile-flush signal would terminate the
direct helper. No profile result motivated this correction.

Complete all twelve plain attempts using the original frozen script. Pause the
supervisor after the last plain terminal verification, with no measurement
worker left active. Reorder only direct-helper arguments to
`benchmark.mjs ROOT direct`, preserving its native options, operation sequence,
60 s cap, original profile hooks and unchanged 30 s cold client. Resume the two
separately declared explanatory profiles, baseline then candidate, exactly once.
No plain sample is replaced, no runtime or assertion changes, and PROTOCOL.md
remains byte-identical. Per-case manifests identify the actual script hashes.
The correction commit is discoverable by git log on this file and benchmark.mjs.

The earlier Document foundation copy failures remain original 59 pass / 1 fail
receipts on both variants. Its missing server.js was a disposable-copy omission.
The separate delivery integrity verifier checks every one of the 95 source-index
hashes against each exact original checkout; it does not alter or rerun either
failed test invocation.
