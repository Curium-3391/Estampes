# Measurements

All timings are tmpfs process-crash observations. Inclusive counters overlap; profiles are separate from plain latency. First exploratory pair and interrupted pre-resume pair are excluded. Missing terminal receipts are not passes.

| Case | Commit total s | Last commit s | Cold client s | Process HWM KiB | Exit / excluded |
| --- | ---: | ---: | ---: | ---: | --- |
| a-history-25-1 | 26.293 | 0.956 | 2.6999302179999978 | 96700 | 0 / True |
| a-history-25-2 | 23.456 | 1.357 | 3.353633523999997 | 96708 | 0 / False |
| a-history-25-3 | 29.806 | 2.054 | 4.008430740999996 | 91160 | 0 / False |
| a-history-25-profile | 29.210 | 2.096 | 4.510384448999997 | 103188 | 0 / False |
| a-history-50-1 | 66.692 | 2.097 | 3.697370828999992 | unknown | missing / True |
| b-base-document-1-1 | 0.910 | 0.910 | 1.3299323320000003 | 89548 | 0 / False |
| b-base-document-1-profile | 0.988 | 0.988 | 1.1775936150000001 | 91668 | 0 / False |
| b-base-document-16-1 | 12.644 | 12.644 | 8.950301060000001 | 514928 | 0 / False |
| b-base-document-16-profile | 11.947 | 11.947 | 12.192501034000001 | 468384 | 0 / False |
| b-base-document-32-1 | 29.593 | 29.593 | 26.742197861 | 727552 | 0 / False |
| b-base-document-32-profile | 26.651 | 26.651 | 19.74035286700001 | 605176 | 0 / False |
| b-base-document-8-1 | 7.232 | 7.232 | 7.481948363000002 | 304764 | 0 / False |
| b-base-document-8-2 | 5.205 | 5.205 | 4.106645158000001 | 304340 | 0 / False |
| b-base-document-8-profile | 5.557 | 5.557 | 9.992050676000002 | 315732 | 0 / False |
| b-document-1-1 | 1.268 | 1.268 | 1.4577152129999995 | 90212 | 0 / False |
| b-document-1-profile | 0.754 | 0.754 | 0.9894431220000002 | 99544 | 0 / False |
| b-document-16-1 | 11.930 | 11.930 | 9.601230946 | 518900 | 0 / False |
| b-document-16-profile | 9.305 | 9.305 | 7.752937721999999 | 468352 | 0 / False |
| b-document-32-1 | 20.452 | 20.452 | 17.501657137000002 | 919604 | 0 / False |
| b-document-32-bounded-retest | 21.362 | 21.362 | 28.958340681999996 | 871424 | 0 / False |
| b-document-32-profile | 25.983 | 25.983 | incomplete | 827924 | 1 / False |
| b-document-8-1 | 8.017 | 8.017 | 5.179344896000001 | 356228 | 0 / False |
| b-document-8-2 | 9.650 | 9.650 | 3.7918621170000004 | 313296 | 0 / False |
| b-document-8-profile | 8.463 | 8.463 | 7.1394487029999985 | 324320 | 0 / False |
| baseline-history-25-1 | 20.502 | 2.162 | 4.637593778000002 | 94584 | 0 / True |
| baseline-history-25-2 | 42.988 | 3.019 | 6.721848922999998 | 92780 | 0 / False |
| baseline-history-25-3 | 27.575 | 2.056 | 2.587656181999999 | 93100 | 0 / False |
| baseline-history-25-profile | 34.973 | 2.472 | 2.9013482580000054 | 104740 | 0 / False |
| baseline-history-50-1 | 86.887 | 2.137 | 3.350227037999997 | 106392 | 0 / True |
