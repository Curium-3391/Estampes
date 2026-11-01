# Review Findings Remediation — Phase 0.1

Status：**READY FOR HUMAN APPROVAL — 尚未 Approved**。六項Finding規格修訂完成；沒有開始Phase1或執行資料遷移。核心方向保持使用者原則性支持的Document/Asset分離、單SceneOwner、雙Domain共享引擎、Graph獨立、typedrefs與legacy非破壞兼容。

## Repository Baseline / Evidence

2026-11-01 UTC重新fetch/ls-remote核對：Phase0 base `b42e6afc7ca78b280ad522a93e111ba2ef407cd7`，遠端Phase0分支相同；main `7fb9b73442401fc32a7034888deaf49303e582a6`與原auditbase無diff。初始workingtreeclean；新branch `docs/unified-visual-architecture-phase0-review`。第一次fetch後沒有origin/Phase0trackingref，調查確認remote只追main refspec，明確fetch該ref後建立reviewbranch，未force或覆寫既有branch。Version仍0.20.0；CURRENTsource不變，所有新增型別/工具/GC/cutover皆PROPOSED。

相關驗證紀錄見[evidence/review-execution-manifest.json](evidence/review-execution-manifest.json)。本輪不重寫Phase0原logs/benchmark，亦不把舊結果列為本輪重跑。ADR-009–012是補充，原ADR-001–008保核心decision、實際受影響段落加連結。文件專用schemas不是productionvalidators。

## R-01 — Critical

- **Finding ID**：R-01
- **Severity**：Critical
- **Original Problem**：Annotation author只有user/assistant，卻允moduleannotation，creator/actor/owner/grants混用。
- **Source Evidence**：RFC-002 Annotation.provenance；CONTRACTS.annotation.create；modules/router.js createRouter 與 scene-ops.applySceneOps trustedsource/ownerchecks。
- **Affected RFC / ADR / Contracts**：RFC-001/002/005/007、CONTRACTS、ADR-002/005→ADR-009、OD-02
- **Alternatives Considered**：A擴enum；B作者/owner分離並容moduleauthor；C禁moduleV1。
- **Recommended Resolution**：B：Principal/ActorContext/Ownership分離，createdBy/lastEditedBy/history；moduleId+signer+lineage+currentgrants，importunclaimed。
- **Exact Contract Changes**：author=user/assistant/module/unknown；actorserver-only；module grant intersection；lineagerestore/keyrotation/disable/reinstall規則；strict input拒author/actor。
- **Compatibility Impact**：legacytools/manifest1不擴權；legacyassistant不依layermodule改成module。
- **Migration Impact**：本機legacy原作者保留為historicalprincipal；外部importactiveauthorunknown、original完整保存、owner不自動復權。
- **Security Impact**：module ID非授權、asynccommit重驗；偽user拒、無childref擴權。
- **Test Impact**：UVA-41/42/55；Provenance正反例與runtime授權spec。
- **PR Impact**：PR-1A/2A/5A新增前置；ADR-009。
- **Remaining Risks**：signer/lineageregistry與Hostactioncapability必productionPR驗；本輪schema不能證明真正actor來源。
- **Status**：RESOLVED — SPECIFICATION COMPLETE

## R-02 — Critical

- **Finding ID**：R-02
- **Severity**：Critical
- **Original Problem**：Legacyuser只能改ownmarks，被沿用為新架構限制，缺AIedit/Evidence/Undo/LLM防覆寫語義。
- **Source Evidence**：src/canvas-state.js editCanvas() author檢查；RFC-003/RFC-007及CONTRACTS舊only-own描述。
- **Affected RFC / ADR / Contracts**：RFC-001/002/003/004/005/007/008、CONTRACTS、ADR-002/004→009、OD-02/05
- **Alternatives Considered**：A全保legacy限制；B Legacy兼容＋Unified完整userediting；C抹原author改成user。
- **Recommended Resolution**：B：user可編輯所有可寫未鎖AI/module Annotation，createdBy不可變；當前claim與歷史verification分開。
- **Exact Contract Changes**：operation-specific矩陣；doc+annotationOCC；geometry/anchor stale、style/presentationlabel不stale；note新claim；Undo exactcontext；userguard與單次owner許可。
- **Compatibility Impact**：edit_visual_canvas維持原規則與response，newroute選unified/1由server決定，不允caller選policy。
- **Migration Impact**：oldedited與原evidence/review全存，不把historicalconfirmed當newgeometryconfirmed。
- **Security Impact**：userauth由可信servercontext；lock不繞過；LLM讀最新仍不可自動覆寫userguard。
- **Test Impact**：UVA-43–45，逐操作與stale/Undo/leasefailuretransition。
- **PR Impact**：PR-2B/4B擴充；PR-5A重驗guard。
- **Remaining Risks**：**產品政策待維護者正式確認**，specification complete不等於HumanApproved；UI與Host真實路徑後續驗。
- **Status**：RESOLVED — SPECIFICATION COMPLETE

## R-03 — Critical

- **Finding ID**：R-03
- **Severity**：Critical
- **Original Problem**：全量generations、journal只提cleanup，缺roots/GC/history/ledger/capacity/FSdurability。
- **Source Evidence**：RFC-006 fullmanifest/ancestry/cleanup段；storage.saveCanvas僅rename且catch；Phase0benchmark只現行render/Bundle。
- **Affected RFC / ADR / Contracts**：RFC-001/002/006/007/008、CONTRACTS、ADR-007→010、OD-01
- **Alternatives Considered**：A所有full永留；B依age直接刪；C rootGC＋losslesshistory/ledgercompaction。
- **Recommended Resolution**：C：current/recovery/pins/checkpoints/transaction/history roots；複本GC＋losslessarchive，quota/reserve，分頁root與verifiedlocatorpublish。
- **Exact Contract Changes**：2代且24h recovery；7天fullACK＋永久tombstone；24hquarantine；Q=10GiB/reserve；64MiBdoc/4MiBpages/64KiBroot；fsyncbarrier/OSlease；完整faulttable。
- **Compatibility Impact**：不改legacy原格式；unsupportedFS不冒durableACK；memorysession另標示，不偷偷降級原durablestore。
- **Migration Impact**：原始資料/migrationraw/history唯一副本永不自動GC，backup含registry/ledger/authority；超quota拒新寫不刪歷史。
- **Security Impact**：GC只managedpaths、newroots再mark、權限與hash驗證；unknownref停止維護。
- **Test Impact**：UVA-46–50/59/60：GC/compact/crash/ENOSPC/backup/ledger；產品故障測試尚未執行。
- **PR Impact**：拆PR-1D先於1B；1C核心durability，7A真FS/powerloss/capacity。
- **Remaining Risks**：硬體honorflush是部署前提；歷史真實成長不可無損消失；defaultquota需批准與實測校準。
- **Status**：RESOLVED — SPECIFICATION COMPLETE

## R-04 — High

- **Finding ID**：R-04
- **Severity**：High
- **Original Problem**：Embed只有概念/矩陣，無persistentobject/binding/mode/edit/cache/ref完整契約。
- **Source Evidence**：RFC-003第6anchorpolicy與rendercache；RFC-005 embed例；現行scene/objects.js沒有embedded-document。
- **Affected RFC / ADR / Contracts**：RFC-002/003/004/005/006/007/008、CONTRACTS、ADR-003/006→011、OD-06
- **Alternatives Considered**：A parent持child副本；B typedembed＋單childauthority＋snapshot獨立clone；C raster。
- **Recommended Resolution**：B：EmbeddedDocumentObject、canonicalEmbedBinding、ResolvedEmbedvector；defaultparentdrawing、explicitchildviewport。
- **Exact Contract Changes**：mode/sourceRevision/snapshotOrigin/matrix/clip/layer/ownership/visibility/lock/missingtarget；operations/lifecycle/cycle/globalgraphlock、dependencytoken/scopedcache、CAS真childRef。
- **Compatibility Impact**：legacybundle/imageobject不假裝能表示embed，unsupported拒；不自動raster。
- **Migration Impact**：Copylive共享child須preview，deepcopy/detach獨立editableclone；export/importclosure/idmap；nested snapshot V1 explicitBLOCKED_DEPENDENCY。
- **Security Impact**：childread/write每次scope驗證；deniedplaceholder無childmetadata；cycle/depthlimited；cacheauthrev。
- **Test Impact**：UVA-51–54/61：lifecycle/cycle/auth/editableclone/CAS/roundtrip。
- **PR Impact**：新增PR-6D（6A後、6B/6C前），1A先定schema。
- **Remaining Risks**：reference reverseindex與grantrevocation通知需runtime驗；nested snapshot未支援已明定拒絕與preview，不存在默認loss。
- **Status**：RESOLVED — SPECIFICATION COMPLETE

## R-05 — High

- **Finding ID**：R-05
- **Severity**：High
- **Original Problem**：API例用短ID、stringlayer、缺requiredrevision/refs；request與command映射含糊，CAS例隱含跨moduleadoption。
- **Source Evidence**：RFC-005原EX04 layer=new-user；d1/s1/tx1等代稱；expectedDocRevision/expectedDocumentRevision混用。
- **Affected RFC / ADR / Contracts**：RFC-002/005、CONTRACTS、所有JSONfences與ADR/roadmaprefs；新增evidenceproposedschemas/corpus/validator。
- **Alternatives Considered**：A只文字修正；B正式closedProposedschemas＋9corpus/MDfencecompare/negativecases；C改productionvalidators。
- **Recommended Resolution**：B：九例全部完整合法IDs與typedrefs；明確所需先決條件；示意Manifest另標illustrative。
- **Exact Contract Changes**：req:UUID→cmd:同UUID，client禁commandId/actor；各route版本軸表；newAxes/frame互斥、layerobject、CASnewownedplot、三objects與一annotationcounts。
- **Compatibility Impact**：Productionvalidator/API完全不改；legacyexpectedRevision仍sceneaxis，newtarget禁止混傳。
- **Migration Impact**：例子非migration實作，不改使用者資料或legacyfixture預期。
- **Security Impact**：strict input拒偽author/permissions、wrongtargetrefs、singularmatrix；不把schema檢查當授權證明。
- **Test Impact**：UVA-55實作docs-onlyvalidator＋16negative/positivecases（含未知歷史module與adoption不改creator）；其他產品tests只規格。
- **PR Impact**：PR-0B交驗證工具；PR-1A/5A後續productionvalidator需實際等價驗證。
- **Remaining Risks**：TS/語意矩陣經交叉人工審核而非完整compiler proof；validator只覆已宣告subset，不驗liveCAS/FS/Host。
- **Status**：RESOLVED — SPECIFICATION COMPLETE

## R-06 — High

- **Finding ID**：R-06
- **Severity**：High
- **Original Problem**：flags/shadow/sidewrite未逐態固定權威；回退/oldbinary/projectionrace可形成雙writer。
- **Source Evidence**：RFC-006 legacyprojection/rollback段；RFC-008flags；0.20.0storage不讀newmarker或newwriterlock。
- **Affected RFC / ADR / Contracts**：RFC-001/004/006/007/008、CONTRACTS、ADR-001/007/008→012、OD-01/06
- **Alternatives Considered**：A flags決定writer；B authorityepochatomicmanifest＋mediator＋OS/launcherfence；C inplace強制遷移。
- **Recommended Resolution**：B：A0–A7逐態read/write/tool/revision/migration/projection/crash/rollback，cutoveralias/doc/seal/ledger同root。
- **Exact Contract Changes**：A3gate/drain/hashrecheck；newepoch拒latejob；projection獨立tree永非authority；flagoff不刪newDoc；oldbinaryfence不可省；A7postwriteexportnewvolume。
- **Compatibility Impact**：舊工具保legacy授權但A4寫unified；newGrapholdAPItyped拒；oldbinary只readonlysnapshot或明確downgradevolume。
- **Migration Impact**：不動原source；sourceSeal/aliasdrift A6不merge；postwrite原位rollback禁止、先v2完整備份與選擇。
- **Security Impact**：舊binary不認lock，mandatorylauncher/ROmount；不能假稱baselinebinary會回新typederror；無fence拒cutover。
- **Test Impact**：UVA-56–58/62＋57真oldbinary/OSwriteguard；pointer後projectionfailure仍newauthority。
- **PR Impact**：PR-1B新增exit並依1D；6B/7A驗postwritebackup與fence。
- **Remaining Risks**：native任意直跑舊binary/privilegedoperator可破隔離，列部署不支援；須實際環境演練才開writer。
- **Status**：RESOLVED — SPECIFICATION COMPLETE

## Cross-document Consistency / Gate

[ANNOTATION-POLICY](ANNOTATION-POLICY.md)、[STORAGE-LIFECYCLE](STORAGE-LIFECYCLE.md)、[EMBED-CONTRACT](EMBED-CONTRACT.md)、[AUTHORITY-CUTOVER](AUTHORITY-CUTOVER.md)為正式推薦細則，RFC/CONTRACTS/ADR/OD/PR/testtrace已同步。新增UVA-41–62，合計62cases；PR新增0B/1D/6D，合計23units。九正式API例與Proposedclosedschemas可檢驗；一manifestfragment明確IllustrativeOnly，未宣稱完整可安裝。

沒有已知尚未處理的契約矛盾；範例驗證的範圍限制、unsupportednestedSnapshot、無fence拒cutover、硬體flush前提均明列而非留實作者猜。**Ready for human approval**只表示規格已可審；R-02產品editingpolicy以及OD-01–06/新ADR尚待人類正式確認。原有Host/performance/runtime安全/GC產品測試仍須相依PR執行，不在本輪假稱已通過。若維護者改選方案，先同步schemas/例子/tests再進Phase1。

## Actual Verification / Evidence Boundaries

本輪Node22全suite實測275passed/0failed/0skipped（125.229s），文件專用contracttests16passed/0failed/0skipped；九組正式JSON全通過Proposedschemas、Markdown/corpus/sequencecheck，另有一個明示IllustrativeOnly的manifestfragment（僅檢宣告permissions/capabilityparams一致，非可安裝完整manifest）。[Contract inventory](evidence/contract-inventory.json)列20個JSON/TSfences，TS僅readmodelprojection＋交叉審查，未聲稱TypeScriptcompiler等價證明。

docs:check通過81Markdown/55tools/22configvars；release:check通過0.20.0；consistency通過8RFC/12ADR/62cases/23PR/6findings/ODrefs、95sourcehash與historicalbaseline不變。曾有一個EOF空白行由gitdiffcheck指出並已修正；沒有降低測試預期。所有正式功能檔案、既有tests/expectations與使用者資料皆未改；本輪只docs/roadmap與evidencevalidators。

未執行真ChatGPTWeb/Mobile/MCPHost/CSP、Docker/mountfence/powerloss/GC/cutover/compaction產品故障測試（功能尚未實作）、本輪Python獨立17tests及效能benchmark重跑。Node全suite含可用CAS/browserintegration，FakeHost不是真ChatGPT。這些未執行項不列pass；各PR仍被相應testgate阻擋。獨立commit與workingtreestatus由最終git回報；此report不自我包含commitSHA。
