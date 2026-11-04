# Measured results

All times seconds; tmpfs process-crash profile. P95 of a single document commit is not a distribution.

| Run | p50 / p95 / max | Commit total | Direct cold | Cold client | Peak process HWM KiB | Allocated warm bytes | Exit |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| document-1-plain | 0.587 / 0.587 / 0.587 | 0.587 | 0.540 | 0.696 | 89484 | 1187840 | 0 |
| document-1-profile | 0.539 / 0.539 / 0.539 | 0.539 | 0.519 | 0.806 | 99888 | 1187840 | 0 |
| document-16-plain | 7.902 / 7.902 / 7.902 | 7.902 | 6.182 | 6.138 | 459108 | 16916480 | 0 |
| document-16-profile | 7.253 / 7.253 / 7.253 | 7.253 | 5.342 | 5.668 | 467976 | 16916480 | 0 |
| document-32-plain | 15.873 / 15.873 / 15.873 | 15.873 | 12.919 | 12.947 | 731024 | 33693696 | 0 |
| document-32-profile | 16.046 / 16.046 / 16.046 | 16.046 | 13.349 | 13.143 | 804236 | 33693696 | 0 |
| document-8-plain | 3.752 / 3.752 / 3.752 | 3.752 | 2.912 | 2.728 | 313280 | 8527872 | 0 |
| document-8-profile | 3.873 / 3.873 / 3.873 | 3.873 | 2.825 | 3.076 | 324148 | 8527872 | 0 |
| history-100-plain | 1.235 / 2.614 / 2.951 | 129.052 | 7.936 | 4.756 | 140004 | 27316224 | 0 |
| history-100-profile | 1.369 / 3.158 / 3.622 | 158.207 | 5.886 | 4.219 | 120040 | 27992064 | 0 |
| history-150-plain | 1.948 / 3.563 / 4.684 | 281.013 | 6.869 | 7.096 | 117580 | 52146176 | 0 |
| history-150-profile | 2.107 / 3.910 / 4.532 | 307.559 | 8.320 | 7.524 | 121840 | 52076544 | 0 |
| history-25-plain | 0.310 / 0.552 / 0.564 | 8.550 | 1.354 | 1.362 | 94208 | 3252224 | 0 |
| history-25-profile | 0.362 / 0.978 / 1.146 | 12.280 | 1.706 | 1.726 | 99868 | 3305472 | 0 |
| history-50-plain | 0.732 / 1.154 / 1.490 | 34.308 | 2.222 | 2.170 | 107588 | 8826880 | 0 |
| history-50-profile | 0.831 / 1.366 / 1.494 | 38.246 | 2.252 | 3.111 | 115384 | 9228288 | 0 |
| phase-document-8 | 4.412 / 4.412 / 4.412 | 4.412 | 3.023 | 2.847 | 325276 | 8527872 | 0 |
| phase-history-25 | 0.381 / 0.775 / 0.816 | 10.670 | 1.448 | 1.424 | 104696 | 3338240 | 0 |

## Plain phase totals

| Run | Build/preflight | Stage/prepare | Candidate/history | CURRENT incl. rehash | Post-publish incl. final rehash |
| --- | ---: | ---: | ---: | ---: | ---: |
| document-1-plain | 0.170 | 0.039 | 0.219 | 0.017 | 0.020 |
| document-16-plain | 2.648 | 0.061 | 3.333 | 0.034 | 0.078 |
| document-32-plain | 5.029 | 0.080 | 7.201 | 0.045 | 0.099 |
| document-8-plain | 1.382 | 0.043 | 1.349 | 0.025 | 0.039 |
| history-100-plain | 23.401 | 8.039 | 56.656 | 19.310 | 21.493 |
| history-150-plain | 55.186 | 15.448 | 121.685 | 41.654 | 46.814 |
| history-25-plain | 1.450 | 0.967 | 3.469 | 1.128 | 1.490 |
| history-50-plain | 5.731 | 2.816 | 14.567 | 5.200 | 5.906 |

## Profile overhead observations

Run order/environment and profiler work are confounded in single pairs. No causal overhead estimate or SLA.

| Pair | Commit total ratio profile/plain | Cold client ratio |
| --- | ---: | ---: |
| document-1 | 0.919 | 1.159 |
| document-16 | 0.918 | 0.923 |
| document-32 | 1.011 | 1.015 |
| document-8 | 1.032 | 1.127 |
| history-100 | 1.226 | 0.887 |
| history-150 | 1.094 | 1.060 |
| history-25 | 1.436 | 1.268 |
| history-50 | 1.115 | 1.434 |

## Last content commit counters (profile)

| History | lstat | FD stat | FD sync | Digest calls | SHA updates / bytes | Canonical calls / bytes | Schema parse calls | Proof metadata paths (cumulative) |
| ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
| 25 | 12896 | 2572 | 220 | 950 | 4146 / 1439834 | 3436 / 994327 | 1118 | 6150 |
| 50 | 24388 | 4772 | 335 | 1783 | 10171 / 2881591 | 8835 / 2009365 | 1969 | 45425 |
| 100 | 48284 | 9074 | 520 | 3419 | 27192 / 5966484 | 24630 / 4241216 | 3597 | 348350 |
| 150 | 69559 | 12596 | 655 | 4817 | 47935 / 9180949 | 44353 / 6614125 | 4881 | 1158775 |

## Focused phase leaf counters and process CPU

Approximate stage markers; nested method durations overlap. Memory is sampled at phase end.

| Run / operation / phase | Wall ms | User / system ms | lstat | Read bytes | SHA bytes | Canonical bytes | Heap / external bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| phase-history-25 / PID 6300 / open-0 / cold-before-recovery-publish | 855.2 | 792.0 / 239.6 | 9925 | 591118 | 1250708 | 1156888 | 21218832 / 2490540 |
| phase-history-25 / PID 6300 / open-0 / build-preflight | 161.0 | 153.7 / 33.4 | 2388 | 92349 | 305470 | 417074 | 23134880 / 2567524 |
| phase-history-25 / PID 6300 / open-0 / stage-prepare | 41.9 | 27.4 / 12.3 | 614 | 15689 | 31851 | 12582 | 17646984 / 2399924 |
| phase-history-25 / PID 6300 / open-0 / candidate-verification | 235.3 | 188.1 / 59.8 | 5285 | 322391 | 694263 | 535686 | 19965856 / 2493166 |
| phase-history-25 / PID 6300 / open-0 / current-publication | 51.0 | 39.7 / 15.3 | 2034 | 155087 | 155087 | 0 | 24442328 / 2687324 |
| phase-history-25 / PID 6300 / open-0 / post-publication | 102.3 | 82.3 / 30.6 | 2343 | 179727 | 204456 | 1473 | 18400664 / 2707556 |
| phase-history-25 / PID 6312 / open-0 / cold-before-recovery-publish | 740.4 | 694.1 / 210.6 | 10013 | 602312 | 1266150 | 1171181 | 18073424 / 2409965 |
| phase-history-25 / PID 6312 / open-0 / build-preflight | 107.6 | 156.4 / 9.8 | 2400 | 93107 | 309911 | 422315 | 21293488 / 2600749 |
| phase-history-25 / PID 6312 / open-0 / stage-prepare | 36.0 | 32.9 / 6.8 | 632 | 16477 | 32128 | 12771 | 22524688 / 2609509 |
| phase-history-25 / PID 6312 / open-0 / candidate-verification | 190.9 | 185.8 / 51.3 | 5345 | 326017 | 702444 | 542054 | 19322264 / 2488420 |
| phase-history-25 / PID 6312 / open-0 / current-publication | 62.3 | 27.0 / 36.4 | 2058 | 156900 | 156900 | 0 | 24070272 / 2692031 |
| phase-history-25 / PID 6312 / open-0 / post-publication | 116.0 | 74.5 / 49.7 | 2375 | 181628 | 206445 | 1473 | 24983520 / 2735550 |
| phase-history-25 / PID 6288 / open-0 / cold-before-recovery-publish | 20.5 | 16.1 / 4.2 | 20 | 0 | 307 | 687 | 14254752 / 4733745 |
| phase-history-25 / PID 6288 / open-0 / build-preflight | 9.6 | 10.1 / 0.6 | 9 | 0 | 6594 | 10332 | 15505880 / 4736585 |
| phase-history-25 / PID 6288 / open-0 / stage-prepare | 53.1 | 48.6 / 12.1 | 143 | 0 | 5627 | 9343 | 14044024 / 2359029 |
| phase-history-25 / PID 6288 / open-0 / candidate-verification | 67.3 | 58.7 / 5.6 | 236 | 6051 | 13211 | 10553 | 17491712 / 2436880 |
| phase-history-25 / PID 6288 / open-0 / current-publication | 13.5 | 12.9 / 0.0 | 88 | 2993 | 2993 | 0 | 18420536 / 2470273 |
| phase-history-25 / PID 6288 / open-0 / post-publication | 19.6 | 15.7 / 5.1 | 197 | 6211 | 9518 | 1469 | 14194040 / 2363366 |
| phase-history-25 / PID 6288 / commit-25 / admission | 0.4 | 0.4 / 0.0 | 0 | 0 | 1190 | 1190 | 34317872 / 3990376 |
| phase-history-25 / PID 6288 / commit-25 / build-preflight | 113.0 | 72.5 / 30.5 | 2284 | 88719 | 314037 | 423721 | 33440608 / 4039133 |
| phase-history-25 / PID 6288 / commit-25 / stage-prepare | 95.4 | 53.6 / 30.8 | 498 | 425 | 36338 | 30717 | 30963400 / 3908925 |
| phase-history-25 / PID 6288 / commit-25 / candidate-verification | 440.2 | 206.3 / 176.5 | 5683 | 350513 | 725063 | 538433 | 42671152 / 4451341 |
| phase-history-25 / PID 6288 / commit-25 / current-publication | 71.6 | 30.5 / 36.7 | 2026 | 153602 | 153602 | 0 | 33429648 / 4020373 |
| phase-history-25 / PID 6288 / commit-25 / post-publication | 92.9 | 37.3 / 48.4 | 2382 | 181333 | 209153 | 1473 | 40580296 / 4353855 |
| phase-document-8 / PID 6347 / open-0 / cold-before-recovery-publish | 1663.4 | 1412.9 / 289.7 | 751 | 25196246 | 50392075 | 41998511 | 102571728 / 23431164 |
| phase-document-8 / PID 6347 / open-0 / build-preflight | 22.7 | 16.4 / 12.4 | 251 | 6447 | 23716 | 35269 | 106145344 / 23515643 |
| phase-document-8 / PID 6347 / open-0 / stage-prepare | 37.3 | 31.9 / 9.1 | 200 | 1309 | 7589 | 8227 | 110106128 / 23612544 |
| phase-document-8 / PID 6347 / open-0 / candidate-verification | 1258.8 | 1088.6 / 215.3 | 473 | 16798109 | 33603176 | 33593999 | 74704032 / 6601468 |
| phase-document-8 / PID 6347 / open-0 / current-publication | 15.3 | 10.8 / 4.2 | 186 | 8398942 | 8398942 | 0 | 76498696 / 10867658 |
| phase-document-8 / PID 6347 / open-0 / post-publication | 25.0 | 16.8 / 12.2 | 311 | 8403672 | 8408491 | 1469 | 79541216 / 15179378 |
| phase-document-8 / PID 6335 / open-0 / cold-before-recovery-publish | 27.3 | 19.6 / 7.2 | 20 | 0 | 307 | 687 | 14256560 / 4733745 |
| phase-document-8 / PID 6335 / open-0 / build-preflight | 13.0 | 15.6 / 0.4 | 9 | 0 | 6594 | 10332 | 15542336 / 4736585 |
| phase-document-8 / PID 6335 / open-0 / stage-prepare | 58.0 | 52.3 / 13.4 | 143 | 0 | 5627 | 9343 | 14114256 / 2360029 |
| phase-document-8 / PID 6335 / open-0 / candidate-verification | 49.0 | 24.5 / 18.5 | 236 | 6051 | 13211 | 10553 | 17565856 / 2437880 |
| phase-document-8 / PID 6335 / open-0 / current-publication | 11.8 | 13.0 / 0.1 | 88 | 2993 | 2993 | 0 | 18494760 / 2471273 |
| phase-document-8 / PID 6335 / open-0 / post-publication | 13.0 | 10.6 / 4.0 | 197 | 6211 | 9518 | 1469 | 14234160 / 2366229 |
| phase-document-8 / PID 6335 / commit-1 / admission | 790.3 | 580.7 / 236.4 | 0 | 0 | 8389823 | 16778433 | 80642568 / 2399570 |
| phase-document-8 / PID 6335 / commit-1 / build-preflight | 1539.7 | 1255.1 / 297.4 | 157 | 2554 | 33577948 | 41976243 | 175925240 / 19229603 |
| phase-document-8 / PID 6335 / commit-1 / stage-prepare | 81.6 | 57.6 / 36.6 | 225 | 425 | 8400042 | 13053 | 181061536 / 19362012 |
| phase-document-8 / PID 6335 / commit-1 / candidate-verification | 1659.3 | 1396.1 / 321.8 | 444 | 25184446 | 50375741 | 41979090 | 58059640 / 23398903 |
| phase-document-8 / PID 6335 / commit-1 / current-publication | 25.5 | 14.2 / 9.1 | 162 | 8397133 | 8397133 | 0 | 59644776 / 27655484 |
| phase-document-8 / PID 6335 / commit-1 / post-publication | 50.4 | 30.2 / 16.7 | 320 | 16793248 | 25189452 | 1469 | 62752624 / 36164828 |
| phase-document-8 / PID 6359 / open-0 / cold-before-recovery-publish | 1468.9 | 1402.8 / 135.2 | 891 | 25203895 | 50404777 | 42009901 | 103724120 / 23493332 |
| phase-document-8 / PID 6359 / open-0 / build-preflight | 24.4 | 24.5 / 4.6 | 287 | 7530 | 26312 | 38948 | 107728520 / 23596486 |
| phase-document-8 / PID 6359 / open-0 / stage-prepare | 32.9 | 19.3 / 12.3 | 200 | 1309 | 7733 | 8227 | 98529168 / 19155317 |
| phase-document-8 / PID 6359 / open-0 / candidate-verification | 1116.8 | 1084.4 / 79.1 | 533 | 16801727 | 33611338 | 33600352 | 66715064 / 6641702 |
| phase-document-8 / PID 6359 / open-0 / current-publication | 15.3 | 8.5 / 7.5 | 210 | 8400751 | 8400751 | 0 | 68757680 / 10917501 |
| phase-document-8 / PID 6359 / open-0 / post-publication | 18.1 | 27.3 / 3.9 | 335 | 8405625 | 8410588 | 1469 | 72082648 / 15238974 |
| phase-document-8 / PID 6359 / commit-1 / admission | 563.5 | 555.5 / 32.0 | 0 | 0 | 8389823 | 16778433 | 114700760 / 2392018 |
