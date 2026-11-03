# PR-1D Final Engineering Acceptance

2026-11-04（Asia/Taipei）。**ENGINEERING BLOCKED — FINITE REMEDIATION REQUIRED**。**PRODUCTION NOT QUALIFIED**。

## 精確基準與環境

- 已 fetch 並以 `git ls-remote` 驗證 `origin/fix/unified-visual-architecture-pr1d-state-machine-hardening` 的 HEAD 為 **`29d097833688ddb649a88cb2a09f22ba5fadda8e`**，source tree **`756ea491e27bce3a2998dc61ba1e3ee34525919c`**。遠端 Round 3 驗收基準為 **`31dae29f1cf7d1e8caf6c670124eed7c7ed91e11`**。六個直接祖先依序為 `a9d01db`、`b76de73`、`3c5f0e8`、`d33d2dd`、`df82b22`、`29d0978`。初始工作樹乾淨，驗收分支為 `codex/pr1d-final-engineering-acceptance`。
- 與 Round 3 比對，hardening 只變更八個 persistence modules、三個授權測試/fixture、限定的 checker 與新文件/證據。既有測試和歷史證據逐 byte 保留。對指定基準的 1,046 個檔案逐一比對 Git blob 並記錄 SHA-256。[環境及 ancestry](evidence/pr1d-final-acceptance/env.log) · [Source manifest](evidence/pr1d-final-acceptance/source-manifest.json)
- Ubuntu 24.04.1 LTS、WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`、Node `v22.23.4`、npm 10.9.9、`estampes` UID/GID 1001/1001、`/usr/bin/flock` 2.39.3。Checkout 與新建 0700 scratch 同在 `/dev/sdd` ext4、major:minor 8:48、statfs magic `0xef53`。Findmnt/mountinfo 記錄 `rw,relatime,discard,errors=remount-ro,data=ordered`，容量約 953 GiB 可用。所有 Store／backup／restore／fault injection 位於自建 disposable 目錄，runner 清除繼承的 `ESTAMPES_*`。既有使用者資料與 deployment 未使用。
- 瀏覽器使用重新取得的 Chromium 141.0.7390.37，驗證 executable SHA-256、`--version` 和實際 `ldd`。需要的 Ubuntu library 套件只解壓至 scratch。Python CAS 使用 scratch venv 與 lockfile。沿用現有 Node 依賴，package 與 lockfile 保持原樣。[Browser runtime](evidence/pr1d-final-acceptance/browser-runtime.log)

## 凍結契約與信任模型

覆核 [Final Architecture Gate](FINAL-ARCHITECTURE-GATE.md)、[Storage Lifecycle](STORAGE-LIFECYCLE.md)、[Contracts](CONTRACTS.md)、[Test Matrix](TEST-MATRIX.md)、[Risk Register](RISK-REGISTER.md)、[Filesystem Trust Model](PR-1D-FILESYSTEM-TRUST-MODEL.md)、[State Machine Hardening](PR-1D-STATE-MACHINE-HARDENING-REPORT.md)、[Round 3](PR-1D-NATIVE-REACCEPTANCE-ROUND3-REPORT.md) 與 [Integrity Hardening](PR-1D-INTEGRITY-HARDENING-REPORT.md)，並重用原始 Round 1/2/3 entrypoints。

支援邊界為單一 authorized writer、同一把 lifetime OS lease、合作 client、私有 managed tree、受信任 writer UID 及 code/module/config 供應鏈，以及 approved native Linux profile。仍須驗證普通損毀、缺檔、I/O 故障與連續 process crash。GC 由所選 Root 內的 plan 控制，維持 live roots/pins/backup 與 G2 grace，並以已選 unlink intent 解釋重啟後的缺檔。檔案 metadata 是變更提示，內容 SHA-256 及長度用來驗證資料，eviction 或 restart 會清除先前 trust。

另一個非合作同 UID 程序在最後驗證後任意寫檔、root/admin、被破壞的 kernel/硬體、完整替換 authority chain 都超出邊界。支援模型仍須拒絕已被檢查偵測到的損毀。Unix mode 與 flock 無法排除同 UID 程序；正式部署需隔離 writer UID、執行環境、ACL/capability、掛載及非合作程序。此處的 fsync／rename／SIGKILL 是 guest 檔案系統與 process-crash 證據，WSL/Windows/VHDX/host/實體裝置的掉電仍需另案。

## 原架構 Gate 與本輪 threshold

| 要求 | 本輪證據 | 已有架構門檻 |
| --- | --- | --- |
| UVA-46–50、59、63 的交易、retention、recovery 與 native barriers | 原始與新 permanent tests，另在 ext4 上轉換 fixture profile 後重跑 | 以當前六-root authority、Ledger、GC 語意判讀，保留故障與原始斷言 |
| UVA-60、63–65 的 operational checkpoint、歷史／容量、maintenance throughput、pin／backup 壓力 | bounded 25/50/100 與 8 MiB，既有較小容量/維護/讀者功能測試 | `1000 commands / 32 MiB` checkpoint 與 verified thinning、maintenance drain、quota/reader/backup 實測仍是 PR-1D exit／release/writer 要求 |
| UVA-66／OD-01 的 production profile | guest ext4 native profile、OS lease、file/dir fsync 與 process-crash 覆蓋 | 指定部署 mount、OS fence、profile 實測後核准；PR-7A 另外涉及 outer VM 或 block fault，後續啟用與 PR-1B 另有授權 |

凍結的 bounded 測試可以裁決 isolated correctness。即使其通過，仍不能替代原 PR-1D exit 所需的 checkpoint/recovery、capacity、維護 drain 和已核准 profile。Final Architecture Gate §B R-03 把 PR-1D 的故障及容量證據列為 PR-1B 前置；§E 要求固定 runner 實測並由 maintainer 核定 profile。README 把 UVA-64–66 列為 release/writer 前必要 gate，並保留完整容量/效能為 PR-1D exit 條件。若要把這些移至另一次 qualification，需 maintainer 另行明示 gate 的定義；本報告沒有更動原要求。[原架構 Gate](FINAL-ARCHITECTURE-GATE.md) · [PR-1D exit 記錄](README.md)

## Gate D — Publication 與 ACK 裁決

[STORAGE-LIFECYCLE](STORAGE-LIFECYCLE.md) 定義 CURRENT rename 為 logical selection point，CURRENT parent directory fsync 成功才跨過 durable publication barrier。Prepared Root／intent 可證準備，選取的 envelope 才是唯一權威。ACK 保證該 commit 與其 exact Ledger 結果已跨過必要 file/dir barriers 和最後內容檢查。發布後錯誤要 fence 並回 `RECOVERY_REQUIRED`，不得回 ACK，也不得恢復舊 CURRENT。 [filesystem.js](../../../src/persistence/filesystem.js#L108) · [coordinator.js](../../../src/persistence/coordinator.js#L207)

獨立 native 測試在 `before-ack` 觸發 EIO，未改檔或模擬其他 writer。原 generation 1 前進到 durable generation 2，Ledger 0→1，client 得到 `RECOVERY_REQUIRED`／EIO 且無 ACK，writer 進唯讀。重啟後 generation 3 以 generation 2 為 parent，Ledger 仍只有一個 effect，同 request 回原 commit/result 的 durable ACK 且 `replayed=true`。三個 envelope、hash、錯誤及 ACK 全部保留。[原生 EIO 裁決測試](evidence/pr1d-final-acceptance/publication-ruling.log)

Round 3 的未修改 `before-ack` adversarial case 先確認無 ACK、fence 與冷讀拒絕，再要求 CURRENT 等於發布前 Root、Ledger 不增加。後兩項與架構衝突，因該 fault 已發生於 durable CURRENT 之後。保留該 raw fail 為負面證據及 stale assertion，正常 release oracle 應採用選取 Root 不回滾。若 fault 在 `current.before-rename`、發布之前就偵測到，舊 CURRENT 與 Ledger 不變仍是正確的 oracle。沒有以新測試覆蓋或修改舊測試。[未修改 Round 3 suite](evidence/pr1d-final-acceptance/r3-adversarial.log)

## Gate A — Native Crash 與 Transaction

原始 H-01 四個案例、22 個 Round 1 原生 faults、Round 2 儲存矩陣、原生平台與發布裁決均執行。正常 authorized client 串列化、真實 lifetime flock、fsync/rename 順序、coherent CommitRoot／Registry／Locator、完整／delta 歷史、Ledger exact replay／payload mismatch、拒絕 forged 或不明 transaction、缺失或損毀 committed dependency 都有執行證據。兩種起始點的永久測試均通過五個合法 CURRENT claims 的建立與讀回、四次連續 recovery SIGKILL、冷重啟、原請求精確重播與 mismatch 斷言。在 `current.before-rename` 起始變體，失敗發生於其後的 G2 drain，見 Gate B。沒有觀察到重複 Ledger effects 或 rollback。[Round 1 原始 H-01](evidence/pr1d-final-acceptance/r1-h01.log) · [原生 faults](evidence/pr1d-final-acceptance/r1-faults.log) · [原生 persistence](evidence/pr1d-final-acceptance/native-persistence.log)

真實 ext4 第二 writer 普通競爭 200 次及 20 ms 延遲 20 次，220 次均維持 `STORAGE_UNAVAILABLE:73`，其中 23 次實際 EPIPE 都有相同的 exit 73；CURRENT bytes、lock inode 及首 writer 不變。Backend／transport／writer release 控制另行通過。[Lease 事件](evidence/pr1d-final-acceptance/lease-events.jsonl)

## Gate B — GC 與 Lifecycle

Round 2 warm missing-quarantine 等原反例、Round 3 正常 repeated planning、G1/G2 active object ownership、quarantine/intent/unlink crash matrix、G2 24h clock/grace、pins、live Roots、備份 dependencies、合法 pathname reuse 與安全唯讀 restore 均執行。重新定位的備份含 active GC plan，能讀原邏輯歷史，拒絕 commit 和 GC，未取得來源檔案刪除權。受控 `gc.before-unlink` replacement 會保留替代 inode（包含同內容），writer fence。[Round 2 storage](evidence/pr1d-final-acceptance/r2-storage.log) · [Round 3 原始矩陣](evidence/pr1d-final-acceptance/r3-adversarial.log) · [原生 persistence](evidence/pr1d-final-acceptance/native-persistence.log)

**Gate B 未簽核。** Native suite 的 `R3-B1 / four interrupted recovery epochs ... current.before-rename` 在合法單 writer、初始未發布、四次 recovery SIGKILL、成功提交與精確 retry 後，G2 在虛擬 24h 到期的 `gcStep` 回 **`quarantining`**，原斷言要求 **`complete`**。原樣單一案例重跑 1/1；另做四次同序列有診斷的 native 重現，均為 12/12 候選已刪、無剩餘項目、writer ready 與單一 Ledger effect。四次診斷未重現首次失敗。首次輸出沒有該 plan 的 remaining candidates 與保護來源，故無法證明是合法 live-root 延後或真實 drain defect。原始 native fail 保留為**未解除的 in-scope 驗收失敗**。未觀察到未授權刪除、ACK 複製或 rollback，未把它定性為已證實的新 High integrity defect。[原始 native #131](evidence/pr1d-final-acceptance/native-persistence.log) · [原樣單例重跑](evidence/pr1d-final-acceptance/g2-original-retest.log) · [四次有界診斷](evidence/pr1d-final-acceptance/g2-diagnostic.log)

## Gate C — Cache 與 Integrity

R2-H03 原始 native worker 在讀取後改寫的 marker 實際命中，拒 ACK、保留 CURRENT、warm/cold 均拒損毀。Round 2 cache 八例、永久 FD／same-inode／inode replacement、forced metadata alias、同長度改寫、shared invalidation、4 MiB budget／eviction/reverification、重新啟動後空 cache 與歷史重建均執行。

Round 3 未修改 metadata 測試在實際發生 fingerprint collision 後預期舊 `proofFingerprint()` 會接受，現行 digest 比對以 `INTEGRITY_ERROR` 拒絕，所以 raw log 保留一筆失敗。這是舊負面重現的期望，現行內容驗證符合凍結契約。受控 before-rename／before-ACK 檢查也拒絕可見改寫。最後檢查之後另一個同 UID 程序任意改寫仍為未支援風險，本輪未嘗試宣稱有排除此風險的保證。[R2-H03](evidence/pr1d-final-acceptance/r2-h03.log) · [原始 cache](evidence/pr1d-final-acceptance/r2-cache.log) · [Round 3 metadata 原始結果](evidence/pr1d-final-acceptance/r3-controls.log)

未修改的舊 `ctime` case 在完整 suite 與原始 persistence 各失敗一次，錯誤為 Missing expected rejection；原樣單例重跑通過。該 case 以安全的 `chmod(0400)` 模擬 ctime 改變，沒有寫入內容。獨立 native 對照 64 次，37 次 mode 已變但完整 fingerprint 相同且 bytes/SHA-256 未變，內容 proof 安全成立；27 次 fingerprint 真變動均拒絕舊 proof。原兩次缺少逐次 stat，timestamp coalescing 與結果一致，不能回填原次數據。最新 hardening 的真 bytes 改寫和 forced metadata alias 測試通過。保留原始失敗，證據未顯示 invalid content 被接受。[舊測試重跑](evidence/pr1d-final-acceptance/ctime-retest.log) · [64 次 mode-only 對照](evidence/pr1d-final-acceptance/ctime-diagnostic.log)

## Gate E — 完整 Regression 與 Native Durability

| 執行 | Exit | Pass / Fail / Skip |
| --- | ---: | --- |
| [完整 Node 22 serial](evidence/pr1d-final-acceptance/full-serial.log) | 1 | **517 / 2 / 0**，Chromium finding-list 與舊 ctime-only |
| [真實 Chromium 全套內結果](evidence/pr1d-final-acceptance/browser-results.json) | 同上 | **7 / 1 / 0**，原始 finding-list 另行重跑 **1 / 0 / 0** |
| [原始 persistence](evidence/pr1d-final-acceptance/original-persistence.log) | 1 | **182 / 1 / 0**，舊 ctime-only |
| [Native durable persistence 副本](evidence/pr1d-final-acceptance/native-persistence.log) | 1 | **181 / 1 / 0**，四次 recovery 後 G2 drain |
| [平台](evidence/pr1d-final-acceptance/platform.log) | 0 | **7 / 0 / 0**，native durable ACK、restart/replay 實際執行 |
| [原始 Round 1 H-01](evidence/pr1d-final-acceptance/r1-h01.log) | 0 | **4 / 0 / 0** |
| [原始 Round 1 fault matrix，含 H-02](evidence/pr1d-final-acceptance/r1-faults.log) | 0 | **22 / 0 / 0** |
| [原始 Round 2 storage](evidence/pr1d-final-acceptance/r2-storage.log) | 0 | **14 / 0 / 0** |
| [原始 Round 2 H-03](evidence/pr1d-final-acceptance/r2-h03.log)／[cache](evidence/pr1d-final-acceptance/r2-cache.log) | 0 / 0 | **1 / 0 / 0**、**8 / 0 / 0** |
| [原始 Round 3 adversarial](evidence/pr1d-final-acceptance/r3-adversarial.log) | 1 | **7 / 1 / 0**，舊 post-publication rollback 斷言 |
| [原始 Round 3 metadata／backup／proof](evidence/pr1d-final-acceptance/r3-controls.log) | 1 | **4 / 1 / 0**，舊 metadata alias 接受斷言 |
| [Hardening standalone probes](evidence/pr1d-final-acceptance/hardening-standalone.log) | 0 | **2 / 0 / 0**，只改 scratch 副本的絕對 import path |
| [原生 EIO ACK 裁決](evidence/pr1d-final-acceptance/publication-ruling.log) | 0 | **1 / 0 / 0** |
| [Lease 正常競爭](evidence/pr1d-final-acceptance/lease-normal.log)／[延遲](evidence/pr1d-final-acceptance/lease-delay.log)／[故障](evidence/pr1d-final-acceptance/lease-failures.log) | 0 / 0 / 0 | 220 次 contention 正確、故障 **3 / 0 / 0** |
| [Contract](evidence/pr1d-final-acceptance/contracts.log)／[Formal examples](evidence/pr1d-final-acceptance/examples.log)／[CAS](evidence/pr1d-final-acceptance/cas.log) | 0 / 0 / 0 | **22 / 0 / 0**、**9** examples 零錯誤、**17 / 0 / 0** |
| [Architecture consistency](evidence/pr1d-final-acceptance/architecture-clean.log)／[release](evidence/pr1d-final-acceptance/release.log)／[source seal](evidence/pr1d-final-acceptance/initial-source.log) | 0 / 0 / 0 | 原有 checker 在 exact Git archive、獨立 index 跑通；全 source tree bytes 保留 |

Native 副本使用未變動的 production source，只轉換 fixture 的 profile、Document persistence 與配對 ACK 語意，雙 profile 迴圈在 native 副本只執行一次。最新兩份永久 suite 都在原始與 native harness 執行。[Native fixture/test hashes](evidence/pr1d-final-acceptance/native-harness.json)

完整 serial 的 finding-list 啟動真實 Chromium，DOM 結果 marker 為 undefined，沒有回報 UI probe 的 `failed` 訊息。原樣單獨重跑通過。測試程式使用 fixed virtual-time budget，證據支持間歇 browser harness 結果，未證實 UI 或 storage 功能出錯，也未把原 suite 改列綠燈。其他 Chromium 案例在完整 suite 通過。各 invocation 使用 serial test concurrency，未跑 default parallel suite。[原樣 browser retest](evidence/pr1d-final-acceptance/browser-finding-retest.log)

## Gate F — Bounded Performance、Memory 與維護

在完整／persistence／native 與 standalone suites 都退出後依序跑，沿用 Round 3 的 native ext4 workload，除輸出檔名標籤外未變更 benchmark。8 MiB 各四次提交，首輪和重跑分列。25/50/100 歷史固定 `autoMaintenance=false`，8 MiB 沿用 `autoMaintenance=true`。每輪新建獨立 Store，不清除 kernel page cache。Direct probe 使用真 flock 與空的 JS cache，合法推進一次 recovery epoch；client 隨後以新 process 和原 30 秒 timeout 再開。File count/allocated blocks 為首個 writer 結束前採樣，peak VmHWM 取 worker。兩次測量仍不足以核定 production latency/RSS profile。

| Workload | Commit p50 / p95 / max / total (s) | Worker peak RSS (KiB) | Files / allocated bytes | Direct recovery / committed verify (s) | Client cold / 30s 裕度 (s) |
| --- | --- | ---: | --- | --- | --- |
| [8 MiB 首輪](evidence/pr1d-final-acceptance/metrics-8mib.json) | 5.100 / 5.187 / 5.187 / 20.064 | 336,124 | 98 / 8,876,032 | 9.602 / 7.302 | 9.625 / 20.375 (ready) |
| [8 MiB 重跑](evidence/pr1d-final-acceptance/metrics-8mib-repeat.json) | 4.890 / 5.023 / 5.023 / 19.390 | 429,812 | 98 / 8,876,032 | 10.771 / 8.219 | 10.203 / 19.797 (ready) |
| [25 筆](evidence/pr1d-final-acceptance/metrics-history-25.json) | 1.379 / 2.466 / 2.851 / 37.440 | 114,904 | 767 / 3,469,312 | 4.220 / 1.050 | 4.222 / 25.778 (ready) |
| [50 筆](evidence/pr1d-final-acceptance/metrics-history-50.json) | 2.696 / 4.576 / 8.885 / 139.369 | 128,276 | 2,003 / 9,039,872 | 7.764 / 2.015 | 8.075 / 21.925 (ready) |
| [100 筆首輪](evidence/pr1d-final-acceptance/metrics-history-100.json) | 4.687 / 8.520 / 15.332 / 470.327 | 133,028 | 6,288 / 28,844,032 | 14.912 / 3.654 | 15.076 / 14.924 (ready) |
| [100 筆重跑](evidence/pr1d-final-acceptance/metrics-history-100-repeat.json) | 4.728 / 8.007 / 17.118 / 457.342 | 137,148 | 5,984 / 27,488,256 | 14.535 / 3.685 | 14.192 / 15.808 (ready) |

| Workload | Verified versions / exact replay | Warm proof bytes / shared fingerprints | Warm hits / misses / evictions | Cold direct content hashes / delta applies | Maintenance |
| --- | --- | --- | --- | --- | --- |
| 8 MiB 首輪 | 4/4 / yes | 8,995 / 16 | 10 / 4 / 0 | 133 / 4 | idle, 0 steps |
| 8 MiB 重跑 | 4/4 / yes | 8,995 / 16 | 10 / 4 / 0 | 131 / 4 | idle, 0 steps |
| 25 筆 | 25/25 / yes | 110,295 / 100 | 325 / 25 / 0 | 701 / 24 | idle, 0 steps |
| 50 筆 | 50/50 / yes | 353,370 / 200 | 1,275 / 50 / 0 | 1369 / 49 | idle, 0 steps |
| 100 筆首輪 | 100/100 / yes | 1,238,895 / 400 | 5,050 / 100 / 0 | 2586 / 99 | scheduled, 0 steps |
| 100 筆重跑 | 100/100 / yes | 1,238,895 / 400 | 5,050 / 100 / 0 | 2581 / 99 | scheduled, 0 steps |

兩輪 100 筆都符合 30 秒既有 client deadline，觀察到的最小裕度 14.924 秒；各自完成全部歷史 hash 重建及精確 Ledger ACK 重播。8 MiB 最慢 5.187／5.023 秒，peak RSS 約 328.2／419.7 MiB。100 筆最慢 commit 15.332／17.118 秒。這些差異列入預算審查，現有契約沒有核准 p95 或 RSS 上限，不能宣稱已通過未定義的預算。4 MiB proof accounting 上限兩輪均未觸及，與整體 RSS 分開。100 筆只排入維護，沒有執行 drain。基於 native G2 原始失敗與既有 scope gate，量測停在 100，未跑 200 或 revision-1000。

## Engineering Complete 與 Production Qualified

**Engineering Complete — NO。ENGINEERING BLOCKED — FINITE REMEDIATION REQUIRED。** Normal transaction/recovery 核心和兩輪 bounded startup/replay 結果已有正向證據。Native durable harness 的 G2 completion failure 在允許的操作下發生，單一重跑和四次有診斷重跑未重現，仍缺足以裁決該次 quarantine 進度的證據。完整原始 suite 也不是全綠。不能把已排除的最後檢查後同 UID 威脅，或與架構矛盾的 rollback 斷言，列為這個正常 G2 項目的解釋。

**Production Qualified — NO。** Native 結果限同一 guest ext4、受信任 writer UID 與 disposable Document Store。正式部署仍須指定 target mount、OS/舊 binary fencing、專用 writer 與 module/config isolation、Host 驗證、跨 Store 與 binary assets、migration/restore continuation、長歷史與 checkpoint、容量／讀者／備份壓力、maintenance drain、VM/block-device/Windows/VHDX/host 與實體裝置 power-loss／flush 測試。沒有把較小的 WSL2 functional evidence 解讀為這些資格或 PR-1B 的授權。

## 有界後續

1. 針對唯一未解除的 native G2 completion case，保留初始失敗，補記該次 selected plan 的 moved/deleted indexes、pending paths、live/recovery Root 或 pin/backup 引用及後續 step 結果。若可證合法延後，驗證同一 plan 在保護解除後有界完成；若進度錯誤，只修正該狀態轉換，再跑同一 native matrix。
2. 保留 Chromium 與 ctime 的原始測試結果。未來調整 fixture 時，先確認 DOM marker 有實際產生，以及 chmod 對照是否真的改變 ctime；舊 Round 3 rollback／metadata 反例仍保留原始歷史。此輪不修測試。
3. 完整 PR-1D exit 仍需 operational checkpoint/recovery、capacity、maintenance drain 與實測後批准的 profile。若 maintainer 擬將 isolated Engineering Complete 與這些既有 exit 要求重新切分，需明示核准新定義。這一輪的 bounded 結果不能作為批准紀錄。

## 證據與交付

本機分支 `codex/pr1d-final-engineering-acceptance`。測試與工具 commit 為 `25b2f9b62e716c1b2deb699cf7dd6ae70c3d6687`，其 parent 為上述 source baseline。報告與證據另行提交。Source code、既有測試及舊報告/證據均逐 byte 核對。Docs、syntax、release 與 whitespace checks 均記錄。重跑須從 checkout 建立新的 owned 0700 ext4 scratch 與 `tmp`，複製 [run.py](evidence/pr1d-final-acceptance/run.py) 到 scratch 後，以 UID 1001 使用同 Node 22 執行。新輸出名稱保護舊 logs。Benchmark 序列見 [performance.sh](evidence/pr1d-final-acceptance/performance.sh)。

[逐次 argv、時間、exit、TAP counts、raw SHA-256](evidence/pr1d-final-acceptance/runs.jsonl) · [證據 SHA-256 manifest](evidence/pr1d-final-acceptance/manifest.json) · [Source SHA-256](evidence/pr1d-final-acceptance/source-manifest.json)。包含行尾空白的原始輸出以 lossless gzip 保存，對應 `.log` 只去除行尾空白，兩份 hash 均可驗證。
