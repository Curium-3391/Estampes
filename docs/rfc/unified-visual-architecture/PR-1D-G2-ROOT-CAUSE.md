# PR-1D G2 根因與修正（#90）

2026-11-08。原 [診斷裁決](PR-1D-G2-DIAGNOSTIC-ADJUDICATION.md) 的 **C — UNRESOLVED INTERMITTENT** 改為 **已重現、已解釋、已修正**。

## 結論

原始失敗（`R3-B1 / current.before-rename`，grace 後第二次 `gcStep` 回傳 `quarantining`）不是時鐘、fsync 或 barrier 問題，是 GC 計畫的所有權缺口：

1. 計畫在 mark 當下選出候選。index page、commit root 與 generation file 都以內容命名，同一份內容永遠落在同一個路徑。
2. mark 之後，任何提交都可能再寫出同一路徑，包括**計畫自己的發布**。被中斷的第一次提交留下的 retention page，若剛好在之後某次提交又變回同樣的內容，就再度被選取的 Root 引用。
3. 舊的 `step` 遇到受保護的未搬移候選只會跳過，等它「解除保護」。內容定址的頁面一旦被引用，就可能永遠被引用（它也一直留在後續 20 個 recovery root 裡），所以這個候選永遠無法搬移。
4. 其餘候選在 grace 後刪光，`deleted < candidates` 但沒有 `waiting`，於是回傳 `quarantining`，而且之後每一步都一樣：計畫永遠不會結束，並一直擋住 `reclaimPages`（它在有 active GC plan 時停止）。

## 失敗現場（已保留）

[captured-store.tar.gz](evidence/g2-resolution/captured-store.tar.gz) 是在舊程式碼下，以原測試的同一流程重跑時抓到的 Store，[capture.json](evidence/g2-resolution/capture.json) 記錄當次回傳。在 container 的 ext4 上，以測試 profile 跑了約 25 次就重現一次。

- 計畫有 13 個候選。第一步搬移 12 個，回傳 `waiting-grace`（0 deleted）。grace 後第二步刪除 12 個，回傳 `quarantining`。
- 沒搬的是候選 10：retention bucket `1b` 的 page，內容只有 `lifecycle` 一筆（`contentSinceMaintenance: 1`、時鐘 `1893456000000`），由被中斷的第一次提交寫出。
- 計畫當下，五個 temporary claim 之一（`ff378ad4-…`）的 retention key `temporary:<claimId>` 也落在 bucket `1b`，所以當時的 live page 是另一份內容，這頁成了候選。
- 計畫的發布會移除各 claim 的 `temporary:` 紀錄，bucket `1b` 因此回到只有 `lifecycle` 的那份 bytes，路徑和候選 10 完全相同。從那一刻起，候選 10 被選取的 Root 引用。

claim ID 是隨機的，每次執行有五個 claim 各以 1/256 的機率落進 `lifecycle` 的 bucket（約 2%）。這就是失敗只偶爾出現、且所有診斷重跑都能完成的原因。

保留的 Store 只能讀，不能開來重跑：計畫記錄了每個候選的 dev/inode，複本拿不到原 inode，開啟時會正確地以 `GC candidate object differs from selected ownership` 拒絕。`tests/persistence-gc-readoption.test.js` 直接讀這份現場，逐項驗證上述每一點。

## 修正

`src/persistence/gc.js` 與 `src/persistence/lifecycle-state.js`（GC 紀錄新增選填的 `released`）：

- **mark 後重新被引用、尚未搬移的候選會被釋放**（`released`）。釋放代表計畫放棄這個路徑：不搬、不刪，檔案留給選取的 Root。它也不會在之後的步驟以較早的 grace 起點被搬移後立即刪除。
- `complete` 的條件改為 `deleted + released` 涵蓋所有候選；`released` 與 `deleted`、`unlinking` 互斥，且釋放的候選不能仍在隔離區。這些都由 `readGcPlan` 檢查。
- temporary disposition 的候選（claim 與其暫存檔）不會被釋放，維持原本較嚴格的處理。

結果：每一步之後，每個候選不是已搬移就是已釋放。grace 後若無阻擋，同一步就完成；非 terminal 的回傳一定是 `waiting-grace`。

**後續（2026-11-08，使用者決定「改」）**：已搬移的候選若路徑之後又被新提交寫出，來源是另一個已驗證 hash 相同的 live 物件，隔離區那份只屬於計畫，照樣等滿 G2 grace 後 unlink，計畫因此能結束，不再擋住 `reclaimPages`。只有在 Root 需要、而來源不存在時（必須由 recovery 搬回），才繼續等待。recovery 已把隔離檔搬回來源、且 Root 引用它的候選，則釋放。H-02 的 quarantined 案例原本斷言 grace 後仍 `waiting-grace`，現改為斷言 `complete`，並在冷重開後驗證 Document、ACK 重播與 `contentCommits` 不變。

## 驗證

沒有放寬任何既有斷言。原 R3-B1 測試不變。

| 檢查 | 結果 |
| --- | --- |
| 必然重現（新提交在計畫後重寫同一 generation file 與 pages） | 修正前：grace 後 `quarantining`，第三步仍 `quarantining`；修正後 `complete` |
| grace 前零刪除 | 釋放的與搬移的候選在 grace 前都是 0 deleted |
| 已隔離後被重寫（後續修改） | grace 前 0 deleted；grace 後隔離副本刪除，live 物件仍是提交寫出的那個 inode，hash 相同 |
| 時鐘回撥 | 回撥後 `waiting-grace`、0 deleted；時鐘回來後同計畫 `complete` |
| 冷重開 | Documents 不變，`contentCommits` 1，同計畫仍 `complete` |
| 保留現場 | 逐項驗證：候選 10 的頁面由計畫自己的發布引用、計畫當下的 Root 沒有引用、claim key 與 `lifecycle` 同 bucket |
| 持續壓力，測試 profile（原 R3-B1 流程，4 recovery SIGKILL，每次新 Store） | 200/200 通過；其中 7 次有候選被釋放，這 7 次在舊程式碼下會卡在 `quarantining` |
| 持續壓力，`linux-local-durable`（container 根目錄 ext4，真 fsync／flock） | 100/100 通過；其中 5 次有候選被釋放 |
| 交付版程式碼再跑（同流程） | 測試 profile 60/60（1 次釋放），`linux-local-durable` 40/40 |

前兩列壓力重跑時的程式碼另外會在 grace 後刪除「已隔離、後被重寫」的隔離副本；交付版還原為原行為（見上節），R3-B1 流程不會走到這條路徑。

## 仍未結案

這個修正解決 #90 的 G2 間歇性失敗。它本身不開啟自動 GC 或歷史壓縮，也不改變 Production 資格（**NOT QUALIFIED**：#89、#91 的掉電與原生容量證據仍待補）。
