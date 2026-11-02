# Unified Visual Architecture — Implementation Roadmap

Status：**PR-1D 隔離實作已獲最新明確授權；整合、PR-1B 與其餘 PR 未授權**。架構仍以 Phase 0.2 契約為準；歷史 PR-1A/PR-1C/native 報告保留原結論。當輪範圍與退出判定見 [PR-1D-AUTHORIZATION](docs/rfc/unified-visual-architecture/PR-1D-AUTHORIZATION.md) 及 [PR-1D report](docs/rfc/unified-visual-architecture/PR-1D-IMPLEMENTATION-REPORT.md)。既有產品基線為 `7fb9b73442401fc32a7034888deaf49303e582a6` / 0.20.0；本輪 base 為 `58f7789414130085543560147df87e85a62123ea`。

後續Agent先確認新HEAD差異與批准紀錄；已批准架構不重新發散探索；缺失的ownership/ordering/publicbehavior不能猜。每PR附before/after fixture、sourceSHA、實測命令、flag狀態、rollback步驟與publicformat差異。以下為likelyfiles，不代表Phase0已新增這些核心模組。

## Dependency Graph / PR Order

```mermaid
flowchart LR
  P0[0A RFC baseline] --> Gate[Architecture approval]
  Gate --> P1A[1A schema identity]
  P1A --> P1C[1C commit coordinator]
  P1C --> P1D[1D retention GC compaction]
  P1D --> P1B[1B adapters and tools]
  P1B --> P2A[2A annotations layers]
  P2A --> P2B[2B coords tools history]
  P2B --> P2C[2C shared render]
  P2C --> P3A[3A viewer factory]
  P3A --> P3B[3B sync host lifecycle]
  P3B --> P3C[3C multi viewport validation]
  P3C --> P4A[4A graph document]
  P4A --> P4B[4B graph annotation anchoring]
  P4B --> P5A[5A module v2]
  P5A --> P5B[5B CAS bindings]
  P5B --> P5C[5C refresh recovery]
  P5C --> P6A[6A workspace migration]
  P6A --> P6D[6D embed contract implementation]
  P6D --> P6B[6B bundle v2]
  P6B --> P6C[6C graph separation]
  P6C --> P7A[7A security perf faults]
  P7A --> P7B[7B host acceptance release]
```

PR IDs為追蹤識別，不代表字母順序可忽略依賴。Phase1先1A→1C→1D→1B；Phase6先6A→6D→6B→6C，避免tools在durability未成立前對user宣稱saved。每PR可再按檔案規模拆不改語義的小PR，但不能略gate或把schema/無測量範圍留實作者猜。

## Phase 0 — Baseline / RFC

Objectives：確認最新main、sourceaudit、設計可驗收契約、舊資料mapping、ADR與reviewgate。Prerequisites：repository access、cleanbranch、safe tempstores。Files：本Roadmap、docs/rfc/unified-visual-architecture全部、`tests/uva-characterization.test.js`。Public interfaces：無production變更。Required tests：npm/docs/release/Python/browserbaseline、兩characterizationcases、researchbenchmark。Acceptance：8RFC/12ADR、67cases、trace/risk/OD、結果不誇大、core零diff。Rollback：revertdocs/testcommit，原資料未動。Dependencies：無。Main risks：把manifest當功能證據、把FakeHost當live、漏掉新main。

| PR | Deliverable / checkable completion | Exit / review evidence |
| --- | --- | --- |
| PR-0B | R-01–06修訂、正式ProposedSchema/九例validator、22新增testspec、ADR-009–012與scope/evidence | docs/release/consistency/examples/negativecases過、production零diff、獨立commit、停HumanApproval |
| PR-0A | 本套audit/RFC/ADR/mapping/trace/roadmap/characterization/baseline | docs/releasechecks過、tests真實結果列明、workingtreelimited、停ArchitectureApproval |

## Phase 1 — Document Foundation

Objectives：獨立identity、單一documentauthority、non-destructivestore與legacyadapter foundation。Prerequisites：OD-01/ADR001/007/008批准，8RFC一貫性審查。Files：`src/documents/{schema,service,store,references}.js`、`src/persistence/{coordinator,journal}.js`、`src/compat/legacy-canvas.js`、server.js、storage.js（只adapterintegration）。Public interfaces：document/1、typedRefs、commandexpectedRevision/idempotency、explicitdocread/create（flagged）。Required tests：UVA-01/03/24/27/28/31/32/33。Acceptance：graphkind可建schema但尚不交付GraphUI；newdoc無assetrequirement、falseACK不可發生、legacywrites一authority。Rollback：依A7與postwritearchive規則；flag只停新增入口，不能切authority；側寫store與原source保留。Main risks：雙authority、fsync缺失、IDaliascollision。

| PR | Scope / public contract | Required completion / rollback boundary |
| --- | --- | --- |
| PR-1A | strictdocument/scene/ref schemas、Actor/Owner/Provenance/Embed與CommitRoot projections、UUIDgrammar、legacysetregistry、read-onlyshadowmapper | duplicate/missingIDcases、oneowner/invariants、sourceunchanged、completefieldinventory；UVA-55正反例/九流程與strictschemas一致；不註冊新write API或改現有儲存；無productioncutover |
| PR-1C | durablecommit/recovery核心；boundedmanifest/pages、intent/fsync/barrier、OSlease、ledger原子同root | depends1A；UVA-49/59/63/66與原31–33；逐stagekill、fsyncfailure無ACK；不開productionwriter，維護由1D完成；rollback留shadow |
| PR-1D | retentionroots/readerpins、losslesshistory、GCquarantine、journal/ledgercompaction、quota/reserve | depends1C；UVA-46–50/60/63–65；重建hash/ledgerexact、7天ACK不重apply、GCcrash無loss；rollback關maintenance保root與history、不刪資料 |
| PR-1B | authority A0–A7、mediatedlegacywrites/adapter、atomiccutover/seal、launcher+OSreadonlymountfence；newtoolsflagged | depends1A/1C/1D；UVA-56–58/62/66；舊55tools契約不變；oldbinary無法diskwrite；flagoff不換authority；rollback依A7、新寫入先archive |

## Phase 2 — Visual Engine Extraction

Objectives：雙domain共同Layer/Interaction/Rendercontract、coordinate/history可驗。Prerequisites：Phase1exit；OD-02/03、ADR002/004批准。Files：canvas-state.js、scene-catalog.js、assessment.js、mark-render.js、scene/objects.js、scene/canvas-render.js、`src/visual/{annotation-contract,layer-contract,coordinates,hit-test,render-plan}.js`。Public interfaces：annotation/layer commands、Anchor/RenderPlan/1、legacy/unifiedprofiles。Required tests：UVA-05–12/34/36（objectanchor完整UI可至Phase4，但purecontracts此處需test）。Acceptance：metadata守恆、sameauthorpolicy、legacyprofile渲染不變、矩陣inverse/tolerance、committedundo安全。Rollback：sharedrenderflag off；newanchors未開就不寫不可讀state。Risks：Evidence欄位遺失、opacity/stacking、undo繞lock、inkgeometrydrift。

| PR | Scope / public contract | Required completion / rollback boundary |
| --- | --- | --- |
| PR-2A | annotation/layercontracts+domainadapters、createdBy/lastEditedBy/modulelineage/ownership、fieldpreservation、typedLayer.content | UVA-41/42；richmarks逐欄hash、importunclaimedowner、trustedactorstamp；legacytests不變，新政策明確分route；rollback不丟原provenance |
| PR-2B | purecoordpipeline/anchortypes、完整Unified AI/module Annotation userediting、claimcontext/Evidencestale、guard、inversehistory、eraser/resize | UVA-43–45與原coords；Move/Resize/Restyle/Relayer/Relabel/Delete+Undo/Redo逐case；exactcontext恢復、防LLM覆寫、legacyroute不擴權；rollback關newpolicy不刪歷史 |
| PR-2C | commonRenderPlan與server/browser/SVGadapters、legacyprofileshadowcomparison | UVA10/11/34＋measuredserverbudget，nocrossaudiencecacheleak、no arbitraryHTML/SVG，核准後optin |

## Phase 3 — Multi-Viewport Infrastructure

Objectives：拆singleton、DocumentStore共享內容、每viewport獨立camera/tool/selection、Hostrecovery。Prerequisites：Phase2parityexit、ADR003、OD-04transport選擇。Files：public/visual-surface.html、workbench.js、newpublic/visual/*、surface/store/service/layout/mcp-tools/widget-source、serverresourceassembly。Public interfaces：surface/2、PanelBinding/ViewportRecord、documents_get_changes、resultenvelope/1。Required tests：UVA-04/13–18/26/32/35/37/40(fake)。Acceptance：same-doc2views/multidocs、兩widgetOCC、latecallback不錯panel、close不丟data、mobilelayout、量測budget核准。Rollback：單vieweradapter；newdocuments可read/export，無強制降級。Risks：globalDOMselector、keyboard/pointers互搶、stalerender、pollcost。

| PR | Scope / public contract | Required completion / rollback boundary |
| --- | --- | --- |
| PR-3A | Viewerfactory/ViewportController/Panelbinding、SurfaceLayoutController extraction；先image兩instances | global#surface dependency清除、dispose/ResizeObserver/gesturecancel、focusrouting；existingUI同fixture保持 |
| PR-3B | docstore subscriptions、pollreconcile、hostdedup/chunkmissingmeta、widgetrestore+draftpolicy | UVA18/26/32/35 runtimecases，samecommand失ACK可查，noautocreationonreload |
| PR-3C | 1/2/5viewers、多profile/rotation/stress與performance trace | UVA13–18/37數據、heap/listenercycles、核定新workloadbudgets；未核准不能exitPhase3 |

## Phase 4 — Independent Graph

Objectives：Graphdoc不需PNG，保留既有math並取得完整sharedannotationtools。Prerequisites：Phase3exit、OD-02anchors批准。Files：builtin-modules/graph/index/manifest、scene/objects.js（只boundedcontextintegration）、documents/service、visualviewer/inspector、surfacepanelregistry。Public interfaces：create/open/read/exportgraphdoc、explicitframe targeting、anchorpolicy。Required tests：UVA-02/05/06/09/11/12/14–17/34。Acceptance：3graphs+image、多view同graph、freehand/pen/highlighter/eraser/resize/layers/undo/zoom/persistence都驗，不以獨立window顯示作exit。Rollback：disablecreate，existinggraphreadonly+editablearchive。Risks：重寫sampler、fakeimageidentity、worldanchor誤解。

| PR | Scope / public contract | Required completion / rollback boundary |
| --- | --- | --- |
| PR-4A | graphkind/solidbackground、trustedGraphViewer sharedfactory、plotcontextadapter | assetwrites=0、existingparser/sampler/labeltests全過、2Graph互不污染、legacycanvasGraph照常 |
| PR-4B | graphsharedtoolbar、Unifiedediting/Evidenceguard、explicitdoc/world/function-xanchor、invalidbadge/reanchor/detach | 完整UVA-43–45與原05/06/09/12、LLMrender/readroundtrip；resize/axesrange/camera區分；無copyengine |

## Phase 5 — CAS / Module Integration

Objectives：modulev2target/permissions/ABI、stableCASbindings、usereditconflict、asyncsafety。Prerequisites：Phase4exit、OD-05/06與ADR005/006/008批准。Files：modules/manifest/router/mcp-tools/permissions/runtimes/packages/selftest/jobs、cas/notebooks/bridge/client、builtinCAS、surface/refresh與publiccalculator。Public interfaces：module/2/panel/2/optionalWASM2、cas-notebook/2、bindingrecord/commands；v1stable。Required tests：UVA-19–21/27–32。Acceptance：9API範例可MCPintegrationexecute、grants不自動擴大、CASpostscene原子、useredit不覆蓋、asyncleasevalidated。Rollback：v2execution/autorefreshoff，publicstoredobjects仍render；nb/v2archive保留。Risks：oldgrant讀所有doc、CASmodel雙authority、跨storepartialcommit。

| PR | Scope / public contract | Required completion / rollback boundary |
| --- | --- | --- |
| PR-5A | v2strictmanifest/targetcontext/effectivegrantintersection+signerlineage+userguard、v1imageadapter、ABIversion/Storediff | UVA-41/42/53；v1signedbytes不改、packageselftests、crossdocdenial、capneededintersectgrants；v1noGraphfakeimg |
| PR-5B | typedCASbinding＋source/targetsignatures、coordinatorlinktransaction、manualeditpause | UVA19/20/31；detach/overwrite/fork具preview+expectedrev；adoptionowner限制、noclobber |
| PR-5C | recomputeattempt/envhash、multitargetpartialrefresh、removed/unavailable、cancel/revocation | UVA21/28/32；lateeffects0、offline不判刪除、afterfault可恢復、每項結果可追 |

## Phase 6 — Workspace / Bundle Migration

Objectives：referenceworkspace、v1→v2sidewrite、editablebundle2、graphseparation。Prerequisites：Phase5exit、OD-06/ADR007/008批准；完整backup可restore至新tempvolume。Files：workspace/storage/bundle/zip/surfacebundleextras、`src/migrations/*`、`src/compat/legacy-bundle.js`、newpreviewUI。Public interfaces：workspace/2、bundle/2、plan/commitmigration與graphseparation、Move/Copy/Link/Embed/Detach。Required tests：UVA-07/12/22–27/29–33/36。Acceptance：每舊格式mapping可replay、wholefieldhash/count/refs、source原bytes不改、realdata操作必plan、rollback保newdata。Rollback：A7凍結原volume、verifiedv2archive；有newwrites僅另建明確選取的legacyvolume，不能原位pointer回退或rasterdowngrade。Risks：錯setcasref、layer split、sameState只比marks、importID撞localexisting。

| PR | Scope / public contract | Required completion / rollback boundary |
| --- | --- | --- |
| PR-6A | workspace/2refitems+legacyworkspaceadapter、performatmigrationplanner/registry/report | UVA22/24/25、fullleafinventory、previewhash+OCC、copy-on-write；archivelegacyundo而非誤套新rev |
| PR-6D | embedded-document object/schema/ops、childsoleauthority、editableclone、dependencyvector、auth/cycle、defaultparentediting | depends6A/5A；UVA-51–54/61/67；同parentrev下child事件更新、noauthleak、snapshot獨立、nestedV1明拒；rollback停embedcreation保doc/refs可read/export |
| PR-6B | bundle/2export/import+v1reader、newIDtwo-passmapping、surface/nb/interactionextras | depends6D；UVA-54/58/60/61/67與原07/23/25/27/30/31/36；editablechildclosure+refs/counts/hash/postreloadverify；externalrefunresolved；rollbackarchive驗 |
| PR-6C | graphseparationpreview+選ink/objects/anchor，5ops、incomingref/CAS/evidenceimpact | depends6B/6D；UVA-54/61/67與原12/22/24/25；embedCopy/Move/Detach/CAS maps；overlap不自動歸屬、locked拒Move、closure完整、undo保原資料與歷史 |

## Phase 7 — Hardening / Release

Objectives：故障、安全、效能與真Host驗收，版本/文件/rollout可操作。Prerequisites：Phase6exit；全部OD批准並核定support期限、測量budgets；實測Host帳號/平台可用。Files：tests/uva-security/recovery/perf、CIoptionalbenchjob、docs/COMPATIBILITY/DEPLOYMENT/TOOLS/RELEASE、Docker/Compose（若必要）、version/URIaliases。Public interfaces：凍結supportedformat/API/ABI版本，noadditionalarchitecture。Required tests：全部UVA-01–67，既有全suite、Python、docs/release、newvolumeCompose+backuprestore。Acceptance：0knownP0/P1、realWeb/Mobile逐平台record、securitynopermissionleak、固定runnerbudgetpass、stagedrelease無forcedmigration。Rollback：旗標+原volume備份、newarchive、read-onlyrecovery；tagrelease需既有maintainer流程，不自動發布。Risks：把fakehost當真、測不完整就release、downgrade丟newgraph。

| PR | Scope / public contract | Required completion / rollback boundary |
| --- | --- | --- |
| PR-7A | faultinjection/zip/securityreferencefuzz、fixedrunnerbenchmark、container/backuprehearsal | UVA-46–50/57–60/62加原28–37全部已執行；Storagegrowth/quota/ENOSPC/GC/compaction/powerloss+oldbinaryfence、limits與dataintegrity不退讓、productionruntime與architectures記錄、noignoredskips |
| PR-7B | 真HostWeb/iOS/Android/MCP/CSP驗收、supportmatrix、docs/releases/versionedURIs | UVA38–40逐項evidence；新formats/downgrade說明；maintainer批准release，未驗平台不得labelTested |

## Architecture Approval Gate

Phase0完成後停止核心功能工作。Review需核實OD-01/02/03/04/05/06推薦、所有ADR status、migration/fullfields、67casegate、單writerdurability與Host未知。批准最小單位可為Phase1 foundation，但需記明NotApproved範圍；未有批准不建立任何Phase1productionmodule、不改dataformat。

## Phase 0.1 — Dependency / Approval Updates

20原PR保留識別，新增PR-0B（本輪規格）、PR-1D（維護）、PR-6D（Embed），合計23單位。1A必含R-01Provenance/Actor/Owner與R-04Embed schema；1C不得包成一個全儲存大PR，maintenance另1D；1B只在1D與fence可用才允cutover。2B新增產品政策需OD-02明確批准；6B/6C需6D的editablechild與refmap；7A需真fault/capacity證據，文件schema通過不取代它們。

Phase退出追加：Phase1=UVA-41/42schema+46–50/56–60/62storage/authority；Phase2=UVA-43–45；Phase4=graphedit/anchor/evidence全流程；Phase5=modulegrant/lineage與CASguard；Phase6=UVA-51–54/61、migrationclosure；Phase7=realFS/powerloss/Host。每PR仍需獨立review/explicitdependencies/testableexit/rollback，不在本輪實作任何項目。

## Phase 0.2 — Limited Approval Package / Additional Exit Gates

23個PR識別不變；本輪只修實質缺口，不增加大型implementation PR。最小可請人類批准的是**PR-1A schema/readonly foundation**：OD-01 identity/typedownership與OD-02/06的必要schema部分逐項簽核；同意資料結構不等同同意editing rollout、durable平台或cutover。批准紀錄要列此review commit、allowed paths/API、tests與NotApproved。沒有紀錄仍不能開始1A。

- PR-1C prerequisites：1A退出、OD-01/ADR-010 persistence/backend明確批准；coherent CommitRoot、六roots、RecoveryCatalog resolverpair、fsync/lease/error分類與Linux profile納UVA-63/66；disposable stores故障測試才是1C範圍，不能直接拿使用者volume驗。維護未完成不能開productionwriter。
- PR-1D prerequisites：1C退出；G1/G2、archive/operationalcheckpoint thinning proof、deadline/quiescent pins、boundedcompaction/backpressure納UVA-64/65；raw capacity/maintenance benchmarks後核准quota/threshold profile，不能因10GiB不夠刪歷史。每stage crash與7dACK/永久ledger oracle不變。
- PR-1B依1C/1D與UVA-66的實際ROmount/oldbinaryfence證據，且可信user-action actor來源在暴露user-level新write route前必有securityreview；若無可證Host來源只允已認證owner management path或拒該user route。Flags不代替approval或authoritycommit。
- PR-6D/6B/6C納UVA-67的snapshot eligibility/拒絕/替代與nested bundle roundtrip；undefinedmaterialize API不在實作範圍。PR-7A涵蓋UVA-63–67的長跑/平台重驗，但不得延後Phase1與6的必要前置測試。

最新獨立R-01–06分類、容量/平台證據限制與推薦範圍見[FINAL-ARCHITECTURE-GATE](docs/rfc/unified-visual-architecture/FINAL-ARCHITECTURE-GATE.md)；它不批准任何ADR，不授權Agent自行進Phase1。

## PR-1A — Actual implementation / stop boundary

[有限授權](docs/rfc/unified-visual-architecture/PR-1A-AUTHORIZATION.md)允許10個隔離schema/helper modules與2個聚焦tests及fixture；實際exports／限制見[Schema Contract](docs/rfc/unified-visual-architecture/PR-1A-SCHEMA-CONTRACT.md)，實測狀態以[Implementation Report](docs/rfc/unified-visual-architecture/PR-1A-IMPLEMENTATION-REPORT.md)為準。PR-1A不啟用production Doc writer、module grant、GraphViewer或migration；既有source/config不變。完成本PR後停止，PR-1C即使依賴schema已具備也仍須維護者另行授權／審查。

## PR-1C — Actual implementation / blocked native verification

[新有限授權](docs/rfc/unified-visual-architecture/PR-1C-AUTHORIZATION.md)已允許獨立PR-1A review修訂及PR-1C隔離transaction backend；歷史1A stop紀錄不被改成全OD批准。真file I/O、flock／journal／sixroots／OCC／ledger／recovery與fault tests的實際範圍見[Implementation Report](docs/rfc/unified-visual-architecture/PR-1C-IMPLEMENTATION-REPORT.md)。

PR-1C尚未完整退出：本環境無已批准ext4/XFS掛載，native durable正向test明確Skip；test-only ACK不算native durable evidence。後續最小工作是在批准的disposable native mount重跑backend／stage faults，保留FS/driver/kernel與exact commands；不用重開架構或先做1D。沒有maintenance／fullotherstore adapters／部署fence，不允啟productionwriter。1D與1B均未開始亦未授權；本輪commit後停止，未push／merge／release。


## PR-1D — Current isolated implementation and remaining gate

Latest explicit user instruction authorizes implementation, not integration. New lifecycle is confined to `src/persistence/` and requires explicit isolated opt-in; persisted policy then remains authoritative across restart. Existing server/tools/stores do not import or activate it. PR-1A, original PR-1C and WSL2 native evidence stay historical and unchanged.

Implemented units within PR-1D: (a) retention/reader pins and verified logical delta locators, (b) coordinator-committed compaction/G1/G2/journal/ACK lifecycle, (c) allocated-block quota/reservations and fair serialized admission, (d) pinned document-store backup and new-volume read-only restore, (e) process/fault tests and measurements. Each Root mutation uses the same coordinator and six-root manifest; no secondary CURRENT.

Exit remains **IMPLEMENTATION BLOCKED** pending new-code native ext4/XFS acceptance, full capacity/workload qualification and exact durable attribution/drain of random atomic crash-temporary artifacts. Unknown artifacts are retained conservatively rather than deleted by suffix. Small real benchmarks and application fault injection do not establish production SLA, block-device power-loss safety or complete UVA coverage. See the report's measured limitations, including historical validation CPU cost and conservative retained metadata. No production writer may be enabled.

PR-1B continues to depend on completed PR-1D safety gates, separately approved Authority Cutover/old-binary fencing, authenticated operation policy, binary/other-store closure, cross-store recovery and explicit migration authorization. Feature flags cannot transfer storage authority. Rollback preserves the complete lifecycle-capable store and history; old PR-1C cannot read delta stores and must not resume their writer.
