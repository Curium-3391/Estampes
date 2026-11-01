# Risk Register

Status：Proposed risk assessment；不是已發生資料損毀的宣稱。Severity S1資料/安全critical、S2功能重大、S3可回復UI；Likelihood為sourcecoupling判斷，非統計機率。CURRENT證據見AUDIT，驗收見TEST-MATRIX。OpenDecision風險受OD gate控制；FutureCRDT/multi-tenant不在範圍。

| ID / Risk | Severity | Likelihood / evidence | Mitigation | Detection | Recovery / owner / gate |
| --- | --- | --- | --- | --- | --- |
| R01 Data loss / false saved | S1 | High；saveCanvas catcheserror、storesseparate | immutablegeneration+durableACK、rawsidewrite、nooverwrite | UVA-31/33：kill/ENOSPC/afterfailure、diskreloadhash | readonlyrecovery+backupvolume，Persistenceowner，Phase1/6 |
| R02 Mark/Layer corruption | S1 | High；visual2import/SVGmetadata/opacitylimits不完整 | perleafmapping、dualdomains、emptylayer+opacity0preserve | UVA-07/10/23–25；metadata/count/hash | 保rawquarantine、重新plan、不回退成raster，Visualowner，Phase2/6 |
| R03 Reference breakage | S1 | High；oIDlocal、CAScanvas缺set、sameStatemissingobjects | typedfullrefs、two-passmaps、unresolvedretain、moveclosure | UVA-12/22/25/29；referenceclosure+incomingrefs | mappingledger重建、禁止猜名，Migrationowner，Phase5/6 |
| R04 Coordinate drift | S1 | High；多種normalized/world/derived/placement | canonicalanchor、noreprojectionwrite、matrixinversecondition | UVA-08/09/12/34；seededroundtrip+boundarypixels | retainoriginalgeometry+invalidanchor/detachpreview，Coordinatesowner，Phase2/4 |
| R05 Graph/CAS desync / overwrite | S1 | High；after分開+useredit未guard | stagedbindingcommit、pauseonuseredit、attempt/envhash | UVA-19–21/31；source/targetsignature | keepoldplot、conflictresolutionfork/detach，CASowner，Phase5 |
| R06 Widget state pollution | S2 | High；singleDOM/globals imageId/cam | factoryinstances、bindinggeneration、focusedkeyboard、dispose | UVA-13–18/35；delayoldrender/rebind | isolatedpanelretry，草稿保留，UIowner，Phase3 |
| R07 Import/export incompatibility | S1 | High；strictformats、v1sameStatecomparison不足 | dualread/v2write、capabilitynegotiation、lossreport | UVA-23–27；v1fixtures/package/URIs | 原ZIP/rawarchive、v1adapterreadonlyprojection，Compatibilityowner，Phase6 |
| R08 Security regression | S1 | Medium-high；newrefgraph擴大讀取面 | scopedlease、refauth、cacheaudience、strictops/manifests | UVA-28–30；crossdocleak/injection/grantrevoke | disablev2runtime、保trustedrender與既有grants，Securityowner，Phase1/5/6 |
| R09 Performance regression | S2 | Medium；multiViewer/assetdecode未知 | sharedimmutableplan、rAF、suspendhidden、boundedqueue | UVA-36/37 rawsamples/heaptrace+derivedbudgets | turnoffmultiViewercreation、keepdocs/export，Renderowner，Phase3/7 |
| R10 Host compatibility regression | S2 | High uncertainty；FakeHost無真CSP/mobile | existingbridgefallback/chunks、URIretention、realplatformscripts | UVA-38–40、delivery/recreateevidence | inlinefallback/read-onlydisplay，不刪userdoc，Hostowner，Phase7 |
| R11 Split partial ownership / locked layer | S1 | High；mixedcanvas無semanticmembership | explicitselection+dependencyclosure、copydefault、movelock/OCC | UVA-22/24/25，planbeforeaftercounts | cancelplan/sourceuntouched或新compensatingcommit，Migrationowner，Phase6 |
| R12 Dual writer / rollback divergence | S1 | Medium；legacy/newstores若各寫成雙權威 | oneauthoritymode+writerlock、legacywritesadapteronly | UVA-31–33；secondwriter+afternewwritesrollback | freeze+v2archive、restore獨立backupvolume，Persistenceowner，Phase1/7 |

所有High風險必須在對應PR有deterministiccase與recovery證據，不能只用render截圖解除。實作遇未分類dataloss、跨權限context或無法enumerateincomingrefs，停在plan/error並更新ADR；不得藉featureflag默默忽略資料。

## Phase 0.1 — Additional Review Risks

| Risk | Severity / likelihood | Mitigation | Detection | Recovery / gate |
| --- | --- | --- | --- | --- |
| R13 modulecreator/owner混淆或reinstall劫持 | S1 / High | Principal/Owner/signerlineage/currentgrantintersection、importunclaimed | UVA-41/42；forgedactor與keyrotationcases | revokelease保data；PR-2A/5A |
| R14 userAIedit抹evidence或LLM覆手改 | S1 / High | createdByimmutable、claimcontextstale、reviewhistory、userguard、exactUndo | UVA-43–45 transitioncrossproduct | preserveoldgeometry/claim、explicitfork/lease；PR-2B/4B |
| R15 GC/compaction刪liveversion/ACKledger | S1 / High | rootedpins、losslesshistory、quarantine、7dACK永久tombstone、locatoratomicpublish | UVA-46–49/60 crash/pin/hash/ledgeroracle | restorequarantine/readonlybackup，不applytwice；PR-1D |
| R16 fullgeneration/manifest磁碟爆量與falseACK | S1 / High | Δgrowthmodel、boundedroot/pages、quota/reserve/reservations、fsyncbarrier | UVA-50/59 ENOSPC/fullrewrite/repeatedhandwriting | refusewrite保draft、readonlyrecovery/export；PR-1C/1D/7A |
| R17 Embed雙authority/循環/cache洩權 | S1 / High | typedobject/binding、childsoleauthority、editableclone、globalcyclecheck、authvector | UVA-51–54/61 concurrentcycle/revocation/CASrefs | placeholder、rejectpartialimport、keeporiginalchild；PR-6D |
| R18 flags/oldbinary/projection造成雙writer | S1 / High | A0–7atomicmanifest、gatedmediator、launcher/ROmountfence、projection獨立tree | UVA-56–58/62 actualbaselinebinary+races | A6/A7readonly、v2backup、新legacyvolume；PR-1B/7A |

ReviewFinding R-01–R-06的狀態見[REVIEW-REMEDIATION](REVIEW-REMEDIATION.md)；risk不是已發生資料事故。GC可回收internalduplicate，不授權刪userhistory。

## Phase 0.2 — Independent Review Risk Updates

| Finding / residual risk | Severity / likelihood | Mitigation | Detection | Recovery / gate |
| --- | --- | --- | --- | --- |
| FG-01 redundant24hfullcopy/checkpoint與永久ledger耗quota | S1 / High under sustainedwrites；算術可證、實際bytes未測 | G1/G2、verifiedcheckpoint thinning、perwrite reservation、maintenance admission backpressure；不刪logicalhistory | UVA-64/65 bytescomponent/drainrate，capacity-model analyticalonly | refuse新write保draft/CURRENT；owner明確擴quota/外部backup；PR-1D先於1B |
| FG-02 rootpair分裂 / starvation | S1 / Medium，Phase0.1未列完整rootrecord | 單CommitRoot六roots、RecoveryCatalog pairing、touchedpagecompare、boundedwriterpause | UVA-63全versionhash/ledgeroracle與kill | A6/verifiedbackup；禁止猜latest；PR-1C/1D |
| FG-03 Desktop/macOS被誤當Linuxdurable | S1 / High uncertainty，ARMimagebuild不是FS證據 | explicitprofileallowlist、Desktop/APFS預設拒cutover、OSfence而非marker | UVA-66平台/driver/faultprofile，記未測項 | readonly或新memorysession，不續寫原durablestore；PR-1C/1B/7A |
| FG-04 nestedclone隱式遺失 / denied metadata leak | S1 / Medium，原materialize未定義 | sharedpreflight、typedrefusal、redactedpreview、editablebundle替代 | UVA-67/55 zeroeffects/canary/hash | 保原source，不flatten；新ADR才recursiveclone；PR-6D/6B/6C |
| FG-05/06 schema通過被誤當權限/產品批准 | S1 / Medium，Matrix/Importshape與文字有落差 | schema反例+wire統一；trusteduseractor缺證據就拒route；每OD分scope簽核 | UVA-55/42/66與人工approvalrecord，diffscope/sourcehash | 不開userwrite/cutover，保provenance；PR-1A/1B/5A |
