# Phase 0.2 — Independent Final Architecture Gate Review

Status：**PROPOSED / HUMAN APPROVAL PENDING**。2026-11-01 UTC審查；未實作Phase1、未遷移資料、未批准ADR。此報告取代Phase0.1自評作為**最新審查結論**，不改寫其歷史證據。Current=production source；Observed=本輪實際命令；Proposed=以下契約；Future=另需ADR的擴充。文件完成、測試通過與人類批准是三件事。

## A. Baseline Verification

| Item | Verified result |
| --- | --- |
| Production / origin/main | `7fb9b73442401fc32a7034888deaf49303e582a6`，version0.20.0；fetch後main相對原auditbaseline無diff |
| Phase0 | `b42e6afc7ca78b280ad522a93e111ba2ef407cd7`，是Phase0.1 ancestor |
| Phase0.1 / remote review branch | `df70d2bfb84f5548fb8e7fc81ebfbd0eb4eefadd`，與prompt及ls-remote相同；包含Phase0 |
| Initial tree / branch | clean；docs/unified-visual-architecture-phase0-review |
| Correction branch | docs/unified-visual-architecture-phase0-final-gate，由exact Phase0.1 commit建立，未merge/rebase/force/main edit |
| Phase0→0.1 diff | 47files、+4521/-125；RFC/ADR/supplements/roadmap、proposed validators/corpus與logs。完整patch可由兩個SHA重現；逐檔hash/numstat分類見evidence/phase01-diff-inventory.json |
| Production integrity | source-index的95個source/config SHA256保持相同；本輪diff只在RFC目錄與root Roadmap，production JS/UI/deployment/version/既有test無修改 |
| Historical integrity | Phase0 BASELINE/source-index/logmanifest、Phase0.1 REVIEW-REMEDIATION/logmanifest/九例corpus保持原bytes；原16文件測試body與expectations未改，新增反例另列 |

Baseline命令包含git fetch origin、明確fetch兩trackingrefs、git ls-remote、git merge-base --is-ancestor兩次、git diff production..origin/main、git diff --numstat/完整patch Phase0..0.1、git status與新branch建立。origin原refspec只追main，明確fetch reviewref後驗證；未強制覆寫本機branch。完整Phase0.1變更分為contracts（重新逐節交叉檢查）、JSON/TS/proposed code（正反例與fence比對）、historical logs（hash+results檢查），不將log行數當功能覆蓋。

Current production依據再次檢查：`src/storage.js:37 atomicWrite`只有writeFile+rename；`:144 saveCanvas`分別寫canvas/SVG/history並catch logging，沒有file/dir fsync或CommitRoot。`src/canvas-state.js:222 editCanvas`在:262拒移動/restyle AI marks、remove只查lock。`src/modules/router.js createRouter/work`由Core帶module actor、async work(false)略過revision；現行job預設10min、manifest上限30min。Dockerfile是Node22/nonroot，Compose把named volume掛至writable `/data`；沒有本方案的supervisor/RO-source fencing。這些都未因文件補齊而變成已修復。

## B. Independent Finding Review

以下是**完成本輪修訂後**分類；前次「RESOLVED」不是判斷依據。R-03/04/05在入場時仍需規格修訂，現已在C列出的契約補正。條件為明確的相依PR/批准門檻，不是隱含授權。

### R-01 — Module authorship / ownership

Classification: ACCEPTED WITH CONDITIONS

原 author enum 與 annotation.write.owned 的矛盾已由 ANNOTATION-POLICY 的Principal/ActorContext/Ownership/AnnotationProvenance分離解決。逐核module create/update、跨module拒絕、user編輯、assistant不得改module、停用/移除保內容、reinstall需signer+lineage/owner adoption event/current grants、legacyassistant不依layer.module改作者。Ref與ModuleID都不授權；currentgrants與lock/OCC於commit重驗。不可變createdBy與lastEditedBy分開，adoption event不能改歷史creator。

本輪找出doc-schema尚允imported-unverified同時保active module owner（FG-05）；已修為createdBy=import/author=unknown、original必存、instance/unclaimed owner，新增negative test。完整備份restore仍需原registry/namespace，普通import不提升trust。原schema反例可重現，不聲稱production曾容許此新API。

條件：PR-1A strict schema等價、PR-2A/5A runtime lineage/currentgrant tests UVA-41/42；**在任何user-level新write route暴露前**，PR-1B/2B必證可信app-user action來源。若Host無可驗來源，拒該route、保草稿，僅明確owner-authenticated管理路徑可用；app-only visibility不算證明。這是failclosed契約，尚未證明真ChatGPT可用；不能把未實作session/action capability寫成現有保證。OD-02產品與授權政策仍需maintainer簽核。

### R-02 — User editing AI/module annotations / evidence

Classification: VERIFIED — SPECIFICATION COMPLETE

Unified user對有權且未鎖的AI/module標註可Move/Resize/Restyle/Relayer/Relabel/Delete/Undo/Redo；不恢復only-own限制。不可變createdBy、sticky editedByUser、lastEditedBy、新revision與完整before/after/history保存原作者。geometry/anchor/units改動使current evidence/verification stale，原raw evidence、claim、review歷史不刪；style/presentation label不改claim語意，finding.note修改是新claim。source semanticHash由trusted classifier決定，未知依賴保守stale；單純range/camera改投影不改world context。

Undo是新command，affected refs/revs/locks與exact語義sourcecontext吻合才恢復原applicability；不抹user audit、不解除guard。LLM拿最新revision仍不能覆手改，one-shot<=10min owner lease只解除該次guard，不擴ownership/grants。Legacy edit_visual_canvas維持自己的授權/回傳。RFC004與政策的wire版本名稱另由FG-06修正，避免內部commandId誤進client接口。

剩餘風險為實作與**產品批准**，不是已完成runtime功能；UVA-43–45/PR-2B/4B及可信actor前置未執行。OD-02需明確批准完整矩陣、label語意與Evidence/guard/Undo；本分類不等同Human Approved，也不允先寫Phase1核心。

### R-03 — Retention / GC / durability

Classification: ACCEPTED WITH CONDITIONS

Phase0.1有roots/journal/7dayACK/permanentledger，但24h blanketquarantine與可回收fullcopy目的矛盾；checkpoint每1000commands也可能放大儲存，Registry/Locator缺完整coherent root。FG-01/02已補六roots CommitRoot、logical recovery resolver pairing、G1/G2、archive與operationalcheckpoint的verified thinning、按bytes預訂、maintenance admission與job quiescence。禁止自動刪logicalhistory／原始資料／唯一已ACK內容；7天fullACK與永久tombstone不能因GC、restore或flags消失；stalebackup不含其後ACK時不得透明續寫舊command lane，先A6並取得完整tail／無postbackup效果證據。超quota拒寫保draft，postrename/fsync不確定進A6，不回durableACK。

Durability只在指定profile、同FS rename、file+directoryfsync barrier、OS單writer lease成立後；platformprobe不證host powerloss。Desktop/macOS預設拒V1 user-volume durablewriter，不把Docker/ARM image可執行當證據（D矩陣）。GC/recovery原子算法已具體，但這輪沒有新引擎可供量測。

條件：OD-01/ADR-010 persistence/platform批准、PR-1C/1D的UVA-46–50/59/60/63–66故障與容量證據、實測後profile校準，**皆在PR-1B writablecutover前**。PR-7A再擴固定runner/長跑/outerVM或blockfault；不可將Phase1必要故障驗證全部延後。1KiB/10GiB/1000/32MiB等是可審查起點，非通用SLA；E列出其不適合的工作量。

### R-04 — Embedded documents

Classification: VERIFIED — SPECIFICATION COMPLETE

已核EmbeddedDocumentObject與canonicalBinding等式、唯一child authority、live captureRevision與effectiveRevision區分、snapshot新editableclone、parent預設drawing/explicit child editing。childcommit沿reverseindex/dependencytoken通知，即使parentrev不變；render固定vector，authrev撤銷不能靠cache續顯。parent read不推child read/write；deniedprojection連childID/hash/count也不回。create/retarget/import對afterstate在bindinggraphlock下檢cycle、depth/visitedlimits，Undo不覆後來child更改；CAS永指真正childplot Ref。

原「先materialize nested graph」沒有V1操作契約（FG-04），已改成sharedeligibility預檢、hidden/scratch偵測、typed refusal/reason、無IDallocation/半clone、stalepreview recheck及具體可選替代。普通editablebundle closure匯出／two-pass import仍允，不能把nested snapshot限制擴成丟棄nested文件；不能默默raster。sourceScene capture範圍及跨Scene引用處理已明列。

剩餘產品限制是明示V1不做recursive snapshot；未來需新ADR，不能implementation自行補。UVA-51–54/61/67須PR-6D/6B/6C實際驗證，尚未執行；OD-06仍需批准這個可見限制與替代。schema/refusal測試只驗文件shape，不證render／authorization runtime。

### R-05 — Contract/example consistency

Classification: VERIFIED — SPECIFICATION COMPLETE

九組完整IDs/typedRefs範例、req→cmd映射、各route revision axis、layerId或layer object、CAS新增owned plot均重新驗證；一manifest片段明示Illustrative Only，七類示例tool schemas不是全產品APIvalidator。正式corpus未改、fences逐字結構比對、sequence refs/counts檢查；TS只readmodel投影，無compiler等價宣稱。client不能送author/actor/ownership/grants/commandId。

實際反例揭露原Matrix僅用det門檻，拒合法小scale卻放過高condition；新Matrix按homogeneous3×3 infinity norm條件，加入smallscale/illconditioned/rotation測試。Provenance import跨欄位補正；新增CommitRoot／snapshotEligibility／refusal closed projections與negativecases。RFC004 wire、Annotation policy OCC欄名及AUTHORITY status用詞也已修（FG-05/06），不是只因九例pass就宣稱全文件正確。

限制：不驗實際grant、adoptionevent存在、archive檔案存在、runtimeoperation dispatch、檔案durability或Host。PR-1A/5A/6D必與production validators作正反等價及integration測試；不存在的tool仍標Not Yet Implemented。文件通過不取代OD審查。I記錄實際執行與原16expectations保留證據。

### R-06 — Authority cutover

Classification: ACCEPTED WITH CONDITIONS

逐態核A0–A7 writer/readers、A3 gate/drain/seal、source hash不等STALE_PLAN、所有alias/docheads/ledger/authority同rootcommit、A4/A5 projection永非authority、lateepoch拒絕、flagoff不刪newdoc。A6只能受管recovery；A7有newwrites不能原位指回legacy，完整v2/volume與ledger保全後另建明選legacyvolume。無postwrite回A0也需seal、ledger與epoch完整，不能forgetretrykeys。原binary不讀marker也不取新lock，規格明確不能依它自我拒啟。

FG-02/03/06補CommitRoot連結、marker非第二權威、writer恢復epoch單調遞增，以及明說CURRENT等機制均是Proposed。Docker root read_only不等 `/data` readonly；oldbinary直接寫必由OS RO-source/volume隔離失敗，managedlauncher另拒不相容protocol。未知或無fence平台不得A3→A4，root/operator重掛可寫是破壞部署前提，不宣稱應用可防。

條件：PR-1B在1C/1D退出後，以真baselinebinary/受管launcher/ROmount與UVA-56–58/62/66驗證，不用mock marker代替。sourceSeal/alias不一致進A6，不能latestmtime合併。postwrite rollback需要完整可恢復volume/backup，尚未有新Bundle實作時不得偽稱projection已是完整backup。OD-01/06及deployment隔離方式未批准，這輪不改Compose或資料。

## C. Additional Architecture Findings

所有「修正」指本branch規格／doc-validator的更改，非production已修復。原報告留存，不把新缺口藏進歷史結論。

| Finding | Severity / exact original contract | Remediation / alternatives / remaining gate | Blocking PR |
| --- | --- | --- | --- |
| FG-01 | High：STORAGE-LIFECYCLE GC step4一律24h、每1000commands全checkpoint；heavywrites/pins/backpressure僅方向 | G1 verifiedduplicate可驗後unlink，G2orphans保24h；operational checkpoints只在另有verified archive chain時thinning；32MiBarchive anchors與所有bytes入容量。拒age-delete/historytruncate，jobs需quiescence，maintenance兩次重試後暫停新admission。尚需實測profile | PR-1D / PR-7A，先於PR-1B |
| FG-02 | High：STORAGE-LIFECYCLE Registry/Locator分述、RFC006 root缺正式coherent欄位 | 單CommitRoot六roots、RecoveryCatalog resolverpair與無自指hash DAG、changedpage compare/rebase；拒雙CURRENT／事後compensation。新rootshape已驗，atomicIO尚未實作 | PR-1A / PR-1C / PR-1D |
| FG-03 | High：FS表泛稱Docker local；AUTHORITY缺Desktop/APFS支援邊界 | 逐平台profile，Linuxconditional、Desktop/nativeMac V1預設拒durable，RO source真fence，probe/documented/fault證據分列。替代為另設平台ADR，不能只放寬probe | PR-1C / PR-1B / PR-7A |
| FG-04 | High：EMBED-CONTRACT snapshot row未定義materialize nested graph plan | eligibility與固定error/reason、preview/無半clone/權限遮蔽、sourceScene範圍、live/link/editablebundle替代；recursiveclone留新ADR。UVA-67未執行 | PR-6D / PR-6B / PR-6C |
| FG-05 | High：proposed-contracts Matrix/Provenance與CONTRACTS/POLICY語意不一致 | 舊schema三反例重現；condition與importedunknown/no moduleowner補驗，原16測試不變，新增6測試。拒把shape成功當runtime授權 | PR-0B / PR-1A |
| FG-06 | Medium：RFC004外部Mutation用commandId、ANNOTATION-POLICY全稱expectedDocumentRevision、AUTHORITY的CURRENT措辭易讀成current實作 | 明確wire requestId/route-specific OCC→internal commandId，relayer/detach及history token的entity revision前置；CURRENT/CommitRoot全為Proposed，marker不作authority。未改正式MCP介面 | PR-0B / PR-1A / PR-1B |

沒有新增distributed infra、GodStore或第二個可變child權威；修正沿原已支持方向。上述規格缺口已處理，實測／產品／平台批准仍是有名有責任的gate。Traceability/Risk/PR/Case同步，不因文件通過消除此風險。

## D. Deployment Durability Matrix

以下摘要服從STORAGE-LIFECYCLE逐平台正式表；現有volume未被probe或切換。V1 durableACK前置是exactvalidatedprofile、OS單writer lease、同FSrename、每檔filefsync及CURRENT父dirfsync、ledger/closure/authority同root、OSfence。任何不確定先readonly/拒writer，不偷偷把原durablestore改memory。

| Environment | Writer policy / lock+rename+flush | Old binary boundary / recovery | Evidence now / gate |
| --- | --- | --- | --- |
| NativeLinux local ext4/XFS | conditional；flock lifetime、same-device、file+dirfsync | mountnamespace ROsource+分開newtree；CURRENT+ledger恢復，無fence拒cutover | 平台語意文件；新backend probe/fault未執行；PR-1C/1B/7A |
| EngineLinux local namedvolume | conditional；daemon backingFS必驗，不憑volume名稱 | nonroot/capdrop、oldprocess只見ROsource，activewritabletree不給它 | Docker docs已讀；實際新mount/lease未測；UVA-66 |
| EngineLinux bindmount | conditional同Linux，拒crossdevice | bind預設可寫host，必ROsource；projection獨立tree | 目前Compose只有writable /data，沒有fence證據；不得拿來cutover |
| DesktopmacOS ARM64 namedvolume | development/unvalidatedcandidate；V1 user-volume durablewriter預設拒 | VM disk與host flush邊界、ROmount、launcher需獨立profile批准 | 只證Docker daemon在LinuxVM；未測VM/hostfault；imageARM支援不推durability |
| DesktopmacOS bindshare | unsupported V1 durable | sharingbackend即使fsync回成功仍unknown；readonly或另建memory | VirtioFS/gRPC-FUSE等需新平台ADR與跨層fault evidence |
| NativeMac/APFS | unsupported V1 durable | 無Linuxsupervisor/fence backend；fsync/F_FULLFSYNC與dirflush另設計 | Darwin header有F_FULLFSYNC定義，不代表Node已調用或APFS斷電已驗 |
| NFS/SMB/FUSE/remote/unknown | unsupported V1 durable | 不用PIDfile/無dirflush降級；UNSUPPORTED_STORAGE、readonlyrecovery | runtimeprobe成功不足以新增allowlist；必要時另建memorysession明標 |

三層證據不能混用：(1) documented primitives、(2) exactemptytempdir capability probe、(3) 真stagefault＋outerVM/blockdevice丟未flushwrite。probe至少測same-device/rename、file/dirfsync返回、第二process鎖失敗與crash釋放；非破壞使用者資料。SIGKILL只測process crash/replay，未證停電；實體disk honorflush仍是部署前提。健康診斷需profile/platform/fs/driver/mount/devices、lease、barrier、readonly原因；不可logkeys。

已讀來源及取得bytes/hash見evidence/platform-reference-fetch.json：Linux man-pages `fsync(2)`明列需要directoryfd fsync、`rename(2)`明列atomic replacement但有EXDEV限制；Docker bind docs明列daemon host、Desktop LinuxVM及readonly，volume docs說明daemon上的volume與可為remote drivers；Apple XNU `fcntl.h`的F_FULLFSYNC註解為「fsync + ask the drive to flush to the media」。這些是**語意參考，不是本產品部署認證**。首次Linux URL路徑404、改正後成功，fetch失敗亦保留紀錄；引用的movingbranch以本輪contenthash固定。

## E. Storage Capacity Assessment

[capacity-model.mjs](evidence/capacity-model.mjs)的可重現輸出見final-gate-logs/capacity-model.log。**ANALYTICAL_NOT_MEASURED**：假設S=64MiB、每命令losslessDelta=2KiB、tombstone上界1KiB、fullACK上界64KiB/7天、365天、archive每32MiBdelta一個S checkpoint。不是實際stroke尺寸、平均壓縮率、engine吞吐或總空間上界；省略assets/ACKartifacts/index/journal/current/staging/pins/backup，實際可更大；24h recovery roots保護的registry/page churn也可能成為主項，須另計commandsInWindow×changedPageBytes，不假定已由Document delta壓縮。4MiB/page是上界而非每命令成本承諾。工作量為有界active筆跡的反覆編輯/替換，不允藉365萬新增marks繞5000annotation cap。

| Commands/day | Δ history GiB/year | Permanent ledger GiB/year | 7day fullACK GiB | Archive anchor GiB | Component sum GiB | 舊規格若保每次full24h / 每1000full一年 |
| --- | --- | --- | --- | --- | --- | --- |
| 1000 | 0.696 | 0.348 | 0.427 | 1.438 | 2.909 | 62.5 / 22.813 GiB |
| 10000 | 6.962 | 3.481 | 4.272 | 13.938 | 28.653 | 625 / 228.125 GiB |
| 100000 | 69.618 | 34.809 | 42.725 | 139.250 | 286.402 | 6250 / 2281.250 GiB |

結論：10GiB不是通用長期容量；即使可回收冗餘，永久ledger與真正歷史仍成長。若每命令重寫64MiB幾何，Δ≈S（625GiB/10000commands）是真實歷史成本，不能假定壓成2KiB。不得拿調低ACK/忘記tombstone或刪history修補。G1及checkpointthinning消除內部重複representation，所有logical versions仍由base+orderedlosslessdeltas/anchors逐hash可還原。

| Default | Assessment / condition |
| --- | --- |
| Q10GiB、reserve=max64MiB/1%Q | 可作小型singleowner起點，不承諾大工作量；perwrite所有reservations+maintenanceworkspace+R納managedquota與actualfree預檢，既有超quota readonly/export或owner擴額 |
| 1KiB tombstone | compactkey/hash設計上界合理可測，永久N*L不能忽略；7天後同key回RETRY_WINDOW_EXPIRED、不apply；跨restore保namespace/ledger；stalebackup缺postbackup tail先readonly，不宣稱有未備份ACK |
| 7days ACK<=64KiB | 需批准重試產品window；附帶downloadartifacts另計且pin。測時鐘倒退／recovery，不延長／縮短firstacceptedwindow作弊 |
| 1000commands或32MiB operationalcheckpoint | 是recovery latency起點，不是永久保留每個full許可；thinning需coverage proof，archive anchors成本另計，maxreplay/重建時間由bench校準 |
| 64sessions / 1GiB physicalpinunion | 不能保證64個不同64MiB版本；共享hash不重算，超budget拒新pin。活FD不可ageexpire；大型onlinebackup需明確增加budget或offline，不拿4MiBbuffer冒充只pin4MiB |
| 100commits/256MiB/80%GC trigger | 起點而非drainrate保證；每write預檢，兩次pageconflict後暫停新admission完成有界maintenance；保draft，不強殺活reader來回收 |
| 10minjob/30minmax與backup30minrenew | 沿現行module時間界線；deadline是cancel請求，不是刪FD許可。輸入materialize後釋physicalpin，lateoutput epoch/grant/OCC重驗 |

PR-1D測1k/10k/100kcmd/day、1/16readers、small/fullDelta、ACK與artifact、backup、滿盤recovery、compaction併寫：記各component actualbytes/peak、maintenance throughput/backlog、commit latency、reconstruct全部hash與重試效果。固定runner三輪後maintainer核profile；保住所有資料與retry invariant是硬gate，數字SLO不憑算術指定。即使不夠容量也應安全拒寫，不是服務可用性保證。ENOSPC在pointer前abort、barrier不確定A6；recovery只清durably證明unreachable者，reserve不足則readonly。

## F. Embedded Document Acceptance

正式schema/operation/lifecycle仍以EMBED-CONTRACT為唯一細則，本輪只補nested拒絕缺口。驗收包括：live單childauthority；snapshot一個新editableDoc/Scene與idMap，原來源不改；sourceRevision是capture provenance不當live版本上限；parent transform/lock/layer不改child內容；default畫parent，explicit childViewport才編輯child並另驗權。

UVA-51/53需證明same parentrev下childevents通知所有viewports、fixeddependencyvector/server/browser/export一致、authrev撤銷cache即失效且deniedresponse無child refs/title/hash/count/pixels。archive child顯placeholder、restore重解析；missing/offline不同；UVA-52必測兩個相反embed併發與importcycle。Undo parent只逆自己command，不覆新child編輯，不刪clone；CAStarget是childplot，snapshot預設不複製liveCASlink（UVA-54/61）。

NestedV1預檢掃選定sourceScene全部content（含hidden/scratch）；無source讀權先FORBIDDEN。unsupportedpreview顯明原因、sharing與獨立性差別，回typed eligibility；正式拒絕BLOCKED_DEPENDENCY/reason=NESTED_SNAPSHOT_UNSUPPORTED、retryable=false，**不配置clone IDs或半寫內容**。commit重新驗parent/source/OCC/graph；source改變STALE_PLAN，不能套舊preview。可選live、開/連原child、明確source edit之後重新plan、完整editablebundleclosure；沒有materialize或自動PNG替代。

Snapshotclone限制不禁止普通nested bundleexport/import；two-pass IDs/完整authorizedclosure/hash/count/history/CASmaps都保留，外部ref unresolved。child無權限則完整export拒，references-only有lossReport、opaquehandle，不能稱完整。UVA-67與55已增；產品cases未執行。未來recursive snapshot必另ADR定capture vector/clone去重/所有ref/history/quotas，不把未來想像當V1完成。

## G. Architecture Decisions / Human Approval Package

所有原Recommendation維持核心方向；以下細化代價與批准scope。沒有任何Approver/Date。允許分stage簽核，但不能把有限schema批准讀成其他OD已同意。

| OD | Original → revised recommendation | Alternatives / trade-offs | Required human approval / dependencies |
| --- | --- | --- | --- |
| OD-01 | UUIDDoc/單SceneOwner/stagedFS → 保留，固定六roots、G1/G2、checkpointthinning與conditionalLinuxprofile | 擴ImageEntry較便宜但identity耦合；SQLite可取代FS但需另storage migration，尚無證據足以改選；現方案有fsync/GC維護成本 | PR-1A可只批ID/ownership/readschemas；1C須批FS/backend/ACK；1D需量測profile；1B須真fence。ADR-001/007/010/012 |
| OD-02 | Dualdomains/documentanchor/Unifiedfulluseredit → 保留，wire與importshape校正 | 全轉SceneObject有metadata/permission損失；only-own不符合雙向產品要求；worlddefault會改圈選行為。保雙domain需typeddispatch | schema用Principal/Owner分離不等同啟用editing；PR-2B/4B前批全操作/Evidence/guard/label/defaultanchor，可信useractor證據；ADR-002/004/009 |
| OD-03 | CanonicalRenderPlan+legacyprofile → 不變 | 全部立即unified較簡單但既有opacity/labels可退化；完全保舊裝飾會綁死UI | PR-2C前批unifiedprofile可見變更、UVA-10/34/goldens與測量budget；不因本輪schemapass批准 |
| OD-04 | Local subscriptions+app-onlypoll → 不變，2sec只是待測scheduler起點 | SSE/WebSocket需CSP與infra；只靠toolresult不符合兩widget同步。poll有latency/call成本 | PR-3B transport與PR-3C performance profile，PR-7B真HostWeb/iOS/Android/CSP逐平台驗收；本輪未測，不預先宣稱Host useractionproof |
| OD-05 | CAS pause-on-user-edit → 不變 | 自動覆蓋丟意圖；自動detach暗中丟live依賴；pause需resolution UI | PR-5B批准signature/style/domain/axes區別與detach/overwrite/fork；manualrefresh不是overwrite同意；ADR-006/009，UVA-20/45/61 |
| OD-06 | Legacyroutes/v2opt-in/nonlossydowngrade → 保留，明確nestedrefusal與Desktop/APFS不開V1durable | 強迫全升級不相容；PNG/fakeimage降級丟可編輯性；recursiveclone需額外完整設計。OSfence有部署成本 | PR-1B/5A/6D/6B/6C前批authority/fencing、V1nested限制、bundle/ref remap與postwriteA7保全；legacy支援期限至少兩minor仍只是建議，release號/日期由maintainer定 |

Approval record用OPEN-DECISIONS模板：指定evidence commit、OD/ADR子項、permitted PR/paths、必測/rollout、notapproved。PR-1A最小批准不能替代PR-1C/1D/1B的儲存與部署批准；editing/Host/CAS/Embed產品行為亦各有其gate。沒有紀錄不開始任何Phase1。

## H. Implementation Readiness

**PR-1A可提交人類審查，尚未獲准執行。** 唯一建議範圍為strictdocument/scene/ref/Actor/Owner/Provenance/Embed與CommitRoot schema、IDparsers、readonly shadow mapping及對照tests；不可註冊新write tools、改既有runtime／儲存authority、操作使用者volume或部署。可review/rollback單位仍23個，不把本輪修正塞一個大implementation PR。

| PR | Explicit prerequisites | Testable exit / safe rollback |
| --- | --- | --- |
| PR-1A | 本review commit + OD-01 identity/ownership、OD-02/06必要schema部分明確簽核；duplicate/import/invalid matrices與九例一致 | UVA-01/03/24/27/28/42/55的該schema/readonly部分，無sourcewrite/新authority；未實作runtimecase不能稱完成。revertschema/shadow不變資料 |
| PR-1C | 1A退出＋OD-01/ADR-010 backend批准；CommitRoot/RecoveryCatalog、Linuxlease、file/dirbarrier、ledger與faultstage契約 | UVA-31–33/49/59/63/66 disposablevolume真fault，nodurablefalseACK；無維護不開productionwriter；rollback停shadow保files |
| PR-1D | 1C退出；roots/verifiedchains/G1/G2/pins/quota/backup契約；capacity採實測profile批准 | UVA-46–50/60/63–65全部phase1cases，clock/crash/ENOSPC、每logicalhash/ledger驗；實測drainrate與backpressure；停maintenance不刪內容，空間不足拒新write |
| PR-1B | 1C/1D退出＋OD-01/06、實際ROsource/isolatednewtree/oldbinaryfence與可信userroute來源證據 | UVA-56–58/62/66及legacy55tool契約，全部writers經mediator；cutover仍explicitplan。A7保資料，flagoff不切authority |

Phase2/4完整AI/moduleuseredit不可降回only-own；Phase5modulegrant/CASguard；Phase6先6D再6B/6C，UVA-67必過。PR-7A長跑與outerpowerloss fault不能替代先前stage必測，PR-7B真Host不是FakeHost。未批准的平台/性能profile保持closed gate，不能以featureflag或schema成功跳過。

## I. Verification Evidence

本輪執行環境：Linux x64/kernel6.18.57，workspace為overlayfs（**不是本方案已驗ext4/XFS部署**）；Node22.23.4，npm11.9.0，Sharp0.34.5/libvips8.17.3，Python3.12.14，Chromium154.0.8037.57。Node預設24.19.0，下面驗證命令明確選Node22；production/test expectations無更動。

執行結果與命令以[evidence/final-gate-execution-manifest.json](evidence/final-gate-execution-manifest.json)及hash固定logs為準。以下為已執行結果；檔案存在、Proposed test標題或Future計畫不算通過：

| Command（Node commands均用 `npm exec --yes --package=node@22 --`） | Actual result | Exit |
| --- | --- | --- |
| `env -u ESTAMPES_STORAGE_DIR -u ESTAMPES_ACCESS_KEY CHROME_BIN=/usr/bin/chromium npm exec --yes --package=node@22 -- node --test` | 275pass / 0fail / 0skip，129.470s；等同package npm test的node --test；含可用CAS/browser/FakeHost | 0 |
| `node --test docs/rfc/unified-visual-architecture/evidence/contract-validation.spec.mjs` | 新增前一輪20pass；補hashDAG案例後22pass / 0fail / 0skip；原16expectations完整保留 | 0 |
| `node docs/rfc/unified-visual-architecture/evidence/validate-contract-examples.mjs` | 9正式JSON、1明示illustrative manifest、7tool example schemas；20JSON/TSfences inventory；非runtime API完成 | 0 |
| `npm run docs:check` | 82Markdown / 55current tools / 22current configvars；最後重驗見manifest | 0 |
| `npm run release:check` | 0.20.0一致；只檢查，沒有推tag/release | 0 |
| `python -m unittest discover -s cas-service/tests -v` | 17pass / 0fail / 0skip，6.387s；Python3.12而非productionimage3.13；有unclosedfile/StreamWriter ResourceWarnings，未改測試或隱藏警告 | 0 |
| `node docs/rfc/unified-visual-architecture/evidence/check-consistency.mjs` | 通過：8RFC/12ADR/67UVA/23PR/6R/6FG/6OD、95hash與historical/原16expectations；最後log含完整結果 | 0 |
| `node docs/rfc/unified-visual-architecture/evidence/phase01-counterexamples.mjs` | 復現舊doc schema小scale誤拒、高condition誤允、imported module owner誤允；是舊規格反例，非產品測試 | 0 |
| `node docs/rfc/unified-visual-architecture/evidence/capacity-model.mjs` | 3workloads analytical output；沒有執行新引擎效能benchmark | 0 |
| `git diff --exit-code df70d2b -- server.js src public cas-service tests .github Dockerfile compose.yaml package.json package-lock.json scripts` | Production/test/deployment diff空；allpaths scope另由consistency驗 | 0 |
| `git diff --check df70d2b` | 通過；無whitespace error | 0 |

未執行：新DocumentStore／storage GC/compaction/authority/embed/annotationruntime faultcases、Linux/Engine/Desktop/APFS exactmount能力探測、container/VM/hostpowerloss/真oldbinaryfence、productionrunnercapacitybenchmark、真ChatGPTWeb/Mobile/MCPHost/CSP驗收、TScompiler或全ProposedAPI等價驗證。功能未實作或需要真平台；都不列pass，也不以FakeHost或算術模型替代。部署referencefetch是read-only文獻證據，不是runtime認證。

Scope/sourcehash、historicaltestsbody、case/PR/OD/R/FG references、formalJSONfences都做機器檢查；自然語言語意仍需maintainer架構審查，checker不保證無未知設計錯誤。獨立correction commit/SHA與最終diffstat由git交付回報；此檔不自我包含其commitSHA。

## J. Final Recommendation

Recommendation: READY FOR LIMITED PHASE 1A APPROVAL

本輪發現並修正六個實質spec/validator缺口；核心identity、dualmodels、Unifieduseredit、childsoleauthority與nonlossycompat方向保留。PR-1A的schema/readonly foundation現在有明確可驗欄位與rollback邊界，可請maintainer作**有限範圍批准**。這不是Phase1啟動授權，也不是整體architecture或所有OD/ADR已批准。

不建議同時批准writable rollout：平台支援與powerloss前提、實際OSfence、容量/maintenanceprofile、可信Host useraction來源與editing產品政策仍有明確待驗/待決gate。1C/1D/1B依H逐一review，未驗環境拒durablewriter／cutover；不能拿已通過的既有275tests或九個ProposedJSON例子冒充新storage／Host已實作通過。

工作停止於Architecture Approval Gate。未開始PR-1A/1B/1C/1D，未merge/main/release/push新branch或遷移資料，未填造任何人類批准紀錄。後續只依maintainer記錄的scope推進。
