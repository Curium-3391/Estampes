# Annotation Authorship / Unified Editing Policy

Status：PROPOSED；R-01、R-02 的正式推薦契約，**未經 Human Approved**。Current：`canvas-state.editCanvas` 只允許 user 移動自己的 mark；`scene-ops.applySceneOps` 已區分 user/module actor 並保留 provenance；`modules/router` 由 registry/grants 建立 context。此文件不改這些正式程式。相關決策 OD-02、ADR-009；測試 UVA-41–45。

## Actor、Author、Owner 與 Grant

Author 是首次創作的來源；Actor 是這次可信任執行身分；Owner 是 module 可修改範圍的 descriptor；實際 authorization 還需當前 grant、目標 scope、operation policy、lock 與 revision。owner 不是 Document 的使用者擁有權；single-owner instance 的 user 能依新政策編輯所有未鎖 Annotation。

| 方案 | 得失 | 建議 |
| --- | --- | --- |
| A 只增加 author=module | 可表達來源，但升級/匯入/現在 actor 與歷史作者仍混用 | 不單獨採用 |
| B Authorship 與 Ownership 分離，author domain 同時容納 module | 接近現有 Scene Operations；可保留不可變作者，又精確驗證 module lineage | **推薦**，採下方 schema |
| C V1 禁止 module annotation | 省去授權面，但與 annotation.write.owned/現有規格衝突，模組擴充能力延後 | 不採用；v1 manifest adapter 本來仍不取得此新權限 |

以下 TS 為資料模型投影；可執行的文件專用驗證 schema 位於 `evidence/proposed-contracts.mjs`，不載入 Production Validator。

```ts
type Principal = { kind:'user'|'assistant'; principalId:string } |
  { kind:'module'; moduleId:string; publisherFingerprint:string|null;
    ownershipLineageId:string|null; version:string|null; packageDigest:string|null } |
  { kind:'legacy-unknown'|'import'; sourceId:string };
type ActorContext = { principal:Principal; authenticatedOwnerId:string;
  origin:'app-user'|'model-tool'|'module-runtime'|'migration';
  effectiveGrants:string[]; targetScope:Ref[]; grantRevision:number;
  executionId:string }; // server-only, never accepted in operation input
type Ownership = { kind:'instance'; ownerId:string } |
  { kind:'module'; moduleId:string; publisherFingerprint:string;
    ownershipLineageId:string; adoptionEventId?:string } |
  { kind:'unclaimed-module'; moduleId:string; historicalSourceHash:string };
interface AnnotationProvenance {
  author:'user'|'assistant'|'module'|'unknown'; // display projection of createdBy
  createdBy:Principal; createdAt:string|null; lastEditedBy:Principal; lastEditedAt:string|null;
  ownership:Ownership; grounding:string;
  editedByUser:boolean; lastUserEditRevision?:number;
  sourceTrust:'local'|'migrated-local'|'imported-unverified';
  original?:{sourceSchema:string;payloadHash:string;archiveRef:string};
  derivedFrom?:Ref;
}
```

createdBy、createdAt、original 不可由 update patch 改；author 由 createdBy 推導，import 原稱作者無法核驗時 author=unknown、原宣稱放 original。lastEditedBy 記每次實際 actor；editedByUser 是「曾由使用者修改」sticky flag，Undo 也不清掉稽核事實；lastUserEditRevision 是最近 user command 的 annotation revision。ownership 只能由 owner 的專用 adoption transaction 改，不是 annotation.update patch 欄位。移 Layer 不改 author，也不轉移 module ownership。

Server 建立 actor：App-user operation 需要已初始化的 app session/user-action capability；模型 tool 固定 assistant；module output 固定該 enabled runtime principal。`author`、`actor`、`createdBy`、`ownership`、`effectiveGrants` 出現在 mutation input 一律 INVALID_INPUT，不能被忽略後當成合法偽造請求。App-only visibility 本身不是認證；session/action capability 必須由可信 host action 路徑建立，無法驗證則不得提供 user-level mutation，回 FORBIDDEN 並保留草稿。一般持 access key 的 owner 管理客戶端屬明確 owner principal，必須使用 owner-authenticated API，不由 caller 的 author 字串切換。

Effective grants = enabled installation grants ∩ capability-declared grants ∩ execution lease grants；再套入 targetScope 與 operation-specific policy。moduleId、相同顯示名稱、public visibility、可讀到 Ref，都不構成 write grant。commit 前重查 installation state、grantRevision、ownership lineage、Document/Annotation revision；background job 也沒有豁免。

principalId由server分配且跨同owner的widget/session/restart穩定：user為owner principal，assistant為該owner的model lane，module的stableidentity為moduleId+ownershipLineageId（version/packageDigest屬此次操作來源，不重設身份）。command另記initiatedBy與executedBy：execute_module可由user/assistant發起，但內容createdBy/lastEditedBy是實際module；idempotency ledger使用**發起端**的穩定authenticated principal與requestId，retry跨widget不因臨時session/executionId改key。executionId只追蹤單次runtime attempt，不拿來當內容作者或重試key。

## Authorization Matrix

所有新內容 mutation 需 Document OCC；wire依CONTRACTS版本對照：edit_visual_document 用 expectedRevision，execute_module 新target用 expectedDocumentRevision，內部統一 expectedRevision；對現有 annotation 另需 expectedAnnotationRevision。source/target layer locked 都阻擋 Move/Resize/Restyle/Relayer/Relabel/Delete/Reanchor/Undo/Redo；只有獨立 Finding Review command 依既有政策可附註，不能混帶幾何或樣式。

| Actor / origin | Create | Geometry / style / label / relayer / delete / anchor | Claim / review | Undo / Redo |
| --- | --- | --- | --- | --- |
| Legacy user (`edit_visual_canvas`) | 原行為 | move/restyle 僅原 user marks；AI 可刪；不新增 resize 等欄位 | 原行為 | 原行為，不擴張舊 API |
| Unified user（owner-authenticated） | user author、instance ownership | **任何可寫 Document 的 user/assistant/module Annotation**，含 Move/Resize/Restyle/Relayer/Relabel/Delete/Reanchor | note 修改建立新 claim；review 由 user actor 記錄 | 可 Undo 自己對 AI/module Annotation 的 edit；需 affected refs/revisions/locks 檢查 |
| Assistant/model | assistant author、instance ownership | 僅 createdBy assistant 且沒有未解除的 user-edit guard；不能修改 user/module Annotation | 可依 claim operation 附 Findings，不能替 user review；不回寫 geometry | 僅自己 command，不能越過 user guard |
| Module/runtime | 需 annotation.write.owned，新 author=module/lineage owner | 僅 moduleId+publisherFingerprint+ownershipLineageId 全吻合、當前 grant 有效且沒有 user-edit guard的 Annotation；其他 module/user/assistant 拒 | tool evidence 由 Core stamp；不能代表 user review | 僅自身命令及同 owner，仍查 guard/lock |
| Imported / unclaimed module | 不作 runtime actor | module/assistant 自動修改拒絕；user 可編輯 | imported claims 維持歷史／未核驗來源 | user 可撤回自己後續的本地編輯 |

Module 停用/移除只停執行與 write lease，既存 public annotation 由 trusted renderer 繼續顯示、可保存/匯出、user 仍可編輯；scratch 的可見權限不因移除升級。重新安裝同 moduleId 不自動取得 lineage。相同 publisher signing key、owner 明確批准 restore/adopt、舊 lineage registry 證據吻合才接續；升級同可信 signer/lineage且無新增未同意 grant可延續。簽名 key 輪替需 owner 確認新舊關聯、更新 lineage record；builtin 由 Core 固定 publisher identity，升級不自行發新 owner。匯入的 module lineage只是 historical source，owner=unclaimed-module，不能憑 bundle 內容授權本機 module。

Principal.module 中 nullable signer/lineage/version/digest 僅容納舊資料的未知歷史；sourceTrust=local 的新module操作一律四欄非null且由registry stamp。migrated-local若signer/lineage未知必用unclaimed-module ownership，不以虛構hash/新lineage補齊；adoption補的是目前ownership連結與新的操作Actor，不改未知的createdBy原歷史欄位。

owner批准adopt/restore/keyrotation會建立server-owned adoption event（event:UUID）及同moduleId的新ownership descriptor，附adoptionEventId；runtime resolver必驗event在目前registry真實存在、由owner批准且綁定exactAnnotationRef/oldhash/newsigner/lineage。未知createdBy或舊signer與新owner不同只有此證據才可連結；JSON裡有adoptionEventId不算授權。author/createdBy仍不改；不允藉此讓任意不同moduleId互改Annotation。

Legacy mapping：author=user/assistant 且無可信 module evidence→保原 author；migration 使用 createdBy 的 `kind:user|assistant, principalId:'legacy:<sourceHash>'` 表示既有本地作者宣稱、sourceTrust=migrated-local。**不能**用 layer.module 推斷 mark author=module。Scene Object 的可信本機 provenance.module 可映射 module author，但缺 signer/lineage→unclaimed-module，user 可編輯。unknown/missing author→unknown。舊 edited=true→editedByUser=true，缺 actor→legacy-unknown/sourceId，缺 time→null 並保 legacy original，不能發明 user ID 或時間（migration event另記當前時間）。

Export 保存 createdBy/lastEditedBy/ownership/history/evidence 原值與來源信任，但不含 lease/token/grants；import 保存原 provenance 在 original archive，active actor=import、author=unknown、owner=instance 或 unclaimed-module，原 author 以 historical badge 顯示。備份恢復同 storeInstanceId 與完整 registry 可恢復本機語義；一般外部 import 不等同可信備份。

## Unified User Editing / Evidence State Transitions

Finding 分離 immutable claim text/version、historical Evidence、user review 與 current applicability。新增 claimContext `{claimId,claimRevision,geometryHash,anchorHash,sourceRevisionVector}`；evidence 附 applicability=`current|stale|historical`；verification `{historicalState,currentState:'unverified'|'user-confirmed'|'user-rejected'|'independently-verified'|'stale',reason?,contextHash}`。reviewHistory 不因 geometry 變動清除；badge 不能把歷史 confirmed 說成目前 confirmed。label 明定 presentation text，語義聲明只放 finding.note；UI 改 Label 不能順便改 note。

| Change | Finding / Evidence | Verification / Review | Provenance / history |
| --- | --- | --- | --- |
| Move / Resize / geometry point edit | geometryHash 改；全部現有 current evidence→stale（不刪 raw）；finding context stale | currentState=stale，保留 historicalState/reviewHistory；即使 user 移動也不自動 confirmed | createdBy 不變；lastEditedBy=user、sticky editedByUser；記 before/after geometry |
| Reanchor / detach / source frame 語義變動 | anchor/source context 變；同上；即使投影位置相同也 stale | 同上；invalid target 再加 anchor-invalid | 明確 transformation 與原 anchor/history 保存 |
| Color / pen / width / opacity / relayer（不改 geometry/anchor/note） | contextHash 不變，保 current applicability | 不改 current verification/review；locked policy仍查 | edit 記錄與 user guard 仍建立，避免 LLM 覆寫 user style |
| Relabel（presentation-only） | note/claimVersion不變；labelHash只供 UI diff，**不在 claimContext 語義hash** | 不使 Finding stale；若要改 claim 必須另送 finding.update | preserve old label in history |
| finding.note 改變 | new claimId/version；舊 evidence→historical，current evidence預設空；拒絕重提政策沿 assessment | new currentState=unverified；舊 review 歷史保留，不繼承到新 claim | createdBy Annotation不變；claim有自己的 actor/history |
| explicit reverify/review | 比對現 geometry/anchor/source hash，新增當前 evidence或 user verdict | 只對 exact contextHash設新state；user review不能產 independently-verified | append review event；不改 original evidence |
| Undo geometry edit | inverse command還原 geometry；找得到歷史 exact context 且 sourceRevisionVector未變才恢復該context applicability | 符條件恢復原 context 的state；否則保持stale，不能盲目套舊confirmed | inverse 是新 revision；createdBy不變；user-edit稽核仍存在 |
| Redo | 重新檢查 affected revisions/locks，套同一轉換規則 | 不因 redo 自動認證 | 新 commandId/history，不重播舊 actor |

claimContext 正式欄位為 claimId/claimRevision/geometryHash/anchorHash/sourceRevisionVector；label 不在語義 context hash；所有 Current/Historical 切換依 context，而非只看 annotation.revision。Frame range/camera 單純投影變化不改 world context；frame units/coordinate meaning改變會改 anchorHash 並 stale。

sourceRevisionVector entries為 `{ref,revision,semanticHash}`：revision保原取得證據版本，semanticHash只涵蓋該證據依賴的語義（例如函數expression/domain、asset hash、frameunits），不含camera與純投影range。檢查目前source不同revision時，只有trusted dependency classifier證明semanticHash不變才維持applicability；無法證明就stale。own geometryHash採anchor-space canonicalgeometry，worldrange重投影不改它；object函數錨點的f(x)語義改動仍使sourceSemanticHash改變並stale。Undo判斷亦用這個exact語義context，不把「document revision不同」直接等同或直接忽略語義差異。

```ts
type ClaimContext = {claimId:string;claimRevision:number;geometryHash:string;
  anchorHash:string;sourceRevisionVector:{ref:Ref;revision:number;semanticHash:string}[]};
type ContextVerification = {historicalState:'unverified'|'user-confirmed'|'user-rejected'|'independently-verified';
  currentState:'unverified'|'user-confirmed'|'user-rejected'|'independently-verified'|'stale';
  reason?:string;contextHash:string};
```

claimId使用建立該claim的event:UUIDv4；claimRevision正safeinteger；各Hash為canonicalUTF8 JSON按key排序、保arrayorder/finite doubles、不四捨五入計算的SHA256小寫64hex。reviewHistory/claim舊versions由losslesshistory保存，不能只存最後一個historicalState。這兩個型別供RFC-002引用，不另有可寫的verification shortcut。

## LLM / Module Conflict Guard

第一次 user 修改任何非 user-created Annotation，記 `userEditGuard={guardRevision,fields,contextHash}`；後續 assistant/module mutation即使讀到最新 revision 仍回 USER_EDIT_CONFLICT，不把 OCC 當 user 同意。user 可用獨立 `annotation.authorize-edit` owner-only action，發單次 `{targetRef,allowedActor,allowedPaths,baseAnnotationRevision,expiresAt}` lease（最多10分鐘、不匯出）；不能改 createdBy 或繞 lock。successful matching edit消耗 lease，同 command retry回原 ACK 不再消耗；target改版/actor撤權即失效。預設推薦保留手改或 fork 新 Annotation；沒有 user action 不能自動解除 guard。Undo 回到原 geometry 也不默默撤除保護。

此單次lease只解除本次matching user-edit guard，**不**擴充原有ownership、targetscope、effectivegrants或actor類別矩陣；assistant仍不得修改module/user authored Annotation，不同module也不能靠此互改。lease由server在ActorContext中lookup並以commit原子consume，不接受client傳新author/owner；無matchinglease就保持conflict。

新政策標識 `legacy/1|unified/1` 由 tool route與 authority registry決定，不接受 client任選較寬政策。OD-02必須正式批准 unified/1 完整 user-edit 矩陣、label semantics、stale/Undo與guard，才能啟用 PR-2B；本輪只完成規格。
