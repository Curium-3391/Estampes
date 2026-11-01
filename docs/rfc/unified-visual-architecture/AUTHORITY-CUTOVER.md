# Legacy Authority Transition State Machine

Status：PROPOSED；R-06、OD-06、ADR-012。以下 registry authority、CURRENT pointer 與 single atomic manifest commit 都是推薦設計，**現有0.20.0沒有這些機制**。推薦由同一 CommitRoot 發布authorityepoch/aliases/sourcehashseal/documentroots，不是featureflag；任何mode內一個set/doc只有一個writer。UVA-56–58/62；PR-1B需此contract和PR-1D維護基礎。

## State / Reader / Writer / Revision Table

| State | Authority / allowed readers | Allowed writers / tools | Migration / projection | Revision / flags / rollback |
| --- | --- | --- | --- | --- |
| A0 Legacy Authority | 舊canvas/set files；legacyread | 唯一mediatedlegacywriter；Unifiedwrite禁 | 無newdata；可建立readonlyplan | legacy scene/hash版本；flags可隱藏UI不能生newwriter；可原版backupvolume |
| A1 Shadow Read | 同A0；Unified只讀shadow比較、標non-authoritative | 只有legacywriter | 影子資料不可給user saved ACK；差異report | sourcehash+legacyrevision為準；可丟shadow回A0 |
| A2 Migration Planning | 同A0；preview固定source snapshot+hash/vector | legacywrites可繼續，但每次提升mediator sourceEpoch | plan是只讀artifact；任何sourcewrite令舊plan失效 | sourceEpoch/hash為準；可取消回A0/A1 |
| A3 Prepared Unified State | legacy仍authority；normalreads仍走legacy | 所選cutoverclosure寫入閘門已關，所有writer（含legacytools）回MIGRATION_BUSY；drain pending IO/flush再seal | 寫immutable preparednewstate，不serve作authority、不雙write；sourcehashseal再驗 | prepared非commit；flags不能繞gate；未cutover可abort回A0/1 |
| A4 Unified Authority | committedroot為唯一authority；newread與可表示legacyadapterread | 所有工具經coordinator；legacyAPI保legacy/1授權與shape、unsupportedgraph拒 | legacyfiles保持sealed，不可新寫；Projection可關 | unifieddocrevision+compat sceneprojection；newflags off只關新增入口，不能還給legacywriter |
| A5 Unified with Legacy Projection | 同A4；legacyread仍由authoritative unifiedsnapshot投影，**不讀落盤projection當權威** | 同A4；projectionworker只寫獨立output tree | `legacy-projections/<root>/...`唯讀供匯出；failure只pendingdiagnostic可retry | projectionRevision/hash標來源root，不改docrev；不產雙writer |
| A6 Read-only Recovery | 最後checksumvalidroot；缺closure則受限read/error，不猜latest | 無normalcontentwriter；只有受管recovery維護（OS lock+explicit mode） | repair copiedfiles/indices，禁止繼續migration/autorefresh | RECOVERY_REQUIRED；新ACK禁；verifiedrestore後回紀錄的A4/A5，或owner明確回A7 |
| A7 Rollback / Export-required | 凍結當前unifiedroot，owner可read/export/backup | 禁contentwrites；只有export/checkpoint/validatedrollbacktransition | newwrites後不能直接換回oldfiles；需完整v2archive+verification+ownerresolution | 保原epoch與ledger；precutover沒有unifiedeffects才可回A0；有newdata按下文新volumecontract |

authorityscope為migrationclosure，不是整server可任意混用set。globalroot有每alias `{sourceStoreId,setKey,documentId,sourceSealHash,authorityEpoch,mode}`；一個closure若包含共享CAS/Workspace依賴則同transition，無法完整枚舉就拒commit，不能一半CAS指old一半指new。

A3 seal前另比較mediator的canonical in-memory state與fresh disk read；原saveCanvas會吞IOerror，不能以它的resolvedPromise當flush成功證據。兩者不同先停止cutover並保兩份diagnostic，需修復/明確保存後重新plan，不把未落盤的legacy編輯說成已被安全遷移。

## Transition Table / Commit Preconditions

| Transition | Required evidence / serialization | Crash recovery |
| --- | --- | --- |
| A0→A1→A2 | legacy所有writes已經mediator單queue；捕捉sourceEpoch/hash、scopeclosure、rawbackup | 不影響legacyauthority，丟partialshadow/plan即可 |
| A2→A3 | coordinator globalcutoverlock→關該scopewritegate→等待inflightlegacy/module/CASjobs結束或cancel→flushlegacyIO→重新讀hash/epoch；不符plan回STALE_PLAN | 若CURRENT無authoritychange，restart以intent辨識gate未commit，清prepared後解legacygate；不自動採prepared |
| A3→A4 | stagedstate/counts/fieldhash/refs/schema/durablebackup完成，OS fencing成立；expectedsourcehash=actual，publish同root的docheads+aliasauthority+ledger+cutoverrecord | pointer未durable時old或new；依CURRENT authorityepoch唯一選path，不能觀察哪個檔較新 |
| A4↔A5 | root記projectionenabled/pendingSourceRoot；不改writerauthority | CURRENT已new但projection缺失則在A4/5重建output，不回legacy讀 |
| A4/5→A6 | hash mismatch、fsync uncertain、lock/locatorcorrupt、sourceSeal/alias不一致 | readonly，以最後validroot+ledger查核，不給projection權威 |
| A4/5→A7 | ownerexplicit，關writegate/drain、pin完整當前root/ledger+beforecutovercheckpoint | 重啟仍A7不能因flagfalse放legacywriter |
| A7→A0 | **僅**證明沒有任何postcutover/newdocumenteffects（含ACKlostledger）、舊source seal吻合、deploymentfence調整；保永久ledger/epoch在mediator | transitiondurable後才允legacywriter；重新cutover仍用原registryIDs/ledger，不能forgetkeys |
| A7→恢復A4/5 | 完整export/backup已驗，但owner選保unified；或修復完成重驗 | sameunifiedauthority，不用oldbinary寫newvolume |

有新Unifiedwrites的downgrade：只能輸出lossless legacy可表示資料到**新volume**，保完整v2backup/ledger/checkpoints與無法表示Graph/Embed/history；owner明確選哪些資料只保v2後才能切舊binary到新legacyvolume。這是另存舊版workflow，不宣稱無損原位rollback；原unifiedvolume保持A7readonly。普通legacyprojection不是rollbackvalidation或user資料完整備份。

## Legacy Writes / Feature Flags / Recovery Cases

- Preview同時legacywrite：sourceEpoch/hash改，plan保留可看但commit STALE_PLAN；不能用僅sceneRevision（不含marks）判斷。
- Cutover期間legacytool：A3已關writegate，queuedrequests回MIGRATION_BUSY、retryable=true但必須samekey，無newID自動retry；到A4同oldtool經adapter寫unified；不存在落舊檔的race。
- 發起前已在跑的asyncjob：先drain/cancel；切換後latecallback持舊authorityepoch拒STALE_AUTHORITY，不套到新doc；新route重新授權/重讀才可重算。
- newDoc建立後關flag：拒更多create/新UI功能；docread/export與必要safeedit/recovery仍依authority狀態，不能刪doc/跳回oldsource；不存在legacyalias的Graph不捏造imageId。
- projectionfail或CURRENT已提交尚未projection：記projectionPending/error，不回滾已ACKunifiedcommit；legacyread動態投影currentroot。projectiontree不能回到originalcanvaspath。
- sourcehash/alias不一致：A0–3→planinvalid/abort；A4–5 sealedsource發現externalmutation→A6並報EXTERNAL_LEGACY_WRITE，保兩者raw供review，不能lastwriterwins或覆寫unifieddoc。
- flags只是route/UI enablement，startup從durableauthoritymanifest決定writer；flag組合若要求legacywriter但root=A4/A5/A7，拒config，不觸發隱式transition。

## Old Binary Fencing — 不假裝 Marker 能限制舊程式

原0.20.0不認CURRENT/authoritymarker，也不取得新writerlock；**單靠新lockfile、schemaVersion或featureflag無法阻止它寫舊canvas.json**。因此cutover前強制deploymentfence：

1. 新supervisor持OS exclusive storagelease，讀 `storage-format.json {minWriterProtocol:1,storeInstanceId,authorityEpoch}`；binary需宣告/驗證writerprotocol，未知舊binary在writableunifiedvolume前由launcher拒啟。marker本身不是舊程式自我保護。
2. legacy originals先完整備份與hashseal，切unified時newprocess只透過**read-only mount**見legacy source snapshot，unified managed tree由獨立writablemount。舊binary若需啟動只能給readonlysnapshot或經explicitdowngrade的新legacyvolume，永遠不掛activeunifiedwritablevolume。Docker非root、cap_drop/read-onlybindmount由部署強制；native模式需等價mountnamespace/OS權限隔離與受管launcher。
3. 驗收直接啟動原baselinebinary繞過protocolmarker對readonlymount嘗試寫：底層EROFS/EACCES，hash無變；受管launcher則startup拒絕。既有saveCanvas可能吞IOerror，所以不能宣稱原binary會回新版typederror；證明的是**no disk mutation**。root/operator任意重掛writable屬破壞部署前提，不能由本設計防禦。
4. 無法建立fence（例如同user任意直跑舊binary共享可寫root）的環境，**拒絕A3→A4 durablecutover**，維持shadow或readonly。這是正式deploymentconstraint，PR-1B與PR-7A必須測，不能留給實作者「小心不要跑」。

## Safety Invariants / Recovery Algorithm

AUTH-1：每alias/closure恰一個authorityepoch writer；AUTH-2：legacyprojection永非readerfallbackauthority；AUTH-3：cutoverroot同commit含aliases、docheads、seal、ledger、mode；AUTH-4：featureflag無transition權；AUTH-5：postwrite退回需v2保全、原volumereadonly；AUTH-6：oldbinary靠OS/launcherfence，不靠認marker假設。

Restart：先storagelease/protocol/mountfence驗證→validateCURRENT+checksum/locator/ledger→讀每closuremode→對未commitcutoverintent保持legacysourceauthority並rollbackprepared；已commit則重建readadapter/deriveprojectionpending、拒所有舊epochjobs→檢seal與aliases→缺證據進A6→按STORAGE-LIFECYCLE完成GC/journalrecovery→只開mode允許的routes。不得在projection故障、flag關閉或newUImount失敗時把舊檔當current。UVA-56–58/62逐情境故障注入、oldbinaryreadonlytest與postwriteexport驗證為exit。

## Phase 0.2 — Root / Platform / Epoch Clarifications

authority payload 是 STORAGE-LIFECYCLE 的同一 `CommitRoot.roots.authority`，registry aliases與sourceSeal、ledger、docheads只由該CommitRoot一起可見。`storage-format.json`是launcher的相容性檢查／保守拒啟提示，不是第二authority；其epoch落後／不符 CURRENT 時只進readonly驗證，不按marker切writer。migration preview也不可只讀marker當root版本。

每個closure的authorityEpoch為正safeinteger，A3→A4、A7→A0及任何重開已凍結writer的A6/A7→A4/A5都提升；A4↔A5僅projection政策不改writer epoch。所有內容命令／asyncattempt在admission捕捉epoch，publish前再比；入列時通過不代表之後通過。late callback、已排隊的legacywrite都不能越過已提升的epoch；A3→A4 gate/drain/原子publish仍不可省略。restart先驗root+fence，再建立新的runtime execution lease，不接舊worker輸出。

已存在0.20.0 Docker `/data` writable volume不提供上述fence；Docker root `read_only`只保護container根檔案系統。平台可執行不代表允許cutover。Desktop/macOS與未知mount依 STORAGE-LIFECYCLE 平台矩陣預設拒V1 durablewriter；native Linux若沒有可測RO source隔離也停A1/A2，不能用 advisory lock對舊binary的不存在配合來過gate。實際部署wrapper/mount變更留PR-1B，這輪不改Docker/Compose。
