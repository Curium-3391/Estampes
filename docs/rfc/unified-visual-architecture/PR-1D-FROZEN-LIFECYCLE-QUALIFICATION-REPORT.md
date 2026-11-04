# PR-1D Frozen Lifecycle Qualification

2026-11-04（Asia/Taipei）。**PR-1D ENGINEERING EXIT BLOCKED — FINITE GATES REMAIN。PRODUCTION NOT QUALIFIED。**

## 基準、環境與凍結矩陣

已 fetch 並核對 `Curium-3391/Estampes` 的 `codex/pr1d-g2-diagnostic-adjudication` 為 `82ae9081f6e60b4965d56138a8046d5831922e1d`，tree `a33f526d43a4802732177954ca47ae97d9f380a3`。從乾淨 checkout 建立 `codex/pr1d-frozen-lifecycle-qualification`。Production 祖先 `29d097833688ddb649a88cb2a09f22ba5fadda8e` 的 tree 為 `756ea491e27bce3a2998dc61ba1e3ee34525919c`。該祖先到診斷基準的 diff 全是架構文件、診斷工具和證據新增。開始前已核對 Git tree 與乾淨 checkout。逐檔 SHA-256 manifest 在 100-command 預檢進行期間產生，交付時再逐 byte 核對全部 **1,144** 個基準檔案，原 production、回歸斷言、報告和歷史證據均保留。[環境紀錄](evidence/pr1d-frozen-qualification/environment.log) · [Source SHA-256](evidence/pr1d-frozen-qualification/source-manifest.json)

Ubuntu 24.04.1 LTS、WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`、Node `v22.23.4`、`estampes` UID/GID 1001、util-linux `flock` 2.39.3。Checkout 與私有 scratch 同為 `/dev/sdd` ext4、8:48、`data=ordered`、statfs magic `0xef53`。原生 Store 在 scratch 以 0700 建立，使用真實 flock、file/directory fsync 與 SIGKILL。Guest 有 7.7 GiB RAM、約 7.0 GiB 可用 RAM、2.0 GiB swap、953 GiB ext4 可用空間。程序 RSS 監控門檻為 1.5 GiB，整個 descendant tree 為 3 GiB，guest RAM 與 ext4 保留底線分別為 2 GiB 和 48 GiB。Quota case 另檢查 C/D/E 的可用空間。全數 workload 依序執行，並行只用在 reader/lease 測試。30 秒 cold-client timeout 沿用原值。[固定矩陣及資源限制](evidence/pr1d-frozen-qualification/MATRIX.md) · [Filesystem trust model](PR-1D-FILESYSTEM-TRUST-MODEL.md)

矩陣以 [Final Architecture Gate §B R-03、§E、§H](FINAL-ARCHITECTURE-GATE.md)、[Storage Lifecycle](STORAGE-LIFECYCLE.md)、[Test Matrix UVA-46–50/59/60/63–66](TEST-MATRIX.md)、[Risk Register FG-01–04](RISK-REGISTER.md)、[Contracts §Phase 0.2](CONTRACTS.md) 為驗收來源。第一版先於 workload 提交為 `99e160d7a2d5fbedae781dec620f3834ecb5b2fe`。矩陣附錄在 Gate C/D 前補記 Windows backing 空間的停止條件，並釐清 32 MiB staging 限制只適用 maintenance batches。content 仍受 64 MiB Document 與 JSON 限制。[實作報告 §4–10](PR-1D-IMPLEMENTATION-REPORT.md) · [前次 Final Engineering Acceptance](PR-1D-FINAL-ENGINEERING-ACCEPTANCE-REPORT.md)

## 裁決表

| Gate | Verdict | 依據 |
| --- | --- | --- |
| Checkpoint / 1,000 commands | **NOT RUN** | 200-command admission preflight 在第 171 筆 ACK 後到達 1,500 s 上限，判 BLOCKED。 |
| 32 MiB 累積 delta 觸發 | **PASS** | 跨過真正 33,554,432-byte 閾值，選取 Full，驗證兩個 crash boundary 後的 authority、4/4 歷史和精確 ACK。 |
| Bounded maintenance drain | **PASS** | 小型 12-command workload 的 compact、G1/G2、crash、pins、backup、grace、rollback 和實體回收。高壓持續寫入 drain **NOT RUN**。 |
| Quota / capacity | **PASS** | 10 GiB 預設配額實體 allocation/admission、reserve、拒寫和恢復。完整 workload capacity matrix **NOT RUN**。 |
| Physical ENOSPC | **NOT RUN** | 缺核准的受限實體 filesystem，已另外通過 deterministic fault injection。 |
| Reader / backup pressure | **BLOCKED** | 64 sessions、1 GiB union 和小型備份控制通過。近 64 MiB Document cold timeout，16-version 完整壓力 **NOT RUN**。 |
| Native crash consistency | **BLOCKED** | Native persistence 182/182，原樣 G2 回歸另一次復現歷史的 `quarantining`。根因仍為 C。 |
| Regression preservation | **BLOCKED** | 既有 assertions 全保留，full serial 及歷史負向回歸有 raw failures，G2 是本輪再次觀察到的 in-scope 異常。 |
| Performance and memory | **BLOCKED** | 200 預檢 wall cap、近 64 MiB 超過 30 s cold-client。正式 p95/RSS 與固定 runner profile 為 **DECISION REQUIRED**。 |
| PR-1D Engineering Exit | **BLOCKED** | 長歷史、實體 ENOSPC、整體壓力、G2 與 measured profile 尚未完成。 |
| Production Qualification | **NOT RUN** | **PRODUCTION NOT QUALIFIED**。這次只涵蓋 WSL2 guest ext4 的獨立工程驗證。 |

## A · Checkpoint、長歷史與 32 MiB

- **100 筆預檢。** 接受 100 筆、selected generation 102 有 1 Full／99 Delta，100/100 logical hashes 和 Ledger ACK 核對通過，cold-client 18.435 s，最後一筆 ACK 精確重播。100 筆時 policy 為 `scheduled`、steps 0，預檢把 auto-maintenance 關閉以量測獨立寫入成本。監控器的舊 `du` 實作在 production 正 rename 暫存檔時因 ENOENT 退出 1。Node 子程序繼續到 `history-verified` 並清理 Store，數字 exit code 未能收錄。200 筆依實際完成的功能條件獲准。原監控錯誤及缺少 exit 的紀錄保留。後續採樣容許單次 concurrent rename 造成的 ENOENT。[100 筆 raw](evidence/pr1d-frozen-qualification/history-100.log) · [監控錯誤](evidence/pr1d-frozen-qualification/history-100-supervisor.log)
- **200 筆預檢。** 1,500.474 s 到達固定 wall cap，監控器 SIGKILL，子程序 exit -9，runner timeout exit 124。最後收到第 171 筆 durable ACK，cold startup 和全歷史核對尚未進入。原 Store 留在 scratch。**Revision 1,000 NOT RUN**，包括該 revision 的 full checkpoint、crash/recovery、verified alternate、後續 G1 thinning 與 pin/backup 釋放的完整證明。[200 筆 raw](evidence/pr1d-frozen-qualification/history-200.log) · [進階判定](evidence/pr1d-frozen-qualification/admit-1000.json)
- **32 MiB 累積 delta 觸發。** 閾值為 33,554,432 bytes 的 canonical lossless delta 累積量。既有鏈 25,167,184 bytes，下一個 patch 12,583,592 bytes，合計 37,750,776 bytes。四版使用有效 Document 和 12 MiB payload。第 4 版於 CURRENT rename 前 SIGKILL 保持舊 Root、Ledger 3。重開 ready 後同 request 在 CURRENT directory fsync 後 SIGKILL，所選 generation 6、Root `4753f178972453c1caea04dc60b8baf643ea00a31aa4420baee26ad4ef5a1dce`、Ledger 4。第 4 版是實際選取的 **12,583,774-byte full generation**，content hash `c5480e18dc19160867f1f71b2ba64e212e9804c73793aa8cff832014cc26f7d4`。[原始 crash 及 threshold](evidence/pr1d-frozen-qualification/archive-32mib.log) · [選取 Root 與 Locator](evidence/pr1d-frozen-qualification/archive-observation.log)
- 原 32 MiB 腳本在確認 Ledger cardinality 後以錯誤的 `requestId` 欄位查 Ledger，exit 1。以原 Store 補觀測，改用正式 normalized `commandId` 查既有條目，**沒有再執行兩個 crash 或提交另一份 workload**。補觀測 exit 0，驗證 4/4 歷史 hash、完整 full representation、cold client 22.111 s、原 ACK 精確重播及 Ledger 4。兩段總計 164.450 s，在原 300 s cap 內。判為 32 MiB 觸發及恢復 PASS，與 revision-1000 gate 分列。[執行 receipts](evidence/pr1d-frozen-qualification/runs.jsonl)

## B · 有界 drain 與 G2

12 筆 256 KiB payload 的完整歷史轉成可驗證的 Locator。13 次 compact 到 `idle`，約 43.468 s 的 compact call 時間。Reader pin 與備份同時存在時 G1 無可選候選，釋放 reader 後固定根備份仍獨立阻擋。備份三步完成，還原到獨立目錄，保持只讀並拒絕 GC。備份完成後，G1 選取 11 個冗餘 full。首個 quarantine rename 後 SIGKILL，冷重啟完成同一 plan，全部候選均從 source/quarantine 消失。候選 allocated blocks 合計 2,928,640 bytes，來源 Store 由 5,840,896 降至 3,108,864 bytes，淨回收 2,732,032 bytes。檔數 571→597，新增的 durable metadata 和實體回收分開計。[Drain raw](evidence/pr1d-frozen-qualification/maintenance-drain.log)

未發布 content 的恢復產生 G2 計畫，選取 29 個候選，共 19,806 content bytes。第一次隔離後與 clock rollback 後兩次均回 `waiting-grace`、0 deleted。時鐘到達選取 deadline `1793859733348`，high-water 同步，generation 46 已選 29 個 durable unlink intents，generation 47 完成 29/29。觀察到的 `quarantining` 均為步內持久化狀態。G2 淨 allocated bytes 增加，因這次小候選刪除與維護 metadata 一起計量，G1 提供淨實體回收證據。最終 generation 48 冷重啟，12/12 歷史逐 hash 重建、Ledger 及 ACK 保留、無 active GC plan。整體 286.199 s，三次 G2 step 約 43.35 / 48.30 / 19.44 s，包含只讀診斷採樣。小 workload 的 drain PASS。持續寫入的較高壓力矩陣仍未執行。[所選計畫／pins／fsync trace](evidence/pr1d-frozen-qualification/g2-trace.jsonl.gz)

**歷史 G2 仍為 C — UNRESOLVED INTERMITTENT。** 本輪有界 drain 無非預期 post-grace 回傳。完整原生 suite 的歷史 #131 通過，但 Gate F 的固定原樣 G2 子集又出現同一 `quarantining` 回傳。原測試 teardown 已清理失敗 Store，TAP 沒有選取的 plan、候選、保護或後續 cold step。症狀再次觀察到，根因仍無法分類。案例在固定回歸結束後停止，歷史 Gate B 保留 BLOCKED。[G2 Diagnostic Adjudication](PR-1D-G2-DIAGNOSTIC-ADJUDICATION.md) · [本輪原樣失敗](evidence/pr1d-frozen-qualification/g2-existing.log)

## C · Quota、backpressure 與 ENOSPC

128 MiB 原生控制 3/3。預設配額由格式讀回為 **10,737,418,240 bytes**，維護 workspace 33,554,432 bytes，recovery reserve 107,374,183 bytes。通過 guest/host 空間門檻後，單一私有 Store 內用 ext4 `posix_fallocate` 依序配置 9 GiB 和 10 GiB 減 120 MiB。實測第一階段仍可提交，另加 1 GiB backup reserve 時 production admission 拒絕。第二階段實測 Store allocated bytes 為 10,611,884,032，commit preflight 以 `STORAGE_UNAVAILABLE` 拒寫，約 76.45 ms，CURRENT、Ledger、Journal 清單、draft 和無關 sentinel 均保留。移除測試 extent 並 fsync 後，在 staging 注入 ENOSPC。錯誤保留原 Root、無可見新 effect。冷開後原 ACK 精確重播，原受阻 draft 成功一次，最終 Ledger 3。Quota admission 及注入 fault 的不變量通過。**實體 ENOSPC NOT RUN**，本輪的 guest ext4 保持可用空間，沒有核准的受限 ENOSPC 測試 volume。[128 MiB 控制](evidence/pr1d-frozen-qualification/quota-control.log) · [10 GiB 與 injected ENOSPC](evidence/pr1d-frozen-qualification/quota-10gib.log)

## D · Reader 與備份壓力

小型 native reader/backup controls 4/4，包括 active read quiescence、併發固定讀取、備份 SIGKILL 後恢復與只讀 restore。64 個 production Store sessions 共用 7,739 bytes 的 physical hash union，第 65 個回 `LIMIT`。64 個併發請求在新 commit 時仍各取得原版本，之後驗證 release、clock expiry 與 `STALE_CURSOR`。獨立 production `ReaderPins` 測試以 16 份不同的 64 MiB 檔案達到 **1,073,741,824 bytes**，共用一檔不增加 union，第 1 GiB＋1 byte 的 pin 回 `LIMIT`。實際 allocated bytes 1,073,745,920，17 sessions 都釋放。該 probe 使用真實檔案與 FD，涵蓋 bound 本身。完整 Document/backup 壓力需另行執行。[小型控制](evidence/pr1d-frozen-qualification/reader-control.log) · [64 sessions](evidence/pr1d-frozen-qualification/reader-64-sessions.log) · [1 GiB union](evidence/pr1d-frozen-qualification/reader-union.log)

大小預檢提交 **67,076,892-byte** Document，durable ACK 耗時 41.082 s，來源 67,260,416 allocated bytes。Cold client 達既有 30 秒期限，回 `RECOVERY_REQUIRED / Writer startup timed out`。整例 exit 1，最高單一程序 RSS 1,048,100 KiB，低於監控上限。原 Store 留在 scratch。備份未開始，16 個不同 64 MiB 版本與 sustained Document/backup 壓力均 **NOT RUN**。這是一筆實測 startup blocker，現有證據無法判定任何內容損毀。[近 64 MiB 預檢](evidence/pr1d-frozen-qualification/reader-size-preflight.log)

## E · 實測 performance 與 memory

| Workload | Commit p50 / p95 / max | Cold client | Peak RSS | 物理與驗證工作 |
| --- | --- | --- | --- | --- |
| 100 commands | 5.535 / 9.844 / 14.645 s | 18.435 s（1 sample） | worker 132,724 KiB | 6,164 files／28,356,608 allocated bytes。100 版逐 hash 驗證 28.373 s |
| 200 preflight，前 171 ACK | 8.907 / 15.391 / 20.786 s | NOT RUN | sampled worker HWM 134,584 KiB | supervisor 67,780,608 peak allocated bytes。1,500 s 停止 |
| 32 MiB delta crossing | 10.574 / 11.267 / 11.267 s（前三筆正常 ACK） | 17.081 / 22.111 s，分別為兩個 crash boundary 後 | supervisor 單 process peak 630,144 KiB | generation 6 時 125 files／42,536,960 allocated bytes，4/4 版本 |
| 12-command drain | 13 次 compact，約 43.468 s 合計 | final cold 4.566 s | supervisor 單 process peak 148,608 KiB | 11 G1／29 G2，含備份、故障、grace、採樣 286.199 s |

100 筆 worker 回報 77,502 次 content hash checks、57,701 次 physical fingerprint checks、348,350 metadata paths traversed、1,238,895 proof metadata bytes，cold committed verification 4.542 s。Peak RSS 以 `/proc`／supervisor 觀測。Worker heap／external 峰值沒有單獨採樣。100 筆 cold 比前次 14.19–15.08 s 長，仍低於固定 30 s。前次 8 MiB commit max 5.02–5.19 s、worker RSS 328–420 MiB，和本輪 12 MiB delta 邊界是不同 workload。兩組都保留為觀測。200 預檢耗盡本輪時間，且 p95 與最大提交時間隨 retained history 增加。已有資料無法建立可接受的 1,000-command scaling 或正式 p95／RSS 上限。最終 Gate §E 的三輪固定 runner、1k/10k/100k commands/day、1/16 readers、2 KiB/64 MiB delta、0/64 KiB ACK＋artifact 與併行備份實測仍有缺口。[先前 benchmark](PR-1D-FINAL-ENGINEERING-ACCEPTANCE-REPORT.md#gate-f--bounded-performancememory-與維護) · [本輪 100 筆](evidence/pr1d-frozen-qualification/history-100.log) · [本輪 200 預檢](evidence/pr1d-frozen-qualification/history-200.log)

## F · Regression preservation

| Raw regression | Exit | Pass / Fail / Skip |
| --- | ---: | ---: |
| [full-serial](evidence/pr1d-frozen-qualification/full-serial.log) | 1 | 502 / 1 / 16 |
| [native-persistence](evidence/pr1d-frozen-qualification/native-persistence.log) | 0 | 182 / 0 / 0 |
| [r1-h01](evidence/pr1d-frozen-qualification/r1-h01.log) | 0 | 4 / 0 / 0 |
| [r1-faults](evidence/pr1d-frozen-qualification/r1-faults.log) | 0 | 22 / 0 / 0 |
| [r2-storage](evidence/pr1d-frozen-qualification/r2-storage.log) | 0 | 14 / 0 / 0 |
| [r2-h03](evidence/pr1d-frozen-qualification/r2-h03.log) | 0 | 1 / 0 / 0 |
| [r2-cache](evidence/pr1d-frozen-qualification/r2-cache.log) | 0 | 8 / 0 / 0 |
| [r3-adversarial](evidence/pr1d-frozen-qualification/r3-adversarial.log) | 1 | 7 / 1 / 0 |
| [r3-controls](evidence/pr1d-frozen-qualification/r3-controls.log) | 1 | 4 / 1 / 0 |
| [publication-ruling](evidence/pr1d-frozen-qualification/publication-ruling.log) | 0 | 1 / 0 / 0 |
| [g2-existing](evidence/pr1d-frozen-qualification/g2-existing.log) | 1 | 1 / 1 / 0 |
| [lease-failures](evidence/pr1d-frozen-qualification/lease-failures.log) | 0 | 3 / 0 / 0 |
| [contracts](evidence/pr1d-frozen-qualification/contracts.log) | 0 | 22 / 0 / 0 |
| [cas-node-followup](evidence/pr1d-frozen-qualification/cas-node-followup.log) | 1 | 20 / 7 / 0 |
| [browser-cas](evidence/pr1d-frozen-qualification/browser-cas.log) | 0 | 3 / 0 / 0 |

- **完整 Node 22 serial。** 519 tests，502 pass、1 fail、16 skips。失敗為 ctime-only 的 `Missing expected rejection`。先前 native mode-only 對照證明 ext4 可能合併 timestamps，因此本輪保留原失敗，沒有把未測到的當次 ctime change 或 bytes 損毀寫成事實。Native serial 182/182，包含 ctime 與 G2 #131。[前次 ctime 對照](PR-1D-FINAL-ENGINEERING-ACCEPTANCE-REPORT.md#gate-c--cache-與-integrity)
- **原樣歷史回歸。** Round 1/2 全通過。Round 3 的 `before-ack` 舊 rollback 斷言仍失敗，已持久化 CURRENT 保留，client 無 ACK 且 writer fence。獨立 publication ruling 1/1 通過。舊 metadata alias 測試再次因現行內容驗證回 `INTEGRITY_ERROR`，其期待接受 alias 的舊斷言保留。原樣 G2 子集的 grace/rollback 通過，四次 interrupted recovery 案例再次在原斷言見到 `quarantining`。這項沒有已知 stale-oracle 裁決。
- **Lease、合約與架構。** 正常競爭 200/200、延遲 parent 20/20 均回 exit 73，CURRENT 和 inode 保留。Lease failure controls 3/3，contract tests 22/22，9 formal examples 零錯誤。Docs/release 通過。既有 architecture checker 在固定的 production archive 和獨立 Git index 通過，本分支另用 source manifest 及 diff 核對。[正常 lease](evidence/pr1d-frozen-qualification/lease-normal.log) · [延遲 lease](evidence/pr1d-frozen-qualification/lease-delay.log) · [Formal examples](evidence/pr1d-frozen-qualification/formal-examples.log) · [Architecture baseline](evidence/pr1d-frozen-qualification/architecture-baseline.log)
- **CAS 與 Chromium。** 鎖定的 SymPy/mpmath 已成功安裝在 scratch，第一次 dependency verification 因在 `--without-pip` venv 執行 `python -m pip` 而退出。系統 Python 缺 SymPy，造成 full serial 的 16 skips。改由系統 pip 驗證該 venv，Python CAS 17/17。Node 補跑 20 pass、7 fail，7 例都在 Chromium launch 收到 SIGTRAP。使用較短 scratch temp 路徑補跑唯一剩餘未成功的三個 CAS browser cases，3/3。16 個 skips 由分開的 13 + 3 pass 補齊，原始數字不覆蓋。經核對的 Chromium 141.0.7390.37 八個歷史 browser cases 均至少有一次通過。補跑的七筆 startup failures 原樣保留，短路徑的三個成功不能單獨證明七筆的原因。[CAS Python](evidence/pr1d-frozen-qualification/cas-python.log) · [Chromium runtime](evidence/pr1d-frozen-qualification/browser-setup.log) · [Coverage mapping](evidence/pr1d-frozen-qualification/regression-coverage.json)


## 未結案項目與交付

1. 在相同的 30 秒 cold-client 限制下取得完成的 200 和 1,000-command 證據，再驗證 revision-1000 checkpoint 的 crash/recovery、舊 full 的 reader/backup 保護與 verified thinning。現有 32 MiB anchor 證據只完成其中一個獨立 gate。
2. 補完實測的長歷史／maintenance throughput 與 1/16 reader、不同 64 MiB 歷史＋1 GiB 實際 Document/backup 壓力。取得限定裝置的實體 ENOSPC 及恢復證據。
3. 維持 G2 C。下一個有限的原生回歸應在原斷言前擷取所選 plan、re-mark 和 barrier trace，並讓同一失敗 Store 保留到一次同計畫的有界 step 和 cold restart。這是區分合法保護與 lifecycle defect 的缺證。
4. 維護者需核定經測量的 performance/RSS budgets、profile 和可用容量，並明列所有未核准平台。Production 另需目標 mount、OS／舊 binary fencing、writer isolation、Host 驗證、跨 Store/asset 和 restore continuation，以及 host/VM/block-device 掉電及 flush 驗證。

原始輸出、受限停止與 exits 收在 [runs.jsonl](evidence/pr1d-frozen-qualification/runs.jsonl)。完整 native evidence 及無損壓縮的 raw logs 由 [manifest](evidence/pr1d-frozen-qualification/manifest.json) 封存。需要保留的 Store 只留在私有 scratch `/home/estampes/estampes-pr1d-frozen.8S9L5lrb`，可從個別 log 定位。提交僅限診斷分支的 harness、報告與證據。
