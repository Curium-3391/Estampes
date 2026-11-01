# PR-1A Independent Review Remediation

Status：**IMPLEMENTED — PRE-MERGE VALIDATED**（只指F-01/F-02）。Base為7eae7f5748a4c264a7dc996b07f005f95e34ff37；branch feat/unified-visual-architecture-pr1c；main仍7fb9b73／0.20.0。先fetch／ls-remote驗PR-1A exact SHA與Phase0.2 ancestry、initial clean；[新授權](PR-1C-AUTHORIZATION.md)不表示整個architecture已批准。

## F-01 — explicit closure validation

原問題：validateDocumentReferences只驗caller snapshots，不能作repository完整性證明。新增partial與declared-complete APIs，保留原strict supplied API。Partial missing外部Document列required report；supplied Document內錯Ref仍拒。Complete要求exact Doc ID/revision/canonicalhash declaration、required deps存在、Scene單owner、canonical bindings與Embed DAG/limits有效；unresolved/historical缺依賴另列，並不給fresh或permission。純函式無Store依賴；PR-1C必由一個committed snapshot／after-state全registry建立closure。Document模型驗證不冒充asset binaries、CAS Notebook、所有repository history或授權驗證。

## F-02 — recovery semantics

report顯式mapped／migrationCompleted=false／json-record-only／originalFileBytesVerified=false／binaryAssetsVerified=false。rawRecoverable只保證返回sidecar的JSON內容；不等source bytes hash或asset restoration。unknown fields、user edits、Evidence／Provenance原值仍在sidecar，report指明archive；blocked不回假成功document。mapped=true仍可editableComplete=false；blocked仍可rawRecoverable=true；三欄不互推。沒有migration／新磁碟寫入／legacy redesign。

## Observed tests / compatibility

命令：`npm exec --yes --package=node@22 -- node --test tests/documents-review.test.js tests/documents-foundation.test.js tests/documents-shadow.test.js`。Node22.23.4／Linux x64。**61 pass / 0 fail / 0 skip，exit0，2312.061534ms**；含原PR-1A 53（未改expectations）＋8新review cases。原始log見[evidence/pr1c-logs/remediation-tests.log](evidence/pr1c-logs/remediation-tests.log)。完整Node／docs／release／contract驗證在PR-1C總報告補實測，這裡不宣稱已重跑。

Changed code：src/documents/integrity.js、legacy-shadow.js；新增tests/documents-review.test.js。變更scope checker只放行本次授權的窄範圍，原95pre-existing hashes／歷史test與logs保留。沒有現有正式write path、格式或權限改變。

Rollback：revert本remediation commit（與後續PR-1C分開），無資料rollback；未寫user volume。F-01/F-02 resolved in specified model scope；未測nativeFS/真Host/授權服務，不推論完成未實作功能。
