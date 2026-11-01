# Open Decisions / Architecture Approval Gate

最新追加：維護者授權PR-1A F-01/F-02 remediation與隔離PR-1C backend／tests，見[PR-1C-AUTHORIZATION](PR-1C-AUTHORIZATION.md)。不授權1D/1B／cutover／migration／全部OD-01；早期限制為歷史紀錄。

最新授權：2026-11-02維護者明確批准 **OD-01/02/06 的 PR-1A schema／唯讀shadow子集**，見[PR-1A-AUTHORIZATION](PR-1A-AUTHORIZATION.md)。不等於整個OD或ADR批准；本文較早的「尚無批准」屬Phase0歷史紀錄，其他產品／部署／後續PR gate保持pending。


Status：**HUMAN DECISION REQUIRED / READY WITH BLOCKERS**。所有推薦是Proposed，CURRENT證據在AUDIT，不能由後續Agent自行視為approved。這些問題不妨礙完成Phase0設計；在相依PR之前簽核，不提前寫入正式產品。Phase0沒有核心程式修改或資料遷移。

## OD-01 — Document Identity / Persistence Authority

Evidence：imageIdOf derives bytes；blank-canvas製造隨機PNG；saveCanvas per-file+catch；CASafter獨立。選項A擴ImageEntry虛擬ID成本低但同時保有asset/doc混用；B獨立UUIDDoc+legacyalias+stagedmanifest成本中高，需所有write route適配；C SQLite transactions較強query但多一次storageplatformmigration。**推薦B**（ADR001/007），原因是型別分離與可側寫回退符合單owner部署。風險是fsync/manifestread隔離必須做全；UVA-01/31–33證明。阻擋PR-1A/1B。審查人需批准IDgrammar、one-writer/filesystem支援邊界、durable ACK contract。

## OD-02 — Marks Domain / Anchoring Default

Evidence：Canvas claims/userownership不同於SceneObjects；frameOf已有worldmapping，但normalizedmarks不隨axesrange移動。選項A全統一object（高遷移成本、metadata/permission風險）；B雙domain+共用Contract（中成本、需typeddispatch）；C逐Viewer平行inkengine（短期快、長期不相容）。**推薦B**。Graph default documentanchor；world/object由explicit選擇（ADR002/004）。另一合理default為worldink（axesrange會移），但未標frame時多axes歧義且舊marks行為改變；不得兩者間自行推斷。阻擋PR-2A/2B/4B，UVA-05/07/09/12。人類需批准預設錨定、invalid保留、whole-markeraser、Legacy/Unified分離的AI/module Annotation完整userediting、Evidence transition與userguard。

## OD-03 — Rendering Compatibility Profile

Evidence：widget送出的userinkopacity .55；markSvg與browserdraw分寫；serverrenderdefaultlabelsnone，widgetlabels含decorations。選項A逐pixel保留全部legacyUI裝飾於所有render（低視覺改動、高綁定成本）；B共享canonicalplan、legacyprofile保原樣、newdocunifiedprofile去掉「sent」對canonicalalpha的影響（中成本、可見變更明確）；C立即全部換unifiedprofile（低adapter成本、既有視覺退化風險）。**推薦B**（RFC003），單一contract但versionedstylepolicy。阻擋PR-2C。UVA-10/34/goldenfixtures與使用者review核准後才能切新預設。

## OD-04 — Cross-widget Sync / Real Host Support

Evidence：Hostbridge無可靠push訂閱保證；getSurface/app-onlycalls已存在；FakeHost無真CSP。選項A app-onlypoll/reconcile+localimmediatesubscriptions（中延遲、低infra成本）；B WebSocket/SSE（低延遲、需CSP與connectionlife驗證）；C只靠nexttoolresult（簡單但不符合兩widget內容更新）。**推薦A**，visiblepoll2sec是可調scheduler起點，Phase3量測後核准budget，非latencypromise。真HostWeb/Mobile supportmatrix需Phase7逐平台結果；無測的平台不得宣稱通過。阻擋PR-3B的transportfreeze與PR-7Brelease；Phase1不因尚無真host測量被迫加入WebSocket。

## OD-05 — CAS User-edited Plot Policy

Evidence：CASplotResult update沒有editedByUser/targetsignatureguard，afterlink沒有targetrevision。選項A refresh覆寫useredits（現行風險、易丟意圖）；B任何userplotchange暫停link、顯conflict供detach/overwrite/fork（中成本、保存意圖）；C useredit自動detach（較簡單但暗中失去live行為）。**推薦B / pause-on-user-edit**，axesrangeonly不觸發targeteditconflict；plotstyle/domain/expression都觸發。阻擋PR-5B，UVA-20/21。需要批准signature範圍、manualrefresh不等同overwrite同意與三種resolution語意。

## OD-06 — Compatibility / Cutover / Downgrade

Evidence：strictmanifest/1拒新target；bundle/1只能imagesets；CASlinks沒有setscope；SVGmetadata不含sceneobjects。選項A要求所有modules/data升級（低compat成本，不合本任務約束）；B v1route/ABI/imagepath保留，newgraph/v2opt-in，sidewrite，newfeatures無法表示時拒losslessdowngrade（推薦，中高adapter成本）；C fakeimg/rasterprojection自動降級（簡單但失可編輯性）。**推薦B**（ADR005/008/RFC006），舊binary只開備份volume，newwrites先完整v2archive。Graphseparationcopy預設、CAScopylive-links須明示；Move完整incomingrefenumeration無法證明則block。阻擋PR-5A/6A/6B/7B；UVA-22–27。人類需批准支援期限與release版本：推薦至少跨兩個minorrelease不移除legacyreader/tools，實際發布號與棄用日期由maintainer定，不由本次Agent猜。

## Approval Record Template

```text
Decision IDs / ADRs:
Approver / Date:
Approved option / semantics:
Scope / permitted PR units:
Required tests / rollout restrictions:
Deliberate migration / visible changes:
Not approved / remaining blockers:
Evidence commit / RFC revision:
```

目前：**尚無批准紀錄**。最小下一步為review本套RFC，對OD-01/02及相依ADR明確批准或改選；不是直接執行Phase1。Stage-local選項可分批批准，但不可默認沉默等於批准。

## Phase 0.1 — Original / Revised Recommendations

原則性支持不等於正式批准。六項Finding的規格已完成，Architecture Gate可提交人類審查；下面仍全部RequiresHumanApproval，不能從文件檢查pass推成Approved。

| Decision | Original recommendation | Revised recommendation / reason | Human approval still required | Blocking PRs |
| --- | --- | --- | --- | --- |
| OD-01 | UUIDDoc+legacyalias+stagedroot | 維持；加root/pin/history保留、InternalGC/compaction、7天ACK＋永久tombstone、quota/reserve、fsyncbarrier、unsupportedFS拒writer（ADR-010） | durability前提、retention/GC/capacitydefaults與單writer部署契約 | PR-1A / PR-1C / PR-1D / PR-1B |
| OD-02 | dualdomain/docanchor；沿legacyuseronly-own | dualdomain/docanchor不變；新Principal/Owner/Grant分離；**Legacy兼容＋Unifieduser可完整編輯AI/moduleAnnotation**；保createdBy、stalecontext/guard/Undo（ADR-009） | 新產品editingmatrix、moduleauthorship/lineage、label非claim語義、Evidence/Verification transition必維護者確認 | PR-1A / PR-2A / PR-2B / PR-4B / PR-5A |
| OD-03 | sharedplan＋legacy/unifiedprofiles | 維持；含moduleauthorbadge、staleverification與embeddependencyvector；失效/拒權placeholder不得誤認fresh | 視覺profiles與badge/placeholder呈現政策 | PR-2C / PR-6D |
| OD-04 | app-onlypoll+localreducer | 維持；加parentdependencytoken（childupdate不偽改parentrev）、authorizationscope失效與explicitchildedit；真Host仍未驗 | transport/pollbudget與host/platform支持；useractioncapability可信Host邊界 | PR-3B / PR-6D / PR-7B |
| OD-05 | CASpause-on-user-edit | 維持；Annotation採相同防覆寫理念但有獨立guard/one-shoteditpermission，不混成CASbinding；CASembed指真childObject | signature範圍、Detach/Overwrite/Fork、Annotationguard單次lease政策 | PR-2B / PR-5A / PR-5B / PR-6D |
| OD-06 | v1adapter＋v2opt-in/sidewrite | 維持；加A0–A7atomiccutover、oldbinaryOS/launcherfence、postwriteA7archive/newlegacyvolume；Embedtypedcontract＋editableclone（ADR-011/012） | cutover/fence部署前提、rollback範圍、snapshot/Copy共享語義、v1支援期限/發布號 | PR-1B / PR-6A / PR-6D / PR-6B / PR-6C / PR-7A / PR-7B |

Maintainer尚未批准任一列。Phase0.1交付不啟動相依PR；最小下一步是以REVIEW-REMEDIATION與ADR-009–012逐項簽核，若改選必同步contract/examples/tests。

## Phase 0.2 — Final Gate Refinements

OD-01推薦不變，但批准內容必含coherent CommitRoot、G1/G2/checkpoint thinning、Linux平台allowlist與10GiB非通用capacity。OD-02完整user-edit、不可變creator、Evidence/guard仍待產品確認；schema批准不自動開啟newpolicy。OD-03/04/05推薦不變，render/Host/CAS退出證據仍須逐階段取得。OD-06需批准nested snapshot V1預檢拒絕與editablebundle替代，以及Desktop/nativeMac預設拒cutover與oldbinaryROfence。六OD的原選項與本輪cost/阻擋PR詳FINAL-ARCHITECTURE-GATE G。尚無Approver/Date；不得從本輪推薦補造批准紀錄。

## PR-1C observed gate (limited authorization)

PR-1C已有隔離backend實作與process-crash／real file I/O測試；native ext4/XFS正向profile因測試掛載缺失尚未驗收。這不撤銷維護者的限定實作授權，也不自動批准platform／capacity／cutover；完整狀態見[report](PR-1C-IMPLEMENTATION-REPORT.md)。1D/1B未開始。
