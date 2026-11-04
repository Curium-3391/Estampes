# Plain latency and memory

Process peak spans parent, warm worker, direct probe, cold worker and exact ACK replay. It is not startup-only RSS. Worker HWM at ready is sampled before replay.

| Case | Commit s | Cold client s | Warm worker HWM KiB | Cold worker HWM at ready KiB | Peak process KiB | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| b-base-document-1-1 | 0.910 | 1.330 | 89548 | 77752 | 89548 | 0 |
| b-base-document-16-1 | 12.644 | 8.950 | 419180 | 412024 | 514928 | 0 |
| b-base-document-32-1 | 29.593 | 26.742 | 727552 | 629572 | 727552 | 0 |
| b-base-document-8-1 | 7.232 | 7.482 | 304764 | 167768 | 304764 | 0 |
| b-base-document-8-2 | 5.205 | 4.107 | 304340 | 174844 | 304340 | 0 |
| b-document-1-1 | 1.268 | 1.458 | 90212 | 78512 | 90212 | 0 |
| b-document-16-1 | 11.930 | 9.601 | 372948 | 413052 | 518900 | 0 |
| b-document-32-1 | 20.452 | 17.502 | 697816 | 597392 | 919604 | 0 |
| b-document-32-bounded-retest | 21.362 | 28.958 | 696688 | 511392 | 871424 | 0 |
| b-document-8-1 | 8.017 | 5.179 | 356108 | 180612 | 356228 | 0 |
| b-document-8-2 | 9.650 | 3.792 | 313000 | 189156 | 313296 | 0 |
| baseline-history-25-1 | 20.502 | 4.638 | 94620 | 64304 | 94584 | 0 |
| baseline-history-25-2 | 42.988 | 6.722 | 92520 | 65960 | 92780 | 0 |
| baseline-history-25-3 | 27.575 | 2.588 | 93100 | 67064 | 93100 | 0 |
| baseline-history-50-1 | 86.887 | 3.350 | 106392 | 81204 | 106392 | 0 |
