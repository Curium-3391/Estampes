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

Intent/prepared保留到transaction terminal、outcome与ledger/history已durable且至少24h；age不能終結不明transaction。aborted intent也保24h後可compaction；committed outcome保7天fullrecord後可納永久compactcommitindex（commitId/generation/registryRootHash/resultHash，不存自指的CommitRootHash、不需完整preparedbody）。Unknown/prepared的判斷取CURRENT的commit membership index，不靠檔案mtime。idempotency與content提交同一root，不存在效果已ACK但ledger未同步。

Compaction演算法：固定sourceRoot並pin→建立新history/ledger/indexpacks→逐logicalversion重建hash/精確ledger鍵數比對→fsync全部file+dir→writerlock下確認sourceindex仍可用，以新root commit publishlocator替代→保舊files於recovery/pin期間→GC。新content可提交但publisher需rebase root指標、不覆蓋並行entities；驗證受影響pages改變則重試compaction。crash在publish前只留下orphanpack；後只使用newroot；從不先刪oldpack。backup在writerlock取snapshot root+pin，再copyclosure/hashes与fullledger/authority/retentionrecords，寫完整backupmanifest後unpin；restore必新volume，root/ledger相同namespace且完整時，7天retry承諾只涵蓋該backup root已納入的commands。不能宣稱可回覆backup之後未保存的ACK；若不能證明無post-backup已ACK效果、或補齊所有ledger/history tail並fence原writer，restore維持A6 readonly，不透明地接續舊command lane寫入。owner可明確另走新store的普通import（新refs/namespace/endpoint，不繼承舊session/retry保證），但不能當作無損continuation／用重設namespace逃過原volume的永久ledger；原volume與已知新資料仍保全。

## GC Algorithm / Crash During GC

1. writerlock取rootEpoch，列上方全部roots/activepins/prepared/checkpoints，建立GC plan（store id、epoch、livephysicalhashset、candidatepaths/hash、rootsethash）；安全路徑只managedimmutablefolders，不得列legacy originals/migrationraw/history唯一副本/userarchive。
2. mark逐closure與locator resolver驗hash，任何unknownref/indexcorrupt→停止GC、readonlyrepair，不當垃圾。新增reader pin需同writer協調；讀取selectedoldroot時必已pin，不能先lookup再pin。
3. 對candidate在rename前取得maintenance lock重讀rootEpoch/pins/prepared；有變化就重新mark，不以「之前沒引用」刪。durable寫GC plan與quarantineindex，將candidate rename至同filesystem gc-quarantine/<gcId>/，fsync兩側dirs；讀root不能引用quarantine。批次間writer正常提交前需遵守quarantineindex，不重新採用candidate而不restore。
4. 依下節 G1/G2 分類決定 unlink 時機；不得對已可重建的完整副本一律套24h grace。兩類都必須再驗新roots無實體引用、文件hash符合plan、所有replacementpacks仍可重建，才unlink。每批fsync dir，寫progress/outcome，可重啟重做unlink（ENOENT視已做）。GC plan不可當根目錄任意path刪除列表執行。
5. crash後reader/recovery先驗CURRENT closure；若hash檔被quarantine且CURRENT需要，依GCmanifest/hash restore後fsync；其餘quarantine重新分類、mark及完成相應grace。partialunlink已不可影響任何root或logicalhistory，否則gate失敗，停止維護。這是待故障測試證明的不變條件，並非已有「零丟資料」實測。

## Filesystem Contract / Durable ACK

| Environment | 支援條件 / failure behavior |
| --- | --- |
| Linux local ext4/XFS | 硬體/OS honoring flush、同filesystem staging/rename、regular file fsync、directory fsync、OS advisory exclusive lock有效；啟動probe與faultrehearsal必須記錄。probe不證明硬碟真的抗斷電，durability屬指定deployment前提 |
| Docker Engine on Linux bind mount / local named volume | 只有backing mount滿足上述local條件才可durable，不能只因Docker就宣稱；volume/driver/mounttype與hostfs記health/evidence |
| NFS/SMB/FUSE/unknown driver / no directory fsync / rename跨device | 預設拒開durablewriter，RECOVERY_REQUIRED/UNSUPPORTED_STORAGE；可explicit readonly或另建memory session，但memory ACK必標durability=memory，不能接續原durablestore寫入 |
| second writer | OS exclusive lock由supervisor/runtime持有整個session，含GC/recovery；第二writer在任何mutation前拒啟。PIDfile/mtime不算鎖，crash由OS釋放；marker/lock不能限制舊binary，另見AUTHORITY-CUTOVER |

Linux實作路徑固定由受管supervisor採util-linux `flock` exclusive nonblocking lease（例如no-fork/exec模式，lock descriptor伴隨主writer存活）；productionPR需驗證exec/childfd處理與supervisor異常不會留下無鎖writer，缺flock/等價OS鎖則拒durablewriter。此為部署依賴，不在本輪安裝或改Docker；PR-1C/1B建立可重現wrapper/fence測試，不能以自行解析PIDfile替代。

提交順序凍結：writeintent→filefsync→intentdirfsync；staged內容/ledger/history/indices→每檔fsync+rename+dirfsync；preparedroot→同樣flush；CURRENT envelope `{generation,rootHash,commitId,checksum}` tmp fsync→atomicrename→**CURRENT父目錄fsync**→publish memory/ACK。CURRENT.checksum為SHA256(canonicalJSON({generation,rootHash,commitId}))，不包含checksum自身；三欄必與referenced CommitRoot相等。rename是logicalvisibility點、parentdirfsync完成才durabilitybarrier；兩者間崩潰可以看到old或new，但任何ACK之前成功的commits必須存在。fsync失敗/不確定不得發durableACK。

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

## Phase 0.2 — Coherent CommitRoot / Reclamation Classes

本節修正 Phase0.1 的 Registry/Locator 原子性缺漏與 blanket 24h quarantine 矛盾（FG-01/02，見 FINAL-ARCHITECTURE-GATE）。以下為正式推薦契約；不是已實作儲存引擎。

**單一 CommitRoot**：`CURRENT.json` 的 rootHash 只指向一份 immutable `estampes.commit-root/1`。其 required fields 是 `schema, storeInstanceId, generation, commitId, parentCommitHash, roots`；storeInstanceId 為 raw UUIDv4，generation 為正 safe integer，commitId 為 tx:UUIDv4，parentCommitHash 為 SHA256 或初代 null。roots 必須且只能含 `registry, locator, ledger, commitIndex, retention, authority` 六個 SHA256 page-root；所有 root/page bytes 用 CONTRACTS 的 canonical JSON/hash 規則。Registry 含 entities/aliases/bindings；Locator 含 logical→physical mapping；ledger 含 ACK/tombstones；commitIndex 含 membership/outcome；retention 含 recovery/checkpoint/job logical pins。**沒有第二個 Locator CURRENT**；不得先發布 registry 再發布 locator。root <=64KiB 與 page <=4MiB 約束不變。

CommitRoot的hash依賴必為DAG：current commitIndex entry固定 `{commitId,generation,registryRootHash,requestKeyDigest,payloadHash,resultHash,outcome:'committed'}`；requestKeyDigest為外部key的64hex digest，maintenance commit無外部key時為null。**不得**在此entry或其fullACK/retention子頁填本次CommitRootHash，否則root包含index而index又包含root，無法產生content hash。V1 fullACK只有commitId/resultId/revisionvector與結果，不包含其外層CommitRootHash。computed CommitRootHash只放CURRENT envelope及不被該root反向引用的prepared/outcome envelope；歷史rootHash可在後續commit作audit，但不作永久physical ancestry pin。RecoveryResolver固定 `{registryRootHash,logicalClosureHash,resolverLocatorRootHash}`，不是本次self-referential resolverCommitHash；所有component先hash/flush再hash CommitRoot，最後發布CURRENT。

Reader 在 publish lock 下取同一 CommitRoot 的 registry/locator/authority/grant snapshot 並登記 physical pin；禁止各自讀「最新」索引。Maintenance 也以新 generation 提交同一 root（不改 Document revision），校驗 logical closure、所有 protected history 與 ledger key/hash/cardinality後才 publish。rebase 只合併未變的 touched pages：compare base generation + 每個 touched page hash；改動則重新計算，不覆蓋並行寫入。任何 commitIndex/ledger/root 分裂或 missing locator coverage 都進 A6，禁止刪檔／發 durable ACK。

Recovery catalog 對每個保留 registry root 記 logicalClosureHash 與 resolverLocatorRootHash；更換 locator 時必須在**同一 CommitRoot** 更新所有受影響 catalog entries，證明新 locator 覆蓋原 logical versions。舊 CommitRoot 的 hash 是 audit 證據，不隱含永久 pin 舊 locator 的所有完整檔案；仍活的 reader/backup 明確 pin 舊 resolver，則絕不可提早回收。恢復舊 logical root 需用經驗證的 resolver pair，不把兩個任意 generation 拼在一起；不能據此自動回退已 ACK 的內容。

| GC class | Required proof / minimum wait | Recovery / prohibition |
| --- | --- | --- |
| G1 verified redundant representation | Replacement packs/locator/retention coverage 已由 durable CommitRoot 發布；所有保護版本逐 hash 可還原；無 physical pin/prepared dependency；GC plan/index已 flush；第二次 mark 在 writer lock 下核對 epoch。滿足後可完成 quarantine→unlink，**不強制等待24h** | 每個被刪 logical hash 仍可解析；crash 時從 committed root + GC plan續做；plan 未發布或 coverage 失敗不可刪。G1不是刪除使用者 history |
| G2 aborted/orphan staging | 先證明 transaction terminal 或未提交、無 root/pin/ledger artifact 引用，durable quarantine plan 起至少24h，再二次 mark | 未決 prepared/intents 不因 age 轉垃圾；未知 hash/ref 停止維護。失敗或不確定的 G1 不能以 G2 年齡條件跳過重建證明 |
| Protected logical content | Current/archive/history/source raw、named checkpoint、有效 ACK artifacts、prepared dependency、活 reader | **沒有自動刪除年齡**。可更換已驗 representation；不可用 G1/G2 刪唯一內容或追溯紀錄 |

若仍用24h保留每次 S=64MiB 的完整副本，10000 commands/day 為625GiB/day；這與10GiB quota不相容。G1消除此不必要副本，不消除真正 history、ledger 或 checkpoints 的成長。UVA-63/64驗收兩者。

## Phase 0.2 — Maintenance Admission / Jobs / Capacity Calibration

所有數字為 **proposed initial controls**，尚無新引擎實測，不是 capacity SLA。1000 commands/32MiB checkpoints、100 commits/256MiB/80% triggers 只決定「何時開始」，不保證 backlog 能追上 writes。PR-1D 必須測量 compaction drain rate、checkpoint 實際 bytes、retention 高水位與 commit latency，再由維護者核准 profile；未量測不得開 writable cutover。

- Trigger 後建立 durable maintenance work item，作業分段 <=32MiB 或128files，完整64MiB checkpoint 可跨多個 batch 建立，全部驗證/flush才 publish。每個 commit admission 都比較 `managedUsed + outstanding reservations + worst-next-write + worst-maintenance-replacement + R <= Q` 與實際 volume free bytes，不能只在每100次寫入時檢查。checkpoint/GC plan/index/outcome 也計 quota。
- 超過80%Q優先排 maintenance；若 maintenance 嘗試兩次因 touched pages 改變而失敗，關閉**新 content commit admission**，drain 已預訂的 command，在 writer 序列化區完成一個有界 replacement publish/GC batch，再重新 preflight。不是回 CONFLICT 後自動重套幾何。等待中的 user drafts 不丟；無法保留足夠 workspace 則回 STORAGE_UNAVAILABLE、保原 CURRENT，不以 pause 為由強制終止 pin。
- Job 的輸入 logical refs/revisions、grant/authority epoch、deadline 登記在 retention；由 source snapshot materialize immutable bounded inputs 後釋放 physical read pin，不把運算全程當 active reader。沿現行 limits：預設10分鐘，manifest jobMs 1000..1800000；backup/export預設30分鐘需明確 renew。deadline 觸發 cancellation，**等 reader/worker quiescent、關 FD 才 release physical pin**；卡住則隔離/終止受管 worker、等待 OS 關 FD，期間拒新 pins/writes，不回收活 reader。作業終結並記錄 outcome後解除 logical pin；新 late output 必驗 epoch/grant/OCC，不能重新取得已撤銷 grant。
- 64 pin sessions/1GiB budget 計**不同 physical hash 的 bytes union**，共享同檔不重複計數；logical pins 不冒充 physical memory usage。分塊 export/backup 每次最多4MiB read buffer並持有整個 closure root及對應resolver pin；buffer小不減少被保護的 physical bytes。closure超過1GiB時需owner先明確調高pin budget或離線備份演練，不能假稱預設支援任意大小online backup；超過 pin budget 拒新任務，不「先准後刪」。不明確聲稱64 sessions皆可 pin64MiB不同版本；此組合已超1GiB。
- 7天 ACK最多64KiB/command **另加 artifacts**，永久 tombstone<=1KiB是上界而非預期平均值；artifact bytes 不在64KiB ACK內也須計 quota/pin。checkpoint模型須包含 full checkpoint amplification，不能從 ΣΔ 推斷儲存只線性於 stroke bytes。1000commands/32MiB觸發的 operational checkpoint只有在所有其logical版本已被另一verified archive chain涵蓋、無physical pin/prepared dependency時才可依G1移除。archive chain保留base + ordered lossless forward deltas，預設每累積32MiB delta再保一個archive anchor checkpoint（另計S bytes）；每個logical version仍有明確hash→chain定位。candidate archive/operational checkpoint thinning必先逐版本重建hash證明，不准按age刪。這將64MiB文件的archive anchor額外成本約束在 `ceil(totalDelta/32MiB)*S`，不再永久每1000筆保一份S；邊界／chunk／index成本另計，並非總空間上界。PR-1D benchmark與recovery oracle不過就維持readonly，不能以不實施thinning仍宣稱符合growth gate。
- 同 volume backup 會暫時需要其完整 closure bytes，必與 pending writes 共用 reservation；空間不夠預設拒，建議 owner 指定外部 destination。外部 destination 需自己的 free-space/hash/flush/completion 校驗；源 pin 到 backup completion或 cancellation quiescence 才解除。未完成 backup 不算有效 recovery point。

24h recovery logical roots也會保護 immutable registry/index pages；4MiB是單page上界，不是每command的成本承諾。即使Document副本已G1回收，root/page churn仍可達 `commandsInRecoveryWindow * changedPageBytes`，必單獨量測及納quota/reservations；不假定已被stroke delta壓縮。這些root/page的24h規則仍保留，沒有默默縮短Recoverywindow；不能支撐的profile需拒新write/不啟cutover，由maintainer另審page-layout或retention變更。不得為通過capacity benchmark漏計metadata或改userhistory。

UVA-64/65 固定 1k/10k/100k commands/day、1/16 active readers、64MiB大文件、2KiB與64MiB兩種 delta、0/64KiB ACK、backup併發、clock/ENOSPC/重啟，分別記 logical bytes、physical bytes、duplicate backlog、ledger/ACK/checkpoints、pins、quota拒寫點、維護吞吐。保留 hash/歷史/效果一次是硬門檻；調整 quota/threshold 只能由記錄過的 measured profile，不能為綠燈刪 history 或 ledger。解析容量數字見 FINAL-ARCHITECTURE-GATE 的 E，算術不算實測。

## Phase 0.2 — Platform Support / Durability Evidence

平台 profile 為 server deployment 屬性，**不可由 request 的 durability 欄位自行提升**。V1 Linux writer backend 預設拒 unknown profile；支援資格需 (1) documented primitive semantics，(2) exact mount 上 capability probe，(3) 相依階段 fault evidence；缺一不得標 validated durable。PR-1C 可於 disposable volume 驗 backend，不代表 user-volume cutover 已批准。

| Platform / storage | V1 policy | Lock / rename / flush / fencing requirements | Evidence boundary |
| --- | --- | --- | --- |
| Native Linux ext4/XFS local block device | Conditional candidate | util-linux flock session lease；same-fs rename；file+directory fsync；managed mount namespace/RO source isolation 才可 cutover | 記 kernel/fs/options/device/cache；probe+SIGKILL不證斷電，PR-7A 需 block/VM unflushed-write fault證據與硬體 flush 前提 |
| Docker Engine on Linux, local named volume | Conditional candidate；不含 remote volume drivers | 上述語義在 daemon backing FS，lock從container測；新 writable managed volume與 sealed RO source分離；old binary直接寫RO失敗 | Docker volume local 名稱不證 backing FS，需 daemon mount/driver資料、container crash+restart與外層 fault證據 |
| Docker Engine on Linux, bind mount | Conditional candidate | exact host mount必須在 allowlisted local FS；全部 staged/CURRENT/GC同 filesystem；RO original bind +分開新tree | writable bind預設可改host檔；Compose root read_only不保護另掛的 /data writable volume |
| Docker Desktop macOS ARM64, named volume | Development / unvalidated candidate，**V1 user-volume durable cutover 預設拒絕** | Linux VM內可有Linux primitives，仍有 VM disk→macOS host flush 邊界；需 Desktop/version/backend與host/guest fault證據、RO source fence | ARM64 image可建置不是 durability 證據；container kill、VM reset、macOS power loss三者分開；未完成 profile approval不可發 durable ACK |
| Docker Desktop macOS, native bind share | Unsupported V1 durable writer | VirtioFS/gRPC-FUSE/其他sharing backend 不視為原生ext4；host-side lock/rename/flush與fence未證明 | 即使 probe 返回成功仍不在allowlist；explicit memory新session或readonly；升級支援需平台ADR/測試 |
| Native macOS/APFS | Unsupported V1 durable writer | Linux flock supervisor/mount fence不可直接移植；Darwin fsync與F_FULLFSYNC邊界及directory flush需另設backend與證據 | 不宣稱普通Node fsync已滿足 host power-loss；readonly/memory開發模式，日後獨立ADR |
| NFS/SMB/FUSE/remote drivers/unknown FS/cross-device staging | Unsupported V1 durable writer | 不退化成 PIDfile、rename+不flush、僅 marker fencing | UNSUPPORTED_STORAGE；既有 durable store 只能readonly/recovery，不默默memory ACK續寫 |

Capability probe 在**部署指定的空 temp path**檢查same device、rename可見性、file/dir fsync返回、第二process鎖失敗及 crash釋放；不修改使用者資料。本輪沒有執行該probe或任何新引擎fault test。已批准 profile在初始化/restore/mount變動後重驗；unknown/no directory fsync直接拒writer，不把「probe success」當host flush保證。Durable ACK只在validated profile + CommitRoot/file/dir barrier成功之後；不確定時回 RECOVERY_REQUIRED，保留 ledger查詢。
