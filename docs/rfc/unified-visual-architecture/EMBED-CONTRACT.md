# Embedded Document Contract

Status：PROPOSED；R-04、OD-06、ADR-011。Current scene object allowlist沒有 embedded-document，本輪不新增productiontype。採單一 child Document權威、Snapshot為獨立可編輯clone，禁止把child可變副本塞入parent props。UVA-51–54/61；PR-6D在6B/6C之前交付此契約。

## Persistent Schema

```ts
interface EmbeddedDocumentObject {
  type:'embedded-document'; id:string; revision:number;
  parent:{documentId:DocumentId;sceneId:SceneId};
  layerId:string; visibility:'public'|'scratch'; locked:boolean;
  provenance:AnnotationProvenance; // shared creator/owner descriptor, not annotation geometry
  props:{
    bindingId:string; // bind:UUIDv4, canonical record in committed registry
    child:{documentId:DocumentId;sceneId:SceneId};
    mode:'live'|'snapshot';
    sourceRevision:number; // capture revision; only explicit retarget/freeze replaces it with history
    snapshotOrigin?:{documentId:DocumentId;sceneId:SceneId;revision:number;contentHash:string};
    localToDocument:number[]; // 9-value affine child du → parent du
    clipRegion:{space:'child-document';x:number;y:number;x2:number;y2:number};
    missingTargetPolicy:'placeholder';
    defaultEditTarget:'parent';
  };
}
interface EmbedBinding {
  id:string;kind:'embed';
  parentObject:Ref; child:{documentId:DocumentId;sceneId:SceneId};
  mode:'live'|'snapshot'; sourceRevision:number;
  status:'fresh'|'unresolved'|'unavailable'|'archived'|'denied';
}
interface ResolvedEmbed { // read/render output only; not another writable store
  ref:Ref; effectiveChildRevision:number; status:EmbedBinding['status'];
  dependencyRevisionVector:{documentId:DocumentId;sceneId:SceneId;
    revision:number;contentHash:string}[];
  transformHash:string; authorizationScopeHash:string;
}
```

id使用obj:UUID或migratedlegacyobjectID（不存在legacyembedtype，不能從imageobject自動推斷）；layer membership遵Layer.content+layerId equation。locked是embed自身鎖，OR parentlayer.locked決定對embed transform/delete；child自身lock與layerpolicy獨立，不能用parentunlocked繞過。provenance只共用creator/ownerrecord，Object domain仍非Annotation；user可移動embed，module只改ownedobject且scene.write.owned，module不能從childref取得childwritelease。

matrix lastrow嚴格[0,0,1]、finite、det nonzero且condition<=1e12；允rotation/scale/shear，禁止perspective V1；clip positive finite rect需在創建時child extent內，child extent變小不改clip而交集顯示；negative scale可顯示鏡像、hit inverse一致。sourceRevision在live mode也只記capture provenance，explicitretarget/freeze才以新capture改值並保舊history，正常childedit不改它，**不**作跟隨最新的constraint；effectiveChildRevision來該render固定root的childhead。snapshotOrigin只於snapshot必填，child必是新cloneDoc而不是原source；snapshot仍可被user編輯，名稱表示與origin斷開，不是唯讀PNG。

EmbedBinding持parentObject與child引用；props.child/mode/bindingId是查詢需要的denormalization，validator要求等於canonicalbinding，op同transaction更新，無client可以分開改其中一份。status/effectiveChildRevision/vector是resolver對固定root+currentauth的materialized結果，不由client改，denied不持久化成跨actor公共狀態。props不存RenderPlan/raster/childScene副本。

## Operations / Atomic Preconditions

所有tools以requestId、expectedParentRevision、expectedSourceRevision或expectedChildRevision、完整typedSceneRef；既有newtool `embed_visual_document` 是create的wireentry，sceneObject不接受rawclient ownership/provenance。其他embedcommands在DocumentCommand操作enum明列，尚未實作。

| Operation | Required inputs / authorization | Commit / output |
| --- | --- | --- |
| embed.create (live) | parent+source SceneRef、mode/live、layerId或layer:{name}、matrix、clip、expectedParentRevision、expectedSourceRevision；parentwrite+childread+referencegrant | 建parentobject+binding；不改childrevision；回完整embedRef/bindingId/dependencyvector |
| embed.create (snapshot) | 同上+mode/snapshot；childread+document.create.graph/image依kind | 固定source revision deepclone全部可編輯domains/refs到新doc，建立object/binding指clone；回cloneRef/idMap；nested embed V1依下節預檢回 BLOCKED_DEPENDENCY，不提供未定義的 materialize operation，不能默默raster |
| embed.update | embedRef、expectedObjectRevision、parentOCC、patch僅matrix/clip/visibility/locked（user） | 禁止patchchild/mode/binding/provenance；update transforms不影響child/其Evidence |
| embed.retarget | embedRef+newChildSceneRef、parentOCC/objectrevision+newchildrev、previewHash；明確user或具scopedmodulegrant | 驗cycle/auth再同commit改binding與props/sourceRevision；history保oldchildref/revision；舊child不刪 |
| embed.detach / freeze | liveembed、expectedParent/Object/Child revisions、previewHash；userexplicit；child可讀 | 將目前child固定版本deepclone成snapshot，重指binding；保原source/snapshotOrigin；所有nested refs按上述reject規則，禁止失資料 |
| embed.delete | parentOCC/objectrev、owner/lockpolicy | tombstone parentobject、bindinginactive；childDocument及history不刪 |
| embed.enter-edit | embedRef、bindingrevision/parentrev、childcurrentrev；childwrite/annotationpermission+explicituseraction | 只建立獨立childViewport session；**不是**資料mutation，不授權module；結束回parent |
| embed.undo / redo | parenthistorytoken、affectedrevisions/lock、必要的childclonecheckpoint | inverse新commit；不還原別人後改的child；clone仍作獨立doc保存，不因undo embed而GC；CASrefs跟其真實childidentity |

V1 parent上drawing預設parentdoc，不以hitTest決定改child。選取點先reversepaintorder命中embed外框/clip，再可選「編輯來源」打開childviewport；在child編輯mode筆畫落child，hover/toolbar明示docID/title，requesttarget永遠明確。pointer inverse完整 `Camera^-1 → parentD → localToDocument^-1 → childD`；clip外不hit，parent自身hidden/locked UI提示不能作child授權。user可看但沒childwritegrant只readonlychildview。

## Lifecycle / Notifications / Cache

live resolver在同committed root抓parent與childheads及遞迴closure；childcommit事件含commitId+changedSceneRefs，由ReferenceService reverseindex推derived invalidation給所有parent subscribedviewport。跨Widget沿documents_get_changes的parentdependencytoken；即使parentdocrevision未變，也回dependencyChanged=true和新vector。DocumentStore據token更新render而不偽造parentcontentrevision/undoentry。reverseindex可重建自bindingregistry，缺index時以有界closure查核/重建，不能永遠漏事件；minimizedviewer resume重算token。

Cachekey包含parentrev、embedobjectrev、每個resolvedchildrevision+hash、renderer/profile/clip/matrix/DPR/layers、scopehash、modulegrantrevision。禁止僅用parentrev。render進行中child更新不混合新舊，該frame固定snapshotvector完成，下一frame再更新。server/browser/export同root+scope解析同vector；denied者cache不能帶childhash、title、objectcounts、pixels或內部IDs到未授權caller，placeholder只含parentembedRef與reason=denied。

child archive→placeholder `archived`，保binding與最後source identity，不auto-unarchive、不以cachedpixels繼續洩漏；userexplicitrestorechild後重解析。missingdoc無tombstone→unresolved，暫存/IO failure→unavailable；永不猜同名doc或fallbackorigin；readonlyexport仍列unresolvedrefs。permission revoked立刻清privilegedprojectedcache/viewportdata，不能等docrev；公開parent不代表child可讀。derivedvector/placeholder status不寫入parentgeometry。

Raw persisted EmbeddedDocumentObject **不可**直接交給未授childread的modulecontext、toolresponse或_meta。授權projection必先遞迴檢查props/bindings/provenance/evidence內所有crossdocrefs；denied時回 `{ref:parentEmbedRef,type:'embedded-document-placeholder',status:'denied',readOnly:true}`，不含props.child、bindingId、source/snapshotOrigin、childdependencyvector或childcount/hash。這是readprojection型別，不可拿去persist/import當新embed。包含deniedchild的完整editableexport預設FORBIDDEN；references-only只給opaque unresolved handle與lossReport，不能透過rawdocumentJSON/manifest繞過同一projection。owner-onlybackup屬獨立明確授權scope，不能給module以parentreadgrant取得。

## Cycle / Depth / Reference Safety

create/retarget/detach/import在coordinator全局bindinggraph lock下，對afterstate以DFS檢查所有live與snapshot childedges；禁止selfcycle、A→B→A，cross-scene同doccycle亦拒。depth<=8、visiteddocs<=12、totalrenderpoints有界。preflight取fixedroot，commit前graphversion不同重新檢查（兩writer同時A→B/B→A不能各自通過）。runtime遇corruptcycle failclosedplaceholder+INTEGRITY_ERROR，不無限遞迴。snapshotcopy非循環豁免，source含nestedembed在V1明確拒以避免隱式外部live關係。

## Copy / Move / Export / CAS

Copy parent（選liveembed）預設新增parentobject/binding仍指同child，preview顯「child共享」；選deep-copy要求clonechild改成snapshot，nested policy同上。Move parentobject轉owner Document需incomingrefmap並重驗cycle/scopes/matrix（preview明示preserveparentpose或mappedpose），child identity不變。Detached clone新doc/scene、object/annotation/layer IDs two-pass重建，evidence/provenance原來源保留而currentapplicability依contexthash檢查；CAS預設historical/detached，userexplicitcopy-live-link才新binding。

Bundle export **預設包含全部可讀 child closure 的 editable documents**及binding/matrix/clip/ownership/history、每docpinnedrevision與idMap。無childread則不能export其內容；可選references-only並列unresolved/lossReport，不verifiedComplete；snapshotchild一樣是普通document。import所有mutableIDs映射、externalref預設unresolved、ownerlineage按ANNOTATION-POLICY不自動grant；cycle beforepublish拒整batch。legacybundle/1不能表示embed，回UNSUPPORTED_TARGET/lossreport，不能自動壓PNG。

CAS Plot target一律child Graph實際Ref，**不能**用parentembedobjectID當plotID；Liveembed不新建第二個CASbinding，child更新透過dependencyinvalidation反映到parent。snapshotclone若未明確copy-live-links，只保CAS歷史；Undoparentdetach不改originalCASlink的target。驗收需UVA-51–54/61檢查parent/childrevision、cachevector、auth、cycle、editableclone、refmaps與CAStarget不污染。

## Phase 0.2 — Nested Snapshot Preflight / Deterministic Refusal

V1 Snapshot 的限制是**不複製含 embedded-document 的 source Scene**；包含 hidden/scratch/archived-reference embed 也算，不以當前可見 pixels判斷。source其他Scene不在本次capture範圍，不因不相關Scene有embed而拒；clone產一個新Document/Scene，原跨Scene非embed refs按RFC006保留 unresolved／explicit remap。此限制涵蓋 snapshot create、live→snapshot freeze/detach、parent deep-copy 的 child clone、graph separation所要求的該clone；不限制普通 live embed、不限制原封匯出完整可編輯 bundle closure。

1. Preview 與 commit 共用 `snapshotEligibility(sourceSceneRef, expectedSourceRevision, actorScope, fixedRoot)`。先驗 parentwrite/source read與必要 create grant，再讀 source固定 Scene 的**全部 content**。不能讀所需 source內容則 FORBIDDEN，不用 skipped entities 組成「完整snapshot」。只掃 source 即能判定存在nested embed，不必取得其 child 的內容或 metadata；cycle/depth另按原 graph validator。
2. Preview 回 proposed read projection `snapshotEligibility={supported:boolean,reason?:'NESTED_SNAPSHOT_UNSUPPORTED',source:SceneRef,sourceRevision,sourceContentHash?,bindingGraphHash,blockers:Ref[],redactedBlockerCount:number,alternatives:('live'|'open-source'|'link-source'|'explicit-source-edit'|'editable-bundle')[]}`；不含未授權 child refs。sourceContentHash 僅有完整未遮蔽source read授權者可取得；有redactedBlockerCount時省略，真source hash保留在server-only preview record。bindingGraphHash只算此scope可公開的source reference projection，不是全server binding graph digest；真正global graphversion只在server記錄並於commit重驗，不洩未授權文件的變動。blockers只列其可讀 parent embed ObjectRefs，隱藏內容只計 redactedBlockerCount，不暴露 ID/title/hash/child counts。UI顯「此來源含嵌入文件；V1無法建立獨立 Snapshot，原文件保持不變」，說明 live共享、snapshot獨立及沒有自動壓平成圖片。
3. 不支援時確定回 Unified error `code:'BLOCKED_DEPENDENCY', retryable:false, details:{reason:'NESTED_SNAPSHOT_UNSUPPORTED', operation, snapshotEligibility}`；operation只允 `embed.create.snapshot|embed.detach|embed.freeze|parent.deep-copy|graph-separation.snapshot`。不新增頂層 error code、不自動改 mode、不配置新 Document/Scene/Object/Binding ID、不寫 staged content，不消耗 source revision。可留只讀 preview artifact／拒絕診斷，不宣稱 saved content。
4. 可支援的 previewHash 綁 actorScopeHash、source ref/revision/contentHash、parent revision、bindingGraphHash、mode/transform/clip、clone policy。commit 在 graph/publish locks 下重新驗授權/OCC/eligibility；source改變→STALE_PLAN，graph改變→重新驗cycle/eligibility；不支援仍回上述 error。任何拒絕都保持 doc/object/binding/ledger content-effect count為0，不能留下半個clone。失敗 request 可重查錯誤；不能在原request hash下改成 live操作。
5. 明確可選的替代：使用 live（preview標 child共享）；另開／link原child；先由owner選擇移除／搬移source內的nested embed（獨立plan、完整備份、歷史與incoming refs保留）再重新preview；或 export完整可讀 editable closure。**沒有** `materialize nested graph` 的V1可執行操作。references-only export可用但須lossReport／unresolved handles，不稱完整snapshot。不能建議「暫存PNG後刪原始內容」。
6. Bundle/2 export/import保存既有多層live/snapshot文件及binding，不做snapshot clone，可在auth/cycle/limits/refs通過後round-trip；正常import two-pass ID remap不是被禁的recursive deep-clone operation。migration source unknown/embed不可表示於legacy則明示 preview blocker；不以此限制 silentdrop 或 raster降級。CAS target維持實際childplot Ref；不指向parent embed或假clone。

未來若支援 recursive editable snapshot，需新 ADR 擴充 ADR-011，明定 entire authorized closure、每doc/scene/object/binding/CAS/history map、shared-child去重、capture revision vector、容量預訂、cycles與失敗原子性；不能在PR-6D自行加隱含 recursive cloning。UVA-67在任何正式clone能力啟用前必過。
