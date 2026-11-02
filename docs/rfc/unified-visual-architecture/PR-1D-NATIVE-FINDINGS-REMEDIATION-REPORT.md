# PR-1D Native Findings Remediation Report

日期：2026-11-03（Asia/Taipei）。**IMPLEMENTATION BLOCKED**。H-01、H-02、M-02 已在 process-crash profile 修復並加入永久 regression；M-01 已有有界 metadata，但 native ext4 reacceptance、cold recovery 與大型文件記憶體仍未過 gate。

## 1. Baseline / commits / scope

來源為 `codex/pr1d-remediation-native-ext4-acceptance` 精確 `05913e926aa07a528815a5f3f3d2078c108e8833`，其包含 `5cc57275…` 且兩者皆 descend from `c090d93…`；validation branch 對 `src/` 無變更。修復分支 `fix/unified-visual-architecture-pr1d-native-findings`：

- `ed3e96e`：H-01/H-02 temporary ownership與GC recovery。
- `1f9a0d8`：M-02 lease startup IPC分類。
- `41c34d8`：M-01 proof metadata budget與去重。

production變更只在 `src/persistence/`；沒有 server、MCP、legacy Canvas、Graph、CAS、Workbench、migration或authority cutover修改。原 native acceptance report/logs保持原 bytes與 BLOCKED 結論。

## 2. Red baseline / root causes

原始 `superseded-current-regression.mjs` 在本機重現兩個 process-crash H-01 failure：第二次 reopen 因 `Committed transaction has an incomplete attributed atomic file` 進入 read-only。兩個 native variants因 overlayfs被 allowlist正確拒絕。H-02 的原 native logs保留兩個 failure；本環境以相同 state sequence的永久 process-crash tests重現並驗證。

H-01 根因是 completed CURRENT claim 永久比較 mutable pathname。H-02 根因是GC plan原子移除 `temporary:<id>` 後，startup inventory又從尚未清理的claim重建它；unlink也缺少可區分「已執行未記帳」與外部遺失的durable intent。M-02 根因是 exit 73先於parent startup send時，EPIPE被通用 child error誤分類。M-01 是version/registry proofs重複保存physical path/fingerprint，未受payload cache上限控制。

## 3. Corrected ownership / GC state machine

H-01只對 `current` target接受歷史 supersession，且必須同時驗證：claim ID/owner/path/hash/bytes、CommitIndex member、immutable prepared record、prepared Root、Root generation/commit/registry identity，以及由該Root重建的exact CURRENT envelope hash/length。CURRENT本身仍須先通過sole-root完整load；未知、缺損或無獨立proof的claim仍fail closed，不回推舊CURRENT、不製造ACK。

H-02將完整 `TemporaryRecovery` descriptor及claim/temp candidate indexes寫入hashed GC plan。startup共同解讀current Root內GC disposition，不再建立第二權威。流程為 classification → GC plan ownership → quarantine progress → **durable unlink intent** → re-mark → unlink → terminal progress。source/quarantine bytes、owner、path、hash、length逐一驗證；只有durable `unlinking`/`deleted` index可解釋missing file。pins、backup與active Roots仍由re-mark保護，G2仍保留24小時grace。

## 4. Lease IPC

startup send使用callback捕捉EPIPE；若真flock已exit 73，exit status回既有 `STORAGE_UNAVAILABLE`。spawn前backend error仍是 `UNSUPPORTED_STORAGE`；已spawn但未知transport failure保守為 `RECOVERY_REQUIRED`，30秒timeout不變。永久測試使用真 `/usr/bin/flock`，只延遲parent spawn callback；沒有mock、刪除或偷取lock。

## 5. Proof metadata / performance

`VerificationCache`新增4 MiB proof metadata hard budget、shared path fingerprints/refcounts、global LRU eviction與diagnostics。Version/Registry proofs只引用共享physical identity；identity改變會invalidate全部依賴proof。Eviction移除trust，下一次必須重新驗證；cache不持久化且不是authority。

相同process-crash workload（單次量測，非SLA）：

| Commands | Commit total / p50 / p95 / max ms | Restart ms | Peak RSS KiB | Proof bytes | Fingerprints |
| ---: | --- | ---: | ---: | ---: | ---: |
| 25 | 15,460 / 476 / 1,527 / 1,553 | 3,156 | 163,028 | 102,195 | 100 |
| 50 | 83,311 / 1,244 / 4,705 / 12,247 | 11,910 | 169,564 | 337,170 | 250 warm / 200 after recovery |
| 100 | 266,140 / 2,297 / 9,006 / 19,346 | 29,915 | 202,600 | 1,206,495 | 400 |

原 native review為25/50/100 physical proof rows 625/2,500/10,000。新數字是去重fingerprints，環境不同，不能宣稱native speedup。100-command cold open仍距30秒timeout約85ms，屬 blocker。

8 MiB process-crash run：max 13,103.5ms、peak RSS 528,268KiB；先前同profile artifact為14,819.9ms、512,008KiB。單次latency下降不構成SLA，RSS仍約516MiB且沒有改善。

## 6. Verification

- 9 persistence suites：121 total，119 pass，0 fail，2 native skips。
- 完整Node 22 serial：457 total，448 pass，7 fail，2 skip；7 fail皆因Playwright Chromium executable不存在，2 skip為native ext4/XFS。
- CAS Python：17/17 pass。
- H-01原始harness：2 process-crash pass；2 native因unsupported filesystem未執行。
- Formal examples、contract、docs、release與architecture checks結果記於evidence；raw logs與SHA256位於 `evidence/pr1d-native-findings-logs/` 及 `pr1d-native-findings-manifest.sha256`。

Fault coverage包含CURRENT後續commit/retry、claim cleanup、GC plan/quarantine/rename/unlink、重複GC、corrupt generation/Registry/Locator、Ledger restart idempotency、reader/backup pins、ENOSPC/EIO/EXDEV及真flock contention。沒有執行native ext4、power-loss、10GiB fill、100k strokes、64 readers或1000-command checkpoint。

## 7. Remaining blockers / rollback / recommendation

Native ext4上的四個H-01及兩個H-02原variants必須由獨立環境重跑；M-02需native scheduling retest。Cold recovery、8 MiB memory、1000-command/checkpoint與容量gate仍open。

安全rollback：在未activation且沒有任何existing-user migration的前提下，停止writer後依相反順序revert本分支三個implementation commits；不要手動刪claim、GC plan/quarantine或回推CURRENT。若任何新格式GC plan已寫入disposable test store，使用同版本完成/匯出或保留整個store，不以舊binary寫入。

**IMPLEMENTATION BLOCKED**。保留修復供native reacceptance；不得啟用Unified Writer或開始PR-1B。
