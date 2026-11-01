# Unified Visual Architecture — Phase 0 / 0.1 / 0.2

狀態：**PROPOSED / 僅準備有限 PR-1A 人類批准 / 尚未 Approved**。調查日期：2026-11-01 UTC。實作事實固定於 `7fb9b73442401fc32a7034888deaf49303e582a6`，版本 `0.20.0`。本目錄不是已實作功能的說明，也不授權 Phase 1–7。

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

Architecture Approval Gate 的審查輸入為全部八份 RFC、十二份 ADR、遷移演算法、測試矩陣、基線與 Open Decisions。批准前禁止建立正式 DocumentStore、修改核心 API 或執行資料遷移。批准後依 Roadmap 開始 PR-1A；不能跳到 Graph 視窗。

Current Implementation：見 AUDIT。Proposed Architecture：見 RFC。Open Decision：見 OD 清單。Future Extension：協作 CRDT、跨 server reference、自訂可執行 Viewer、Scene 共享寫入均排除。

## Phase 0.1 — Review Remediation Deliverables

本輪R-01–06規格修訂已完成，未進Phase1，所有政策仍待維護者批准：

| 文件 | 用途 |
| --- | --- |
| [REVIEW-REMEDIATION](REVIEW-REMEDIATION.md) | 六Finding逐欄resolution、兼容/遷移/安全/test/PRimpact與residualrisks |
| [ANNOTATION-POLICY](ANNOTATION-POLICY.md) | R-01/02 actor/author/owner/grants與UnifiedAIediting/Evidenceguard/Undo |
| [STORAGE-LIFECYCLE](STORAGE-LIFECYCLE.md) | R-03 retention/GC/compaction/quota/fsync/durability/recovery |
| [EMBED-CONTRACT](EMBED-CONTRACT.md) | R-04 persistentembed/operations/refs/auth/cache/editableclone |
| [AUTHORITY-CUTOVER](AUTHORITY-CUTOVER.md) | R-06 A0–A7authority、oldbinaryfencing與postwrite回退 |
| [ADR-009](adr/ADR-009.md) | Authorship與UnifiedUserEditing補充原ADR002/004/005 |
| [ADR-010](adr/ADR-010.md) | InternalGC/compaction/durability補充ADR007 |
| [ADR-011](adr/ADR-011.md) | Embedchildauthority/snapshot補充ADR003/006 |
| [ADR-012](adr/ADR-012.md) | Cutover/fencing補充ADR001/007/008 |
| [Proposed schemas](evidence/proposed-contracts.mjs) | 文件專用closedschemas，無productionimports/APIregistration |
| [Formal examples](evidence/contract-examples.json) | 九個合法IDs/Refs的完整API流程，未實作/待批准標記 |
| [Contract inventory](evidence/contract-inventory.json) | 全部正式JSON與TS投影範例位置及驗證分類，未宣稱TS編譯證明 |
| [Example validator](evidence/validate-contract-examples.mjs) | corpus/Markdownfences/schema與sequence一致性 |
| [Validation tests](evidence/contract-validation.spec.mjs) | 正負範例、偽actor、layer/ID/revision/ref/embed/lineage驗證 |
| [Review execution manifest](evidence/review-execution-manifest.json) | 本輪命令/環境/exit/results/loghash；舊Phase0logs不覆寫 |

測試規格62cases、Roadmap23PRunits；補充文件不改核心方向或自動批准。主要RFC與CONTRACTS已逐項整合新契約。

## Phase 0.2 — Independent Final Gate

最新審查：[FINAL-ARCHITECTURE-GATE](FINAL-ARCHITECTURE-GATE.md)。前次報告保持歷史原文；本輪修正G1/G2與checkpoint容量、coherent roots、平台durability、nested snapshot預檢、doc-onlyschema反例及wire名稱。當前67cases/23PRunits；Node/文件/範例check只證明已執行範圍，不等於人類批准或未實作功能驗收。尚未開始Phase1。
