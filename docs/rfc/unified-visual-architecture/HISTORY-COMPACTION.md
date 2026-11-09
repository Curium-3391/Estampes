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

Lifecycle 選項 `autoCompaction`（預設 `false`，UVA 畫布儲存與 mirror 開啟）讓 writer 在每
64 次提交、ACK 回傳之後，於同一個序列化佇列上執行一輪：

1. 把滿 7 天的 ACK 轉成 tombstone（每批最多 64 筆）。
2. prune，每次發布最多更動 96 個 index bucket，避免超過 maintenance 的 128 筆暫存上限。
3. 推進每個到期的 GC 計畫，並規劃下一批（最多 1024 個候選），然後立即搬到隔離區。

失敗不會讓提交失敗：完整性錯誤會照常讓 writer 進入 read-only recovery，其餘錯誤記在
`diagnostics.compaction`，下一輪再試。

## 同時修正

- GC 標記以前對每個保留的 root 重新讀取全部索引頁（20 個 recovery point × 整份索引），
  現在只走尚未標記的頁面。單輪標記從約 4 秒降到 0.6 秒。
- GC 標記改用 writer 的驗證快取。快取的完整副本證明不含它的 `alternative` delta，
  歷史載入現在會在這種情況重讀 delta，避免它在 GC 時被當成不可達。
- 頁面回收原本在有任何進行中 GC 計畫時整個跳過。計畫現在幾乎一直存在，所以改為跳過
  計畫持有的路徑。
- GC 搬移與刪除每批只對每個目錄 fsync 一次，在記錄進度之前完成。

## 仍未結案

這不改變 Production 資格（**NOT QUALIFIED**：#89、#91 的掉電與原生容量證據仍待補）。
