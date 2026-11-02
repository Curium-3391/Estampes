# PR-1D Performance & Recovery Remediation Report

Status: **IMPLEMENTATION BLOCKED**. 本輪完成可審查的效能修補、atomic temporary 歸屬與 recovery 實作；尚未取得原生 ext4/XFS 新程式碼驗收，8 MiB 記憶體峰值仍過高，1000-command 與完整容量／power-loss gate 未執行。因此不得啟用 production writer、進入 PR-1B、遷移資料或把此狀態解讀為 Architecture Approval。

## 1. Scope、baseline 與 commits

| Item | Observed |
| --- | --- |
| Required base | `322038b4b6e24fef0210fc04781e87181f879d8c` |
| Branch | `fix/unified-visual-architecture-pr1d-remediation` |
| Performance commit | `3d71254` |
| Temporary attribution/recovery commit | `b163a85` |
| Runtime | Node `v22.23.4`, Linux x64 |
| Workspace / disposable store | overlayfs / tmpfs |
| Native ext4/XFS | **UNAVAILABLE — external gate** |

只修改隔離的 `src/persistence/` 實作、disposable tests、benchmark/evidence 與本架構文件。未修改 `server.js`、MCP tools、legacy canvas/storage、Graph、CAS、Module Runtime、Workbench 或使用者資料。本輪沒有 push、merge、release、migration、PR-1B 或 production activation。

## 2. Profile finding 與修補

### OBSERVED before

`CommitCoordinator.#publish()` 對 prepared candidate 執行 `verifyPreparedClosure()`，CURRENT durable 後又執行完整 `loadCommitted()`。`loadSnapshot()` 每次逐一重建所有 Locator versions，再逐一 materialize 所有 retained Registry；`readVersion()` 每次從 full anchor 重播 delta chain。這使 retained history 在每次 write 中反覆 canonicalize、parse、hash 與 reconstruct。

原始 commit 的真 coordinator workload（tmpfs/process-crash profile）顯示：

| Workload | Commands | Max commit before | Peak worker RSS before |
| --- | ---: | ---: | ---: |
| 128 KiB title edit | 12 | 6,362 ms | 155,376 KiB |
| 1 MiB title edit | 8 | 24,525 ms | 203,664 KiB |
| 8 MiB title edit | 4 | 59,808 ms | 515,548 KiB |
| 12×64-point strokes/command | 8 | 9,769 ms | 126,796 KiB |

Exact remediation commit rerun：

| Workload | Max commit after | Peak worker RSS after | Max latency change |
| --- | ---: | ---: | ---: |
| 128 KiB title edit | 900 ms | 170,584 KiB | −85.9% |
| 1 MiB title edit | 3,254 ms | 213,800 KiB | −86.7% |
| 8 MiB title edit | 14,820 ms | 512,008 KiB | −75.2% |
| 12×64-point strokes/command | 2,118 ms | 152,640 KiB | −78.3% |

Latency下降是 OBSERVED 單次 run，不是 SLA。8 MiB RSS只由 515,548 KiB降至512,008 KiB，幾乎沒有改善，仍是 exit blocker。Raw artifacts與SHA-256見 `evidence/pr1d-remediation-manifest.json`。

### IMPLEMENTED

- `VerificationCache` 以 logical ref/Locator row hash 綁定 proof；每次 reuse 都重新檢查實體檔案的 device、inode、size、mtimeNs、ctimeNs。內容或 identity 改變便失效並重新 reconstruct。
- Document record LRU 上限 24 MiB，Registry proof/cache 上限 32 MiB；cache 不是 authority，也不跨 process 保存。
- retained Registry proof 綁定 logical closure、Resolver Locator rows 與 hash-addressed Registry pages。歷史 materialization 成功後可 reuse，但實體 page fingerprints 與目前 Locator rows 仍需相符。
- prepared candidate 仍完整執行 typed closure、hash、reference、Ledger、membership 與 recovery-catalog 驗證。CURRENT durable 後改驗 exact CURRENT bytes、prepared root identity 及本 transaction 全部 staged paths/hash/length，不再第二次重建所有歷史 versions。
- diagnostics 提供 build/preflight、stage/prepare、candidate verification、CURRENT publication、post-publication 與 total timing，以及 cache hit/reconstruction counters。最近 transaction ring 上限 64。
- malformed／被替換的 committed generation 轉成 storage-integrity failure；live writer 在 ACK 前進入 read-only recovery。新 regression test 實際替換 generation bytes，確認 cache 不會隱藏 corruption。

這不是跳過完整性檢查。Cache proof 的任何 physical fingerprint、Locator row、Registry root、logical closure 或 resolver 關係變更都會重新驗證；restart cache 為空，會從 durable bytes 重建。

## 3. Atomic temporary attribution contract

每次 atomic write 在建立 temporary **之前**，先 durable 建立 `estampes.temporary-claim/1`：

```text
{
  "schema": "estampes.temporary-claim/1",
  "claimId": "<uuid-v4>",
  "owner": { "kind": "transaction", "id": "<uuid-v4>" },
  "finalPath": "visual-registry/CURRENT.json",
  "temporaryPath": "visual-registry/CURRENT.json.tmp-<claimId>",
  "hash": "<sha256>",
  "bytes": 123,
  "label": "current"
}
```

Owner kinds 限於 `transaction`、`bootstrap`、`backup`、`restore`；owner ID 是 server 產生的 UUID，不接受 client/module ID 作為授權。Claim 使用 `open(wx) → write → file fsync → claim-directory fsync`，其後才建立 exact temporary path。Temporary write、rename、target-directory fsync 完成後才 unlink claim 並 fsync claim directory。正常完成不永久累積 claim。

### Recovery classification

1. Startup 遞迴 inventory 所有 `*.tmp-<uuid>`；找不到 exact claim 時保留原檔並進入 read-only recovery。
2. Claim schema、filename、temporary/final relation、owner 或 hash 不一致即 fail closed；同一 final path 有兩個 surviving owners 視為 ambiguous，不能猜測。
3. Transaction membership 存在時，final target 必須符合 claim；否則 committed transaction 不完整，進入 read-only recovery。
4. Final target 符合 claim則分類 atomic operation 為 `completed`；未 committed 且 final 不符則為 `aborted`。存在 temporary 時必須符合 exact hash/length。
5. 分類以 `estampes.temporary-recovery/1` 寫入 sole CommitRoot retention index；只有此 durable classification 才能讓 claim/temporary 進入 G2 plan。
6. G2 plan 固定 exact path/hash，quarantine 後至少等待 24 小時且 clock 不回退，再 re-mark、re-hash、unlink。Plan publication同時移除 temporary recovery record；GC plan本身成為後續 durable proof。
7. Bootstrap format rename crash 可在「沒有 CURRENT、沒有 transaction」的 pristine store 續建 genesis。任何 established store 缺 CURRENT 都不會被當成新 store。

Backup closure 在 temporary recovery record 存在時包含 claim 與 temporary；restore artifact 仍維持 read-only continuation restriction。Unknown legacy temporary 不因名稱或年齡自動刪除。

## 4. Fault evidence

新增 process-crash tests 實際 SIGKILL／fault：

| Stage / condition | Expected and observed result |
| --- | --- |
| claim before write / file fsync / directory fsync | 無 unattributed effect；restart either has no claim or exact claim，Document effect 0 |
| staged temporary before file fsync | exact owner/hash可讀；restart分類 aborted；G2 quarantine 等滿一天才刪 |
| claim before unlink | final atomic member與claim一致；restart分類，不重做 content effect |
| CURRENT after rename | committed effect preserved；claim分類 completed；不回退 CURRENT |
| bootstrap after rename | exact format claim idempotently完成；pristine genesis重建 |
| unclaimed temporary | 原檔保留，writer read-only recovery |
| two claims / one target | ambiguous ownership，writer read-only recovery |
| live generation replaced | cache invalidates；無 ACK；writer read-only recovery |

既有 transaction、GC、backup、ENOSPC、journal、pin 與 COW tests 未降低期待值。Native durable/power-loss semantics仍未由 tmpfs fault injection證明。

## 5. Long-history qualification

100-command small-document run 是實際 coordinator/worker、100 個 retained logical versions、100 個 durable request keys，非算術模型：

| Metric | Observed |
| --- | ---: |
| Commit total | 207,328 ms |
| p50 / p95 / max | 2,019 / 4,268 / 8,269 ms |
| Recovery open | 23,843 ms |
| Recovery committed verification | 17,542 ms |
| Peak worker RSS | 177,764 KiB |
| Allocated bytes / files | 27,209,728 / 6,182 |
| Version reconstructions during writes | 100 for 100 versions |
| Retry after restart | `replayed:true`; content effects remain 100 |

Candidate verification仍隨 retained metadata 增長；100-command max 和 restart 已接近 internal 30-second startup timeout。依此實測，1000-command 不是本輪可合理完成的 qualification，且沒有執行。不能以外推值宣稱通過；這是明確的 long-history exit blocker。

## 6. Current limitations and gate

- 8 MiB latency明顯改善，但峰值 RSS 仍接近 0.5 GiB。Zod/canonical JSON/document closure 的大型 transient allocations 尚未達可批准 budget。
- 100-command 寫入與 recovery仍呈 history-length cost；1000-command、revision-1000 operational checkpoint 與 restart未執行。
- 10 GiB fill、100k strokes、64 readers、完整 backup/capacity races 與 block-device power-loss仍未執行。
- 工作環境是 overlayfs/tmpfs。`linux-local-durable` 的 ext4/XFS guard未放寬；本輪新 attribution/cache code 尚無 native-positive evidence。
- Benchmark 是單次 disposable profile，不是 production SLA 或 statistically approved budget。

### Validation record

| Command / scope | Result | Exit | Evidence boundary |
| --- | --- | ---: | --- |
| `npm run docs:check` | PASS；93 Markdown files、55 tools、22 config variables | 0 | 文件結構與引用檢查，不代表 storage gate 通過 |
| `npm run release:check` | PASS | 0 | 現行 release metadata 檢查 |
| Node 22 `check-consistency.mjs` | PASS | 0 | RFC/ADR/PR/UVA/OD、source seals、remediation allowlist |
| Node 22 `validate-contract-examples.mjs` | PASS；9/9 formal examples | 0 | Proposed contracts；不註冊 production API |
| attribution/performance/lifecycle/backup/transaction suites | PASS；54 pass、0 fail、1 skip | 0 | skip 是 native ext4/XFS positive gate |
| Node 22 full `node --test` | 440 pass、7 fail、2 skip；449 total | 1 | 7 fail 全部因 Playwright Chromium executable 不存在；2 skip 包含 native filesystem gate |
| `npx playwright install chromium` | FAIL；CDN 回覆 `403 Domain forbidden` | 1 | 環境依賴無法補裝；未將 E2E 標為通過 |

Full-suite 的 7 個 dependency failures 位於 cards、layers、surface-open、upload、workbench 與 zoom-perf browser tests。它們沒有提供 browser product assertion 的 pass/fail evidence；本報告不把它們歸類為已證明的產品回歸，也不把缺少 executable 當作 skip。Performance、temporary attribution 與 tamper regression 的 Node tests 已通過，但原生 durability、真實 power-loss 與上述 browser scopes仍未完成。

## 7. Exit recommendation

**IMPLEMENTATION BLOCKED**

保留 `3d71254` 與 `b163a85` 供 storage/security review。下一 gate 必須至少包含：原生 ext4/XFS 全套新 fault tests、8 MiB transient-memory reduction、1000-command/checkpoint/restart qualification、完整容量壓力與 independent storage review。PR-1B、production writer、migration、push/merge/release仍未授權。
