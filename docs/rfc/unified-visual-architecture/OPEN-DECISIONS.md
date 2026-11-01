# Open Decisions / Architecture Approval Gate

Status：**HUMAN DECISION REQUIRED / READY WITH BLOCKERS**。所有推薦是Proposed，CURRENT證據在AUDIT，不能由後續Agent自行視為approved。這些問題不妨礙完成Phase0設計；在相依PR之前簽核，不提前寫入正式產品。Phase0沒有核心程式修改或資料遷移。

## OD-01 — Document Identity / Persistence Authority

Evidence：imageIdOf derives bytes；blank-canvas製造隨機PNG；saveCanvas per-file+catch；CASafter獨立。選項A擴ImageEntry虛擬ID成本低但同時保有asset/doc混用；B獨立UUIDDoc+legacyalias+stagedmanifest成本中高，需所有write route適配；C SQLite transactions較強query但多一次storageplatformmigration。**推薦B**（ADR001/007），原因是型別分離與可側寫回退符合單owner部署。風險是fsync/manifestread隔離必須做全；UVA-01/31–33證明。阻擋PR-1A/1B。審查人需批准IDgrammar、one-writer/filesystem支援邊界、durable ACK contract。

## OD-02 — Marks Domain / Anchoring Default

Evidence：Canvas claims/userownership不同於SceneObjects；frameOf已有worldmapping，但normalizedmarks不隨axesrange移動。選項A全統一object（高遷移成本、metadata/permission風險）；B雙domain+共用Contract（中成本、需typeddispatch）；C逐Viewer平行inkengine（短期快、長期不相容）。**推薦B**。Graph default documentanchor；world/object由explicit選擇（ADR002/004）。另一合理default為worldink（axesrange會移），但未標frame時多axes歧義且舊marks行為改變；不得兩者間自行推斷。阻擋PR-2A/2B/4B，UVA-05/07/09/12。人類需批准預設錨定、invalid保留、whole-markeraser與AI/user既有編輯界線。

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
