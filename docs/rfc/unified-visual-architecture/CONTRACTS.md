# Contract Appendix — Implementation Handoff

Status：**Proposed Architecture**，補足RFC002–006的validation/operation細節；不是已存在API。Currentvalidators維持legacyroute；OpenDecisions引用OD-01/02/03/05/06。Future任何非allowlistedoperation/type必須新schema/RFC，不能傳unknownobject繞過授權。

## Persistence / Identity Rules

UUID grammars：`doc|scene|vp|panel` prefix後canonicallowercaseUUIDv4，分開parser；transaction/command/binding/event新ID用對應prefix+UUID。legacylocal IDs允o1..o999999、L1..L999999、已存在最多64字markID；新object/annotation/layer分別 `obj|ann|layer:<UUID>`，Ref.kind始終必填，不因相同string混kind。legacy scene-ops/1仍只接受原o<n>，compat object allocator為該legacyScene保留oSeq；newdoc-ops可用新typedlocalID，不能送入未適配的舊IdOrRef parser。

AssetRef.fullsha為64lowerhex；legacy img alias16hex與fullhash核對，不猜同prefix可共享。localmigrationregistry namespace是storageInstanceUUID，首次migrationplan生成，寫新registry不改oldfiles；externalimportnamespace用bundlefullhash+sourceIDs。回復同backupregistry保原docID；獨立外部import新IDs。ID只標識，不作授權/因果/版本token。

Document種別image/graph、title<=80、timestampsRFC3339UTC、revision正safeinteger，Scene.extent每邊finite>0且<=1e9du；V1正常create一Scene，最多24Scenes以有界集合支援future同Doc多Scene；全doccaps仍RFC007，不藉scene分拆擴量。kind不可inline轉換，需copy/explicitmigration。persistence是deployment-derivedreadfield，import依本server是否有storage重新計算，不信檔案宣稱durable。

Scene.background增加 `{kind:'transparent'}`，用於baseAsObject遷移，不以white/transparent混淆；solidcolor是trustedallowlist或#RRGGBB；imageasset只用AssetRef與有限9matrix。baseAsObject舊rasterobjectPNG轉assetref時必驗hash/decode，rawdataURI留migrationraw而不是secondmutableimageauthority。

Layer.content是paintorder權威；contentenvelope的layerId是必須相等的membershipdenormalization，只有`content.move-layer`可同時更新兩處；單獨改layerId或同entity出現兩layer拒INTEGRITY_ERROR。object的legacy`layer`只adapter投影，newenvelope用layerId。layer name1..40trimmed、opacityfinite[0,1]不再量化成.05；legacyeditroute保持舊量化，v2則精確原值，visible/lockedboolean。

SceneObject保留closedtypedprops與現有function/axes算法；**shape.props.space:'canvas'仍代表scene-normalized，不是du**，frame仍world。image/axes.props.region仍normalized，renderadapter投影至du；不能因Document命名而把舊0.5當0.5du。newAnnotation.geometry依anchor的units：document/object用du、image-normalized用[0,1]、world用frameunits。Scene.frames只有descriptor：axesframe `{id,kind:'axes',ownerObjectId}`、affineframe `{id,kind:'affine',parentFrameId:'document'|string,localToParent:number[9]}`；axesranges/region只在ownerobjectprops一處可寫，descriptor transform/revision是derived。framegraph必須acyclic，V1annotations world只axesframe，functionattachment只function-plot。

## Domain Operation Contract

outercommand的documentId/expectedRevision/commandId/actor由RFC002；operations min1/max64；Scene target每op明示sceneId，draft apply全batch後驗refs/limits才提交。batchlocal `$ref`只允引用之前create，不能跨batch；output refs回serveractual IDs。所有read/write需要documentpermission；table中user/assistant/module指server-establishedactor。任何modulepayload author/ownership/provider不可影響actor。

| Operation / required fields | Optional fields / validation | Authorization / effect |
| --- | --- | --- |
| scene.apply `{sceneId,operations}` | inner scene-ops/1原schemas、expectedSceneRevision只為legacyprojectioncheck | user可touchsceneobjects；module只own，assistant保現有sceneops限制；lock檢查；不對外呼舊persist |
| annotation.create `{sceneId,type,geometry,anchor}` | layerId或`layer:{name}`互斥；style/label/finding；clientref可選不當ID；geometry完整finite，polyline2..128points | user/user-pointer，assistant/unverified由route賦予；module需annotation.write.owned新grant；新layer作者與actor映射，不讓module冒user |
| annotation.update `{sceneId,id,patch}` | patch只geometry/anchor/style/label/finding；type不可改，explicitconvert另create+delete；anchor改須previewhash | usermove/restyle僅ownmarks；assistant不得覆user；module只own；finding附註有獨立claimpolicy；鎖層禁止geometry/style/delete |
| annotation.delete `{sceneId,id}` | 不存在回NOT_FOUND，deletebatch重送靠commandId | user可刪user/assistant；assistant只own；module只own；locked拒；refs轉target-removed，非刪相關evidence歷史 |
| layers.create `{sceneId,name}` | idserverassign；opacity/visible defaults1/true、lockedfalse | user/assistant/module僅建立其author/modulelayer；無隱式跨doclayerlookup |
| layers.update `{sceneId,id,patch}` | patch name/opacity/visible/locked；不接受content或author | user可改所有；assistant/module不改userlock/visibility；legacyassistant layername reuse保持既有route語義 |
| layers.reorder `{sceneId,order}` | 必須列所有layers恰1次；v2不採legacyorderpartialappend，adapter補成fullorder | user；LLM需explicit可用的usercommand代理路徑，不能自行解除lock |
| content.move-layer `{sceneId,ref,targetLayerId,index}` | ref在同Scene、index0..length、source/targetlock查；不改geometry | 沿domainownershippolicy；同transaction更新layerId/content，entityrevision+1 |
| anchors.detach `{sceneId,annotationId,expectedAnchorHash}` | lastResolved存在且valid→docdugeometry；無pose拒UNRESOLVED_ANCHOR | annotationeditpolicy與lock；附explicitconversionhistory，不改evidence原來源 |
| bindings.update `{bindingId,action,expectedBindingHash}` | actions refresh/detach/overwrite/fork/reattach只對該typedbinding；source/targetrevs完整 | CAS/transfercoordinator專用validator；userresolution不得偽裝module，crossdocscope雙方都驗 |
| document.archive / restore | 無geometrypayload；保content與references | ownerexplicitaction，moduleruntime無archivegrant；docrevision+1；可顯示archivedplaceholder |
| history.undo / redo `{token}` | history完整before/afterhash；affectedentitiesexpectedrevs/lockchecks | ownactorhistory；user可依explicitowneroperation管理，不能跨widget默默rebase；newrevision與newcommandId |

lockedlayer允許findingreview或補註沿現有`applyCanvasChanges`，不可拿findingpatch塞geometry；evidence validator保留model/tool/user observer邊界。assistant在v2與legacy都不能把「曾說看過」升級independently-verified。frame-dependentannotation不從axesdeletecascade刪除，轉invalid保留。

`annotation.update`finding note改變：沿assessment policy清除舊claim的currentverification/evidence，將舊claim寫history（不直接繼承review）；同note補新evidence可走原settleClaim規則；rejected同position無新evidence依現行拒絕紀錄不再重提。import不走edit生成新claim，另保存historicalclaim與importverification。

## Supporting Records / State Transitions

GestureDecision `{id,memberRefs:Ref[],verdict:'user-confirmed'|'user-rejected',sourceEventId?,original?}`；2..8members為新建立policy，legacy1member等異常raw完整保留並標unresolved而不改筆跡。Rejection沿assessment.js的kind/from/to/text/reason/at/ref原結構保存，typedrefs另附mapping，不能改文字配對結果。InteractionEventRef `{eventId,schema:'estampes.interaction/1',payloadHash}`，payload包含explicitintent、note<=500、userQuote<=300、roles、submissionId、targetrevision、annotationRefs與原0.2-draft event（若有），neverinventpastconversation。

Tombstone `{ref,deletedAt,deletedInCommit,priorRevision,reason}`；不是硬刪除raw資料。CommandHistory entries保存commandId/actor/affectedRefs/beforeAfterHashes/inverse/forward、legacyarchive與bounded60recentcommands；該window外可完整archive/export，但不承諾可undo。ReferenceBinding的status變更也提升doc/nb受影響revision，不由clientbadge覆寫。

CAS binding canonicalrecord由coordinator registry generation持有；document.bindings、notebook.links只持bindingId與typedendpoints，response可materializestatus；不能把兩份完整可寫status各存一處。RFC002 `bindings:ReferenceBinding[]`是materializedreadschema；persistence以bindingIdlist+manifestbindingrecord為權威。relationbindings同樣有一record，pairlinks方向作資料，不由兩份Map彼此修正。

ViewportFSM與Document存檔FSM不同：drawing→localDraft只改DraftStore；commitACK→cleardraft是explicitdraft操作，不能由任一snapshotredelivery清掉。validation成功但ui/message失敗，annotation已保存，submissionjournal保chatPending；retry ui/message不重建筆跡，UI顯「已保存、尚未送出聊天」。LLM/userannotationevent有submissionId，可由app-onlyvalidate/commit固定一次event；Host的ui/message delivery仍不保exactly-once，重送message帶相同submissionId供LLM辨識，不宣稱host去重。

## Tool Discovery / Paging / Error Envelope

Modeltools（Proposed）：create/read/edit/exportvisualdocument、openvisualpanel、execute_moduletargetextension、embedvisualdocument、migrationplan/commit、separationplan/commit。App-only：documentssnapshot/changefeed/chunks、userannotationvalidation/commit、viewportpreset/surfaceoperations。app-onlyvisibility沿既有`_meta.ui.visibility:['app']`，server仍需認證與validation；不當作獨立安全認證token。

read_visual_document required doc/scene、optionalexpectedRevision/include；summary預設最多50objects+50annotations，pagecursor binddocumentId/revision/audience/filterhash，最大page200，變rev回STALE_CURSOR不跨snapshot拼。renderpixel另MCPimagecontent，completeeditableJSON可downloadchunks/hash；summarytruncated=true及totalcounts明示，不能少回就說資料遺失。doclist只authenticatedowner可讀，module沒有全庫list接口。

Unifiederror `isError:true, structuredContent:{kind:'estampes.document_error',code,message,retryable,documentId?,currentRevision?,commitId?,details?}`；message<=300、不含secrets/rawuntrustedHTML；sourcevalidationpaths可回。codes固定：INVALID_INPUT、UNSUPPORTED_SCHEMA、UNSUPPORTED_TARGET、AMBIGUOUS_TARGET、AMBIGUOUS_REVISION、NOT_FOUND、FORBIDDEN、LOCKED、LIMIT、CONFLICT、STALE_PLAN、STALE_CURSOR、IDEMPOTENCY_MISMATCH、UNRESOLVED_REFERENCE、UNRESOLVED_ANCHOR、NON_INVERTIBLE、OUT_OF_BOUNDS、INTEGRITY_ERROR、STORAGE_UNAVAILABLE、RECOVERY_REQUIRED、CANCELLED、BACKEND_UNAVAILABLE。legacyroute回原errorcode/shape，由adapter轉換，不要求舊client認新code。

retryable只表示同request安全重查或重試的可能，不授權content自動rebase。CONFLICT/STALEPLAN需freshpreview/userresolution；INTEGRITY/RECOVERY必read-only；STORAGE_UNAVAILABLE不回savedACK；NOT_FOUND沒有tombstone時不自動產removed。正常response帶resultId/commitId/revisionvector與replayed，_meta missing不影響server資料。
