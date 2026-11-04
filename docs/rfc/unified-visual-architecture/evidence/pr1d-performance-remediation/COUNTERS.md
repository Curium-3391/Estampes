# CPU, logical IO, JSON and memory counters

Instrumented runs only. Timers are inclusive and overlap. CPU is per operation; memory is operation-end, while HWM is per process. Read bytes are logical IO, not physical device traffic. Canonical bytes count repeated encoding.

| Case / operation | User / sys ms | lstat | FD stat | FD read / readFile bytes |
| --- | ---: | ---: | ---: | ---: |
| b-base-document-1-profile / commit | 815.2 / 120.8 | 1308 | 230 | 5277149 / 1060465 |
| b-base-document-1-profile / cold-client-open | 878.0 / 113.6 | 2456 | 428 | 6345193 / 1095420 |
| b-document-1-profile / commit | 577.7 / 140.2 | 1308 | 230 | 5277149 / 1060465 |
| b-document-1-profile / cold-client-open | 736.3 / 94.6 | 2456 | 428 | 6345193 / 1095420 |
| b-base-document-8-profile / commit | 4990.8 / 410.0 | 1308 | 230 | 41977309 / 8400497 |
| b-base-document-8-profile / cold-client-open | 7939.3 / 1323.9 | 2456 | 428 | 50385385 / 8435452 |
| b-document-8-profile / commit | 6985.1 / 894.3 | 1308 | 230 | 41977309 / 8400497 |
| b-document-8-profile / cold-client-open | 5734.9 / 650.9 | 2456 | 428 | 50385385 / 8435452 |
| b-base-document-16-profile / commit | 10482.4 / 1038.7 | 1308 | 230 | 83920353 / 16789106 |
| b-base-document-16-profile / cold-client-open | 10729.2 / 1232.1 | 2456 | 428 | 100717037 / 16824065 |
| b-document-16-profile / commit | 7861.6 / 873.7 | 1308 | 230 | 83920353 / 16789106 |
| b-document-16-profile / cold-client-open | 6789.5 / 801.8 | 2456 | 428 | 100717037 / 16824065 |
| b-base-document-32-profile / commit | 22938.0 / 2792.9 | 1323 | 232 | 167806433 / 67121602 |
| b-base-document-32-profile / cold-client-open | 17694.6 / 2136.4 | 2496 | 434 | 234935613 / 100711841 |
| b-document-32-profile / commit | 22313.9 / 3066.9 | 1323 | 232 | 167806433 / 67121602 |

| Case / operation | Guard calls / ms | Canonical calls / bytes | Schema parse calls / ms | Hash calls / bytes |
| --- | ---: | ---: | ---: | ---: |
| b-base-document-1-profile / commit | 312 / 479.2 | 256 / 12667904 | 197 / 343.9 | 316 / 16889627 |
| b-base-document-1-profile / cold-client-open | 516 / 425.9 | 453 / 9598609 | 308 / 329.5 | 530 / 12781115 |
| b-document-1-profile / commit | 307 / 387.2 | 256 / 12667904 | 197 / 271.3 | 316 / 16889627 |
| b-document-1-profile / cold-client-open | 512 / 300.3 | 453 / 9598609 | 308 / 230.8 | 530 / 12781115 |
| b-base-document-8-profile / commit | 312 / 3880.1 | 256 / 100748288 | 197 / 2657.7 | 326 / 134330139 |
| b-base-document-8-profile / cold-client-open | 516 / 6304.8 | 453 / 75658897 | 308 / 3862.2 | 542 / 100861499 |
| b-document-8-profile / commit | 307 / 5168.6 | 256 / 100748288 | 197 / 3064.1 | 326 / 134330139 |
| b-document-8-profile / cold-client-open | 512 / 3933.4 | 453 / 75658897 | 308 / 2437.9 | 542 / 100861499 |
| b-base-document-16-profile / commit | 312 / 8494.8 | 256 / 201411601 | 197 / 5976.3 | 336 / 268547885 |
| b-base-document-16-profile / cold-client-open | 516 / 8933.3 | 453 / 151156396 | 308 / 6816.1 | 554 / 201524820 |
| b-document-16-profile / commit | 307 / 6196.4 | 256 / 201411601 | 197 / 3865.0 | 336 / 268547885 |
| b-document-16-profile / cold-client-open | 512 / 5155.5 | 453 / 151156396 | 308 / 3150.6 | 554 / 201524820 |
| b-base-document-32-profile / commit | 322 / 18956.4 | 265 / 436295913 | 199 / 12894.9 | 364 / 604095929 |
| b-base-document-32-profile / cold-client-open | 535 / 14555.7 | 470 / 369266376 | 312 / 9433.0 | 602 / 570631464 |
| b-document-32-profile / commit | 317 / 18016.1 | 265 / 436295913 | 199 / 10833.6 | 364 / 604095929 |

| Case / operation | Heap used / total bytes | External / arrayBuffer bytes | Worker HWM KiB |
| --- | ---: | ---: | ---: |
| b-base-document-1-profile / commit | 32903632 / 61423616 | 8912836 / 6605629 | 99600 |
| b-base-document-1-profile / cold-client-open | 22903608 / 57458688 | 3470837 / 1163670 | 84272 |
| b-document-1-profile / commit | 32856288 / 61685760 | 8912636 / 6605429 | 99544 |
| b-document-1-profile / cold-client-open | 22867016 / 57458688 | 3470837 / 1163670 | 84680 |
| b-base-document-8-profile / commit | 113041672 / 142163968 | 36165628 / 33858421 | 315732 |
| b-base-document-8-profile / cold-client-open | 88697200 / 116973568 | 15238934 / 12931767 | 182964 |
| b-document-8-profile / commit | 54316472 / 83386368 | 36164828 / 33857621 | 324320 |
| b-document-8-profile / cold-client-open | 80294496 / 108314624 | 15238934 / 12931767 | 182604 |
| b-base-document-16-profile / commit | 138217104 / 167034880 | 52943648 / 50636441 | 432532 |
| b-base-document-16-profile / cold-client-open | 88943472 / 116678656 | 15240137 / 12932970 | 468384 |
| b-document-16-profile / commit | 103790488 / 133988352 | 52943648 / 50636441 | 383264 |
| b-document-16-profile / cold-client-open | 88853392 / 116416512 | 15240137 / 12932970 | 468352 |
| b-base-document-32-profile / commit | 154638112 / 183263232 | 86496646 / 84194073 | 572960 |
| b-base-document-32-profile / cold-client-open | 154976136 / 183001088 | 15237903 / 12935370 | 584436 |
| b-document-32-profile / commit | 221168968 / 250650624 | 86496646 / 84194073 | 827620 |

## Sampled retained allocation

The Inspector heap samples estimate retained allocation sites at stop, not cumulative allocation or transient memory peaks. Per-worker samples and CPU ranks (including explicit idle samples) remain in summary.json and compressed original profiles.

| Case | PID profile | Sampled retained bytes |
| --- | --- | ---: |
| a-history-25-profile | heap-2626.json.gz | 5251192 |
| a-history-25-profile | heap-2650.json.gz | 3152672 |
| a-history-25-profile | heap-2662.json.gz | 3153672 |
| b-base-document-1-profile | heap-3308.json.gz | 7343808 |
| b-base-document-1-profile | heap-3320.json.gz | 4194376 |
| b-base-document-1-profile | heap-3332.json.gz | 5243000 |
| b-base-document-16-profile | heap-3507.json.gz | 36701792 |
| b-base-document-16-profile | heap-3519.json.gz | 35651808 |
| b-base-document-16-profile | heap-3531.json.gz | 37752064 |
| b-base-document-32-profile | heap-3648.json.gz | 34603280 |
| b-base-document-32-profile | heap-3660.json.gz | 35654736 |
| b-base-document-32-profile | heap-3678.json.gz | 36705192 |
| b-base-document-8-profile | heap-3406.json.gz | 16777248 |
| b-base-document-8-profile | heap-3418.json.gz | 17826400 |
| b-base-document-8-profile | heap-3430.json.gz | 19925848 |
| b-document-1-profile | heap-3357.json.gz | 5243152 |
| b-document-1-profile | heap-3369.json.gz | 5243880 |
| b-document-1-profile | heap-3381.json.gz | 3156128 |
| b-document-16-profile | heap-3595.json.gz | 37748944 |
| b-document-16-profile | heap-3607.json.gz | 36701704 |
| b-document-16-profile | heap-3619.json.gz | 34603072 |
| b-document-32-profile | heap-3703.json.gz | 33554448 |
| b-document-32-profile | heap-3720.json.gz | 35661920 |
| b-document-8-profile | heap-3458.json.gz | 17825856 |
| b-document-8-profile | heap-3470.json.gz | 20975280 |
| b-document-8-profile | heap-3482.json.gz | 18874688 |
| baseline-history-25-profile | heap-2570.json.gz | 5246432 |
| baseline-history-25-profile | heap-2589.json.gz | 1048824 |
| baseline-history-25-profile | heap-2601.json.gz | 7355720 |
