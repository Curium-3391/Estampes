# PR-1A — Limited Maintainer Authorization

Status：**APPROVED — LIMITED PR-1A SCOPE ONLY**。此為維護者於本次使用者訊息的明確授權紀錄，不是Agent替人類作決策。日期2026-11-02（Asia/Taipei）；證據基礎Commit `1fc6de91d1618e57a492eee1059c54d0bb0f735d`。原授權文字的SHA256與精確新增檔案allowlist見[evidence/pr1a-authorization.json](evidence/pr1a-authorization.json)。

維護者原文：**“The maintainer has approved the limited PR-1A implementation scope described below.”** 以及 **“This authorization does not extend to PR-1C, PR-1D, PR-1B or subsequent phases.”**

| Decision | Approved subset | Remains unapproved |
| --- | --- | --- |
| OD-01 | Document UUID、Asset/Document分離、單SceneOwner、typed refs、strict schemas、唯讀legacy shadow、CommitRoot結構 | Writer、journal/fsync、GC/compaction、durability profile、真正storage authority/cutover |
| OD-02 | 雙domain、Principal/Actor/Owner/Provenance schema、原AI/module作者保存、必要editing輸入契約／pure helper | 新user route、runtime grants、完整編輯政策啟用、Host action認證、Renderer/Interaction |
| OD-06 | Versioned compatibility schemas、legacy identity mapping、Embed schema/refs、非破壞唯讀foundation | Embed clone/render/edit、正式import/export／migration、legacyadapter切換、downgrade執行 |

相關ADR-001–012也只在上表必要結構範圍授權，**不是全部ADR已Approved**。OD-03/04/05與後續PR各自gate仍存在。本次不重開已批准方向，不變更現有MCP tools、Module ABI、ImageEntry、Canvas／Scene／Storage權威、CAS／Graph／Workbench路徑或版本。

允許小型隔離production validation modules、聚焦測試、文件與scope checker更新；不寫使用者volume、不啟新writer、不新增runtime依賴。檢查器保留95既有source/config hashes、既有tests與歷史紀錄，只為明列PR-1A新檔放行；allowlist是Agent在維護者已批准的功能範圍內選定的實際檔案邊界，不表示維護者曾逐檔簽署，也不讓任意client JSON賦予權限。

Git授權：使用者另明確要求先推送Phase0.2，已完成且遠端SHA吻合；PR-1A只commit、不push、不merge。完成實作、實測、報告、獨立commit後停止。PR-1C可做下一次審查準備，**尚未授權實作**。
