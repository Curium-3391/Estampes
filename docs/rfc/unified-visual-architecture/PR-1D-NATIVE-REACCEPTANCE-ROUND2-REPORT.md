# PR-1D Native Reacceptance Round 2

2026-11-03（Asia/Taipei）。**Defect Reacceptance BLOCKED。PR-1D Overall BLOCKED。** 原始 H-01 四個變體與 H-02 兩個失敗變體在 WSL2/ext4 轉綠，M-02 原生 OS lease 測試通過。新增反例仍證實 H-01 可接受偽造的歷史發布證據，H-02 在同一 writer 生命週期可把缺檔記為已刪除，另有跨兩個基準重現的 warm cache 驗證競態。

## 基準與環境

- Repository `Curium-3391/Estampes`，遠端 `refs/heads/fix/unified-visual-architecture-pr1d-native-findings`。先以 `git ls-remote --exit-code origin <ref>` 核對，再以 `git fetch --no-tags origin <ref>:<remote-tracking-ref>` 取回，兩者均 Exit 0 且得到 **`88d892829c7fada3ebbf5db8a2bcdf8c42975c47`**。第一個短暫 askpass 腳本因檔案開啟中回 Exit 128，關閉腳本 FD 後重試成功。驗證分支 `codex/pr1d-native-reacceptance-round2` 由指定 SHA 建立。六個指定提交逐一驗證 ancestor，完整 parent SHA 見 [source-audit.log](evidence/pr1d-native-round2/source-audit.log)。
- Ubuntu 24.04.1 LTS、`6.6.87.2-microsoft-standard-WSL2`、x86_64、`estampes` UID/GID 1001/1001、Node v22.23.4、npm 10.9.9、真實 `/usr/bin/flock` 2.39.3。Checkout 和測試目錄都在 `/dev/sdd` ext4，major:minor 8:48，statfs magic `0xef53`、fsid `be1d78fd15e717c5`。Mount options 為 `rw,relatime,discard,errors=remount-ro,data=ordered`。起始可用空間 953 GiB、可用 inode 67,034,734。原始 `findmnt`、mountinfo 與 device identity 見 [environment.log](evidence/pr1d-native-round2/environment.log)。
- 所有 Store、備份與還原測試位於本輪 0700 scratch 下的自建 disposable 目錄。清理依各 fixture 保留的路徑，先關閉或 SIGKILL 並等待相應 writer，遞迴清理不追蹤 harness 內的 source 與依賴 symlink。Runner 清除繼承的 `ESTAMPES_*`，以空 storage/access key 與 retention 0 啟動。故障注入只改本輪 fixture 的檔案或測試程序，包含真 SIGKILL、FileHandle partial write、受控 EIO／ENOSPC／EXDEV、內容破壞與只推進測試時鐘的 24 小時 grace。
- 現有 npm 依賴可執行，沿用 lockfile 與已裝 Playwright Core 1.56.1、pdfjs-dist 4.10.38、@napi-rs/canvas 1.1.0。本輪重新下載 **Chromium 141.0.7390.37**，驗證實際執行檔、`ldd` 無缺項及 SHA，並設定 `CHROME_BIN` 和 `CHROMIUM_BIN`。Ubuntu 的 NSS、NSPR 與 ALSA .deb 只解壓至 scratch。CAS 以 scratch venv 安裝鎖定 Python 依賴。見 [Chromium runtime](evidence/pr1d-native-round2/browser-runtime.log)、[binary and package hashes](evidence/pr1d-native-round2/browser-hash.log)。
- 已比對上一輪 BLOCKED 報告、native findings remediation、原 PR-1D remediation、Storage Lifecycle、Test Matrix 和 Risk Register。生產程式、既有測試、package/lock 與歷史報告和證據均以 Git 差異檢查保留，273 個基準檔案另逐 byte 與 SHA-256 驗證。見 [source-manifest.json](evidence/pr1d-native-round2/source-manifest.json)。

## Gate A、B、C

| Gate | 原始 regression | Round 2 判定 |
| --- | --- | --- |
| H-01 | 原封不動的兩種 profile × 有無後續 content commit，4/4、零跳過 | **BLOCKED**。合法 supersession、三次 reopen、原 commit/result ACK replay、同 request key 異 payload 的 `IDEMPOTENCY_MISMATCH` 與 CURRENT claim cleanup SIGKILL 可復原。缺失或單獨損毀的 prepared 證據會進 read-only。聯合偽造反例仍可進 ready。 |
| H-02 | 原封不動的 before-quarantine、after-rename 兩個紅案例均轉綠，after-unlink 亦通過 | **BLOCKED**。已驗證 owner 不重建、24h 前保留、重啟後繼續清理；冷啟動會拒絕 corrupt plan、tampered quarantine 和缺少 unlink intent 的 missing quarantine。同一 writer 的遺失反例仍可發布 complete。 |
| M-02 | 真 flock 無延遲 200 次，父程序延遲 20 ms 另 20 次 | **PASS**。220/220 回 `STORAGE_UNAVAILABLE` 且 exit 73；22 次真 startup send EPIPE 均與 exit 73 對應。競爭期間原 writer ready，CURRENT bytes 與 lock inode 不變。 |

H-02 的原始 22-case 矩陣包含真 SIGKILL 於 claim/staged barrier、ACK 前、startup classification 與歷史讀取、partial write、已知 corrupted/unknown/conflicting ownership，以及歷史 Locator/generation 替換。新增測試以 `after-publication-durable` 精確停於 GC plan、unlink intent、terminal progress，以 `gc.after-quarantine` 停在 unlink intent 之前，讀取實際 committed progress 區分各 phase。終止前後的測試時鐘驗證 24h 邊界，並用兩次 reopen、反覆 gcPlan/gcStep 及 Document backup 驗證內容仍可讀。原生 pin 案例驗證 GC 保護 pinned full generation，釋放後替代表示仍按原邏輯 hash 重建。見 [unchanged H-01](evidence/pr1d-native-round2/unchanged-h01.log)、[unchanged fault matrix](evidence/pr1d-native-round2/unchanged-fault-matrix.log)、[supplemental storage](evidence/pr1d-native-round2/supplemental-storage-v3.log)。

M-02 補測涵蓋 writer SIGKILL 後取得同一 inode 的 lease、限定 fixture 的不存在 backend（ENOENT / `UNSUPPORTED_STORAGE`）、已 spawn 的 EIO transport event（`RECOVERY_REQUIRED`）、startup send callback EIO 且 child 未退出（約 30.004 s timeout、fail closed）。來源 timeout 仍為 30,000 ms。真 flock 在執行 writer 之前取得 OS lock，worker 另驗證持有 lease。Review 發現 parent 接受匹配 id 的 IPC value 時沒有獨立驗證 response shape。該 channel 只連本機 child，本輪沒有向實際 worker 注入 malformed response，亦無兩個 writer 獲得同一 authority 的證據。見 [normal contention](evidence/pr1d-native-round2/lease-contention-results.json)、[delayed contention](evidence/pr1d-native-round2/lease-delayed-parent-results.json)、[transport and release](evidence/pr1d-native-round2/lease-failures.log)、[raw IPC events](evidence/pr1d-native-round2/lease-events.jsonl)。

## Gate D 與獨立 findings

原生 inode replacement 與同 inode 的 mtime/ctime 改動強制重新讀取舊版，加上新版本各增一次 reconstruction。改變 size、歷史 generation、Locator 或 Registry bytes 的案例在 ACK 前拒絕並保留 CURRENT。冷 cache 重建三版並保持每版 logical hash。1,400-byte test budget 中，兩次載入累計 version reconstructions 從 7 升至 14、evictions 從 10 升至 21，驗證 eviction 導致實際重新驗證。224 個 ext4 physical paths 的壓力案例在預設 4 MiB budget 內觀察到 4,193,826 帳面 bytes、224 shared fingerprints、148 proofs、77 次 eviction；更換共用 dependency 使相依 proofs 失效，重新登記後剩 1 proof、1 fingerprint 和 583 帳面 bytes。這些 bytes 是實作對 metadata 的計帳。Map、陣列、物件與 GC overhead 由 runtime 配置，總 process memory 另見 RSS/profile。見 [cache integrity results](evidence/pr1d-native-round2/cache-integrity-final.log)。

### R2-H01 High — 未發布 Root 可成為歷史 CURRENT 證據

[`temporary-attribution.js` 74–84](../../../src/persistence/temporary-attribution.js#L74) 驗證 prepared Root 的 hash、generation、commit ID、Registry root 和由該 Root 重算的 envelope。相同 CommitIndex 欄位可以出現在另一個從未選取的 Root，prepared 和 claim 自洽仍不足以證明發布。

最小重現為 CURRENT 目錄 fsync 後 SIGKILL，正常 reopen 讓 recovery epoch 取代 CURRENT。保留所選 CURRENT、原 durable intent、CommitIndex、Ledger 與 outcome，只更換舊 Root 的 parent hash，另寫新的 content-addressed Root，讓 prepared 指向該 Root，並重算 claim hash/length。再 reopen 得 `ready`、claim outcome `completed`。缺失或單獨損壞 prepared 的兩個控制案例均進 read-only。沒有觀察到新 Root 取代當前 authority 或捏造 Ledger entry。建議以已選 root 所信任的歷史 publication identity 或原 durable staged Root/intent 證據核對 exact root/hash/store namespace，並保留證據直到 claim 的終結狀態。見 [fault harness](evidence/pr1d-native-round2/storage-faults.mjs) 與 [raw result](evidence/pr1d-native-round2/supplemental-storage-v3.log)。

### R2-H02 High — Warm G2 把事先遺失的隔離檔記為已完成

[`gc.js` 101–107、117–133](../../../src/persistence/gc.js#L101) 在 move 前可把兩處皆缺的 candidate 直接記入 deleted；在已記錄 moved 的路徑，會先發布新的 unlink intent，再把當時已缺的 quarantine 當成刪除成功。相對地，cold `verifyCandidateLocation` 會要求已存在的 unlinking/deleted proof。

最小重現為 G2 成功 quarantine 且等待 grace，確認 selected record 無 `unlinking`。在同一 writer 執行期間刪除一個 attributed quarantine fixture，推進測試時鐘至 24h，再 gcStep。結果為 `complete` 且 writer `ready`。同樣破壞後先冷啟動的對照會進 read-only。執行中的 re-mark 仍檢查 live-set、pins 與備份來源，該反例的遺失物是 disposable orphan，未觀察 committed Document 遺失。建議以舊 committed progress 驗證位置和 digest，再發布新 unlink intent，僅讓已存在的 exact intent 解釋重啟後缺檔。見 [raw result](evidence/pr1d-native-round2/supplemental-storage-v3.log)。

### R2-H03 High — 讀取與 fingerprint 間替換可發出不實 durable ACK

[`records.js` 36–44、120–131](../../../src/persistence/records.js#L36) 以稍後的 pathname stat 為先前已驗證 bytes 建立 proof。在受控注入下，新指紋指向破壞後的 bytes，warm cache 仍使用先前的驗證結果。獨立的純 loader 測試顯示 warm load 通過而 cold load 回 `INTEGRITY_ERROR`。

真 worker 重現先提交 A，再以 mtime/ctime 改動強制 A 重新讀取，接著提交獨立的 B。One-shot preload 在讀完 A 的 canonical generation JSON、fingerprint 擷取之前，把 A 的檔案改成 `{}`。Writer 發出 B 的 **durable ACK** 並將 CURRENT 從 generation 3 推進到 4；冷 load 和重啟分別回 `INTEGRITY_ERROR`、`read-only-recovery`。同一 harness 在 `05913e926aa07a528815a5f3f3d2078c108e8833` 也重現，故此競態早於本輪去重修復。控制版本在第一個 raw bytes read 後改檔，第二次 JSON read 可偵測，該次確實在 ACK 前拒絕。本反例的條件為驗證期間發生外部改寫，沒有雙 writer 或物理介質故障的證據。建議讀取與指紋使用同一已驗證的 file identity，確認讀取前後 fingerprint 一致且 pathname 仍對應該 inode，變更時丟棄 proof 並拒絕 candidate。見 [warm/cold result](evidence/pr1d-native-round2/cache-integrity-final.log)、[worker ACK](evidence/pr1d-native-round2/cache-ack-race-v2.log)、[prior-commit control](evidence/pr1d-native-round2/cache-ack-race-prior.log)。

## Gate E — 完整測試與契約

| 實際執行 | Exit | Pass / Fail / Skip |
| --- | ---: | --- |
| [原始完整 Node 22 serial](evidence/pr1d-native-round2/full-node22-serial.log) | 0 | **457 / 0 / 0** |
| [完整套件中的實際 Chromium 案例](evidence/pr1d-native-round2/browser-results.json) | 0 | **8 / 0 / 0** |
| [原始 persistence 九個 suite](evidence/pr1d-native-round2/persistence-original.log) | 0 | **121 / 0 / 0** |
| [Disposable native durable harness](evidence/pr1d-native-round2/persistence-native.log) | 0 | **120 / 0 / 0** |
| [原生 platform suite](evidence/pr1d-native-round2/native-platform.log) | 0 | **7 / 0 / 0**，durable profile 正向 assertion 實際執行 |
| [未修改原始 H-01](evidence/pr1d-native-round2/unchanged-h01.log) | 0 | **4 / 0 / 0** |
| [未修改原始 native fault matrix](evidence/pr1d-native-round2/unchanged-fault-matrix.log) | 0 | **22 / 0 / 0**，含原 H-02 兩個失敗變體 |
| [Round 2 H-01/H-02](evidence/pr1d-native-round2/supplemental-storage-v3.log) | 1 | **12 / 2 / 0**，兩個新完整性反例 |
| [Lease 200 正常／20 延遲](evidence/pr1d-native-round2/lease-200.log) | 0 / 0 | **220 / 0 / 0** 次競爭 |
| [Lease transport、backend、release](evidence/pr1d-native-round2/lease-failures.log) | 0 | **3 / 0 / 0** |
| [Cache budget、eviction、tamper、pin](evidence/pr1d-native-round2/cache-integrity-final.log) | 1 | **7 / 1 / 0**，warm proof race |
| [原生 worker cache ACK race](evidence/pr1d-native-round2/cache-ack-race-v2.log) | 1 | **0 / 1 / 0**，先前 SHA 另以同一 harness 重現 |
| [Contract validation](evidence/pr1d-native-round2/contracts.log) | 0 | **22 / 0 / 0** |
| [Formal examples](evidence/pr1d-native-round2/formal-examples.log) | 0 | **9** examples、7 schemas、零錯誤 |
| [CAS Python](evidence/pr1d-native-round2/cas-python.log) | 0 | **17 / 0 / 0** |
| [Docs](evidence/pr1d-native-round2/docs-final.log)、[release](evidence/pr1d-native-round2/release.log)、[architecture](evidence/pr1d-native-round2/post-test-architecture.log)、[sealed inputs](evidence/pr1d-native-round2/sealed-inputs.log) | 0 / 0 / 0 / 0 | 檢查均通過 |
| [Git whitespace](evidence/pr1d-native-round2/staged-whitespace.log)、[syntax](evidence/pr1d-native-round2/syntax.log) | 0 / 0 | 檢查均通過 |

Chromium 覆蓋 info cards、finding-list、layers、兩個 surface-open、upload、Workbench 和 zoom。使用 repository 的 fake Host 與 MCP bridge。完整 suite 與 persistence 的每次 Node invocation 都使用 serial test concurrency，未執行預設 parallel suite。測試期間有其他獨立 invocation，同時執行的結果未用來量測效能。Native durable 副本只轉換 profile、fixture durability 與 ACK 語意，合併原本的雙 profile 迴圈，既有 suite 檔案不變。原生正向案例執行 durable ACK、重啟與精確 replay 的 assertion。Unsupported filesystem 負向案例在 ext4 提早返回，這部分未驗證其他 mount 類型。驗證腳本與 12 組 source/transformed SHA 在 [native harness](evidence/pr1d-native-round2/native-harness.json)。

早期 Round 2 嘗試及失敗仍保留。第一版 storage observer 誤以為所有 stage 都會送 IPC，且以所有後續 GC plan 都應為空作為斷言。修正後從真 trace 找到目標 unlink occurrence，並區分新 journal 候選與舊 temporary ownership。一次 H-01 cleanup 早期重跑出現 30 s startup timeout，當次缺少 OS/IPC 資料，後續實際命中 barrier 的三次 reopen 均完成。Cache 壓力初版使用的 192 個 paths 未達 4 MiB eviction threshold，增至 224 路徑後觸發。詳細迭代和各次結果見 [runs.jsonl](evidence/pr1d-native-round2/runs.jsonl)。

## Gate F — 效能與冷重啟

所有量測以 `linux-local-durable` 在同一個 WSL2 ext4 mount 執行，完整測試與故障 harness 結束後才開始。8 MiB 兩輪各四筆，同樣是第一筆帶 8 MiB extension、後續只更新 title/revision。歷史量測沿用原 25/50/100 workload，每組新建 Store，關閉 writer 後以新 process 重啟。OS page cache 沒有清除；直接 flock probe 和 IPC client restart 各自建立新的 in-memory cache，且先行 probe 會發布 recovery epoch。以下為單次實測，分開看 profiler 開關與前一輪不同環境，不能推算 SLA 或跨環境加速比。

| 8 MiB workload | Commit p50 / p95 / max | Worker peak RSS | 實體檔案 / allocated bytes | 歷史重建 |
| --- | --- | ---: | ---: | --- |
| [無 profiler](evidence/pr1d-native-round2/metrics-8mib.json) | 10.20 / 10.98 / 10.98 s | 582,832 KiB（569.2 MiB） | 98 / 8,876,032 | 4/4 |
| [CPU + heap profiler](evidence/pr1d-native-round2/metrics-profile8.json) | 10.83 / 10.90 / 10.90 s | 547,676 KiB（534.8 MiB） | 98 / 8,876,032 | 4/4 |

兩輪均為一個 full anchor 加三個 deltas。無 profiler 的最後一筆內部 build/preflight 4.02 s，candidate verification 5.67 s，CURRENT publication 約 12 ms。Warm cache 報 7,715 proof metadata bytes、16 fingerprints、0 eviction、4 version misses/reconstructions 與 14 version hits。獨立冷 closure 加逐版本重建 20.86 s。

CPU 樣本 self time 集中在 `visit`（18.90 s）、`addString`（8.47 s）與 `encode`（4.39 s）。Heap sampling 估計累計配置 3.77 GB，其中 `join` + `encode` 約 2.19 GB。採樣 heap peak 333.1 MiB、結束 41.4 MiB，GC events 454 次共約 457 ms。這支持大 payload 的 canonicalization／validation 反覆配置為可測的成本來源，累計 allocation 與 RSS/heap live set 分別記錄。建議優先讓同一份已驗證且不可變的 canonical bytes 在驗證、hash 與 serialization 階段重用，保留 schema、closure 與 I/O barrier，再以同條件 profile 比對。見 [summary](evidence/pr1d-native-round2/profile-summary.json)、[CPU](evidence/pr1d-native-round2/8MiB-profiled-19798.cpuprofile.gz)、[heap](evidence/pr1d-native-round2/8MiB-profiled-19798.heapprofile.gz)、[GC and memory](evidence/pr1d-native-round2/8MiB-profiled-19798.observation.json.gz)。

| Commands | Commit total / p50 / p95 / max (s) | Peak RSS (KiB) | Files / allocated bytes | IPC reopen (s) / margin | Direct flock / committed verify (s) | History |
| ---: | --- | ---: | --- | --- | --- | --- |
| 25 | 21.243 / 0.830 / 1.270 / 1.315 | 152,324 | 780 / 3,530,752 | 3.512 / 26.488 s (ready) | 3.610 / 1.717 | 25/25, replay True |
| 50 | 90.016 / 1.438 / 4.456 / 10.278 | 165,280 | 2,070 / 9,338,880 | 9.393 / 20.607 s (ready) | 9.535 / 5.705 | 50/50, replay True |
| 100 | 359.440 / 3.267 / 7.473 / 13.550 | 179,172 | 6,207 / 28,491,776 | 28.999 / 1.001 s (ready) | 29.310 / 19.553 | 100/100, replay True |

| Commands | Warm proof bytes / fingerprints | Warm evictions / misses / reconstructions | Warm paths traversed | Cold proof bytes / fingerprints | Cold evictions / misses / reconstructions |
| ---: | --- | --- | ---: | --- | --- |
| 25 | 102,295 / 100 | 0 / 25 / 25 | 6,775 | 102,295 / 100 | 0 / 25 / 25 |
| 50 | 337,370 / 200 | 0 / 50 / 50 | 47,925 | 337,370 / 200 | 0 / 50 / 50 |
| 100 | 1,206,895 / 400 | 0 / 100 / 100 | 358,350 | 1,206,895 / 400 | 0 / 100 / 100 |

- 25 commands 的 cold parent closure 與各版本重建共 2.606 s；maintenance 為 `idle`、0 steps。
- 50 commands 的 cold parent closure 與各版本重建共 8.253 s；maintenance 為 `idle`、0 steps。
- 100 commands 的 cold parent closure 與各版本重建共 30.548 s；maintenance 為 `scheduled`、0 steps。

歷史量測關閉 auto-maintenance，以維持與原 harness 相同的條件。100 筆時排入維護但還未 drain。另有原生 suite 測試在持續寫入下確認 bounded maintenance step 計數前進。這兩組分開記錄，維護吞吐與容量 gate 尚待測量。Benchmark 的 files / bytes 為關閉 writer 前的受管理 store 用量。100 筆使用一個 full anchor 加 99 個 deltas。冷探針共 10,000 個 version path references，共享為 400 個 distinct physical fingerprints。Probe 的 user/system CPU 約 13.58 / 15.91 s，已提交閉包驗證花 19.553 s；剩餘 wall time 包含重新建立 barrier、journal/claim 恢復和 recovery epoch。

**100 筆在 28.999 s 進入 ready，距現有 30 s client timeout 約 1.001 s，startup 仍是 blocker。** Round 1 WSL2/ext4 測到 27.84 s，repair branch 的另一 process-crash 環境測到 29.915 s。這三次各自保留，未視為同條件 benchmark。建議先修正 proof 身分競態，再在單次 closure verification 內重用已校驗的 delta prefix 與相同 physical dependency 結果，保留每個版本的 hash／ownership 檢查及原有 fsync，量測 metadata traversals、cold verify、journal/barrier 各階段。修復後先重跑同條件 100 筆，留出可重現的 timeout 裕度再擴大規模。見 [25 commands](evidence/pr1d-native-round2/metrics-history-25.json)、[50 commands](evidence/pr1d-native-round2/metrics-history-50.json)、[100 commands](evidence/pr1d-native-round2/metrics-history-100.json)。

## 最終分類與正式部署缺口

- **Defect Reacceptance BLOCKED。** 原 H-01/H-02 regression 已轉綠，M-02 contention/IPC 通過。新增的歷史發布 forgery、warm GC missing proof 與 false durable ACK 反例仍須修復並重測。現有結果不足以滿足完整性 gate。
- **PR-1D Overall BLOCKED。** 100 筆冷重啟只有約 1 秒裕度，8 MiB 仍觀察到 569.2 MiB peak RSS。本輪停在 100 筆，尚未實測 1,000-command checkpoint、10 GiB quota pressure、100k strokes、64 reader/1 GiB pin stress、部署吞吐與備份並行的完整容量驗收。
- 本輪的耐久範圍是 WSL2 guest ext4 上的 application process crash、real lease、rename 與 file/directory fsync。正式部署仍需指定目標 mount 的獨立驗證、VM 或 block-device 未落盤寫入故障測試、Windows/VHDX/host 與實體介質 power-loss/flush 驗證，以及真實 Host、其他 Store 和跨 Store 整合驗收。
- 驗收只在本機 `codex/pr1d-native-reacceptance-round2`。測試與工具 commit 為 `26a51e6f9f85e7d64870810bb93d7f58db42ece4`，其 parent 是已核對的 source HEAD。Report 和證據以獨立 commit 保存。產品資料、部署與 writer activation 不在本輪範圍。

## 證據與重現

[命令、開始時間、exit code、耗時、TAP counts、raw SHA-256](evidence/pr1d-native-round2/runs.jsonl) 與 [完整 SHA-256 manifest](evidence/pr1d-native-round2/manifest.json)。TAP 或 Chromium 產生尾端空白時，對應的 `.log.gz` 保留原始 bytes，`.log` 為可閱讀版，兩者的雜湊均列入 manifest。第一版 supplemental storage 的 input 路徑於 child 已載入 module 後更新，沿用 runner 在執行結束才取 input hash，manifest 另列出實際第一版 snapshot 和 SHA。兩個早期 inline Python 稽核完成後遇到 runner 將長程式碼當 pathname 的 ENAMETOOLONG，原 stdout 保留，最後以具名 [verify-inputs.py](evidence/pr1d-native-round2/verify-inputs.py) 通過同一組及更廣的驗證。

重現時從報告的 exact source 及本輪 evidence branch 取相同程式，建立新的 owned 0700 ext4 scratch root 與 `tmp`，把 [run.py](evidence/pr1d-native-round2/run.py) 複製到該 root，從 checkout 以 `estampes` 帳號執行。使用新的 output 路徑保留舊 logs。Native 副本由 [prepare-native.py](evidence/pr1d-native-round2/prepare-native.py) 建立。Chromium、Python venv、harness 和 fault Store 的原始路徑都是本輪 scratch 路徑；需要用對應版本和新的 disposable 路徑重建。
