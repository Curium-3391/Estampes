# PR-1D Remediation — WSL2 Native Acceptance & Independent Storage Review

日期：2026-11-03（Asia/Taipei）。**BLOCKED — PR-1D Native Acceptance 不通過；不可啟用正式 writer 或開始 PR-1B。** 原生環境與既有測試可執行，兩個新重現的 temporary lifecycle 缺陷仍阻擋驗收。本輪只驗證、fault test、profile、review 與提交證據，未修補 production source。

## 1. Baseline / authorization / environment

- Repository：`Curium-3391/Estampes`。已以非 root 帳號 fetch 指定 remote ref，`ls-remote` Exit 0 確認 source branch `fix/unified-visual-architecture-pr1d-remediation` 為 **`c090d93a9c984f015d1a2a24a3f70df026be7f34`**，沒有 discrepancy。
- 已逐一 `git show` / `merge-base --is-ancestor` 驗證 `322038b4… → 3d71254f… → b163a859… → c090d93a…`，直接 parent 關係亦相符。從 clean checkout 建立 `codex/pr1d-remediation-native-ext4-acceptance`。舊 PR-1C 分支及 remediation/main 不改。
- Ubuntu 24.04.1 LTS、WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`、x86_64；Node `v22.23.4` / npm `10.9.9`；所有 Node/npm、flock writer、benchmark 與 Git 寫入皆為 `estampes` UID/GID **1001/1001**。工具的外層 root shell只負責切換使用者、環境檢查與既有 GitHub 登入的短暫 fetch authentication；未持久儲存憑證，未加入 safe.directory 例外。
- Checkout `/home/estampes/projects/Estampes` 與專用 `TMPDIR=/tmp/estampes-pr1d-native-l_u7qnh9/tmp` 的 `findmnt -T` 均為 **`/dev/sdd ext4 rw,relatime,discard,errors=remount-ro,data=ordered`**。statfs `0xef53`、device 2096；完整 `/proc/self/mountinfo` 與原始命令保留於 [environment.json](evidence/pr1d-native-logs/environment.json)。沒有偽造 mountinfo/statfs、借用 overlay/tmpfs 或 `/mnt/c` 作測試 volume。
- 真正 `/usr/bin/flock`、file/directory fsync 與同裝置 rename。所有 Store 皆為 harness `mkdtemp` 建立的 owned 0700 `estampes-pr1c-*` roots；source 與 backup/restore destinations 皆屬本輪專用暫存樹。
- 清除繼承的 `ESTAMPES_*`，僅設空 `ESTAMPES_STORAGE_DIR`/`ESTAMPES_ACCESS_KEY`、retention=0；未自行建立 Store 的舊 server tests 使用 memory，其餘測試各自建立 disposable Store。原有 production Store、使用者資料、活躍他人程序及 lock 未操作。
- 已檢查 fixture、platform、backup/GC、benchmark 的清理。只刪自行建立的 roots/files，writer 先 close/SIGKILL 並等待 exit。Native harness 的 `src`/`node_modules` symlinks 只作 imports；清理不 follow symlink 到工作區。
- 已安裝 lock-listed npm packages 版本逐一相符，故不重跑會移除可選依賴的 npm ci；package/lock 未改。現有 Playwright Core 1.56.1、pdfjs-dist 4.10.38、@napi-rs/canvas 1.1.0 可用。舊臨時 Chromium 路徑確實已不存在；重新下載並驗證 **Chromium 141.0.7390.37**，設 repo-supported `CHROME_BIN` 與 finding-list 的 `CHROMIUM_BIN`。缺的 Ubuntu libraries 只下載 .deb、解壓至本輪 scratch，再設 LD_LIBRARY_PATH，沒有安裝系統套件。
- Python 3.12.3，專用 venv 安裝鎖定 SymPy 1.14.0 / mpmath 1.3.0。初次 pip 命令被 venv PATH shadow，Exit 1；改用 `/usr/bin/python3 -m pip --python <venv>` 後 Exit 0。失敗未刪除。

已閱讀原 PR-1D implementation/remediation、PR-1C native report、Final Architecture Gate、Storage Lifecycle、Test Matrix、Risk Register、Traceability，並逐段檢查指定 12 個 persistence modules。原始 source seals、所有 `src/`、既有 tests、歷史報告與 evidence 保持原 bytes；完整 source hashes 見 [source-manifest.json](evidence/pr1d-native-logs/source-manifest.json)，命令與退出碼見本輪 manifest。

## 2. Commands / tests / native durability

[逐次命令、exit、耗時、TAP counts、log SHA256](evidence/pr1d-native-logs/runs.jsonl)。UTC 開始時間 +08:00 為臺北時間。每個 log 保留成功或失敗原文，未覆寫失敗。原始 suite 與改 profile 的 harness 分開記錄。

| Scope / command | Exit | Pass / Fail / Skip |
| --- | ---: | --- |
| `node --test --test-concurrency=1`，原始 sealed source/tests | 0 | **449 / 0 / 0**，cancelled/todo 亦為 0 |
| 原始 9 個 `tests/persistence-*.test.js`，serial | 0 | **113 / 0 / 0** |
| 原始 `persistence-platform.test.js` | 0 | **6 / 0 / 0**；native durable positive 實際執行 |
| [native prerequisite probe](evidence/pr1d-native-logs/native-prerequisite.log) | 0 | approved ext4 可用；只是 prerequisite，不是 acceptance |
| Disposable Native Durable 9-suite harness | 1 | **111 / 1 / 0**，112 total；一次 second-writer startup error（`Cannot start OS lease backend`），未回預期 exit 73 |
| Native platform diagnostic retest，真 spawn + error observer | 0 | **6 / 0 / 0**；沒有重現 startup error，未捕捉到原始 OS cause |
| Native lease 200 次無 delay 診斷 | 0 | 200/200 正確 exit-73 contention，Root/lock/原 writer 不變 |
| Native lease 20 次 parent callback delay 20ms | 1 | 20/20 真實 EPIPE 被 production code 誤分類，詳 M-02 |
| [CURRENT claim minimal regression 初跑](evidence/pr1d-native-logs/superseded-current-regression.log) | 1 | **0 / 2 / 0**，兩種 profile 都失敗 |
| [CURRENT claim 四個最終變體](evidence/pr1d-native-logs/superseded-current-final.log) | 1 | **0 / 4 / 0**，兩種 profile × 有/無後續已 ACK content |
| [獨立 Native fault matrix 最終版](evidence/pr1d-native-logs/independent-native-faults-complete.log) | 1 | **20 / 2 / 0**，兩個 G2 regression 真失敗 |
| `node --test .../contract-validation.spec.mjs` | 0 | **22 / 0 / 0** |
| `node .../validate-contract-examples.mjs` | 0 | 9 formal examples、9 fences、7 schemas、0 errors |
| `python -m unittest discover -s cas-service/tests -v` | 0 | **17 / 0 / 0** |
| `npm run docs:check` / `npm run release:check` | 0 / 0 | 文件與 0.20.0 metadata 通過，未發布 |
| `node .../check-consistency.mjs` | 0 | 95 baseline source/config hashes、source seals、歷史 tests/evidence 與契約一致 |
| Final syntax / staged and baseline whitespace | 0 / 0 / 0 | 9 ES modules、4 Python scripts；code 與 evidence/報告 staged/base whitespace checks 通過 |

Native harness 只複製 fixtures/tests，將 profile、document persistence 與 ACK 語意期待改為 durable，雙 profile 歷史 Binding case 合併為一個 native iteration，故比原始 persistence suite 少一例。`src/` 直接連結未修改的 production code。完整 source/transformed hashes 見 [native-harness.json](evidence/pr1d-native-logs/native-harness.json)，以 [prepare-native.py](evidence/pr1d-native-logs/prepare-native.py) 可重建。未修改 allowlist、fsync、Lease、Recovery、timeout 或 G2 grace；不是原始 suite 全部本來就用 durable。

原始全測實際通過 8 個 browser assertion cases：cards、finding-list、layers、surface-open 的 2 個 browser cases、upload、workbench、zoom。沒有 filter 或 Skip；使用真 Chromium + repo fake host/MCP bridge，不是實際 ChatGPT Host。預設 parallel suite 未執行，serial pass 不證 parallel stability。Native 112-suite 那一次 error 的 errno 未捕捉，不能以後續 6 pass 把原 invocation 改寫成綠燈；後續 bounded scheduling 診斷另重現 M-02 的 IPC EPIPE race。

## 3. Independent prioritized storage review

### H-01 / High — Surviving committed CURRENT claim fences a later valid CURRENT

**已重現，不是 hypothesis。** `src/persistence/temporary-attribution.js:60–66` 的 `classifyTemporaryClaims()` 對任何 committed owner 一律要求「目前 final target」仍符合舊 claim hash。`coordinator.js:78–79` 首次完成分類後立即合法發布 recovery-epoch，CURRENT 因而更新，但舊 claim 要等 G2 才刪。

最短序列：native commit 在 `current.after-dir-fsync` 暫停 → SIGKILL，client 無 ACK → 第一次 reopen ready，claim durable classification=completed，request retry 精確回原 ACK、effect=1 → recovery-epoch 已合法改 CURRENT → 第二次 reopen **read-only-recovery / INTEGRITY_ERROR / `Committed transaction has an incomplete attributed atomic file`**。另一變體先完成並取得第二筆 native durable ACK，再 restart，同樣失敗。process-crash-test 亦相同。

直接 `loadCommitted` 仍可重建正確 Root、最新 Document 與 1/2 個 Ledger effects；沒有在這些案例觀察到資料遺失，但正常 writer/recovery 不可用，需要受管修復，不能刪 claim 或回退 CURRENT「解套」。四個 regression 預期 ready 而真失敗；沒有修改 assertion 去期待錯誤狀態。

最小修復建議：把 atomic-operation terminal proof 與 mutable final pathname 的當前 bytes 分開。以 sole Root 內精確 claim-ID/owner/path/hash/bytes 的已驗證完成/GC disposition，加上原 CommitRoot membership／必要 immutable publication proof，辨認已被合法 supersede 的 CURRENT；不要要求舊 CURRENT 永遠佔用現有 pathname。不能單憑 membership 就忽略任意 corrupt claim，也不能直接跳過未分類 claim。修補後須通過連續 recovery、後續 ACK、舊 retry、claim cleanup 再中斷與 G2 全流程。

### H-02 / High — Startup reintroduces a GC-owned temporary record, leaving a dangling claim reference

**已重現。** `gc.js:59–66` 在 durable G2 plan 接管 claim/temp 時移除 `temporary:<id>`；`classifyTemporaryClaims():55–66` 完全未考慮既有 GC plan，仍從尚未移走的原 claim 重建該 retention row。

序列：保留一筆已提交 Doc/Ledger → 第二筆未完成 write 留下 attributed temporary → reopen 分類 → publish G2 plan → SIGKILL 於 `gc.before-quarantine` 或第一個 `gc.after-rename` → restart 重新加入 temporary row → GC 經完整虛擬 24h grace、re-mark/hash 後完成 unlink → claim 不存在、row 卻仍被 Root 引用 → 下一次 `gcPlan` 讀 claim 得 **ENOENT，writer 進 read-only-recovery**。Log 同時顯示 Document 與 Ledger 各 1、claimExists=false、staleTemporaryProof 仍存在。

未觀察 unique committed content 被刪，但 maintenance 可用性被阻擋，backup 的 temporary closure 亦有同樣 dangling reference 風險（backup 影響是 code-path 推論，未額外宣稱已跑此失敗）。`gc.after-unlink` 的中斷變體通過；不能以那個通過覆蓋另外兩個真反例。

最小修復建議：startup classification 與 durable GC plan/progress 共同解讀 claim disposition；exact matching、hash-verified plan 已接管者不得重新建立獨立 temporary row。或在後續 GC progress transaction 中原子 reconcile 被重新引入的 row；仍需先證明 claim/temporary 的 exact identity 與 quarantine/deletion inventory，不准放寬 unknown/missing-owner 保護。Regression 必含 plan 後未 quarantine、第一個 rename 後、grace/final unlink、再次 gcPlan/backup/restart。

### M-01 / Medium — Version proof metadata is outside the advertised record/registry byte caps

`records.js:16,22–24` 的 24 MiB record / 32 MiB Registry LRU 不限制 `versions` Map。每個 logical version 的 proof 保存完整 ancestor physical path fingerprints；delta chain 逐版增長時，proof rows 可呈 N²。這是 rigorous code-path 的效能風險，下面用 controlled history 實測 proof counts；不是已證明 1000-command OOM，也不是 8 MiB 四版高 RSS 的唯一原因。

最小建議：為 proof metadata 加有界 budget、deduplicate 同一 verification pass 的已驗證 physical dependencies；被 evict 者要重新驗證而非略過完整性，保留所有 logical history。Regression 應量 proof bytes/rows、eviction/tamper miss、cold startup 與 memory cap，而非只看 versionReconstructions 次數。

### M-02 / Medium — A startup IPC EPIPE is misclassified as unsupported backend

`lease.js:28–30` 將 child 的任何 `error` 事件都當作啟動 backend 失敗，但 `spawn` callback 的 `child.send(open)` 沒有 callback 處理已退出 child 的 IPC error。忙碌的真 flock 可以先退出，再由父端 startup send 得 EPIPE；原 OS lease 仍正確拒第二 writer。

先做 200 次無注入 contention，200/200 都回正確 `STORAGE_UNAVAILABLE:73`。再只在獨立 spawn observer 中讓 parent 的 spawn callback 延後 20ms，真 flock/production source 照常執行：**20/20 回 `UNSUPPORTED_STORAGE / Cannot start OS lease backend / cause=EPIPE`**，observer 捕捉 `errno=-32, syscall=write`。CURRENT bytes、lock inode 與第一個 writer ready 全保持。這是已重現的 IPC 錯誤分類 race，不是 filesystem unsupported 或雙 writer 成功；最初 native-suite 那一次沒有捕捉 errno，不能事後斷言該次必然同因。

最小建議：為 startup `child.send` 設 error callback，區分真正 spawn failure 與 exit-before-IPC；在已知 child exit 73 時回穩定 contention error，未知 transport/startup 結果仍保守 recovery-required，保留 bounded startup timer。不得忽略所有 IPC errors、刪 lock 或允許第二 writer。Regression 應含無 delay 與 parent scheduling delay 的實際 OS contention。詳見 [200 次正常診斷](evidence/pr1d-native-logs/lease-contention-results.json)、[20 次 scheduling reproduction](evidence/pr1d-native-logs/lease-delayed-parent-results.json)與 [error events](evidence/pr1d-native-logs/spawn-errors.jsonl)。

### Closed / disproved hypotheses and test correction

Historical Registry 的 Binding 使用各自 Registry；既有 native historical update/removal regression 通過。Cache 在仍受保護的 historical generation 或 Locator page 被 atomic inode replacement 時，會失效、拒 ACK、fence writer 並於 restart 保持 read-only。這兩項沒有獨立重現的 integrity defect。

初次 cache-Locator 反例 `Missing expected rejection` 是**本輪 fixture 假陽性**：`legacy:true` 同時傳入 lifecycle options，結果 lifecycle 已合法 repoint resolver，被破壞的舊 Locator 已不再是 live dependency。已修正 fixture，並先 assert resolver 確實仍指向該 Locator，再驗證拒絕。first 20-case run 為 17 pass/3 fail；修正後 21-case run 為 19 pass/2 個真 G2 fail；補上 actual partial-write injection 後 final 22-case 為 20 pass/2 fail。原始 source/tests 未改；失敗版 harness 快照及 logs 保留。

## 4. Temporary attribution / crash matrix

實際追蹤 `registerTemporary → durableCreate claim (wx/write/file fsync/dir fsync) → temp create/write/file fsync → rename → parent fsync → claim unlink/claim-dir fsync → startup inventory/classification → sole Root retention → G2 plan/quarantine/grace/unlink`。詳細 stages、typed errors、exact bytes 與 Ledger/cardinality assertions 由原始/native suites及 independent harness 保留。

| Boundary / condition | Actual evidence / result |
| --- | --- |
| durable claim、temp 尚未建立 | SIGKILL `temporary-claim.after-dir-fsync` / `staged.before-write`；aborted/no false ACK，retry 一次 effect |
| partial temporary write | opt-in FileHandle preload 在 owned generation temp 真寫前半 bytes 後 SIGKILL；partial bytes 保留、CURRENT 不變、無 ACK、restart 正確 RO；屬明示應用層 partial-write injection |
| 完整 temp 未 fsync / 已 fsync / rename 前後 / dir fsync 前後 | 原始與 native fault suites、獨立 8-stage cases；whole Root / old-or-new visibility、retry/effect=1 |
| CURRENT rename → directory fsync → ACK 前 | 既有 native cases通過；新 repeated-restart/後續 commit 反例 H-01 失敗 |
| startup classification / historical reconstruction 中斷 | root-scoped preload 在真 production read 完成後 SIGKILL，stderr marker 證明命中；下一次 reopen 能安全恢復，非只在 startup 前 kill |
| G2 plan / quarantine / final unlink | H-02 的 2 fail；after-unlink case pass，virtual clock 保原 DAY 門檻 |
| backup 中斷、fixed Root + later ACK、manifest last、restore | Native 原始 backup tests執行；supported Doc-only closure、history/Ledger 保留、續作及 RO restriction assertions |
| EIO / ENOSPC / EXDEV、corrupt CURRENT/root/registry/generation/journal、stale CURRENT | Native 原始 suites真程式 + adapter injection；無不實 ACK、不得猜舊 Root |
| corrupt claim schema/hash、modified temp bytes、missing claim/Journal | 獨立 5 cases：RO、拒寫、原始 bytes 保留 |
| competing claim owners / reused transaction owner / same immutable retry | 原始衝突 + 新 same-owner/same-target 反例安全拒；重試/反覆 restart 不增加 Ledger effects |
| unknown legacy PR-1C atomic temporary | native 原始 case保留檔案且 RO，不按名稱/年齡刪 |
| active pins / GC / history / backup | Native lifecycle tests：FD/pair fixed、old physical reader blocks G1、release 等 quiescence、所有 fixture revisions hash reconstruct、backup pin + RO restore |

所有 destructive actions 只在 owned disposable roots。上述 errors 是 application adapter/preload 注入，SIGKILL 是 process crash；沒有真的填滿磁碟、製造 filesystem/block-device corruption、斷電或重掛 user volume。Native barrier calls 返回成功不是 host/Windows/VHDX/實體硬體 honoring flush 的認證。Unsupported mount 的 negative branch 在 ext4 可能 early-return，不把它當其他 filesystem已驗證。

## 5. Native ext4 performance / CPU / heap / GC

與原 remediation 相同 payload/command/stroke workloads，profile/document persistence 必須改為 native durable。Capacity options/auto maintenance 與 command pattern 保持對應原 harness；新加 p95、phase diagnostics、cache stats、history hash reconstruction 與 profiling。每組一輪，OS page cache、硬體與原 tmpfs runner 不同，**不作跨環境 speedup / SLA 宣稱**。

| Workload | Commands | Commit p50 / p95 / max ms | Peak worker RSS MiB | Files | Allocated bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 128KiB | 12 | 843.0 / 1,116.3 / 1,116.3 | 168.9 | 310 | 1,576,960 |
| 1MiB | 8 | 1,991.9 / 2,285.6 / 2,285.6 | 186.8 | 196 | 1,978,368 |
| 8MiB | 4 | 11,224.7 / 11,537.9 / 11,537.9 | 537.9 | 98 | 8,876,032 |
| strokes | 8 | 1,429.4 / 2,212.5 / 2,212.5 | 155.8 | 196 | 1,134,592 |

[實測 metrics](evidence/pr1d-native-logs/metrics-capacity.json)。所有版本逐 hash 重建；128 KiB 為 12、1 MiB/strokes 各 8、8 MiB 為 4。8 MiB 仍只有一個 full anchor + 3 deltas、約 8.88 MB allocated；低磁碟 amplification 不代表低 RSS。原 tmpfs 的 max 900/3254/14820 ms、RSS 170584/213800/512008 KiB 只是舊環境對照。

8 MiB 第 2–4 筆內部 build/preflight 約 4.27–4.38s、candidate verification 約 4.74–5.80s；stage/prepare 約 0.27–0.32s、CURRENT publication 約 14–16ms、post-publication 約 56–60ms。Internal `totalMs` 不包含全部 IPC/入口 parse，與 round-trip latency 不應強行相等。原 warm Cache 只重建 4 個新 versions，record cache 最後約 16 MiB，Registry cache 約 1 KiB；不能用「只重建一次」推論其他校驗工作已常數化。

[獨立 8 MiB CPU/heap/GC profile summary](evidence/pr1d-native-logs/profile-summary.json)與 lossless gzip 原始 [CPU](evidence/pr1d-native-logs/8MiB-profiled-58999.cpuprofile.gz)、[heap](evidence/pr1d-native-logs/8MiB-profiled-58999.heapprofile.gz)、[GC/memory observation](evidence/pr1d-native-logs/8MiB-profiled-58999.observation.json.gz) 保留。Profiling 只針對 8 MiB 四筆工作負載，不冒稱四組都有 CPU profile；其 observer 有 overhead，與 uninstrumented timings 分開。

- Profiled max RSS 540836 KiB（約 528 MiB），採樣 peak heapUsed 399960440 bytes（約 381 MiB）、heapTotal 436314112 bytes（約 416 MiB）、external 約 26 MiB。profile 結束記錄 heapUsed 約 41 MiB、heapTotal 約 75 MiB、RSS 約 179 MiB。RSS/high-water 不等於 live JS heap 或 cache bytes。
- 包含已被 minor/major GC 回收物件的 heap sampling 估計累積配置約 **3.77 GB**；encode/join 配置約 2.17 GB，hash update 約 403 MB，JSON schema transform 約 361 MB。這是累積採樣估計，不能當同時存活大小。
- CPU sampled wall 約 42.66s，idle 約 3.16s；self visit/addString 約 29.56s。inclusive assertJson 約 31.19s、canonicalJson 約 21.24s、Zod parse path（含 guards/transforms）約 18.52s。Inclusive rows 重疊，不能相加或把全部歸罪 Zod 本體。
- 觀察 457 個 GC events、總約 462ms（事件與 Inspector CPU 的 GC sample 不完全同一口徑）。大型暫存 string/object/Buffer 與 V8 heap expansion 是高 RSS 的主要證據方向，非已證明長期 cache leak；未做移除單一呼叫的 ablation，不能給唯一 root cause 或精確獨立貢獻。
- Minimal performance recommendation：同一 transaction 對已驗證 immutable snapshot 的重複 canonical/parse/hash 工作應以可驗證的共用結果或有界編碼減量；保 strict schema、byte limits、全部 logical hashes、physical invalidation 與 ACK barriers。需另行授權，這裡沒有套 production optimization。

## 6. Controlled long-history / startup qualification

[完整 25/50/100 原始 metrics 與決策](evidence/pr1d-native-logs/history-summary.json)。以下 ms 為 commit round trip；open/verify 為秒。

| Commits | Commit total s | p50 / p95 / max ms | Direct open / verify s | Normal client open s | Version physical proof rows | Files / allocated bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 25 | 20.57 | 801 / 1278 / 1304 | 3.17 / 1.50 | 3.38 | 625 | 791 / 3,579,904 |
| 50 | 79.42 | 1562 / 2715 / 3737 | 8.85 / 5.19 | 8.89 | 2500 | 2116 / 9,551,872 |
| 100 | 340.52 | 2965 / 7016 / 13187 | 27.02 / 18.17 | 27.84 | 10000 | 6190 / 28,389,376 |

每個規模使用新 Store，autoMaintenance=false、maxContentCommits=1000；不是執行 1000 commands。量實際 worker commit、replay、全版本重建與 allocated blocks。先 close worker，再以真 flock 的 direct coordinator probe量 recovery，另量未修改的正常 30 秒 client startup。direct probe 最多 60 秒診斷上限，不是提高 production/client timeout 以通過 gate。兩次 open 都是空 JS VerificationCache 的新 process，未 drop OS page cache；direct probe 合法推進 epoch，所以後續 client 多一筆 recovery generation/journal，不能宣稱兩者逐位元相同 Root。

三個規模皆 ready、無 client timeout、retry replayed=true、effects=N，全部 N 個版本重建通過。**100-command gate 本次功能成功，但 27.84s client open 只剩約 2.16s deadline 餘裕**，未進行 200/1000；沒有改 timeout 或將推測值標為實測。100 commits 共約 340.52s，後段 max 13.19s，沒有 OOM 或 corrupt/inconsistent recovery 的證據。8 MiB 大物件與長 history 是不同壓力；100-command commit worker RSS 180160 KiB，direct recovery 169200 KiB。

25/50/100 的 version physical proof rows 實測為 625/2500/10000；原始 Locator 的 delta spans 分別累計 300/1225/4950，warm `versionReconstructions=N` 不表示 physical proof revalidation 或 cold replay 是 O(N)。100 cold direct open 約 27.02s，其中 committed verification 約 18.17s；新增的非侵入 resourceUsage 記錄 user CPU 約 11.54s、system CPU 約 14.77s。這支持 validation/reconstruction 與大量 metadata syscalls 為主要成本，不能簡化成硬碟 flush 慢；CPU+system 約 26.31s 接近總 wall，但不是逐 syscall 的 exclusive latency profile。

來源碼還有 `temporary-attribution.js:27–38` 的全樹 inventory，startup 由 bootstrap 與 classification 各走一次，並有全 closure resync/journal recovery；verification 外的時間不能全部無證據歸為 disk wait。100 的 CPU counters 是只新增觀測欄位的 probe 版本，25/50 的原始 probe 亦保留；不修改 coordinator、caller timeout 或資料。未作 1000-command/revision-1000 checkpoint、完整冷 OS cache或硬體重啟 qualification。

## 8. Reproduction / evidence handling

既有 source/tests 與歷史 evidence 全部不改。新增獨立 tests 放在 evidence 的 `.mjs` entrypoints，**不自動加入原始 default test discovery**；必須明確跑它們，不能只看原始 449 green 就宣稱新 regression 通過。`superseded-current-regression.mjs` 預期 production 修復後才會 ready；本驗收分支故意保留真失敗，未修改 source 或斷言降標準。

在 repo、非 root estampes、Node 22 下，建立全新的 owned root，複製 `runner.py` 到該 root，建立 `tmp/`、`profiles/`。Runner 預設以自身所在目錄為 scratch，清除 inherited ESTAMPES_*，但會把 logs 寫入本 repo 的 evidence；使用全新的 run-name，遇已有同名 log 會拒絕覆寫。

```sh
pr1d_replay_root=$(mktemp -d /tmp/estampes-pr1d-native-replay-XXXXXX)
mkdir -m 700 "$pr1d_replay_root/tmp" "$pr1d_replay_root/profiles"
cp docs/rfc/unified-visual-architecture/evidence/pr1d-native-logs/runner.py "$pr1d_replay_root/runner.py"
python3 "$pr1d_replay_root/runner.py" replay-full-unique node --test --test-concurrency=1
python3 docs/rfc/unified-visual-architecture/evidence/pr1d-native-logs/prepare-native.py "$PWD" "$pr1d_replay_root/native-harness"
python3 "$pr1d_replay_root/runner.py" replay-native-unique node --test --test-concurrency=1 "$pr1d_replay_root"/native-harness/tests/persistence-*.test.js
python3 "$pr1d_replay_root/runner.py" replay-current-unique node --test --test-concurrency=1 docs/rfc/unified-visual-architecture/evidence/pr1d-native-logs/superseded-current-regression.mjs
python3 "$pr1d_replay_root/runner.py" replay-faults-unique node --test --test-concurrency=1 docs/rfc/unified-visual-architecture/evidence/pr1d-native-logs/independent-cases.mjs
```

這是重現指引，不是本輪額外執行的命令。完整 browser/CAS replay 先在新 root 安裝 venv requirements、Playwright browser 與必要 libraries：實際版本/命令見 environment/runs；將已驗證的 executable 寫入新 root 的 `browser-path`，勿沿用已刪除的舊路徑。`browser-libraries.py` 必須複製到新 root 再執行，避免把解壓檔寫進 evidence。若先 npm ci，需重新安裝可選 Playwright/PDF packages，並確認 lock-listed dependencies 不因 no-save install 被升級。

`benchmark.mjs capacity`、`history 25` / `50` / `100` 為本輪真實命令。8 MiB profile 用 `PR1D_PROFILE_MODE=1`、`NODE_OPTIONS=--import=<absolute profile-preload.mjs>` 執行 `benchmark.mjs profile8`，資料寫入新 root 的 profiles；`summarize-profiles.py` 保留原始 gzip bytes 及衍生 summary。重跑前用新 evidence destination/run-name 保存 metrics（benchmark metrics 名稱固定），不能覆蓋本輪檔案。不要盲跑 200/1000，也不要調 client timeout。

Startup/partial-write preloads 明確限定該 child root，只在真 production I/O 後 SIGKILL；spawn observer 原樣委派真 spawn，只有 `PR1D_SPAWN_DELAY_MS=20` 場景故意延後 parent callback。這些是 disposable test injection，不是 production source 修改。CPU/heap observation 僅作用於該 worker，會增加觀測成本。原始失敗 harness、source hashes 與 [執行 manifest](evidence/pr1d-native-logs/manifest.json)保留版本對應。

本輪第一次 `docs-final` 因報告先連到尚未產生的 manifest，Exit 1；補上 manifest 後重跑通過，原 log 保留。這是本輪文件組裝錯誤，不是 production/storage 缺陷。

Raw `.log` 以目錄內 `.gitattributes` 的 `-text -whitespace` 保留 bytes/行尾/TAP assertion 空白；source/scripts/report 的 whitespace checks 仍啟用，沒有修改 root attributes 或舊 logs。原始 profile 使用無損 gzip；manifest 同時保存 compressed 與 decompressed SHA256。未修改 profile 資料來隱藏 hot path 或失敗。

## 9. Remaining blockers / recommendation / commits

1. **必修 H-01/H-02**，在相同 baseline/native environment 重跑新增紅燈；未取得 production source 修改授權，因此保留可重現失敗與最小建議，不製造 patch 或把錯誤期待改成通過。
2. 8 MiB 約 538 MiB RSS、11.54s max commit 仍無核准 memory/latency budget；profile 支持重複 guard/canonical/transform 暫存配置方向，但未修復或完成固定 runner 三輪校準。
3. 受控 history 的實際結果與尚未執行 gate 見上節；**1,000-command、revision-1000 operational checkpoint/restart 未執行**，不能外推通過。10 GiB fill/recovery、100k strokes、64-reader/1 GiB default stress、完整容量/backup races與長期 metadata/ledger growth仍未驗收。
4. Native suite 出現一次 OS lease backend startup error，後續 standalone pass 不能證明穩定性；初次 root cause 沒捕捉到，不捏造 EAGAIN/資源耗盡結論；M-02 的可重現 IPC EPIPE 分類也應修正。Default parallel stability 未驗。
5. 未驗 hardware/VM/block-device power loss、Windows/VHDX flush、其他 allowlisted部署/XFS或未知/unsupported filesystems；不把 process SIGKILL / injected EIO 當真實斷電。
6. Production profile approval、old-binary fence、trusted Host edit authorization、跨 CAS/Surface/Workspace/binary assets 整合、migration/Authority Cutover/PR-1B、可續寫 restore都未完成或未授權。

Regression/harness commit：`5cc57275b4be71ae7955c1105bb87e247a9818b2`（13 個獨立 test/profiling/reproduction scripts）。第二個獨立 commit 只收本報告、raw logs、profiles、source/run manifests 與失敗版本快照；其 SHA 由最終 Git 回報，避免自我參照。最終工作樹 clean，專用 scratch 已清理；所有既有本地/remote-tracking refs 除 validation branch 外維持原值。

**結論：WSL2/ext4 確實可執行 native durable code，原始全測與 browser gate 已有當前證據；PR-1D remediation 的完整 native recovery/lifecycle 保證未達成，Acceptance 維持 BLOCKED。** 未修改 main/remediation source branch、未 push/merge/release、未啟動 production writer、未遷移使用者資料、未開始 PR-1B。
