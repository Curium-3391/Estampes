# Requirements Traceability Matrix

Status：Proposed；Code欄先列CURRENT依據，箭頭後是Proposedboundedchange。測試ID定義見[TEST-MATRIX](TEST-MATRIX.md)，PR定義見[Roadmap](../../../IMPLEMENTATION-ROADMAP.md)。Current/Proposed不可混用；OpenDecisions必簽核；FutureExtensions不列為已交付。

| Requirement / acceptance | RFC / ADR | Current code → proposed implementation | Migration / compatibility | Test IDs | Phase / PR |
| --- | --- | --- | --- | --- | --- |
| 2.1 image/graph獨立、無PNG身份 | 001/002/005，ADR001 | blank-canvas/image-store/router→documents/schema/service+Graphv2target | set→doc registry，v1blankpath保留 | 01/02/27 | 1/4：1A/1B/4A |
| 2.1 Panelclose不刪Document、獨立rev/lifecycle | 002/004，ADR003 | surface/service/workbench→panelbinding+controller | surface1→2 preserveclosedrecord、nbrefs | 04/15/26 | 3：3A/3B |
| 2.2 Freehand/point/rect/arrow/polyline | 002/003，ADR002 | scene-catalog/freehandMark/markSvg→sharedannotations | fullmetadata/geometrymapping，非shape降格 | 05/07/11 | 2/4：2A/4B |
| 2.2 Pen/highlighter/eraser/selection/move/resize | 003/004 | penStyle/pickMark/shifted→sharedtoolFSM/handles/wholemarkeraser | legacyuser/assistantpermission保留 | 05/06/13 | 2/3：2B/3A |
| 2.2 Layers/opacity/visibility/lock/undo-redo/zoom-pan | 002/003/004 | canvas-state/pastfuture/setCam→layercontract/commands/controller | persistedvisibility基線+viewportoverride；history非破壞archive | 06/08/10/17 | 2/3：2A/2B/3A |
| 2.2 User/LLM雙向、保存匯入可重編 | 002/005/006 | present/validate/buildAnnotationEvent→docscopedtools | intent/evidence/provenance全保留；schemaaliases | 05/07/23/27/38 | 1/4/6：1B/4B/6B |
| 2.3 doc/vp/panel separation、多Graph | 001/004，ADR001/003 | singletonCanvas+maxInstances1→Viewerfactory/ViewportStore | panelbindingsretain、no globalstateclone | 14/15/16/17 | 3/4：3A/3B/4A |
| 2.3 samedoc多vp、twowidgets更新隔離 | 004，ADR003 | appliedKey/syncCanvas→revisionreconcile/poll/epoch | resultdedup、optionalwidgetState、samecommandreplay | 16/18/32/35 | 3：3B |
| 2.4 Marks/Objects/Layers/Evidence/Provenance/Verification/Gesture/Intent | 002/006，ADR002/007 | storage/protocol/assessment/groups→fieldinventory/migration | leaf守恆、rawquarantine、nevertrustpromotion | 07/23/24/25 | 0/2/6：0A/2A/6A/6B |
| 2.4 noimplicitrasterflatten | 003/006 | marks-file/bundle/compose→editablebundle2/live/snapshotembed | v1lossreport+refuseunrepresentable；sourceimmutable | 22/23/25/27 | 6：6B/6C |
| 2.5 existingMCP/CanvasJSON/Bundle/Workspace/CAS/module | 005/006，ADR005/008 | tools/router/manifest/marksFromDocument/bundle→compatadapters | oldURI/ABI/signatures/grants保留、versionedv2 | 24/25/27/28/35 | 1/5/6：1B/5A/6A/6B |
| 2.6 noManifestJS/HTML/CSS、trustedops | 005/007 | validateManifest/applySceneOps/renderObjects/egress→v2strict+scopedrefs | consent/admin/signedbytes不修改 | 03/28/29/30 | 1/2/5：1A/2C/5A |
| 3 fullaudit+dependency/state/tests/risks | AUDIT、source/testindex | allspecifiedsourceareas+CI/Docker/CAS inspected | code/documentconflictsGAP01–07記錄 | baseline273+characterization2 | 0：0A |
| 4 definitions/ownership/options/lifecycle | 001/002/004，ADR001/002/003/006 | Entry/surface/ws→boundedservices | onesceneowner、workspace refs、noGodStore | 01/03/04/14/22 | 1/3：1A/3A |
| 5 Scene/Marks alternatives、rendercontract | 002/003，ADR002 | dualmodels+duplicatebrowserdraw→sharedplan | profilelegacy/unified、fieldmapping | 05/07/10/11/34 | 2：2A/2C |
| 5 allcoordinates/graphanchoring/invalidrefs | 003，ADR004 | frameOf/mapMark/CTM/placement→typedanchors | doc/worldexplicit、nooverlapguess、reflastpose | 08/09/12/22 | 2/4/6：2B/4B/6C |
| 5 Screenfixedpersistedowner | 003/004，ADR004 | 無screenanchor→ViewportOverlaySurfaceprefs | defaultdocbundle不includeHUD，explicitconvert | 09/17/26/34 | 3/4：3A/4B |
| 6 12workbenchscenarios/pointerarbitration | 004/003 | workbench/globalpointers→factories+FSM | close/destroy/reloadpreservecommittedcontent | 04/13–18/26/35/39 | 3：3A/3B |
| 7 Graphfunctions/points/axes/CAS/imageoverlayreuse | 005 | graph.run/objects/parser/compose→contextadapter+Graphdoc | existingmathsemantics/labelspreserved | 02/11/12/19/22 | 4/5：4A/4B/5B |
| 7 module targetevolution+9APIexamples | 005，ADR005/008 | execute_module/manifest/wasm1→explicitv2target | imagev1legacyadapter，newgrantforv2 | 27/28/29 | 5：5A |
| 7 CASstabledependencies/stale/recompute/useredit | 005，ADR006 | CASafter/refreshLinks→bindingattempt/revguard | canvas→defaultdoc；copyCASdefaultdetach、importstale | 19/20/21/31 | 5：5B/5C |
| 8 eachlegacyformatmapping/missing/collision/revision/rollback | 006，ADR007/008 | storage/workspace/bundleextras→twopassplanner | perfieldtable+sourcehashplan+registry+rawbackup | 07/23/24/25/27/33 | 1/6：1B/6A/6B |
| 8 Graphseparation/MoveCopyLinkEmbedDetach | 006，ADR006 | workspace transfer/compose→selectiondependencyplan | nolocationinference、CAS/evidence/refmaps、atomicMove | 12/22/24/25 | 6：6C |
| 8 Bundlehash/schema/counts/refs/report/integrity | 006 | bundle/zip/sameState→strictv2import+ledger | acceptv1nonoverwrite、newmutableIDs、noautoexternalrefbinding | 23/25/30/31 | 6：6B |
| 8 crossstoreconsistencyoptions/recovery | 006，ADR007 | perfilequeues/after→stagedjournal+pointer | legacyprojectionnotauthority、onewriter、fsync | 31/32/33 | 1/5/6：1C/5B/6B |
| 9 newtrustboundaries/object/grant/refsecurity | 007/005 | security/manifest/router/egress→leasedscopedtargets | noimplicitdatareadfromembed、audiencecachekeys | 28/29/30 | 5/7：5A/7A |
| 9 measurableperformance/allworkloads | 007/BASELINE | zoom-perf/render/sampler→bench+multiViewertrace | numericbaselineonlywhereexecuted，unmeasuredexitblockers | 36/37 | 0/3/7：0A/3C/7A |
| 9 HostWeb/Mobile/MCP/CSP/order/widgetstate | 004/007/HOSTACCEPTANCE | hostbridge/chunks/toolURI→hydrationreducer | fake/real分開，negotiatedfallbackoldURI | 18/26/35/38/39/40 | 3/7：3B/7B |
| 10 all20testcategories+baselinecommands | 008/TESTMATRIX/BASELINE | current57testfiles→40specifiedcases+2characterization | nofailingfuturetests/noexpectationweakening | 01–40 | 0–7：各PR |
| 11/12 8RFC/8ADR/Roadmap/trace/risk | README全部deliverables | docs-onlyPhase0+necessarytests | nofunctionalrefactor/noUserdatawrite | docs:check+consistencycheck | 0：0A |
| 13/14 approvalgate/report/evidenceboundaries | OPENDECISIONS/BASELINE | baselineSHA+gitbranch/status+testlogs | noPhase1beforeapproval | gateaudit | 0：0A |

TestID欄數字皆為 `UVA-` prefix；區間表示每個case，非單一籠統測試。工程驗收需逐casepass，traceability不代替測試結果。
