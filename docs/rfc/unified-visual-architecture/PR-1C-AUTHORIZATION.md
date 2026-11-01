# PR-1A remediation / PR-1C — Limited Maintainer Authorization

Status：**APPROVED — LIMITED IMPLEMENTATION SCOPE**。2026-11-02（Asia/Taipei）。維護者本次明確授權：“Address the two findings from the independent PR-1A review”及“Implement PR-1C — Commit Coordinator, Journal, Immutable Generations and Recovery”。原授權SHA256／base／不授權事項見[evidence record](evidence/pr1c-authorization.json)。

OD-01／ADR-007／ADR-010只在PR-1C isolated backend、six-root publication、OS lifetime lease、file+directory barriers、durable ledger、deterministic recovery與disposable tests所必需範圍批准。先獨立commit F-01/F-02；再交PR-1C commit。現有API／Storage／Module／Graph／CAS／Workbench及原始user volume保持隔離。

PR-1D retention/GC/compaction、PR-1B old-binary fence／authority cutover、migration、new writable MCP routes、部署、全architecture／其他OD或ADR仍未批准；禁止push／merge／release。新engine只能以明確isolated testing purpose使用，不在maintenance缺失時開production writer。

本環境僅overlayfs／tmpfs、無CAP_SYS_ADMIN，沒有已批准native ext4/XFS掛載。Linux durable profile必拒這些mount；若執行顯式process-crash test harness，其資料與ACK必標test-only/non-durable，不能當physical power-loss或approved-platform證據。這是測試證據限制，不擴storage allowlist或放寬durable ACK。原生profile驗收未完成時不得把PR-1C報為完整通過。
