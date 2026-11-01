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
| embed.create (snapshot) | 同上+mode/snapshot；childread+document.create.graph/image依kind | 固定source revision deepclone全部可編輯domains/refs到新doc，建立object/binding指clone；回cloneRef/idMap；nested embed V1拒snapshotclone，需先顯式materialize nested graph plan，不能默默raster |
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
