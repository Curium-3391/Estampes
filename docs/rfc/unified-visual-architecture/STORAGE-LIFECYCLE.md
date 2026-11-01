# Internal Generation Retention / GC / Compaction / Durability

Status：PROPOSED；R-03、OD-01、ADR-010。CURRENT 只有各檔案 atomic rename，沒有此維護系統；不在本輪實作。此規格區分「可重建的內部實體檔案」與「使用者邏輯內容/歷史」，後者禁止自動刪除。UVA-46–50/59–60 是正式實作門檻。

## Retention Roots / Reachability

每個 logical version=(storeInstanceId, entityId, revision, contentHash)可由 standalone full generation 或 verified checkpoint+delta/history pack重建。physical locator index 是可替換的存放位置，不改 logical revision/hash。Content History Archive 為正式 durable store，保存每個已提交內容改變的完整前後可還原資料與 provenance/evidence/intent；最近60個 commands只限制快速 Undo，不授權刪更早歷史。alias/authority/ledger等 internal metadata用各自保留規則，不必保永久完整registry snapshot。

| Generation class | Root / lifetime | 可回收條件 |
| --- | --- | --- |
| Current | CURRENT checksum envelope指向的完整 registry closure、現存/archived docs 的最新內容 | 永不可刪唯一 representation；archive document仍為 root |
| Recovery | 最近兩個已完成 durable publish 的 registry roots與其closure，且不短於24小時 | 同時超過2代與24h，且不在其他root；不足2代全保留；不靠任意「latest file」猜回退 |
| Active reader pins | server openSnapshot在commitlock下登記generation+refs，直到release；備份/export獨立pin | reader仍活著就不可刪；無逾時直接回收活reader。client paging token會以租期renew，10分鐘未renew且已關閉serverread可expire，回STALE_CURSOR |
| Referenced | Snapshot binding、historical evidence需可解析version、undo token、canonical history archive及資產 | 必須有另一已驗證representation或explicit lifecycle解除ref；provenance-onlyhash不保physical原檔，但保logicalhistory |
| Transaction dependency | prepared/publishing或outcome尚未durable的before/after roots、request結果依賴 | transaction terminal+compacted ledger/history接管之後才可解除 |
| Rollback checkpoint | owner建立的named checkpoint、cutover before/after root、未結案rollback/export | owner明確解除checkpoint；不自動expire；包含source raw與aliasauthority |
| Archived generation | user archive/history包、migration raw/backups與explicit保留版本 | 不因internal GC刪document/history；duplicatephysical可驗證重建後移除 |
| Unreachable | 不屬以上root、失敗staging、已替換且verified的duplicatefullsnapshot | 經本輪mark與publish前再驗，才進GC quarantine |

不是每個 commit.parent 都形成永久 physical ancestry root：commit record保存parent hash作audit；recovery從durable CURRENT、bounded recovery roots、compact commit index和未終結intent判斷，不能遞迴pin全部祖先。logical user history另由checkpoint/delta archive保留，不依永久保留每個全量generation。

兩層索引固定：RegistryRoot的entity reference是logical `(id,revision,contentHash)`；LocatorRoot把logicalhash對應到fullfile或verifiedpack+offset。保留Recovery/Referenced root表示**保留可重建邏輯版本**，不是強迫24小時內每個full副本留存；compaction可原子更換LocatorRoot，同logicalhash不變。開啟reader時pin `(RegistryRoot,LocatorRoot)` 及實際file descriptors，活reader的舊locator不能被換掉後刪檔；恢復checkpoint可搭目前已驗證包含該logicalclosure的新locator，不需pin所有歷史locator。每次GC mark依root種類選用對應locator；若無可重建representation則阻擋回收。這使24h recovery與losslesshistory不退化為24h*N*S完整副本。新reader pin預設上限64 sessions、pin physical bytes budget1GiB（可設定），超出只拒新pin，不過期／刪除仍活reader。

## Storage Growth / Quota / Backpressure

設 current全量大小 S、每command新增與變更資料 Δ、每秒commands r、interval t、command數 N、recentfull數 K、pinnedfull數 P、asset總量 A、ledger每項上限 L：

```text
naive immutable growth ≈ A + N*S                     # 禁止無界保留這種副本
compacted physical ≈ A + (K+P)*S + ΣΔ + checkpoints + N*L + index/journal overhead
peak preparation ≥ current + staged-full + historydelta + two registry roots + GC replacement
```

Δ包含被改/刪的舊geometry/evidence及新值，不能只記ID而不可復原。每次拖曳抬筆一command，pointermove不寫generation；同gesture stroke coalesce不得跨已ACK command合併消除歷史。5000×128points的doc若每次存full，10000commands就是10000*S；compaction後接近10000*strokeDelta，但若每次重寫全doc幾何則Δ≈S，**不可無損消除這種真實歷史成長**，應quota/backpressure而不是刪history。

Default proposed unified-managed disk quota Q=10GiB（可明確設定，既有source/import assets亦計實際被本volume管理的bytes）；不是聲稱所有使用者資料能裝入此值。reserve R=max(64MiB,1%Q)。每寫入preflight計B=stagedpayload+historydelta+registry/indexreplacements+ledgerresult+worstjournal，在commit之前需volume available≥B+R，且managedUsed+B≤Q；reservations在globalwriter下分配，並行tx不能重複預訂free bytes。保留recoveryreserve供寫小型outcome/root，正常edit不可用。現有volume超Q時readonly/export或明確擴quota，不自動清資料。

新Document serialized上限64MiB，單registry/indexpage<=4MiB（字節，非JS字元）；總doccaps不替代byteslimit，超大legacy保完整read-only/export，透過明確split/detach plan減量。Root manifest只列固定分區map roots、authority epoch、root hashes、ledgerroot/retentionroot，<=64KiB；entity/alias/binding/ledger索引使用256個hashprefix桶、必要時分頁、單page4MiB，copy-on-write只改觸及pages。禁止每command複製一份包含全部documents和ledger的巨大manifest。checkpoint每doc累計1000 commands或delta32MiB就建立完整checkpoint，先達者觸發；舊history lossless分pack保留，pack<=32MiB，不減邏輯版本。完整checkpoint可用<=64MiB standalone generation；單一delta超32MiB時分immutable chunks，由locator的有序chunklist與整體logicalhash驗證，全部flush後才能publish，不能為符合pack上限截資料。

維護觸發：每100 content commits，或nonpinned fullsnapshot duplicate bytes≥256MiB，或managedUsed≥80%Q；取最早。GC/compaction共享writer協調、可yield，單批最多128檔/32MiB新增工作；禁止在quota壓力下忽略pins/history。活reader導致保留過多時限制**新**read pins並提示release/export，不能刪現有reader所需版本。

ENOSPC/preflight失敗：prepared前abort、無ACK、原CURRENT保留；fsync/rename後不確定則readonly RECOVERY_REQUIRED並由recovery辨認，不回「未儲存可任意重送新ID」。recovery磁碟滿時，只可清已durably標示unreachable的staging/quarantine，不能靠刪最新generation/ledger解圍；若reserve也不足則只讀現有root、回diskspace要求，不發durableACK。

## Idempotency / Journal Compaction

requestId=req:UUIDv4→commandId=cmd:同UUID；ledger key=(storeInstanceId,authenticated principal stable identity,commandId)，含canonical payload hash（route、target與revision參數皆包含）、commitId、firstAcceptedAt、fullAck、expiry。**完整重取 ACK window為成功提交後7天**；client重送不得延長firstAcceptedAt，未來時間/系統時鐘倒退不得縮短保留（monotonic observed high-water與保守retain）。正常 retry window內必回同ACK，不重新apply；相同key不同hash永遠 IDEMPOTENCY_MISMATCH。

7天後 fullAck可壓縮，但永久保留 compact tombstone `{key,payloadHash,commitId,resultHash,acceptedAt}`，每項canonical JSON設計上限<=1KiB（key內principal identity以固定長度digest保存，不反覆嵌入完整descriptor）；舊key相同hash回 RETRY_WINDOW_EXPIRED（可查commit，不重新apply），不同hash仍拒。永久tombstone是避免「忘了就重新執行」的安全成本，N*1KiB需納quota；不能以GC/restore/旗標關閉重設storeInstanceId來逃避。owner明確銷毀整個store是另一路徑，非InternalGC。fullAck含mutablecontent時以小結果/Refs返回，單項<=64KiB，超量結果改downloadhandle+hash；7天內其response artifacts同樣pin。

Intent/prepared保留到transaction terminal、outcome与ledger/history已durable且至少24h；age不能終結不明transaction。aborted intent也保24h後可compaction；committed outcome保7天fullrecord後可納永久compactcommitindex（id/root/result hashes、不需完整preparedbody）。Unknown/prepared的判斷取CURRENT的commit membership index，不靠檔案mtime。idempotency與content提交同一root，不存在效果已ACK但ledger未同步。

Compaction演算法：固定sourceRoot並pin→建立新history/ledger/indexpacks→逐logicalversion重建hash/精確ledger鍵數比對→fsync全部file+dir→writerlock下確認sourceindex仍可用，以新root commit publishlocator替代→保舊files於recovery/pin期間→GC。新content可提交但publisher需rebase root指標、不覆蓋並行entities；驗證受影響pages改變則重試compaction。crash在publish前只留下orphanpack；後只使用newroot；從不先刪oldpack。backup在writerlock取snapshot root+pin，再copyclosure/hashes与fullledger/authority/retentionrecords，寫完整backupmanifest後unpin；restore必新volume，root/ledger相同namespace才提供7天retry承諾。

## GC Algorithm / Crash During GC

1. writerlock取rootEpoch，列上方全部roots/activepins/prepared/checkpoints，建立GC plan（store id、epoch、livephysicalhashset、candidatepaths/hash、rootsethash）；安全路徑只managedimmutablefolders，不得列legacy originals/migrationraw/history唯一副本/userarchive。
2. mark逐closure與locator resolver驗hash，任何unknownref/indexcorrupt→停止GC、readonlyrepair，不當垃圾。新增reader pin需同writer協調；讀取selectedoldroot時必已pin，不能先lookup再pin。
3. 對candidate在rename前取得maintenance lock重讀rootEpoch/pins/prepared；有變化就重新mark，不以「之前沒引用」刪。durable寫GC plan與quarantineindex，將candidate rename至同filesystem gc-quarantine/<gcId>/，fsync兩側dirs；讀root不能引用quarantine。批次間writer正常提交前需遵守quarantineindex，不重新採用candidate而不restore。
4. grace至少24h，且再驗新roots無引用、文件hash符合plan、所有replacementpacks仍可重建，才unlink。每批fsync dir，寫progress/outcome，可重啟重做unlink（ENOENT視已做）。GC plan不可當根目錄任意path刪除列表執行。
5. crash後reader/recovery先驗CURRENT closure；若hash檔被quarantine且CURRENT需要，依GCmanifest/hash restore後fsync，零丟資料；其餘quarantine保留至重新mark/grace成立。partialunlink已不可影響任何root或logicalhistory，否則gate失敗，停止維護。

## Filesystem Contract / Durable ACK

| Environment | 支援條件 / failure behavior |
| --- | --- |
| Linux local ext4/XFS | 硬體/OS honoring flush、同filesystem staging/rename、regular file fsync、directory fsync、O_EXCL/OS advisory exclusive lock有效；啟動probe與faultrehearsal必須記錄。probe不證明硬碟真的抗斷電，durability屬指定deployment前提 |
| Docker bind mount / named volume | 只有backing mount滿足上述local條件才可durable，不能只因Docker就宣稱；volume/driver/mounttype與hostfs記health/evidence |
| NFS/SMB/FUSE/unknown driver / no directory fsync / rename跨device | 預設拒開durablewriter，RECOVERY_REQUIRED/UNSUPPORTED_STORAGE；可explicit readonly或另建memory session，但memory ACK必標durability=memory，不能接續原durablestore寫入 |
| second writer | OS exclusive lock由supervisor/runtime持有整個session，含GC/recovery；第二writer在任何mutation前拒啟。PIDfile/mtime不算鎖，crash由OS釋放；marker/lock不能限制舊binary，另見AUTHORITY-CUTOVER |

Linux實作路徑固定由受管supervisor採util-linux `flock` exclusive nonblocking lease（例如no-fork/exec模式，lock descriptor伴隨主writer存活）；productionPR需驗證exec/childfd處理與supervisor異常不會留下無鎖writer，缺flock/等價OS鎖則拒durablewriter。此為部署依賴，不在本輪安裝或改Docker；PR-1C/1B建立可重現wrapper/fence測試，不能以自行解析PIDfile替代。

提交順序凍結：writeintent→filefsync→intentdirfsync；staged內容/ledger/history/indices→每檔fsync+rename+dirfsync；preparedroot→同樣flush；CURRENT envelope `{generation,rootHash,commitId,checksum}` tmp fsync→atomicrename→**CURRENT父目錄fsync**→publish memory/ACK。rename是logicalvisibility點、parentdirfsync完成才durabilitybarrier；兩者間崩潰可以看到old或new，但任何ACK之前成功的commits必須存在。fsync失敗/不確定不得發durableACK。

CURRENT只有一個權威，不在powerloss後猜最大filename。若 envelope/hash closure損毀→readonlyrecovery，從durable recovery record或verifiedbackup還原需owner審查；不可靜默回退丟已ACK資料。processkill能測順序與replay，powerloss需要VM/blockdevicefault harness，兩者結果不能混稱。

## Deterministic Recovery / Fault Injection Table

Harness以fs-adapter stagehook＋childprocess IPC報「已到stage」後SIGKILL；restart同tempvolume，assert root、content+metadatahash、ledger effectcount。fsync/ENOSPC由bounded test filesystem或adapterinject；GC/compaction固定fixture與rootpins，虛擬clock推grace；powerloss另用可丟未flushblock的VM裝置。

| Kill / fault point | Recovery algorithm / expected result |
| --- | --- |
| before intent flush | CURRENT old，丟未durabletemp，不見效果，無ACK；retry可首次apply |
| after intent flush | 查commitindex無membership→abort/stagingcleanup，CURRENT old；retry相同key尚無committed效果 |
| during staged writes | verify所有stagedhash，缺檔不publish；oldroot完整；不得當prepared |
| after prepared manifest / before CURRENT rename | prepared不是commit；無membership即abort或保留await explicitretry；不自動套原operation第二次 |
| after CURRENT rename / before directoryfsync | 無ACK；restart只採checksumvalid old/newroot；newroot有ledger則return原effect，oldroot才重試；powerloss可丟未flushnewroot |
| after durabilitybarrier / before ACK | newroot+ledger完整；同key重取ACK，effectcount=1 |
| during GC rename/unlink | replayquarantineplan，先restore仍被root引用的hash；只刪重新mark證明unreachable者 |
| during compaction | old或newlocatorroot，全部logicalversionhash/ledgercount相同；不能失7天ACK或永久tombstone |
| disk full during generation write | abort前commit無效，原CURRENT不變；保quotareserve與userdraft；不fakeACK |
| disk full during recovery | readonly優先；只清durable證明unreachable檔，無法恢復則要求空間/backup，不刪roots |
| second writer startup | 在讀寫journal/GC前exclusive acquisition失敗；第一writer內容/lock無變 |

Implementation：PR-1C只交durablecommit/recovery核心；PR-1D另交retention/pins/GC/compaction/capacity（在PR-1B writablecutover之前必過），PR-7A加真filesystem/powerloss/capacity演練。未實作維護時只能temp/readonlyshadow，不能開無界fullgenerationproductionwriter。
