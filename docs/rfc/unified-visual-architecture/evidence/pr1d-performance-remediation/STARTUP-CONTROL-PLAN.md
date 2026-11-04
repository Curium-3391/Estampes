# Finite startup-timeout qualification control

Written after the first complete serial invocation exposed a startup timeout
in the unchanged `SIGKILL / after-intent-durable preserves one whole root and
at most one retry effect` case, before either control is executed.

No integrity assertion failure has been observed in that case: startup failed
before the post-recovery assertions could run. This does not establish their
correctness and does not prove an infrastructure root cause. The failure Store
was removed by the original fixture teardown; its original TAP/receipt remain.
The resource snapshot shows no cgroup OOM event and no extra live benchmark;
CPU/IO pressure files are unavailable. Root cause is UNKNOWN.

After complete discovery finishes, run that exact original case once against
the exact baseline source, once against candidate source, sequentially. Use
fresh owned tmpfs scratch, pinned Node, original profile/fixture/assertions,
original 30 s startup and 15 s stage limits, 180 s per control, no profiler.
`matrix.py fault-control` records both results even if one fails. No Store or
assertion is repaired and no timeout is changed.

If both controls pass and the complete run has no other failure category,
permit at most one complete serial rerun at the same 1,800 s resource budget.
The separately qualified G2 before-rename case stays excluded to avoid another
attempt. Preserve the first complete failure regardless of the rerun result.
If a supported integrity regression appears or validation cannot be completed,
revisit KEEP/REVERT rather than loosening a test or retrying without bound.
