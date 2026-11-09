# UVA 歷史壓縮（自動）

2026-11-09。依使用者決定「引擎自動歷史壓縮」，移除 UVA 畫布儲存的終身提交上限。

## 問題

在此之前，每次提交都會讓以下四類資料永久增加：

| 類別 | 每次提交約增加（單文件、單筆修改） | 原因 |
| --- | --- | --- |
| 索引頁（Locator、Ledger、CommitIndex） | 8 KB | 每個版本、每筆請求、每個 membership 都永遠留一列 |
| journal（`visual-transactions/`） | 4.5 KB | 7 天後只壓成 retention proof，proof 與空資料夾永遠留著 |
| 歷史 delta 與 chunk | 2.2 KB | Locator 只增不減，所以每個版本都受保護 |
| 文件 anchor（每 32 版一份完整副本） | 4.5 KB | 同上 |

另外，每類索引有 100,000 筆的硬上限，所以即使磁碟夠用，提交數也有絕對上限。
256 MiB 的 Beta store 約在 1915 次提交時被容量管理拒絕。

## 保留什麼

**horizon** 是所有保留中的根之中最舊的 generation，包括：最近 20 個 recovery point、
具名 checkpoint、reader pin、進行中的 backup，以及被選為 CURRENT 發布證據的 temporary 紀錄。

- **版本（Locator 列）**：只要被以下任一 registry 引用就保留：目前的 registry、每個保留的
  recovery registry、checkpoint、pin（含其 `historyRefs`）。被引用版本的整條 delta base
  鏈也一起保留，鏈長受 `ANCHOR_SPAN`（32）限制。保留中的完整副本若其 `alternative` delta 的
  base 已不需要，就移除 `alternative`，完整副本本身不變。
- **membership（CommitIndex 列）與 Ledger**：在 horizon 之下，且同時符合以下條件才移除：
  ACK 已滿 7 天並轉成 tombstone、journal 檔案已被 GC 刪除（GC 本來就在 7 天後才壓 journal），
  沒有任何 temporary claim 或 temporary 紀錄屬於它，也不是目前的提交。移除時同一批一起移除
  它的 Ledger tombstone、`journal-compacted:` 與 `journal-key:` proof，然後刪掉空的 journal
  資料夾。
- **其他 retention 紀錄**：已中止交易的 `journal-compacted:` proof（journal 已刪除時）、
  不再有 Ledger 列的 `journal-key:`，以及 `sourceGeneration` 在 horizon 之下的已完成 GC 紀錄，
  連同其空的隔離資料夾。

## 檔案怎麼刪

壓縮本身不刪任何檔案，只是讓這些檔案不再受保護。GC 計畫新增一個 G2 來源：掃描
`visual-history/deltas`、`visual-history/chunks`、`visual-documents/*/generations` 與
`visual-maintenance/gc`，挑出不在受保護集合、不屬於任何進行中計畫、也不是 temporary claim
目標的檔案。這些檔案走原本的流程：先搬到隔離區，等滿 1 天的 G2 grace 後重新標記，才 unlink。
時鐘回撥時 grace 不會前進。

為了跟上每天的提交量，自動壓縮使用的計畫上限從 128 提高到 1024 個候選，所有進行中計畫的
總上限從 4096 提高到 16384。可以同時有多個計畫，每輪只推進到期的計畫。

## 重送的請求

被遺忘的請求如果重送，不會重複套用：每次提交都會讓它改到的 Document revision 加一，而重送
的命令帶著舊的 `expectedRevision`，所以會得到 `CONFLICT`，而不是 7 天內的原 ACK 重播或
`RETRY_WINDOW_EXPIRED`。horizon 之下、ACK 視窗之外的 request ID 不再檢查 payload 是否一致。

## 自動執行

Lifecycle 選項 `autoCompaction`（預設 `false`，UVA 畫布儲存與 mirror 開啟）。

壓縮拆成**單位**（#107），每個單位只做一件有上限的事，所以一次提交最多等一個單位：

| 單位 | 內容 |
| --- | --- |
| GC 步驟 | 推進一個到期的 GC 計畫（新計畫、`planned`/`unlinking`、寬限剛滿，或有候選被保留的根持有時每 64 次提交重試） |
| ACK 到期 | 把滿 7 天的 ACK 轉成 tombstone，每批 64 筆 |
| prune | 一次發布，最多更動 96 個 index bucket |
| 頁面回收 | 刪除不可達的索引頁 |
| GC 計畫 | 規劃一批最多 256 個候選，並立即搬到隔離區 |

排程（writer 序列化佇列上）：

- **閒置**：佇列空了 `compactionIdleMs`（開啟選項，預設 3000 ms）之後，一次排一個單位；
  有請求在等就停。
- **持續寫入**：單位還找得到工作時，每 8 次提交在 ACK 之後插入一個單位；找不到工作後改為每 64 次。
- 沒找到工作、或沒填滿一批的檢查，要等更多次內容提交才再做（ACK 與 prune 16 次，頁面回收與
  GC 計畫 32 次）。每次維護發布本身都會留下被取代的頁面，所以「找到東西」不能當成再做一次的理由，
  否則規劃永遠不會停（測試中實際發生過）。
- GC 步驟在沒有候選要搬時不標記，G2 寬限未滿時不重新標記，紀錄沒變時不發布。

失敗不會讓提交失敗：完整性錯誤會照常讓 writer 進入 read-only recovery，其餘錯誤記在
`diagnostics.compaction`（同時記錄最後一個單位與耗時），之後再試。

## 同時修正

- GC 標記以前對每個保留的 root 重新讀取全部索引頁（20 個 recovery point × 整份索引），
  現在只走尚未標記的頁面。單輪標記從約 4 秒降到 0.6 秒。
- GC 標記改用 writer 的驗證快取。快取的完整副本證明不含它的 `alternative` delta，
  歷史載入現在會在這種情況重讀 delta，避免它在 GC 時被當成不可達。
- 頁面回收原本在有任何進行中 GC 計畫時整個跳過。計畫現在幾乎一直存在，所以改為跳過
  計畫持有的路徑。
- GC 搬移與刪除每批只對每個目錄 fsync 一次，在記錄進度之前完成。

## 驗證

`node scripts/uva-qualify.mjs --only history --history 2500 --store 1 --edit one --day-every 100`
（單一 120 個標記的畫布，每 100 次提交模擬一天，開發機）：

| 項目 | 壓縮前 | 壓縮後 |
| --- | --- | --- |
| 可完成的提交數 | 1915 次後被容量拒絕（108 MB） | 2500 次全部完成 |
| 磁碟 | 線性成長 | 約 1000 次後持平在 13–18 MB |
| 提交 p50 | 隨歷史上升 | 約 1000 次後持平在 1.3 s |
| 冷啟動 | 1915 次時 9.3 s | 2500 次時 7.2 s |
| 壓縮輪造成的等待 | 無 | p99 27 s，最長 56 s（一次補上數個模擬日） |

#107 改成單位之後，同一命令（連續寫入，沒有停頓）：

| 項目 | #106 一輪 | #107 單位 |
| --- | --- | --- |
| 提交 p50 / p95 | 1.3 s / – | 0.98 s / 2.6 s |
| 提交 p99 / 最長 | 27 s / 56 s | 8.0 s / 9.6 s |
| 2500 次時磁碟 | 13–18 MB | 25 MB（見下） |
| 冷啟動 | 7.2 s | 5.7 s |

加上 `--history 1000 --think-ms 1000 --idle-ms 500`（每次儲存後停 1 秒，閒置 0.5 秒就開始壓縮）：
p50 0.86 s、p95 5.2 s、p99 6.8 s、最長 7.4 s，磁碟 12.5 MB，結束時沒有剩下的工作。停頓比閒置門檻長，
所以幾乎每次停頓都開始一個單位，下一次儲存常要等它做完；p95 因此反映單位本身的耗時。

測試：`tests/persistence-history-compaction.test.js` 驗證有界性、完整 verify、冷重開、
舊請求重送得到 `CONFLICT` 而新請求重播 ACK、5 個 SIGKILL 點（ACK/prune 發布、GC 搬移、
GC 刪除、journal 資料夾移除、暫存寫入）之後 Documents 不變且下一輪完成，以及大型計畫的
proof 數量不超過 maintenance 上限（修正前會讓 writer 進入唯讀）。

## 仍未結案

- 一次提交最多等一個單位，最長約 6–9 s（一次 256 個候選的 GC 計畫或步驟，加上維護發布本身約 1 s）。
  要再降低，需要讓單位更便宜（較小的計畫、較便宜的發布），而不是再調排程。
- 完全沒有停頓的連續寫入時，每 8 次提交一個單位跟不上：最後 1000 次磁碟從 16 MB 增到 25 MB。
  一有 3 秒以上的停頓，閒置單位就會補上（有停頓的量測結束時沒有剩下的工作）。

這不改變 Production 資格（**NOT QUALIFIED**：#89、#91 的掉電與原生容量證據仍待補）。
