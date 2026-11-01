# PR-1C — Isolated Persistence Implementation Report

Status：**IMPLEMENTATION BLOCKED — approved native filesystem validation unavailable**。CURRENT為本分支已實作的隔離引擎；OBSERVED為下列actual tests；未接入正式路徑。這不是架構重新研究，亦非全部PR-1C驗收通過。Process-crash test profile不回Durable ACK。日期2026-11-02（Asia/Taipei）。

## 1. Baseline / ancestry / authorization

Production/main仍7fb9b73442401fc32a7034888deaf49303e582a6、version0.20.0。Phase0.2 1fc6de91d1618e57a492eee1059c54d0bb0f735d → PR-1A 7eae7f5748a4c264a7dc996b07f005f95e34ff37 → 獨立remediation 75a30febee1f60e18981ec54e3c76b225c515bb1 → 本PR-1C commit（SHA由git最終回報，本文不自我包含）。Fetch／ls-remote確認PR-1A及main，initial tree clean；工作分支feat/unified-visual-architecture-pr1c由exact PR-1A建立，未reset/rebase/force/main edit。先交[F-01/F-02 report](PR-1A-REMEDIATION-REPORT.md)，再實作engine。[維護者有限授權](PR-1C-AUTHORIZATION.md)涵蓋這兩個PR單位，不含1D/1B或push。

## 2. Architecture interfaces / current boundary

`openIsolatedStore(directory,options,observeStage?)`於受管flock --no-fork/exec child執行writer；parent只是IPC client。options必有purpose=isolated-pr1c-testing；profile預設linux-local-durable，可顯式選linux-process-crash-test。root必為owned 0700、無symlink的disposable estampes-pr1c-*資料夾，unknown既有tree拒絕。Native durable profile只允Linux kernel回報的ext4/XFS與相符fs magic，且managed tree全同device；這是backend的必要條件，不認證硬體／Docker host flush。目標平台仍有第10節前提與阻擋。

Client methods：snapshot、diagnostics、commit(command,initiatingActorContext,expectedEpoch)、injectFault、kill、waitForExit、close；observeStage是trusted diagnostic callback，不是client tool欄位。沒有HTTP/MCP listener、config註冊、Module handle或現有服務import。Coordinator.open本身也重新檢查platform與自己的OS lease，且只能open一次；publication是private method，不能由外部直接呼叫繞過queue／admission。

Internal command schema為requestId、changes[1..64]（每筆expectedRevision:null|positive、完整validated document）、可選readSet(docId/revision/read-model hash)。這是**內部已經domain-validated snapshot transaction**，不是新增的MCP Annotation API。Coordinator再驗strict schemas、Doc/Scene/entity revision軸、immutable creator、complete after-state Doc closure、canonical bindings、原子all-or-none。Domain permissions/grants/locks／user-action認證須由未來service先驗；這裡解析ActorContext不認證caller，也不替module做授權。Actor參數是**發起端**stable identity，只用於ledger key；內容的executedBy/createdBy由domain service stamp，coordinator不捏造。

Snapshot回同Root的materialized immutable copy；`readCommittedSnapshot(directory)`每次只讀一次CURRENT，再固定讀該root。`validateCompleteDocumentClosure`由coordinator完整registry after-state產生exact declaration，不能接受client自稱closure。範圍是Document模型／Ref／binding，不宣稱CAS Notebook、Asset bytes或整個repository binary closure。新Notebook/Workspace/Surface transaction adapters留對應PR；本次只支援Document entity，不存假成功其他store。

## 3. Changed files

| File | Responsibility |
| --- | --- |
| src/persistence/errors.js | stable typed storage errors |
| src/persistence/platform.js | Linux/profile/mount/device/private-directory checks；驗證本process inherited flock FD/PID/inode |
| src/persistence/lease.js | util-linux flock exec／IPC client、startup/exit errors、client lifetime |
| src/persistence/worker.js | private writer入口、單coordinator、RPC與test-only fault arming、disconnect立即exit |
| src/persistence/filesystem.js | canonical file/hash I/O、immutable stage/fsync/rename/dir barriers、bounded plan／test preflight與fault hooks |
| src/persistence/pages.js | 六種索引、256 hash-prefix桶、4MiB bounded chained pages、COW touched buckets、hash/kind/order驗證 |
| src/persistence/records.js | internal command／ACK／ledger／physical record schemas；load/verify完整六root／retained version closure |
| src/persistence/journal.js | durable intent/prepared/outcome；root membership recovery，不按mtime／最大檔名 |
| src/persistence/coordinator.js | global serialized OCC queue、after-state closure、immutable versions／bindings唯一權威、publish／recoveryepoch／retry |
| tests/persistence-transactions.test.js | true file transactions、OCC／parallel clients／rich metadata／COW／barrier ordering／tombstone read helper |
| tests/persistence-faults.test.js | 每stage SIGKILL、每file/dir fsync失敗、rename/ENOSPC、root/file corruption、recovery interruption |
| tests/persistence-platform.test.js | unsupported profile拒絕、OS contention／crash release／supervisor death／native positive case（缺環境Skip） |
| tests/fixtures/uva-persistence.mjs | 合成資料、owned disposable tmp volumes、明確test-only profile、cleanup |
| RFC evidence / README / OPEN-DECISIONS / Roadmap / Matrix / Traceability | limited approval、實際覆蓋／阻擋／logs hashes；oldreports不改寫 |

本commit新增9個production modules、3個test files及fixture。PR-1A兩個schema helper的主要修訂屬前一個獨立commit；本commit另補F-01 integration反例：currently-confirmed/rejected/independently-verified ClaimContext的source refs屬required，stale/unverified context才可保historical missing refs，並保留原8case期待、追加assertions。現有95source/config、既有產品tests、version／dependencies／Docker／server／saveCanvas／CAS／Graph／Workbench保持原bytes，未對user volume做任何操作。

## 4. Transaction state machine / persistence representation

Admission → queue/OCC/readSet/epoch → pure after-state validation → plan/capacity preflight → intent durable → staged immutable files/indices durable → prepared Root durable → candidate closure從disk重驗 → CURRENT temp fsync/rename → CURRENT parentdir fsync → verify published root → durable outcome → memory snapshot / ACK。Prepared不是authority；只有CURRENT選generation。提交後不可abort，只能new transaction；publication嘗試或barrier不確定則read-only-recovery、無ACK。

Six roots為registry/locator/ledger/commitIndex/retention/authority，CommitRoot<=64KiB。Index根只存256 bucket page hashes；每page<=4MiB，可分鏈；改動只重寫touched bucket及root，不複製全ledger manifest。單entry太大／isolated index>100000拒絕於publish前。Entity standalone record<=64MiB，logical ref=(storeUUID,docId,revision,contentHash)；locator path由typed ID/revision/hash推導，不信任任意relativePath。

Document磁碟record將bindings拆成bindingIds；canonical binding僅registry一份，read才materialize。舊binding由retained historical registry保持；當前不再引用的binding從current index移除，未刪history。Hash採canonical UTF8 sorted object keys，保array與finite數值精度。Raw contentHash是**stored record** hash；readSet／Doc closure hash是**materialized read model** hash，兩者不可混用。

Retention目前保全部既有full版本／registry resolver pairs，不刪任何logical history；RecoveryCatalog pair與locator覆蓋逐項驗。未做thinning／GC／compaction。Parent CommitRootHash只作audit，不沿最大檔名或recursive parent選authority；root DAG無self hash。初代及每次reopen的epoch maintenance也是同一六root commit，Document revision不變。

## 5. Durability / ACK barriers

intent file+dir flush在任何staged effects前；每個staged file皆write temp → fsync file → rename → fsync parent；prepared root及journal prepared相同規則。CURRENT rename是logical visibility，CURRENT父目錄fsync完成才可durable。**相同hash既有檔也重新file+dir flush**，避免重用崩潰時尚未durable的orphan name。Candidate closure逐disk hash與typed refs驗證後才publish。

ACK內含commitId/resultId/revisionVector/noChange/durability，不含其外層CommitRootHash；ledger/index/retention先hash，最後root，無自指。Response wrapper有replayed，saved ACK本體byte/semantic value維持相同。Test profile ACK明列durability=process-crash-test，Document.persistence=memory；這不是fallback，也不是一般memory session，僅disposable file-I/O rehearsal。Unsupported native mount直接拒writer，不在同store透明換profile；stored profile不能提升。

## 6. Recovery algorithm / uncertain outcomes

先OS lease → profile／marker consistency → single CURRENT envelope/checksum → root與六root hashes／bounded pages → logical full generation與binding closure → ledger/index cardinality／key／payload／result identity → retained registry/resolver coverage。任一錯誤進read-only-recovery，沒有猜最新或自動倒回舊root。

有效root先重新flush其完整referenced files／dirs及CURRENT，再逐UUID transaction dir查membership。Committed補相符outcome，不apply content；absent membership則aborted／incomplete-intent，不adopt prepared。已存在committed outcome與selectedroot不符→RO，避免靜默丟已ACK效果。Missing/malformed staged內容若未被current引用，不當新authority；corrupt orphan若後來同hash path被重用，拒overwrite／ACK，交repair。Outcomes與intents重做皆idempotent，recovery遇ENOSPC或flush failure保持RO，不清最新root或ledger解圍。

完成recovery才用maintenance commit提高authority epoch並建立新execution lease；old queued/late epoch拒絕，已commit retry先查ledger可回原ACK。所有writes單global queue序列化，故不需要此階段引入parallel draft rebase；不同Doc更新仍從最新root compose，未覆蓋其他Doc。

## 7. Fault matrix / observed boundary

| Scenario | Required / tested oracle |
| --- | --- |
| 15 process kill points：beforeintent、intent file/dir flush、afterintent、staged file/rename/dir、afterstages、rootfile、afterprepared、CURRENT before/afterrename/beforedirflush、afterdurablepublish、beforeACK | old或whole new root；same temp storage重啟、membership／metadata／exact document／ledger effect=1；不是power loss |
| 13 file/directory fsync EIO boundaries，含mkdir／intent／staged／root／prepared／CURRENT／outcome | 零ACK、writer RO；重啟後whole root、same key只一effect |
| ENOSPC準備／prepared／CURRENT前及rename後dirflush，EXDEV rename | 無falseACK；未publish保old，rename後可見whole new；restart ledger判定 |
| CURRENT／root／page／generation／intent／outcome損毀、registry-locator split、live metadata tamper | RO／拒新ACK，不guess priorroot；bad bytes不被自動覆蓋 |
| corrupt uncommitted staging、existing orphan resync failure、interrupted recovery EIO/ENOSPC／SIGKILL | 不adopt prepared、不重複effects，復原可重試；不能自行清唯一內容 |
| second writer／client supervisor SIGKILL | 真flock contention失敗、current不改；OS釋放lease／無orphan writer |

原始tap logs逐case記錄，第9節填final實測數字。沒有GC、compaction、VM block-fault、硬體power-loss或oldbinary mountfence測試；不能把錯誤注入當實體媒體斷電證據。

## 8. Idempotency semantics

key=(storeInstanceId, SHA256 stable authenticated initiating principal descriptor,cmd:same UUID as request)。User/model principalId與owner stable；module用moduleId+lineage，version/packageDigest/executionId不重設lane。Coordinator的ActorContext是server-only trusted record，不是可由MCP caller自行選的author。Canonical payload hash涵蓋internal route、完整command、targets、revisions／readSet；actor execution epoch不當payload，跨restart不妨礙已commit retry。

Ledger與Docheads同CommitRoot；retry先查committed key，同hash回原ACK，異hashIDEMPOTENCY_MISMATCH；OCC/epoch不能使已commit retry再次apply。Current fullACK不依年齡刪除，至少涵蓋7day承諾；永久tombstone read schema/helper可回RETRY_WINDOW_EXPIRED或mismatch且不重做效果，**本PR不生成／compact tombstone**。原子compaction／clock high-water／retention tests仍PR-1D。Intent還未終結時key亦保payload binding，本PR不刪intent；未來abort-journal compaction須保本契約。

## 9. Actual verification / raw evidence

正式[evidence manifest](evidence/pr1c-execution-manifest.json)與[baseline/scope](evidence/pr1c-baseline.json)保存exact commands／versions／exit／log SHA256。Node命令皆明確使用`npm exec --yes --package=node@22 --`，並非預設Node24。

| Command / run | Actual result | Exit |
| --- | --- | --- |
| `env -u ESTAMPES_STORAGE_DIR -u ESTAMPES_ACCESS_KEY CHROME_BIN=/usr/bin/chromium npm exec --yes --package=node@22 -- npm test` | **402 cases：401 pass、0 fail/cancel/todo、1 skip**；177360.242766ms；包含原328、review8與新增persistence66 | 0 |
| `node --test tests/documents-review.test.js tests/documents-foundation.test.js tests/documents-shadow.test.js` | 最後F-01 source：61 pass／0fail／0skip；3564.407771ms | 0 |
| `node --test tests/persistence-transactions.test.js tests/persistence-faults.test.js tests/persistence-platform.test.js tests/documents-review.test.js tests/documents-foundation.test.js tests/documents-shadow.test.js` | publication encapsulation前的storage版：127cases／126pass／1nativeSkip／0fail；86287.586754ms；後續僅F-01 active Context加嚴，已用上列full402與review61重跑；最後private publisher／Coordinator platform重驗後再跑完整402與平台6cases | 0 |
| `node --test tests/persistence-platform.test.js` | 最後封裝版：6cases／5pass／1nativeSkip／0fail；2172.291541ms | 0 |
| `node --test docs/rfc/unified-visual-architecture/evidence/contract-validation.spec.mjs` | 22 pass／0fail／0skip；原期待不改 | 0 |
| `node docs/rfc/unified-visual-architecture/evidence/validate-contract-examples.mjs` | 9formal examples／9fences／7tool schemas，0errors；API仍Proposed，不宣稱新runtime實作 | 0 |
| `python -m unittest discover -s cas-service/tests -v` | 17 pass／0fail／0skip；9.560s；有unclosed-file/StreamWriter ResourceWarnings與asyncio teardown diagnostics | 0 |
| `npm run docs:check` | 88markdown／55currenttools／22currentconfig | 0 |
| `npm run release:check` | 0.20.0一致；未push tag／publish | 0 |
| `node docs/rfc/unified-visual-architecture/evidence/check-consistency.mjs` | 8RFC／12ADR／67UVA／23PR／R與FG各6／6OD、95oldhash、historical records與原16doc期待、9examples，exact新檔與2review helper範圍通過 | 0 |
| `git diff --check 7eae7f5748a4c264a7dc996b07f005f95e34ff37`（含新增stage檔） | 無whitespace errors | 0 |

最終環境：Node22.23.4／defaultNode24.19.0、npm11.9.0、Python3.12.14、Chromium154.0.8037.57、Sharp0.34.5/libvips8.17.3、Zod4.6.7、util-linux flock2.41.5、Linuxx64 kernel6.18.57。原275與PR-1A53測試保持，new review file只追加active-context assertions；first fault run與earlier full log保留為development evidence，不能代替final source。

唯一Skip是缺原生ext4/XFS的正向Durable ACK case。Zero fail不是所有acceptance已過；temp-file SIGKILL、faultadapter與真OSlease不能證明host power loss。未執行項目另列第7/10/11節。

## 10. Supported / unsupported profiles

CURRENT：只對明確isolated purpose提供Linux backend；OS flock／same-device／file+dirfsync由真系統呼叫。linux-local-durable候選需native ext4/XFS、已批准deployment的local driver、OS/硬體honor flush與exact-mount fault證據；kernel filesystem識別與primitive成功不認證host hardware，未驗環境不列validated。一般Estampes操作完全沒有import此engine。

OBSERVED：本環境kernel6.18.57、workspace overlayfs、/tmp tmpfs，沒有CAP_SYS_ADMIN／已批准ext4/XFS test mount。Native durable open被拒，正向native ACK case明確Skip。所有process kill／filesystem error rehearsal使用tmpfs真檔案，profile清楚test-only且無durable ACK。**Native durability acceptance尚未完成**；不是放寬allowlist或memory fallback。

Unsupported：Native macOS/APFS、Docker Desktop named/bind share、NFS/SMB/FUSE/unknown driver／跨device；未驗Docker Engine backing filesystem也不稱支持。沒有改Docker或建立OS source fence；old binary防寫留PR-1B。

## 11. Remaining PR-1D / integration dependencies

沒有GC／compaction／永久ledger實體縮減／60command快速undo／delta archives／reader pin budget／backup／fullhistory thinning／quota calibration／fair maintenance admission。這些是1D必要前置，不能開full generation productionwriter。當前測試purpose有明確server-side quotaBytes（default256MiB，128MiB..10GiB）、reserve=max64MiB/1%Q、maxContentCommits（default100，1..1000），preflight計staging+metadata budget與free bytes；超限拒新寫。這是**隔離演練上限**，非已測production capacity profile；不宣稱符合UVA-50/64/65長期growth。未清staging，aborted attempts也耗quota，空間不足保持資料並拒寫。quota目前計managed file logical bytes與staging budget，非已校準allocated-block／maintenance quota；loader eager驗全部retained generations，記憶體／large-history成本尚未校準。不得以本次小fixture推論64MiB×大量版本可用，PR-1D需streaming／pack與容量、記憶體驗收。新建時quota/maxContentCommits寫Format固定，reopen不改這些caps，尚無線上調額操作。

1B才可接現有tools、saveCanvas／ImageEntry、domain authorization／Host user-action、alias/source seals／cutover／oldbinary fence。CAS/Surface/Workspace與binaryassets的完整transaction adapters不在此Doc-only backend里假裝存在。其他OD產品決策／真Host／performance均維持pending。

## 12. Rollback

PR-1A remediation與PR-1C分開commit，均未啟用正常路徑；revert本engine commit即可移除新增modules/tests/docs整合。Disposable test directories由test fixture owner清理，不存在使用者資料rollback／migration。若將來integration啟用或產生真正durable資料，不能引用本PR的無資料回退方式；必須按1D/1B各自gate保volume/ledger／history，不倒回舊CURRENT。

## 13. Explicit exit recommendation / stop

**READY WITH BLOCKERS / PR-1C不能報完整驗收通過**：隔離transaction correctness、real file I/O／OS lease／process-crash及counterexamples可審；必要的native Linux ext4/XFS正向profile驗收缺測試掛載，真power-loss／部署證據仍未證。保留程式與測試供review，下一步只需在已批准disposable native mount完成相同backend/fault驗證，無須重開架構。

不開productionwriter、不遷移、不啟任何new writable API／authority切換、不push／merge／release；不開始PR-1D或PR-1B。本報告不以文件／現有tests通過替代未執行的durability acceptance。
