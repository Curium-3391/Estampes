# Unified Visual Architecture — Phase 0

狀態：**PROPOSED / READY WITH BLOCKERS / Architecture Approval Required**。調查日期：2026-11-01 UTC。實作事實固定於 `7fb9b73442401fc32a7034888deaf49303e582a6`，版本 `0.20.0`。本目錄不是已實作功能的說明，也不授權 Phase 1–7。

## 閱讀與決策權限

程式碼決定 Current Implementation；執行紀錄決定 Observed；文件與 Changelog 表示歷史意圖；下列 RFC、ADR 的 Decision 都是 Proposed recommendation，尚未經人類批准。使用者本次限制優先於本文件。Open Decision 必須在相依 PR 前簽核；Future Extension 不屬本輪交付。不因 Agent 推薦就成為 Approved。

| 文件 | 用途 |
| --- | --- |
| [AUDIT](AUDIT.md) | 現行依賴、每個 subsystem 的狀態、API、證據與風險 |
| [BASELINE](BASELINE.md) | 環境、命令、真實結果與不能推論的範圍 |
| [RFC-001](RFC-001.md) | Architecture、替代方案與不變條件 |
| [RFC-002](RFC-002.md) | Document、Scene、Annotation、Layer、ID、版本與生命週期 |
| [RFC-003](RFC-003.md) | 座標、錨定、Renderer、Hit Testing 與指標仲裁 |
| [RFC-004](RFC-004.md) | 多實例 Workbench、Panel、Viewport 與 Host 復原 |
| [RFC-005](RFC-005.md) | Modules、Graph、CAS 與完整 API 範例 |
| [RFC-006](RFC-006.md) | 儲存、逐格式遷移、Bundle 與交易復原 |
| [RFC-007](RFC-007.md) | 安全、效能、Host 相容與操作要求 |
| [RFC-008](RFC-008.md) | 測試、功能旗標、發布閘門與回退 |
| [Contract Appendix](CONTRACTS.md) | ID grammar、operation fields、validation、支援記錄、分頁與錯誤契約 |
| [TEST-MATRIX](TEST-MATRIX.md) | 可執行的逐案例驗收規格 |
| [TRACEABILITY](TRACEABILITY.md) | 硬性需求 → 設計 → 程式 → 遷移 → 測試 → PR |
| [RISK-REGISTER](RISK-REGISTER.md) | 資料、座標、CAS、安全、效能與 Host 風險 |
| [OPEN-DECISIONS](OPEN-DECISIONS.md) | 重大選項、成本、推薦及批准紀錄 |
| [Implementation Roadmap](../../../IMPLEMENTATION-ROADMAP.md) | Phase 0–7、可獨立回滾的 PR 單位 |
| [Evidence source index](evidence/source-index.json) | 95 個 source/config 檔案的 SHA-256、imports、函數與行號；文字掃描，不等同 runtime 覆蓋 |
| [Evidence test index](evidence/test-index.json) | 基線 57 個 Node 測試檔案與測試名稱索引 |
| [Benchmark harness](evidence/benchmark.mjs) / [samples](evidence/benchmark-results.json) | 合成暫存資料的現行取樣、渲染、Bundle 效能測量 |
| [Consistency checker](evidence/check-consistency.mjs) | RFC/ADR/Case/PR 完整性、95 檔案雜湊與 Phase 0 修改範圍檢查 |
| [Execution manifest](evidence/execution-manifest.json) | 實際命令、exit code、測試統計與原始 log 雜湊/路徑 |
| [Host acceptance script](HOST-ACCEPTANCE.md) | 尚未執行的真 ChatGPT Web/iOS/Android 與 MCP Apps/CSP 驗收 |
| [Characterization tests](../../../tests/uva-characterization.test.js) | 保護現行 axes/normalized marks 與 rich canvas storage 行為 |

ADR： [01 Identity](adr/ADR-001.md)、[02 Marks](adr/ADR-002.md)、[03 Viewport](adr/ADR-003.md)、[04 Anchoring](adr/ADR-004.md)、[05 Module Target](adr/ADR-005.md)、[06 References](adr/ADR-006.md)、[07 Persistence](adr/ADR-007.md)、[08 Compatibility](adr/ADR-008.md)。

## 完整性與停止點

文件以 `INV-*`、`UVA-*`、`PR-*`、`OD-*` 交叉追蹤。新增型別、函數、工具與路徑均明示 Proposed；既有路徑以 AUDIT 與 source index 核實。Contract Appendix 是八份 RFC 的共用validation細則，有矛盾時更新兩者並重審，不由實作者挑一個猜。後續 Agent 必須先核對實作 SHA；若 main 有更新，重做差異審查，不能把本次觀察直接套到新版本。

Architecture Approval Gate 的審查輸入為全部八份 RFC、八份 ADR、遷移演算法、測試矩陣、基線與 Open Decisions。批准前禁止建立正式 DocumentStore、修改核心 API 或執行資料遷移。批准後依 Roadmap 開始 PR-1A；不能跳到 Graph 視窗。

Current Implementation：見 AUDIT。Proposed Architecture：見 RFC。Open Decision：見 OD 清單。Future Extension：協作 CRDT、跨 server reference、自訂可執行 Viewer、Scene 共享寫入均排除。
