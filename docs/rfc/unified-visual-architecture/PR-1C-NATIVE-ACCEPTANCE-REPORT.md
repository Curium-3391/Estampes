# PR-1C Native ext4 Acceptance Report

日期：2026-11-02（Asia/Taipei）。狀態：**PASS — WSL2/ext4 Functional Acceptance（isolated testing only）；正式部署仍未驗收**。

本報告補充 [PR-1C 原始實作報告](PR-1C-IMPLEMENTATION-REPORT.md)，只更新 WSL2/ext4 隔離功能驗收的證據；舊報告與舊環境的 Skip 紀錄保留。這不是正式部署、Windows/VHDX flush 或實體磁碟斷電認證。

## 環境與執行邊界

| 項目 | 實測 |
| --- | --- |
| 初始 Git HEAD | `5549f10586dc17e0a802c42dd6c37ebaa70ad80a`，完全符合要求；初始 working tree clean |
| 原分支 / 驗收分支 | `feat/unified-visual-architecture-pr1c` / `codex/pr1c-native-ext4-acceptance` |
| 系統 | WSL2，Ubuntu 24.04.1 LTS，Linux `6.6.87.2-microsoft-standard-WSL2`，x86_64 |
| 執行身分 | `estampes`，UID/GID 1001；npm、Node writer、測試及 Git 寫入皆由此非 root 使用者執行。工具初始 shell 是 root，僅用來檢查環境並切換身分 |
| Node / npm | `v22.23.4` / `10.9.9`，明確使用 `/home/estampes/.nvm/versions/node/v22.23.4/bin` |
| 工作區 / 暫存目錄 | `/home/estampes/projects/Estampes` / `/tmp/estampes-pr1c-native-x8qc79vm/tmp` |
| 核心掛載證據 | `findmnt -T`：兩者均 `/dev/sdd`、`ext4`、`rw,relatime,discard,errors=remount-ro,data=ordered` |
| 引擎原生檢查 | 未偽造 statfs 或 mountinfo；`inspectPlatform` 實際回 `linux-local-durable`、`fsType=0xef53`、`device=2096`、`durability=durable` |
| OS lease | 真正 `/usr/bin/flock`；沒有刪除、偷取或替換 lease |
| Python / 瀏覽器 | Python 3.12.3；專用 venv 的 SymPy 1.14.0、mpmath 1.3.0；Playwright Core 1.56.1、Chromium 141.0.7390.37 |
| 可選 PDF 依賴 | pdfjs-dist 4.10.38、@napi-rs/canvas；實際版本列於 environment.json |

[環境命令、exit codes、原始輸出及版本](evidence/pr1c-native-logs/environment.json)。`stat -f` 的 ext-family 名稱不足以識別 ext4，本次以 `findmnt` 與引擎的 `/proc/self/mountinfo` 核對，未只憑 magic 宣稱 ext4。

## 資料與清理檢查

先檢查 `tests/fixtures/uva-persistence.mjs`、`tests/persistence-platform.test.js`，再檢查其他 Node 測試的 `rm`/`unlink` 及 Store 設定。PR-1C 的 root 都來自 `mkdtemp(join(tmpdir(), "estampes-pr1c-"))`，owned 0700；清理只刪該 root。Fixture 先 SIGKILL、等待 writer exit，才 recursive rm；平台測試的 temporary helper 也只清理自行建立的目錄。若 open 在 cleanup hook 註冊前失敗，最多留下該 disposable root，沒有擴大刪除範圍。

本次 runner 使用新的 owned 0700 暫存根目錄，`TMPDIR` 指向其 `tmp/`。清除繼承的所有 `ESTAMPES_*` 設定，再明確設 `ESTAMPES_STORAGE_DIR=""`、`ESTAMPES_ACCESS_KEY=""`、`ESTAMPES_STORAGE_RETENTION_DAYS=0`。未自行指定 Store 的服務使用 memory；其他測試自行建立專用 temporary Store。專用暫存根目錄已於驗收後清理，raw logs 留在 evidence。未打開、刪除或遷移真實使用者資料，未連接正式 Store；亦未終止其他工作階段的程序。

初始 root shell 找不到 Node/npm，Git 亦以 ownership protection 拒絕；改用既有擁有者與 NVM PATH 解決，沒有加入 `safe.directory` 例外。`npm ci` Exit 0。可選測試依賴以 `--no-save --package-lock=false` 安裝；可選安裝曾自動更新 hono/jose，已還原 lock 中的 4.13.14 / 6.2.14，最終全測前核對所有已安裝 lock-listed packages 版本相符。`package.json`、`package-lock.json` 均未更動。Python 初次 venv bootstrap 因缺 ensurepip Exit 1，改由 system pip 的 `--python` 安裝至專用 venv 成功。瀏覽器缺的三個 Ubuntu libraries 僅下載 .deb、解壓至 disposable root，透過 `LD_LIBRARY_PATH` 使用，未安裝 system packages。`npm ci` audit 原有 1 high severity 通知保留於 log，未做超出範圍的 audit fix。

## Historical Registry / Binding 調查

指定 HEAD 的 `src/persistence/records.js` 已在 `materialize(registry)` 內建立局部 `bindings` Map，並由參數 `registry` 填入；Current 用 `materialize(indices.registry)`，Recovery catalog 則對每個 retained Registry 呼叫 `materialize(registry)`。**沒有重現 Review 描述的「以 Current Registry 的 Binding materialize Historical Registry」錯誤，因此未修改 production source，也沒有可誠實宣稱的原始程式 red→green 修復。**

新增兩個 regression cases，分別使用 process-crash-test 與 native durable profile：

1. 原子提交 parent embed + child，保存原始 envelope 與 ACK。
2. 將 child、embed object 與 canonical Binding 的 sourceRevision 更新至 2，正確遞增 Document/Scene/object revisions，驗證舊 envelope 仍還原原 Binding。
3. 刪除 embed 與 Binding，驗證 Current、兩個 Historical envelopes 各自 materialize 正確版本。
4. SIGKILL/reopen 後 ready，Current 資料完整，兩個舊 request 精確 replay 原 ACK，ledger content effects 仍為 3。

未改動的 production source 上，新增測試初跑即 **2 pass / 0 fail / 0 skip**。另只在專用 disposable source copy 注入 [錯誤差異](evidence/pr1c-native-logs/binding-mutation.diff)，將 Binding 來源改為 `indices.registry`：相同兩測試均以 `Canonical embed binding differs from object` **失敗，Exit 1**。這是刻意 mutation 的負向證據，**不是 baseline bug 的重現，也不是工作區修復前的失敗**。工作區 `records.js` 與預期 HEAD byte-identical。測試 commit 將如實命名為 regression coverage，沒有捏造 production fix。

## 命令與結果

所有列出的 Node/npm 命令均經非 root runner 執行；其環境、完整 argv、UTC 開始時間、耗時、Exit Code、TAP counts 與 log SHA256 見 [完整驗收 manifest](evidence/pr1c-native-logs/manifest.json)與 [逐次執行紀錄](evidence/pr1c-native-logs/runs.jsonl)。臺北時間為紀錄 UTC +08:00。[Runner 原始碼](evidence/pr1c-native-logs/runner.py)亦保留；重現時須在新 disposable root 複製並建立 `tmp/`，不應把 evidence 目錄本身當 test root。

| 命令 / 執行 | Exit | Pass / Fail / Skip |
| --- | --- | --- |
| `npm ci` | 0 | 安裝成功；[log](evidence/pr1c-native-logs/npm-ci.log) |
| `node --test tests/persistence-platform.test.js`，baseline | 0 | 6 / 0 / 0；native durable ACK 正向案例實際執行 |
| `node --test tests/persistence-transactions.test.js tests/persistence-faults.test.js`，新增測試前 | 0 | 60 / 0 / 0 |
| `node --test --test-name-pattern=historical tests/persistence-transactions.test.js`，未改 production source | 0 | 2 / 0 / 0 |
| 同上，僅 disposable Current-Binding mutation copy | 1（預期） | 0 / 2 / 0；測試能抓到錯誤 |
| `node --test <native-harness>/tests/persistence-transactions.test.js <native-harness>/tests/persistence-faults.test.js` | 0 | 61 / 0 / 0 |
| `npm test`，預設併行初跑 | 1 | 403 / 1 / 0；Module network audit assertion 失敗；所有 PR-1C cases 通過 |
| `node --test tests/persistence-platform.test.js`，與全測同時複測 | 1 | 5 / 1 / 0；第二 writer contention 取得 `Cannot start OS lease backend`，未取得預期 exit 73；native 正向仍通過 |
| `npm test -- --test-concurrency=1`，最終 Node 22 全測 | 0 | **404 / 0 / 0**；cancelled/todo 亦為 0，沒有篩除任何 test |
| `node --test tests/persistence-platform.test.js`，最終獨立重測 | 0 | 6 / 0 / 0；native 正向再度實際通過 |
| `node --test tests/packages.test.js`，獨立診斷 | 0 | 24 / 0 / 0 |
| `node --test docs/rfc/unified-visual-architecture/evidence/contract-validation.spec.mjs` | 0 | 22 / 0 / 0 |
| `node docs/rfc/unified-visual-architecture/evidence/validate-contract-examples.mjs` | 0 | 9 formal examples、9 fences、7 schemas、0 errors |
| `node docs/rfc/unified-visual-architecture/evidence/check-consistency.mjs` | 0 | 架構、授權範圍、95 pre-existing hashes、historical evidence 及契約一致 |
| `npm run docs:check` / `npm run release:check` | 0 / 0 | 文件及版本一致；沒有執行 tag/publish |
| `python -m unittest discover -s cas-service/tests -v` | 0 | 17 / 0 / 0；teardown ResourceWarnings 詳見 log |
| `node --check server.js` | 0 | 語法檢查通過 |
| `git diff --cached --check` / `git diff --check 5549f10586dc17e0a802c42dd6c37ebaa70ad80a` | 0 / 0 | 程式與報告無 whitespace errors；raw logs 保留原始空白 |

Native harness 只把 disposable fixture 的 profile / document persistence 及對應 ACK 期待改為 durable，並把新增雙 profile case 限為 durable；Recovery 測試中的 explicit reopen profile 也一併改成 durable。生產 `src/` 直接連結工作區，沒有改 allowlist、barriers、Lease 或 Recovery；[完整替換內容及產物 SHA256](evidence/pr1c-native-logs/native-harness.json)保留供重現。可用 [重建腳本](evidence/pr1c-native-logs/prepare-native-harness.py)在新的 disposable 目錄重建，並驗證 SHA256。這項 61-case 補充演練與原始測試結果分開，沒有冒稱原始測試全部預設使用 durable profile。

併行初跑的 Module 失敗位於既有 `tests/packages.test.js:397`；`src/modules/audit.js` 的 record 將 append 排入 chain，但 read 沒有等 chain/flush，測試亦在 flush 前讀檔，有讀寫競態的可能。未改此 scope 外的 module 程式或測試。平台 contention 初次複測的 spawn 失敗只留下通用錯誤，確切 OS cause 未捕捉，不能宣稱已證實是資源耗盡。獨立平台與 packages 重測皆通過；降低 runner 併行度不改任何 storage 保證，也不刪除測試。

## Fault Injection 與功能覆蓋

49 個 Fault/Recovery cases 在原始 process-crash-test profile 與 native durable harness 都執行：15 個 SIGKILL publication/barrier stages、13 個 file/directory fsync EIO stages、5 個 ENOSPC stages、2 個 EXDEV rename stages、6 類 corrupt metadata/data，以及 ACK replay、非權威高檔名、混合 roots、aborted prepared generation、Recovery ENOSPC、CURRENT rollback 拒絕、orphan bytes re-barrier、live tamper fencing 與 recovery outcome repair 再中斷。數量含以單一 case 執行多項 assertion 的 Recovery 案例。

驗證包含 whole-root visibility、未完成 transaction 不回 ACK、publication 後不確定性轉 read-only-recovery、重啟 deterministic recovery、精確 ACK replay、最多一次 ledger effect、真 OS lease contention/釋放、IPC client 終止不留 orphan writer，以及 intent→staging→prepared→CURRENT directory flush→ACK 順序。ENOSPC/EIO/EXDEV 是既有 fault adapter 的應用層注入，沒有真的填滿磁碟、製造壞區或跨裝置寫正式資料。

## 尚未滿足的正式部署條件

- WSL2 guest ext4 的 process crash / syscall 功能通過，不證明 Windows host、VHDX、Hyper-V、底層 filesystem/controller/磁碟在斷電時 honor flush。未執行 VM/host 強制斷電、block-device fault、實體 power-loss 或重啟後硬體持久性驗證。
- 本次僅驗此 WSL2/ext4 掛載；未驗 XFS、其他 Linux 部署、Windows native、macOS/APFS、Docker Desktop shares、NFS/SMB/FUSE。平台測試中 unsupported-mount case 在 ext4 提早返回，本次沒有實際提供不支援的 mount；不把該 case 的 Pass 當這些平台的負向驗收。
- 維持 `isolated-pr1c-testing` 限制、owned 0700 disposable roots、same-device、allowlist、真 file/directory fsync、OS flock 與 read-only-recovery；不啟用正式 writer、新 API、migration 或 authority cutover。
- PR-1D 的 retention/GC/compaction、長期 ledger/history growth、streaming/pack、quota/allocated-block、容量與記憶體校準、maintenance/backup，以及 PR-1B 的 old-binary fence、整合與 cutover 均未開始。
- Document-only complete closure 仍不涵蓋 CAS/Surface/Workspace transaction adapters、binary assets、domain 授權與真 Host 使用者動作。瀏覽器測試使用 fake host，不是 ChatGPT host 的端到端驗收。
- 併行初跑失敗與最終處置見上表及原始 logs；未刪除失敗證據。

初次 staged/baseline diff whitespace check Exit 2，僅因原始 assertion/browser 輸出自帶 trailing spaces。以 evidence 目錄內的 `.gitattributes` 僅對 `*.log` 設 `-text -whitespace` 保留逐位元原始輸出；未修改 raw logs、source 或報告的 whitespace 規則。後續 final diff checks Exit 0。

## 提交與結論

第一個獨立 commit：`1684335e7e463a0ea5bb1a560ed6565ef42299ae`，`test(persistence): guard historical binding registry isolation`，只提交 regression test。第二個 commit 只提交本報告、環境、原始成功/失敗 logs、可重現 harness 差異與證據 manifest；報告 commit SHA 由最終 Git 回報，避免自我參照。沒有 production fix commit，原因是指定 HEAD 的 Binding 行為已正確，不能把 mutation failure 當作原始缺陷。

**PR-1C 已達到本次指定環境的 WSL2/ext4 Functional Acceptance。** 已解除「缺少可執行原生 ext4 正向 profile」這一項環境阻擋：native durable ACK、原生掛載上的 transaction/fault/recovery、歷史 Binding 與完整 Node 22 序列測試均有實際通過證據。預設併行全測與同時平台複測曾失敗；最後序列全測與獨立平台複測通過，未宣稱併行穩定性已完全驗證，也未掩蓋初跑失敗。

這項結論不把 PR-1C 全部正式部署 gate 改成通過；上述 power-loss/host storage、平台、維護容量、整合授權等條件仍未滿足。main 與既有本地/remote-tracking refs 保持原值；所有提交都在 `codex/pr1c-native-ext4-acceptance`，未 push、merge、release，未開始 PR-1D 或 PR-1B。
