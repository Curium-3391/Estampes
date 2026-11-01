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
