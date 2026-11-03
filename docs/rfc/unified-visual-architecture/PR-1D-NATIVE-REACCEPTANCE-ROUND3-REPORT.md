# PR-1D Native Reacceptance Round 3

**Integrity Defect Reacceptance BLOCKED。Native Lifecycle Qualification BLOCKED。PR-1D Overall BLOCKED。** Round 2 的三個原始反例在原生 ext4 重跑均通過。Round 3 在 recovery 再次崩潰、重複 GC 規劃，以及發布與 unlink 的最後檔案檢查之後，重現仍會阻擋驗收的反例。

## 基準與隔離環境

- 已 fetch 並以 `ls-remote` 核對 `fix/unified-visual-architecture-pr1d-integrity-hardening` HEAD **`b2f853c5e7473a008552ff70c838de3faff07c20`**，tree **`c634b864f5643ffc189f1dddedf38d1656ada57d`**。遠端 Round 2 為 **`a33fe411aac7fe763a9adf5b8d71bf4f77e5f3b0`**。工作樹起初乾淨。驗證線性 ancestry 為 Round 2 → `6fc40c5` coherent observations → `b716875` selected CURRENT proof → `6b5f77c` GC authorization → `c09d9e7` prefix optimization → `a21aecf` terminal reuse → `b2f853c` source seal。新分支為 `codex/pr1d-native-reacceptance-round3`。[環境與完整 ancestry](evidence/pr1d-native-round3/env.log)
- Ubuntu 24.04.1 LTS，WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`，Node `v22.23.4`、npm 10.9.9，`estampes` UID/GID 1001/1001，真實 `/usr/bin/flock` 2.39.3。Checkout、初次 scratch 及重建 scratch 同在 `/dev/sdd`、ext4、8:48、magic `0xef53`、fsid `be1d78fd15e717c5`，mount options `rw,relatime,discard,errors=remount-ro,data=ordered`。重啟後 953 GiB 與 67,034,389 個 inode 可用。Store、backup、restore 及 fault mutation 都只使用新建的非 root owned 0700 目錄。Runner 清除繼承的 `ESTAMPES_*`，使用隔離的 `TMPDIR`。[重建環境](evidence/pr1d-native-round3/restarted-env.log)
- WSL 在首輪 full suite 中途重啟，舊 `/tmp` scratch 消失。保留至 TAP #310 的 [部分輸出](evidence/pr1d-native-round3/full-serial.log)，該次沒有可信 exit 或 suite totals。重建 0700 scratch 後重新安裝瀏覽器、專用 library 與 Python venv，再完整重跑。第一次 browser probe 在 Playwright 尚未寫完 executable 時得到 `ETXTBSY`，其後等待 download 完整結束，執行 `--version`、SHA-256 和 `ldd`。瀏覽器為 Chromium 141.0.7390.37。8 個 browser case 使用 repo fake Host。[Browser runtime](evidence/pr1d-native-round3/browser-runtime-restart.log)
- 驗證涵蓋 Integrity Hardening、Round 1/2 報告、Storage Lifecycle、Final Architecture Gate、Test Matrix、Risk Register 與對應 evidence/source seals。獨立 review 涵蓋 coherent I/O、cache／Registry／Locator、delta／page sharing、commit publication、temporary attribution、GC、Journal／Ledger、Lease、pins 與 backup。

## Gate A — R2-H03

**原始重現通過，擴展 gate BLOCKED。** 未修改的 Round 2 `cache-ack-race.mjs` 在原生 worker 命中 post-JSON-read rewrite marker，回 `RECOVERY_REQUIRED`，CURRENT 維持原 generation，冷讀與重啟偵測損毀。8 個原始 cache 案例全部通過，涵蓋 eviction 後重驗、共用 fingerprint invalidation、歷史 Registry／Locator／generation 和 reader pin。實際 FD 已 open、首次 read 之前的同 inode overwrite 也被拒絕，marker 顯示原 inode、不同 size 與 timestamp。[原始 ACK race](evidence/pr1d-native-round3/round2-h03.log) · [Cache cases](evidence/pr1d-native-round3/round2-cache.log) · [FD boundary](evidence/pr1d-native-round3/metadata-boundary.log)

**R3-A1 High（外部寫入條件）**。在 [coordinator.js 207–225](../../../src/persistence/coordinator.js#L207)，原始碼在 candidate closure 驗完與進入 `atomic()` 之間、以及最後一次 `verifyObservation()` 與返回 ACK 之間仍有可排程間隙。獨立 worker preload 只在指定 fixture 的真實 stage 改動歷史 generation，保留前後 fingerprint、worker PID、CURRENT／Ledger 和結果。

| 實際觸發點 | 變更 | Worker / Root / Ledger |
| --- | --- | --- |
| `after-prepared` | 同 inode overwrite，在 candidate verification 前 | `RECOVERY_REQUIRED`、read-only，CURRENT 仍 generation 3，Ledger 1→1，通過 |
| `current.before-rename` | atomic inode replacement，在最後 pre-publish observation 之後 | 回 `RECOVERY_REQUIRED` 並 fence，CURRENT **3→4**、Ledger **1→2**，無 ACK |
| `before-ack` | 同 inode overwrite，在最後 observation 之後 | **durable ACK**，writer 當時仍 ready、CURRENT **3→4**、Ledger **1→2** |

三種冷啟動都拒絕損毀。最後一種是受控的同帳號／非 lease-cooperative 寫入，沒有重現第二個合法 writer。最小修正應縮短最終驗證與 rename、ACK 間的間隙，並以部署隔離防止其他程序寫入 managed tree。單靠追加 pathname stat 無法排除另一個有寫入權限的程序在下一個指令改檔。不得為了維持舊指標而在不確定時靜默回退已發布 CURRENT。[原始結果與 exact stage marker](evidence/pr1d-native-round3/adversarial.log)

**R3-A2 Medium（metadata 假設）**。同一實際 ext4 上，128 次快速等長 in-place rewrite 中 **56 次**保留相同 dev／inode／size／mtimeNs／ctimeNs，其中一個 specimen 的 `proofFingerprint()` 接受先前 observation，獨立重讀已是新值。這證實 metadata 可碰撞而不是不可變性證明；該測量本身未發出 commit ACK。既有 focused suite 的 ctime-only assertion 曾失敗，獨立原樣重跑通過；首輪沒有該次前後 stat，故不確定是同一原因。對照已命中實際內容改變後的 coherent read，也證明 hash 檢查未被移除。修復應依賴已驗證 FD／內容與可強制的寫入隔離，明確限制 metadata-based trust 的生命週期。[Metadata experiment](evidence/pr1d-native-round3/metadata-boundary.log) · [初次 ctime 結果](evidence/pr1d-native-round3/focused.log) · [原樣重跑](evidence/pr1d-native-round3/ctime-original-retest.log)

## Gate B — R2-H01

**四個原始案例與原 forgery 通過，重複 recovery gate BLOCKED。** 由現行選取的 CURRENT 建立 `estampes.selected-current-proof/1`，先驗 prepared Root、claim bytes/paths/owner、namespace 與 CommitIndex，再與實際 selected envelope 比對。後續 supersession 依已選 retention 內的原 proof；單獨準備、自洽的 forged claim/prepared 組合、缺／壞 prepared 或無新 proof 的 legacy descriptor 都不能自行取得歷史 authority。原始腳本涵蓋兩種 profile、合法後續 commit、重啟、精確 ACK replay 與不同 payload。Retained proof 使用原 prepared/root；移交 GC 時 exact descriptor 隨 hashed plan 綁定。[原始四例](evidence/pr1d-native-round3/original-h01.log) · [Round 2 storage](evidence/pr1d-native-round3/round2-storage.log)

**R3-B1 High（合法 crash／可用性）**。先在原 content 的 `current.after-dir-fsync` SIGKILL，再在 recovery epoch 已發布 selected proof、但尚未移除自己的 CURRENT claim 的同一點 SIGKILL。此時根正確記錄原 selected proof，Ledger 仍為 1，卻有兩個 genuine CURRENT claims。[temporary-attribution.js 114–125](../../../src/persistence/temporary-attribution.js#L114) 先按 final pathname 排除第二 owner，再檢驗各自 proof，故下一次重啟報 `Atomic target has conflicting temporary owners` 並進 read-only。兩個對照通過：在 recovery `after-prepared` 尚未發布 proof，以及 `after-publication-durable` 已完成 claim cleanup 的時點，各自能再重啟兩次與精確重播。未觀察 Root rollback、額外 Ledger effect 或資料遺失。建議允許經逐筆 exact selection 證明且可排序的 CURRENT 歷史鏈共存，仍拒絕未證實或互斥 owner。[雙次 SIGKILL 與 controls](evidence/pr1d-native-round3/adversarial.log)

## Gate C — R2-H02

**原始缺檔反例通過，生命周期 gate BLOCKED。** 原始兩個 H-02 variants、warm missing-quarantine、缺少原 source、冷啟動 quarantine tamper、corrupt plan、24h grace／clock rollback、各 unlink barrier、重啟、合法 quarantined/terminal pathname reuse、reader pin 均執行。新增案例在選取 GC plan 之後啟動備份，re-mark 保留已在 plan 中的兩個 journal members，備份完整寫出並驗證。合法重建的 live source 不會由舊 plan unlink。[原始 fault matrix](evidence/pr1d-native-round3/original-faults.log) · [新增 native suite](evidence/pr1d-native-round3/native-persistence.log) · [Backup GC re-mark](evidence/pr1d-native-round3/backup-gc.log)

**R3-C1 High（正常操作／可用性）**。準備三個歷史版本並 compaction，連續執行兩次合法 G1 `gcPlan`，都選進兩個相同的 full-generation pathname。第一份 `gcStep` 正常完成後，冷啟動因第二份 plan 找不到候選又無自身 unlink intent 而進 read-only。沒有外部改寫、斷電或 live 版本遺失。[gc.js 73–78](../../../src/persistence/gc.js#L73) 的 `selected` 僅限當次規劃，之前的 active plan 未排除其 source；[cold validator](../../../src/persistence/gc.js#L180) 因而正確拒絕單份沒有授權的缺檔。建議在同一 Root 中保留未終結候選的唯一 ownership，拒絕／重用重複規劃，並用可驗證的 disposition 處理已存在的 overlap。[兩份 plan 和重啟結果](evidence/pr1d-native-round3/adversarial.log)

**R3-C2 High（外部寫入條件）**。[gc.js 151–156](../../../src/persistence/gc.js#L151) 確實先 re-mark 並驗 quarantine digest/length，但 [filesystem.js 146–149](../../../src/persistence/filesystem.js#L146) 在 `gc.before-unlink` 後以 pathname unlink。fixture 在該點用不同 inode、不同 bytes 取代原 quarantine 檔。GC unlink 了替代檔，回 `complete`，writer 保持 ready。未刪除 live source 或真實資料。建議讓受管 quarantine 路徑只對 lease owner 可寫，並在刪除前確認已授權的 object identity；任意同權限改寫下，stat 加 pathname unlink 仍有競態。[Exact inode marker 與結果](evidence/pr1d-native-round3/adversarial.log)

## 追加的 selected proof 對照

兩個 native fixture 各在原 claim 被合法 supersede 之後再完成三筆內容提交和多次冷啟動。原 ACK 完全相同，Ledger 只有四個 effects。然後在停 writer 後刪除或改壞實際承載 selected proof 的 content-addressed retention page，兩者都拒絕重啟與寫入，CURRENT bytes 保持。這把 missing/corrupt on-disk evidence 和原 legacy in-memory descriptor case 分開。Checksums 與 Root membership 是完整性錨點。能同時改寫 CURRENT 與整套 authority metadata 的程序超出目前隔離模型，無法靠 self-consistent hash 推導從未發生的歷史發布。[兩個實際磁碟對照](evidence/pr1d-native-round3/publication-controls.log)

## Gate D — Regression、瀏覽器與契約

| 實際執行 | Exit | Pass / Fail / Skip |
| --- | ---: | --- |
| [完整 Node 22 serial 重跑](evidence/pr1d-native-round3/full-serial-restart.log) | 1 | **485 / 1 / 0**，同 inode 等長 in-place proof 反例；[8 個 Chromium cases](evidence/pr1d-native-round3/browser-results.json) 全數通過 |
| [原始 persistence](evidence/pr1d-native-round3/original-persistence.log) | 0 | **150 / 0 / 0** |
| [Native disposable persistence](evidence/pr1d-native-round3/native-persistence.log) | 0 | **149 / 0 / 0** |
| [Native platform](evidence/pr1d-native-round3/platform.log) | 0 | **7 / 0 / 0**，含真實 durable ACK、restart 與原 ACK replay |
| [原始 H-01](evidence/pr1d-native-round3/original-h01.log) | 0 | **4 / 0 / 0** |
| [原始 H-02 及 fault matrix](evidence/pr1d-native-round3/original-faults.log) | 0 | **22 / 0 / 0** |
| [Round 2 storage](evidence/pr1d-native-round3/round2-storage.log) | 0 | **14 / 0 / 0** |
| [Round 2 worker H-03](evidence/pr1d-native-round3/round2-h03.log) | 0 | **1 / 0 / 0** |
| [Round 2 cache tamper、eviction、pins](evidence/pr1d-native-round3/round2-cache.log) | 0 | **8 / 0 / 0** |
| [未修改 hardening focused tests](evidence/pr1d-native-round3/focused.log) | 1 | **28 / 1 / 0**，ctime case 單獨重跑通過 |
| [獨立 adversarial matrix](evidence/pr1d-native-round3/adversarial.log) | 1 | **3 / 5 / 0**，均有對應的 fault/state 證據 |
| [FD 與 timestamp controls](evidence/pr1d-native-round3/metadata-boundary.log) | 0 | **2 / 0 / 0**，第二例量測 metadata 限制 |
| [Selected proof on-disk controls](evidence/pr1d-native-round3/publication-controls.log) | 0 | **2 / 0 / 0** |
| [GC re-mark with active backup](evidence/pr1d-native-round3/backup-gc.log) | 0 | **1 / 0 / 0** |
| [Lease 普通競爭](evidence/pr1d-native-round3/lease-normal.log)／[延遲 callback](evidence/pr1d-native-round3/lease-delay.log) | 0 / 0 | **220 / 0 / 0** 次，21 個實際 EPIPE 均與 exit 73 對應 |
| [Lease backend、transport、timeout/release](evidence/pr1d-native-round3/lease-failures.log) | 0 | **3 / 0 / 0** |
| [契約](evidence/pr1d-native-round3/contracts.log) | 0 | **22 / 0 / 0** |
| [Formal examples](evidence/pr1d-native-round3/examples.log) | 0 | **9** examples、7 schemas、零錯誤 |
| [CAS Python](evidence/pr1d-native-round3/cas.log) | 0 | **17 / 0 / 0** |
| [Release](evidence/pr1d-native-round3/release.log)／[source seal](evidence/pr1d-native-round3/source-seal.log)／[architecture](evidence/pr1d-native-round3/architecture-clean.log) | 0 / 0 / 0 | Source tree 821 檔案逐 byte 與 SHA-256 核對 |

Native harness 使用 Round 2 的 profile-only 準備方式，另外轉換兩個新 hardening test 的 fixture persistence/profile。原始斷言和工作區既有 tests 保留，native 副本中的雙 profile loop 合併為單一 native iteration。見 [fixture/test hashes](evidence/pr1d-native-round3/native-harness.json)。Unsupported filesystem case 在允許的 ext4 mount 上會 early return，適用的 ext4/XFS 正向 case 實際執行。架構 checker 本身只允許 hardening 改動，會拒絕看到額外 Round 3 artifacts。最後以完全相同的 `b2f853c` archive、隔離 Git index 及工作樹外的依賴 symlink 重跑，保留前幾次失敗。早期重跑舊 preservation helper 時，它重新產生自己所在的歷史 source seal，已還原該次寫入並用只讀比對確認最終 bytes 完全一致。原始 Git 歷史未改。

完整 serial 的唯一失敗是 hardening 原始 assertion `coherent observation rejects in-place changes and cannot seed a warm proof`，回 Missing expected rejection。該 case 在前兩份 persistence suite 通過。這是原始未修改測試的間歇失敗，符合獨立量得的 metadata alias 風險，但沒有該次前後 fingerprints 可直接配對。Focused 初跑另有 ctime-only case 的間歇失敗。保留所有結果，未以後來的局部通過覆蓋。各 invocation 使用 serial test concurrency，未執行 default parallel suite。

## Gates E／F — 原生效能與受控 scale

在所有測試結束後逐一執行，對照是從 **`a33fe411aac7fe763a9adf5b8d71bf4f77e5f3b0`** 解出的原始碼。使用同一 ext4 device、Node、同一份 benchmark、相同 document 變更與一個 writer。25/50/100 歷史關閉 auto-maintenance。8 MiB 沿用 Round 2 的四筆寫入、auto-maintenance 設定，另加 direct/IPC 冷啟動與 exact replay。量測未清除 OS page cache。Direct probe 使用 real flock 和新 process，會新增 recovery epoch；實際 client 再以空的 JS cache 啟動，deadline 維持 30 秒。Peak RSS 從 worker VmHWM 讀取，表中歷史檔案與 allocated bytes 在重啟前採樣。以下均為單次結果。

| Workload | Commit total / p50 / p95 / max (s) | Worker peak RSS (KiB) | Files / allocated bytes | Direct recovery / committed verify (s) | Client cold / 30s 裕度 (s) |
| --- | --- | ---: | --- | --- | --- |
| [Round 2 base，8 MiB](evidence/pr1d-native-round3/baseline-metrics-8mib.json) | 37.874 / 10.096 / 10.724 / 10.724 | 536,676 | 97 / 8,871,936 | 20.519 / 18.244 | 20.472 / 9.528 |
| [Round 3，8 MiB](evidence/pr1d-native-round3/metrics-8mib.json) | 18.804 / 4.707 / 4.746 / 4.746 | 336,204 | 98 / 8,876,032 | 9.825 / 7.664 | 9.815 / 20.185 |
| [Round 3，25](evidence/pr1d-native-round3/metrics-history-25.json) | 24.206 / 0.940 / 1.453 / 1.570 | 151,632 | 750 / 3,395,584 | 3.010 / 0.671 | 2.989 / 27.011 |
| [Round 3，50](evidence/pr1d-native-round3/metrics-history-50.json) | 106.886 / 1.940 / 4.338 / 11.551 | 162,824 | 2,050 / 9,281,536 | 7.487 / 1.900 | 6.410 / 23.590 |
| [Round 2 base，100](evidence/pr1d-native-round3/baseline-metrics-history-100.json) | 338.437 / 3.118 / 6.919 / 12.381 | 197,236 | 6,227 / 28,639,232 | 27.800 / 18.698 | 27.359 / 2.641 |
| [Round 3，100](evidence/pr1d-native-round3/metrics-history-100.json) | 312.839 / 3.117 / 5.391 / 12.586 | 175,304 | 6,181 / 28,340,224 | 10.652 / 2.368 | 11.348 / 18.652 |

所有未 instrumented workloads 的 direct probe exit 0，實際 client ready，重建所有版本並重播完全相同的最後一筆 Ledger ACK。100 筆冷重啟實測快約 58.5%，8 MiB 最慢 commit 約減 55.7%、worker peak RSS 約減 37.4%。100 筆的最大 commit 略慢，不能把冷啟動改善等同所有延遲改善。先前 tmpfs 資料與 Round 2 歷史 native 28.999 s 僅列背景，本表比較的是重新量測的同環境 pairing。

| Candidate history | Warm proof bytes / shared fingerprints / physical path refs | Warm hits / misses / evictions | Cold delta applies / prefix hits / fingerprint checks | 獨立閉包及全歷史重建 (s) | 維護 |
| ---: | --- | --- | --- | ---: | --- |
| 25 | 102,295 / 100 / 625 | 325 / 25 / 0 | 24 / 24 / 699 | 1.938 | idle，0 steps |
| 50 | 337,370 / 200 / 2,500 | 1,275 / 50 / 0 | 49 / 49 / 1,363 | 6.491 | idle，0 steps |
| 100 | 1,206,895 / 400 / 10,000 | 5,050 / 100 / 0 | 99 / 99 / 2,593 | 20.639 | scheduled，0 steps |

Physical path references 取直接冷探針中的 version proof paths，等量 distinct fingerprints 共用。4 MiB 是 proof accounting 上限，總 process RSS 另計。Cold prefix sharing 以同一 Locator 與 operation 為界，驗證 anchor 內容、delta payload/from/to、每步 hash/長度和最終 logical ref。另以無 shared session 的 readVersion 逐版本重建。原始測試中對 invalid strict Document schema、historical bindings、corrupt prefix dependency 的檢查仍執行。100 筆已排維護但沒有 drain；有 auto-maintenance 的功能斷言和歷史 benchmark 分開。

### 8 MiB CPU、heap 與 I/O profile

第一輪 instrumented 8 MiB，p50/p95/max 為 4.834 / 4.959 / 4.959 s，worker max RSS 442,752 KiB。Inspector 估計 1.515 GB 累計配置，峰值 heapUsed 299,410,080 B、external 52,660,691 B，188 次 GC 共約 191.9 ms。CPU self time 以 `visit` 7.895 s、`addString` 4.708 s、`encode` 1.519 s 為主，strict schema path 與 hash 更新也見於 profile。Managed `bytes`／`json`／`info`／`digest` 呼叫數為 232／221／1,143／88。巢狀時間不可相加；Inspector 是樣本，instrumented peak 與 uninstrumented peak 分列。[第一輪 profile](evidence/pr1d-native-round3/profile-summary-first.json) · [Raw CPU](evidence/pr1d-native-round3/8MiB-profiled-10359.cpuprofile.gz) · [Raw heap](evidence/pr1d-native-round3/8MiB-profiled-10359.heapprofile.gz)

第一輪只啟動 Inspector，counter 的 opt-in 變數未設，保留該輪。第二輪以相同 b2f853c source archive 和獨立輸出補測，canonicalJson 1,779 次、hashJson 865 次（不含直接 SHA 或 streaming digest）。Zod safeParse inclusive 約 8.706 s，和其他 inclusive frames 重疊。四筆 p50/p95/max 5.077 / 5.160 / 5.160 s，RSS 435,964 KiB，heapUsed 282,860,640 B、external 35,911,804 B，估計 1.516 GB 累計配置。194 個 GC events 約 225.5 ms。兩次 profiler 與無 profiler RSS 差異顯著，仍缺可重現的 memory ceiling。 [Counted profile](evidence/pr1d-native-round3/metrics-profile8-counted.json) · [兩輪摘要](evidence/pr1d-native-round3/profile-summary.json)

## 結論與下一輪 gate

- **Integrity Defect Reacceptance BLOCKED**。三個原始 Round 2 反例轉綠，未修改的 in-place assertion 仍間歇失敗，新增 adversarial tests 有五個 fail。優先修復合法雙 crash 與重複 active plan 的狀態轉換，再以原案例重跑。外部寫入需要可執行的隔離邊界，另驗證最後 publication/ACK／unlink 與 metadata alias 的風險。保留既有失敗案例與故障證據。
- **Native Lifecycle Qualification BLOCKED**。已驗證的範圍是這個 WSL2 guest ext4 上的 isolated durable ACK、正常 replay、單一 worker/lease、備份及一般 GC 與 process-crash recovery。雙次 recovery crash、重複 GC plans 與替代 inode 邊界仍未達門檻。
- **PR-1D Overall BLOCKED**。儘管 100 筆有約 18.65 s client 裕度，因 High findings 停於 100 筆。200、1,000-command／revision-1000 checkpoint、checkpoint 後 recovery、10 GiB pressure、100k strokes、64 reader／1 GiB、長時間寫入與 maintenance drain、真 Host 和跨 Store 完整部署仍開放。此輪真實 file/directory fsync 與 SIGKILL 涵蓋 application process crash；尚需指定部署 volume、OS fencing、VM/block-device 未落盤故障、Windows/VHDX/host/實體裝置 flush／power-loss 驗證。
- 工作範圍為本機 `codex/pr1d-native-reacceptance-round3`，獨立測試/工具 commit `94f3b59f1b5eabe6ce8dabfc33362ddb35a27bc4`，報告與證據另行提交。與指定基準逐 byte 核對，生產原始碼、既有 tests 和歷史報告維持原樣。

[執行命令、開始時間、exit、counts 與 log SHA](evidence/pr1d-native-round3/runs.jsonl) · [證據 manifest](evidence/pr1d-native-round3/manifest.json) · [精確 source tree hashes](evidence/pr1d-native-round3/source-manifest.json)。有尾端空白的原始 log 以 lossless gzip 保留，`.log` 是去除行尾空白的閱讀版。重現需新建同 mount 的 0700 scratch、`tmp` 及獨立輸出。將 [run.py](evidence/pr1d-native-round3/run.py) 複製到 scratch 根目錄，從 checkout 用同版本 Node 及 UID 1001 執行。先建立 exact baseline archive，再用 [performance.sh](evidence/pr1d-native-round3/performance.sh) 的序列與相同 benchmark。腳本使用固定 evidence 名稱，重現時請改用新輸出以保留既有 logs。
