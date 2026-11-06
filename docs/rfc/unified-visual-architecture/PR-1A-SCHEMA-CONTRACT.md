# PR-1A — Isolated Schema / Read-only Projection Interface

Authority：[有限維護者授權](https://github.com/Curium-3391/Estampes/blob/d9aaa49f27d195ed53baeb12e95e434f1a7b10b0/docs/rfc/unified-visual-architecture/PR-1A-AUTHORIZATION.md)與Phase0.2契約。CURRENT僅為下列隔離函式／schemas；現有工具未import它們。真正writer、runtime authorization、Graph Viewer、Scene mutation與migration仍PROPOSED。本頁固定機械表示，不重新選架構。

## Modules / exact interfaces

| File | Exports / contract |
| --- | --- |
| src/documents/validation.js | DocumentValidationError(code,message,path)、assertJson(value,limits)、bounded(schema,limits)、parse(schema,value)、canonicalJson/hashJson/cloneJson；Revision/ContentHash/Timestamp/Finite schemas |
| src/documents/identity.js | Typed ID schemas、createId(kind)、parseId(kind,value)、parseAssetRef(value)、normalizeRequestId(req)；server UUIDv4、新prefix與legacy local IDs分開 |
| src/documents/references.js | SceneRef/Ref/ObjectRef/AnnotationRef/LogicalRevisionRef/IdentityMapping schemas；parseRef/refKey、lookupIdentity(table,source) |
| src/documents/provenance.js | Principal/Ownership/AnnotationProvenance/ImportedProvenance/ActorContext schemas；parseProvenance、intersectGrants(installation,capability,lease)、assertCreatorUnchanged(before,after) |
| src/documents/embed-schema.js | AffineMatrix/ClipRegion/EmbeddedDocumentObject/EmbedBinding/SnapshotEligibility/SnapshotRefusal schemas、assertEmbedBinding(object,binding) |
| src/documents/schema.js | VisualDocument/Scene/Layer/Annotation/SceneObject/CoordinateFrame/ReferenceBinding/ClaimContext/Verification等strict read schemas；parseVisualDocument(value)、parseDocumentJson(text) |
| src/documents/integrity.js | validateDocumentReferences(documents)、resolveReference(documents,ref)；只查caller提供的完整snapshots，不查Store、不驗grants、不抓URL |
| src/documents/input-schema.js | AnchorInput/AnnotationCreateInput/AnnotationUpdateInput/EditDocumentInput schemas、parseEditDocumentInput(value)、parseAnnotationPatch(input,storedType)；只宣告create/update/delete subset，無dispatcher |
| src/documents/legacy-shadow.js | LegacyShadowContextSchema、mapLegacyCanvas(canvasJsonRecord,context) → status/document/sidecars/report；無I/O、clock、random、mutable registry |
| src/persistence/commit-root-schema.js | 六root/CommitRoot/CommitIndexEntry/RecoveryResolver/RecoveryCatalog/LegacyAlias/CommandLedgerKey/CommandTombstone/CurrentEnvelope schemas；parseCommitRoot、assertCurrentEnvelope、assertCommitIndexEntry；無persistence execution |

每個函式回傳解析後新資料，不是store handle。Zod `.safeParse()`返回shape/semantic issues；`parse()`統一成DocumentValidationError。INVALID_INPUT是syntax/type/unknownfield，LIMIT是bytes/count/depth，UNSUPPORTED_SCHEMA是version，INTEGRITY_ERROR是owner/duplicate/membership/hash不一致，UNRESOLVED_REFERENCE是缺target，OUT_OF_BOUNDS是normalized/clip範圍，NON_INVERTIBLE是matrix，FORBIDDEN只用於**資料契約**中的偽來源／不可變欄位，並非實際認證結果。

## Identity and trust boundaries

UUID為canonical lowercase v4；doc/scene/vp/panel/obj/ann/layer/bind/req/cmd/tx/event/lineage/exec各有parser，createId只明確呼叫時生成。AssetRef是full64hex與可選legacy16hex alias的語法／prefix一致檢查，**沒有讀bytes驗完整asset hash或decode**；caller需提供已驗來源。Legacy object o1..o999999、layer L1..L999999；mark為<=64字opaque local ID，即使字面像另一種ID也由Ref.kind+Document/Scene scope區分，不把它轉成Doc ID。Frame是<=80字descriptor，`document`保留給affine parent；沒有發明global Frame UUID協議。

IdentityMapping是提供好的allocation table，不是allocator；namespace是local-migration/storeUUID或external-import/bundleHash，source=(schema,legacyKey,kind,id)，target是完整Ref。source/target重複與kind轉換拒絕；不同kind同local字串可合法共存。多Scene來源的legacyKey必明確攜source Doc/Scene作用域，重複source不靠last-wins。Shadow context的local table必對同sourceStoreId，external profile不能誤用local table；bundle/file hash真實性由未來intake驗證。

Trusted read record schema能描述user/module資料，不認證它。ActorContext只能由未來server route建立，parse不證session或adoption event存在；client mutation嚴格拒author/actor/createdBy/ownership/grants/commandId及renderer-derived lastResolved。ImportedProvenance profile強制import/unknown、original archive、instance/unclaimed owner；不能自選local來獲權。intersectGrants只計交集；新Module ID不產生grant。assertCreatorUnchanged保createdBy/createdAt/original/sourceTrust與sticky user edit audit，不執行adoption或授權。

## Model and reference validation

VisualDocumentSchema檢查單Scene owner、defaultScene、200objects/5000annotations全Doc合計、24Scenes、128points/stroke、typedgeometry、layers.content雙向唯一membership、local axes/frame/anchor/gesture/intent refs與framegraph acyclic。60000 raw shape points可靜態檢查；**曲線取樣後60000 rendered points由後續renderer驗，PR-1A不取樣／渲染**。合法Tombstone可讓已移除的annotation anchor保留invalid引用；未證明的missing target不自動當removed。Scene Object沿用現有strict typed props／expression parser，不呼叫normalize-label／operation／renderer；既有Scene Object tool-evidence保留其domain，並非強迫變成Mark Evidence。

單Document structural parse不證外部Ref存在；validateDocumentReferences以提供的snapshots驗fresh refs、canonical binding、childScene、CAS真plot target及embed cycle/depth<=8/visited<=12。顯式unresolved/unavailable/removed的read狀態可保typed historical ref，不回假resolved；同UUID的canonical binding不能指向不同內容。未知source/原provenance歷史不靠跨Doc查詢重新指認。重複embed edges去重，避免同child重複帶來指數遍歷。

FullDocument read record的binding為materialized records；不是可寫registry副本。SceneObject.layerId與Layer.content是同一membership的兩種表示，並非另一順序權威。Embed只持childRef；snapshotOrigin/capture revision一致且child為獨立Doc，無子文件可變副本。clip在captured live revision或初代snapshot extent驗界，後續extent縮小保原clip供renderer交集。SnapshotEligibility只是shape，不執行preflight traversal或clone。

## Bounded JSON and reserved read fields

完整Doc與shadow來源預設64MiB UTF8 JSON、depth32、4,000,000 visited JSON nodes；root64KiB、tombstone1KiB。結構預掃先於深層Zod；拒cycles/accessors/proxies/exotic prototypes/symbols/functions/undefined/sparse arrays/nonfinite。字節包含escape與UTF8；不靠JSON.stringify巨量字串後才判limit。depth/node上限是PR-1A parser資源防護，不宣稱滿載互動performance已驗。Canonical JSON排序object keys、保array順序、finite doubles不量化；不執行extensions／archive資料。只有Document.extensions可用namespaced key（例如org.estampes:inspection），unknown正式欄位拒絕，不靜默strip。

Scene.undo使用read projection `{entries,legacyArchive?}`；entries為最近<=60command metadata（actor、affectedRefs、beforeAfterHashes、inverse/forward data、base/applied revisions），inverse/forward是有界data，不執行。rejections保有界原始claim records；interactionEvents只記eventId/schema/payloadHash。完整legacy history留shadow sidecar，不假裝新Undo可操作。這些read表示不是已啟用的新磁碟格式。

CommitRoot只允registry/locator/ledger/commitIndex/retention/authority六hash；current membership與RecoveryResolver不能指回自身外層root。CURRENT.checksum不含自己；pure guard比對generation/commitId/rootHash/checksum，沒有讀referenced pages或證明flush。RecoveryCatalog、authorityEpoch、alias與ledger metadata只驗結構；fullretention page layout、pins/GC/ACK lifecycle留PR-1C/1D，不以placeholder writer假報saved。

## Legacy shadow context / reports

輸入為version1 canvas.json的**JSON snapshot**，不是live ImageEntry/Map；caller傳documentId/sceneId/sourceStoreId/fullAssetRef/sourceToDocument/ownerId/title/projectedAt/sourceTrust。所有ID與時間由caller plan明示；function不自動create、不以PNG產Doc identity。sourceToDocument由caller提供已知asset mapping；normalized ink→du使用已存在W/H定義，不猜EXIF或registration。persistence固定memory/non-authoritative。

layer/mark/object legacy IDs、geometry/points/order/opacity0/lock、original Evidence/review/verification/stroke timings、Scene props/tool evidence、rejections/gesture決策保留。createdAt無史料即null；缺作者依最新明確授權“不發明Provenance”記unknown，不套舊importer的assistant預設。layer.module不推作者。local historical module沒有signer/lineage時unclaimed；external source全部unknown，舊confirmed只保historical，current不升級。legacy edited geometry或無法證明Evidence source時current stale，不刪原文。

完整canonical source放isolated sidecar、hash與original archiveRef可追；report說明未投影的intent/undo/unknown fields、unsupported gestures、unresolved refs，不塞raw進module-visibleextensions。mapped表示可產有效read model；不等於editableComplete、已持久化或migration驗收。blocked回document=null與完整raw/report，不能把缺object的partial canvas稱成功。unsupported object／不完整refs不silentfilter；legacy PNG object需後續verified decode/Asset intake，現在回BLOCKED_DEPENDENCY而非假Asset或raster flatten。

Link需caller明確bindingId與完整target allocation，無法提供就block；有typed allocation仍標unresolved，不假裝查過另一Canvas。Unlayered內容需明示new fallback Layer ID；不存在的named layer不擅自修復。savedAt與所有舊unknown/history完整在sidecar，不冒充原有creation time或新command歷史。hash是canonical JSON語意hash，不宣稱原始檔bytes hash。

## PR-1A review remediation — explicit closure / recovery meaning

Current APIs新增 `validatePartialDocumentSnapshots(documents)`：缺外部Document回missingDependencies（required/reason/target），不聲稱completeClosure；已提供Document內缺active Scene/entity仍拒絕。`validateCompleteDocumentClosure(documents,declaration)` required declaration為estampes.document-closure/1、storeInstanceId、generation與exact documentId/revision/contentHash列表；逐hash、唯一owner、active Ref、canonicalBinding與Embed DAG驗證，缺required依賴拒絕。顯式unresolved/historical缺target仍列report、不升級fresh；current confirmed/rejected/independently-verified ClaimContext的source refs必須存在，stale/unverified context可列historical缺依賴；complete限**Document模型closure**，不是asset bytes／CAS Notebook／repository-wide／authorization證明。Caller必由同一root產生declaration；PR-1C須在coordinator讀全registry後建立，不能採用client自稱closure。原validateDocumentReferences保持strict supplied-snapshots compatibility語意，沒有新repository-complete宣稱。

Shadow report現在明列mapped、migrationCompleted=false、recoveryScope=json-record-only、originalFileBytesVerified=false、binaryAssetsVerified=false。rawRecoverable只表示sidecar可還原輸入JSON record；canonical-json/sha256不是source-file bytes hash。mapped只代表read schema合法，editableComplete只代表本次支持欄位未有archive/issues；三者不互相推論，不保證外部binary/asset、全格式migration或磁碟durability。Blocked永遠document=null／mapped=false／editableComplete=false，raw仍可保留。見[review report](https://github.com/Curium-3391/Estampes/blob/d9aaa49f27d195ed53baeb12e95e434f1a7b10b0/docs/rfc/unified-visual-architecture/PR-1A-REMEDIATION-REPORT.md)。
